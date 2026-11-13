import type { Readable, Writable } from "node:stream";

/**
 * The client end of the Agent Client Protocol (agentclientprotocol.com, protocol version 1): JSON-RPC 2.0 with one
 * JSON message per line over a child's standard input and output. The runner sends requests (`initialize`,
 * `session/new`, `session/prompt`…) and notifications (`session/cancel`); the agent sends its own requests
 * (`session/request_permission`) and notifications (`session/update`), answered by the handlers given.
 *
 * Nothing here knows which agent is on the other end: `brain-opencode.ts` drives OpenCode (`opencode acp`) with it.
 */

/** The protocol version this client speaks (`initialize`). */
export const ACP_PROTOCOL_VERSION = 1;

/** A message longer than this ends the connection: no agent sends one, and a runaway line would fill the memory. */
export const ACP_MAX_LINE = 64 * 1024 * 1024;

/** JSON-RPC's "method not found", what an agent's request this client doesn't serve gets. */
export const ACP_METHOD_NOT_FOUND = -32601;

/** A JSON-RPC error the agent answered with (or the connection ending before an answer: `code` 0). */
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export interface AcpHandlers {
  /** A notification from the agent (`session/update`). */
  onNotification?(method: string, params: unknown): void;
  /** A request from the agent: its result, or an `AcpError` thrown to answer with that error. */
  onRequest?(method: string, params: unknown): unknown;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class AcpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private ended: Error | null = null;
  /** When the agent last sent anything (any message or line). */
  lastHeard = Date.now();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly handlers: AcpHandlers = {},
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.read(chunk));
    output.on("end", () => this.close(new Error("The agent closed its output")));
    output.on("error", (err: Error) => this.close(err));
    // A child gone before it read what we wrote ends the connection by its exit, not by a broken pipe.
    input.on("error", () => undefined);
  }

  /** Whether the connection ended (and why). */
  get closed(): Error | null {
    return this.ended;
  }

  /** Sends a request and resolves with its result; rejects with `AcpError` (or when the connection ends first). */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Sends a notification (no answer). */
  notify(method: string, params: unknown) {
    if (!this.ended) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends the connection: every request still waiting rejects with `reason`. */
  close(reason: Error = new Error("The connection closed")) {
    if (this.ended) return;
    this.ended = reason;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  private write(message: unknown) {
    try {
      this.input.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private read(chunk: string) {
    this.lastHeard = Date.now();
    this.buffer += chunk;
    if (this.buffer.length > ACP_MAX_LINE && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.close(new Error("The agent sent a message too large to read"));
      return;
    }
    for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.receive(line);
    }
  }

  private receive(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not a protocol message (a stray log line): skipped.
      return;
    }
    if (!isRecord(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        this.handlers.onNotification?.(method, message.params);
        return;
      }
      void this.answer(id, method, message.params);
      return;
    }
    if (typeof id !== "number") return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const e = message.error;
      waiting.reject(
        new AcpError(
          typeof e.code === "number" ? e.code : -32603,
          typeof e.message === "string" ? e.message : "The agent refused",
          e.data,
        ),
      );
    } else waiting.resolve(message.result);
  }

  private async answer(id: unknown, method: string, params: unknown) {
    const handle = this.handlers.onRequest;
    try {
      if (!handle) throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
      const result = await handle(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const e = err instanceof AcpError ? err : new AcpError(-32603, err instanceof Error ? err.message : String(err));
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) },
      });
    }
  }
}
