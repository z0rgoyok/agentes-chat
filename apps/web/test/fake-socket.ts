import type { SocketFactory, SocketLike } from "@agenteschat/client";
import type { FakeLiveServer } from "@agenteschat/client/live/testing";

/** A WebSocket stand-in: records what the client sends, lets tests push server frames. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  /** JSON frames sent, read (a text frame that isn't JSON stays as it came). */
  sent: unknown[] = [];
  /** Bytes sent, on a socket that carries them. */
  binary: Uint8Array[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | Uint8Array) {
    if (typeof data !== "string") {
      this.binary.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer).slice());
      return;
    }
    try {
      this.sent.push(JSON.parse(data));
    } catch {
      this.sent.push(data);
    }
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** Server side: */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/**
 * The app's sockets in a test. With `live` (the fake API's live server, `fakeLiveOf.get(api)?.server`), a live file's
 * socket (`/api/live`) reaches it and syncs as with the real server (ADR 0196); every other socket is a `FakeSocket`
 * the test drives.
 */
export function fakeSockets(options: { live?: FakeLiveServer } = {}) {
  const sockets: FakeSocket[] = [];
  const plain: SocketFactory = (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  const factory = options.live ? options.live.socketFactory(plain) : plain;
  return { sockets, factory, last: () => sockets[sockets.length - 1] as FakeSocket };
}
