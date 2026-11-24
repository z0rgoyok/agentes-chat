import {
  type BrowserTraffic,
  HEARTBEAT_MS,
  type MachineEgress,
  type MachineLoad,
  type MachineRequest,
  parseServerFrame,
  RUNNER_STOPPED_CLOSE,
  type RunnerFrame,
  type RunnerInfo,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  RECONNECT_HEALTHY_MS,
  reconnectDelay,
  reconnectStep,
  retryAfterFromReason,
  waitAfterRetryHint,
} from "@agenteschat/client/lib/backoff";
import { type HandlerContext, handleRequest, type RequestObserver, RequestRunner } from "./handlers";
import type { McpBridge } from "./mcp";

/** After the server says it is stopping (close 1001), the first dial goes out at a random point within this. */
export const SERVER_STOP_SPREAD_MS = 30_000;

/** What a transport tells the connection. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export interface Socket {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens a socket (real WebSocket in the runner, a fake in tests). */
export type Dial = (url: string, handlers: SocketHandlers) => Socket;

/** The global WebSocket (Node 22+ and Bun both have it). */
export const webSocketDial: Dial = (url, handlers) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("This runtime has no WebSocket client. Use Node.js 22 or newer, or Bun.");
  }
  const ws = new WebSocket(url);
  let closed = false;
  const decoder = new TextDecoder();
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev) => {
    const data: unknown = ev.data;
    if (typeof data === "string") handlers.onMessage(data);
    else if (data instanceof ArrayBuffer) handlers.onMessage(decoder.decode(data));
    else if (ArrayBuffer.isView(data)) handlers.onMessage(decoder.decode(data as Uint8Array));
  });
  ws.addEventListener("close", (ev) => {
    if (closed) return;
    closed = true;
    handlers.onClose(ev.code, ev.reason);
  });
  // An `error` is always followed by `close`; the watchdog covers the rest.
  ws.addEventListener("error", () => {});
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    },
  };
};

/** 1 s, 2 s, 4 s… up to 60 s, each ±20 % (the host's and workers' retries; the link itself uses `reconnectDelay`). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = reconnectStep(attempt);
  return Math.min(RECONNECT_CAP_MS, Math.round(base * (0.8 + 0.4 * random())));
}

/** A restart drops every runner at once: each comes back at its own moment, not all into the new server's start. */
export function serverStopDelay(random: () => number = Math.random): number {
  return Math.round(RECONNECT_BASE_MS + random() * (SERVER_STOP_SPREAD_MS - RECONNECT_BASE_MS));
}

/** Why `run()` ended: the CLI exits with `exitCode`. */
export interface ConnectionOutcome {
  exitCode: number;
  reason: "invalid_token" | "revoked" | "outdated" | "replaced" | "stopped";
  message: string;
}

/** `start`'s exit code when the server refuses the token (unknown or revoked): only a new token helps. */
export const TOKEN_REFUSED_EXIT = 2;

const REFUSED_EXIT: Record<Exclude<ConnectionOutcome["reason"], "stopped">, number> = {
  invalid_token: TOKEN_REFUSED_EXIT,
  revoked: TOKEN_REFUSED_EXIT,
  outdated: 3,
  replaced: 0,
};

export interface ConnectionOptions {
  /** `wss://…/api/machines/connect`. */
  url: string;
  token: string;
  /** What `hello` says; a function is asked again for each `hello` (pause and access change over time). */
  info: RunnerInfo | (() => RunnerInfo);
  context: HandlerContext;
  dial?: Dial;
  log?: (line: string) => void;
  random?: () => number;
  /** Runs requests instead of `handleRequest` (tests: a fake; a worker: only its own agent's). */
  handler?: typeof handleRequest;
  /**
   * Background tasks (protocol 4): `hello` carries their journal, each
   * `welcome` re-sends every `task.done` not yet acknowledged, `task.ack`
   * marks one delivered. Defaults to `context.tasks`.
   */
  tasks?: Pick<NonNullable<HandlerContext["tasks"]>, "list" | "attach" | "detach" | "ack">;
  /** Protocol 5: the local MCP endpoint of mission tasks; its calls go out while connected. */
  mcp?: Pick<McpBridge, "attach" | "detach" | "result"> & Partial<Pick<McpBridge, "tools">>;
  /** Protocol 7: the coding CLIs on the machine, looked up for each `hello` (cached by the caller). */
  executors?: () => RunnerInfo["executors"];
  /** Protocol 22: the last day's load; each new summary goes out once, on the next `pong`. */
  load?: () => MachineLoad | null;
  /** Protocol 23: the agents' browsers' last day of traffic, the same way. */
  browserTraffic?: () => BrowserTraffic | null;
  egress?: () => MachineEgress | null;
  /** Called after each `welcome` (frames sent from here on reach the server). */
  onWelcome?: (welcome: { machineId: string; name: string; heartbeatMs: number; observeEgress: boolean }) => void;
  /** Protocol 9: the server's `agents` frame (the agents that use this machine). */
  onAgents?: (agents: unknown, deleted: unknown) => void;
  /** Protocol 12: a person's turn in an agent's browser started, changed or ended (`browser.handoff`). */
  onBrowserHandoff?: (frame: Extract<ServerFrame, { type: "browser.handoff" }>) => void;
  /** The socket's state: dialing, welcomed, or down (reconnecting). */
  onState?: (state: "connecting" | "online" | "offline") => void;
  /** Sees every request start and end (the desktop app's jobs, the activity log). */
  observer?: RequestObserver;
}

/** A watchdog firing this much later than asked means the process was suspended (sleep), not a silent server. */
const SUSPENDED_AFTER_MS = 30_000;

interface SessionEnd {
  /** Welcomed and up `RECONNECT_HEALTHY_MS`: the next drop starts the waits over. */
  healthy: boolean;
  /** The wait the server's close asked for (`retry-after=`), in ms. */
  retryAfterMs: number | null;
  outcome?: ConnectionOutcome;
  /** The server closed it saying it is stopping (1001). */
  serverStop?: boolean;
}

/**
 * Keeps one connection to the server: `hello` first, `pong` for each `ping`,
 * requests run concurrently, reconnects with backoff, and reconnects when
 * nothing arrives from the server for two heartbeats. Ends only when the
 * server refuses the runner or `stop()` is called.
 */
export class RunnerConnection {
  private stopped = false;
  /** `reconnect()` was asked: the next dial goes out at once (no backoff). */
  private redial = false;
  /** An operator's standby (ADR 0176): no link to the server until `resume()`. */
  private parked = false;
  private endSession?: () => void;
  private wake?: () => void;
  /** The welcomed session's sender (null while connecting or down). */
  private live: ((frame: RunnerFrame) => void) | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ConnectionOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Whether a session is welcomed right now. */
  get online() {
    return this.live !== null;
  }

  /** Sends a frame on the welcomed session; false when not connected (the next `hello` carries the state). */
  send(frame: RunnerFrame): boolean {
    if (!this.live) return false;
    this.live(frame);
    return true;
  }

  async run(): Promise<ConnectionOutcome> {
    let attempt = 0;
    while (!this.stopped) {
      if (this.parked) {
        await this.sleep(2 ** 31 - 1);
        attempt = 0;
        continue;
      }
      const end = await this.session();
      if (end.outcome) return end.outcome;
      if (this.stopped) break;
      if (this.parked) continue;
      if (this.redial) {
        this.redial = false;
        attempt = 0;
        this.log("reconnecting now (asked by the app)");
        continue;
      }
      if (end.healthy) attempt = 0;
      const delay = end.serverStop
        ? serverStopDelay(this.opts.random)
        : end.retryAfterMs !== null
          ? waitAfterRetryHint(end.retryAfterMs, reconnectStep(attempt), this.opts.random)
          : reconnectDelay(attempt, this.opts.random);
      attempt++;
      this.log(`disconnected; reconnecting in ${(delay / 1000).toFixed(1)} s`);
      await this.sleep(delay);
    }
    return { exitCode: 0, reason: "stopped", message: "stopped" };
  }

  /**
   * Drops the socket and dials again at once (the app's "Reconnect"): what
   * runs on this session is aborted like on any disconnect (the server
   * resumes an interrupted agent turn when the new socket says hello).
   */
  reconnect() {
    if (this.stopped) return;
    if (this.endSession) {
      this.redial = true;
      this.endSession();
    } else this.wake?.(); // waiting out a backoff: dial now
  }

  /**
   * An operator's standby (ADR 0176): the socket closes as on any disconnect (what runs on it is aborted, so the
   * server sees the computer leave), and nothing dials until `resume()`. Everything else on the computer runs on.
   */
  standby() {
    if (this.stopped || this.parked) return;
    this.parked = true;
    this.endSession?.();
  }

  /** The standby is over: dials at once. */
  resume() {
    if (!this.parked) return;
    this.parked = false;
    this.wake?.();
  }

  get inStandby() {
    return this.parked;
  }

  /** Closes the socket, aborts running requests and makes `run()` return. */
  stop() {
    this.stopped = true;
    this.endSession?.();
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = undefined;
    });
  }

  private session(): Promise<SessionEnd> {
    return new Promise<SessionEnd>((resolve) => {
      const { opts, log } = this;
      let socket: Socket | undefined;
      let welcomed = false;
      let welcomedAt = 0;
      let retryAfterMs: number | null = null;
      let finished = false;
      let outcome: ConnectionOutcome | undefined;
      let serverStop = false;
      let heartbeatMs = HEARTBEAT_MS;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let sentLoad: MachineLoad | null = null;
      let sentTraffic: BrowserTraffic | null = null;
      let sentEgress: MachineEgress | null = null;
      let observeEgress = false;

      const send = (frame: RunnerFrame) => {
        if (finished || !socket) return;
        if (frame.type === "pong" && frame.egress && !observeEgress) {
          const { egress: _, ...privateFrame } = frame;
          frame = privateFrame;
        }
        // Browser pictures are independent JPEG frames: skip stale pictures while the link is backed up.
        // Results, heartbeats and input keep their normal ordered delivery.
        if (frame.type === "browser.frame" && (socket.bufferedAmount ?? 0) > 2 * 1024 * 1024) return;
        try {
          socket.send(JSON.stringify(frame));
          if (frame.type === "pong" && frame.egress) sentEgress = frame.egress;
        } catch {
          // closing; the session ends on `close`
        }
      };
      const runner = new RequestRunner(
        opts.context,
        send,
        log,
        opts.handler ?? handleRequest,
        undefined,
        opts.observer,
      );
      const tasks = opts.tasks ?? opts.context.tasks;

      const end = () => {
        if (finished) return;
        finished = true;
        if (watchdog) clearTimeout(watchdog);
        if (this.live === send) this.live = null;
        runner.close();
        tasks?.detach();
        opts.mcp?.detach();
        if (this.stopped) socket?.close(RUNNER_STOPPED_CLOSE, "stopped");
        else socket?.close();
        this.endSession = undefined;
        opts.onState?.("offline");
        const healthy = welcomed && Date.now() - welcomedAt >= RECONNECT_HEALTHY_MS;
        resolve({ healthy, retryAfterMs, outcome, serverStop });
      };
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        const armedAt = Date.now();
        watchdog = setTimeout(() => {
          // Fired much later than asked: this process was suspended (the Mac slept), not the server gone quiet.
          const late = Date.now() - armedAt - 2 * heartbeatMs;
          log(
            late > SUSPENDED_AFTER_MS
              ? `no ping from the server: this computer was asleep for about ${Math.round(late / 1000)} s; reconnecting`
              : "no ping from the server; reconnecting",
          );
          end();
        }, 2 * heartbeatMs);
      };

      const onFrame = (raw: string) => {
        const frame = parseServerFrame(raw);
        if (!frame) {
          log("ignored a frame the runner doesn't understand");
          return;
        }
        switch (frame.type) {
          case "welcome": {
            welcomed = true;
            welcomedAt = Date.now();
            observeEgress = frame.observeEgress === true;
            if (typeof frame.heartbeatMs === "number" && frame.heartbeatMs > 0) heartbeatMs = frame.heartbeatMs;
            log(`connected as ${frame.name}`);
            this.live = send;
            opts.onState?.("online");
            opts.onWelcome?.({ machineId: frame.machineId, name: frame.name, heartbeatMs, observeEgress });
            // First: a supervisor passes what this server does with a repeated call on to its workers' welcome.
            opts.mcp?.attach(send, { mcpOnce: frame.mcpOnce === true });
            tasks?.attach(send);
            return;
          }
          case "agents":
            opts.onAgents?.(frame.agents, frame.deleted);
            return;
          case "browser.handoff":
            opts.onBrowserHandoff?.(frame);
            return;
          case "mcp.result":
            opts.mcp?.result(frame);
            return;
          case "mcp.tools":
            opts.mcp?.tools?.(frame);
            return;
          case "task.ack":
            tasks?.ack(frame.taskId);
            return;
          case "ping": {
            const load = opts.load?.() ?? null;
            const traffic = opts.browserTraffic?.() ?? null;
            const egress = observeEgress ? (opts.egress?.() ?? null) : null;
            send({
              type: "pong",
              at: frame.at,
              ...(load && load !== sentLoad ? { load } : {}),
              ...(traffic && traffic !== sentTraffic ? { browserTraffic: traffic } : {}),
              ...(egress && egress !== sentEgress ? { egress } : {}),
            });
            sentLoad = load;
            sentTraffic = traffic;
            sentEgress = egress;
            return;
          }
          case "request": {
            const { type: _type, id, ...request } = frame;
            void runner.start(id, request as MachineRequest);
            return;
          }
          case "cancel":
            runner.cancel(frame.id);
            return;
          case "refused": {
            const reason = frame.reason in REFUSED_EXIT ? frame.reason : "invalid_token";
            outcome = { exitCode: REFUSED_EXIT[reason], reason, message: frame.message || reason };
            end();
            return;
          }
        }
      };

      this.endSession = end;
      opts.onState?.("connecting");
      try {
        socket = (opts.dial ?? webSocketDial)(opts.url, {
          onOpen: () => {
            queueMicrotask(() =>
              send({
                type: "hello",
                token: opts.token,
                ...(typeof opts.info === "function" ? opts.info() : opts.info),
                ...((executors) => (executors ? { executors } : {}))(opts.executors?.()),
                ...(tasks ? { tasks: tasks.list() } : {}),
              }),
            );
          },
          onMessage: (raw) => {
            if (finished) return;
            try {
              onFrame(raw);
            } finally {
              // Any frame is a sign of life, not only a ping: a busy server's pings may come late behind others.
              if (!finished) arm();
            }
          },
          onClose: (code, reason) => {
            serverStop = code === 1001;
            retryAfterMs = retryAfterFromReason(reason);
            if (!finished && !welcomed && code !== 1000) {
              log(`could not connect${reason ? ` (${reason})` : code ? ` (code ${code})` : ""}`);
            }
            end();
          },
        });
      } catch (err) {
        log(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
        end();
        return;
      }
      if (finished) socket.close();
      else arm();
    });
  }
}
