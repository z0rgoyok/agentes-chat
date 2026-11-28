import { lookup } from "node:dns/promises";
import { isIP, type Socket, connect as tcpConnect } from "node:net";
import {
  EGRESS_SHARE,
  isEgressTarget,
  isStreamId,
  type MachineReplies,
  type MachineRequest,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import { onOwnNetwork, publicAddress } from "./egress";
import { RunnerError } from "./errors";
import type { DataSocket } from "./streams";

/** Reading from the destination pauses while the data socket holds more than this. */
const HIGH_WATER = 1024 * 1024;
const RESUME_POLL_MS = 25;
const PAUSE = JSON.stringify({ type: "pause" });
const RESUME = JSON.stringify({ type: "resume" });

type Limits = { open: number; connectMs: number };

/**
 * ADR 0237, on a person's computer: `egress.dial` opens one TCP connection for the workspace's own computer and
 * carries it on a data socket. Only a public address is reached (the person's own network never is), on any port but
 * `EGRESS_SHARE.refusedPorts`, at most `open` at once. Bytes are not capped: a product decision (ADR 0237 §4).
 */
export class EgressShare {
  private open = 0;
  private readonly limits: Limits;

  constructor(
    private readonly o: {
      resolve?: (host: string) => Promise<string[]>;
      connect?: (host: string, port: number) => Socket;
      /** This computer's interfaces (default `os.networkInterfaces()`). */
      interfaces?: () => Parameters<typeof onOwnNetwork>[1];
      limits?: Partial<Limits>;
    } = {},
  ) {
    this.limits = { ...EGRESS_SHARE, ...o.limits };
  }

  private async addresses(host: string): Promise<string[]> {
    if (isIP(host)) return [host];
    try {
      const resolve = this.o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
      return await resolve(host);
    } catch {
      throw new RunnerError("not_found", `${host} has no address`);
    }
  }

  async dial(
    req: Extract<MachineRequest, { op: "egress.dial" }>,
    dialData: (streamId: string) => Promise<DataSocket>,
  ): Promise<MachineReplies["egress.dial"]> {
    const { streamId } = req;
    if (!isStreamId(streamId) || !isEgressTarget({ host: req.host, port: req.port })) {
      throw new RunnerError("bad_request", "egress.dial takes a stream, a host and a port it carries");
    }
    if (this.open >= this.limits.open) throw new RunnerError("no_slot", "This computer carries enough connections now");
    const found = await this.addresses(req.host);
    // A name that points anywhere private (this network, this computer) is refused whole: never the person's own.
    if (found.length === 0) throw new RunnerError("not_found", `${req.host} has no address`);
    const interfaces = this.o.interfaces?.();
    if (!found.every((ip) => publicAddress(ip) && !onOwnNetwork(ip, interfaces))) {
      throw new RunnerError("not_allowed", "Only public addresses outside this computer's own network are reached");
    }
    this.open++;
    let tcp: Socket | null = null;
    let data: DataSocket | null = null;
    try {
      tcp = await this.reach(found[0] as string, req.port);
      data = await dialData(streamId);
    } catch (error) {
      this.open--;
      tcp?.destroy();
      throw error instanceof RunnerError ? error : new RunnerError("not_found", `Couldn't reach ${req.host}`);
    }
    this.pipe(tcp, data);
    return { connected: true };
  }

  private reach(address: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = (this.o.connect ?? ((h, p) => tcpConnect({ host: h, port: p })))(address, port);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RunnerError("not_found", "The site didn't answer in time"));
      }, this.limits.connectMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new RunnerError("not_found", "The site refused the connection"));
      });
    });
  }

  private pipe(tcp: Socket, data: DataSocket) {
    pipeSocket(tcp, data, {
      ended: () => {
        this.open--;
      },
    });
  }
}

/**
 * Carries a TCP socket's bytes on a data socket and back until either side ends (then both do, `ended` once).
 * Reading from the TCP socket pauses while the data socket is more than `HIGH_WATER` behind, or from the server's
 * `pause` to its `resume`; past `HIGH_WATER` waiting to be written to the TCP socket, this side says `pause` itself
 * (`resume` once it drained). Returns the way to end it.
 */
export function pipeSocket(tcp: Socket, data: DataSocket, o: { ended?: () => void } = {}): () => void {
  let done = false;
  /** The server said `pause`. */
  let held = false;
  /** This side said `pause`. */
  let full = false;
  let wait: ReturnType<typeof setInterval> | undefined;
  const end = () => {
    if (done) return;
    done = true;
    clearInterval(wait);
    tcp.destroy();
    data.close(STREAM_CLOSE.normal, "");
    o.ended?.();
  };
  tcp.on("data", (chunk: Buffer) => {
    if (done) return;
    data.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (wait || data.bufferedAmount <= HIGH_WATER) return;
    tcp.pause();
    wait = setInterval(() => {
      if (!done && data.bufferedAmount > HIGH_WATER / 2) return;
      clearInterval(wait);
      wait = undefined;
      if (!done && !held) tcp.resume();
    }, RESUME_POLL_MS);
  });
  tcp.on("drain", () => {
    if (done || !full) return;
    full = false;
    data.send(RESUME);
  });
  tcp.on("error", end);
  tcp.on("close", end);
  data.listen({
    bytes: (chunk) => {
      if (done) return;
      tcp.write(chunk);
      if (full || tcp.writableLength <= HIGH_WATER) return;
      full = true;
      data.send(PAUSE);
    },
    control: (frame) => {
      if (done || (frame.type !== "pause" && frame.type !== "resume")) return;
      held = frame.type === "pause";
      if (held) tcp.pause();
      else if (!wait) tcp.resume();
    },
    closed: end,
  });
  tcp.resume();
  return end;
}
