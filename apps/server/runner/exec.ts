import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants } from "node:os";
import path from "node:path";
import type { MachineReplies } from "@agenteschat/adapters/machine-protocol";
import { ConsoleDecoder, consoleText } from "./console-text";

/** Kept per stream (head and tail when larger). */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Streamed in `output` frames per command; the result still carries the kept text. */
export const MAX_STREAMED_BYTES = 1024 * 1024;
export const STREAM_BATCH_MS = 100;
const KILL_GRACE_MS = 3_000;
const CUT_MARKER = "\n[… cut …]\n";

export type ExecReply = MachineReplies["exec"];

/** `62.7KB`: how Claude Code writes a size. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  const at = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** at;
  return at === 0 ? `${bytes} bytes` : `${Number(value.toFixed(1))}${units[at]}`;
}

/** Keeps the first and last `limit / 2` bytes of a stream. */
export class OutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  constructor(private readonly limit = MAX_OUTPUT_BYTES) {}

  push(chunk: Buffer) {
    this.total += chunk.length;
    const half = Math.floor(this.limit / 2);
    let rest = chunk;
    if (this.headBytes < half) {
      const take = rest.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    const tailLimit = this.limit - half;
    while (this.tailBytes > tailLimit) {
      const first = this.tail[0] as Buffer;
      const extra = this.tailBytes - tailLimit;
      if (first.length <= extra) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(extra);
        this.tailBytes -= extra;
      }
    }
  }

  get totalBytes() {
    return this.total;
  }

  text(): string {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.total <= this.limit) return consoleText(Buffer.concat([head, tail]));
    return consoleText(head, { cut: true }) + CUT_MARKER + consoleText(tail, { cut: true });
  }
}

export interface ExecOptions {
  command: string;
  /** Absolute, already checked against the workspace. */
  cwd: string;
  timeoutSeconds: number;
  /** Aborted on `cancel` (or when the connection goes away). */
  signal?: AbortSignal;
  /** Called with batched new text while it runs (only when streaming). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Tests: shorter batching. */
  batchMs?: number;
  /** Added to the runner's environment (the agent's secrets, ADR 0027). */
  env?: Record<string, string>;
  /** Applied to everything that leaves the machine: live chunks and the result. */
  redact?: (text: string) => string;
  /** Live output holds back this many characters (the longest secret − 1), so a value split between chunks never leaves in pieces. */
  redactHold?: number;
}

/** The platform shell, the way Node's own `shell: true` does it. */
export function shellCommand(command: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  return { file: "/bin/sh", args: ["-c", command], verbatim: false };
}

/** `taskkill` by its full path: a bare name is looked for in the current folder first. */
export const windowsTaskkill = () =>
  path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

/** Kills the command and everything it started. */
export function killTree(
  child: {
    pid?: number;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): unknown;
  },
  signal: NodeJS.Signals,
) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Already ended: its pid may be another process's now. (`taskkill /T` follows a tree only while its root lives.)
    if (typeof child.exitCode === "number" || child.signalCode) return;
    try {
      const killer = spawn(windowsTaskkill(), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      (killer as unknown as EventEmitter).on("error", () => {});
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Every process under `pid` on macOS and Linux, from `ps`, even those in a process group of their own (Claude Code
 * starts each shell command detached); empty when `ps` can't say.
 */
export function descendantPids(pid: number): number[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
  const children = new Map<number, number[]>();
  for (const row of (ps.stdout ?? "").split("\n")) {
    const [child, parent] = row.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  for (let i = -1; i < found.length; i++) found.push(...(children.get(i < 0 ? pid : (found[i] as number)) ?? []));
  return found;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** Milliseconds between 1601-01-01 (a Windows FILETIME's zero) and the Unix epoch. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;
let kernel32: ReturnType<typeof openKernel32> | undefined;
async function openKernel32() {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const { symbols } = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { ...symbols, ptr };
}

/**
 * When a process started (ms since the epoch), on Windows; null elsewhere, or when it is gone or can't be read.
 * Windows hands a freed pid to the next process at once: a pid with its start time names one process. A direct
 * system call, since asking PowerShell takes about a second.
 */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  try {
    kernel32 ??= openKernel32();
    const k = await kernel32;
    const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!handle) return null;
    try {
      const times = new BigUint64Array(4);
      const ok = k.GetProcessTimes(handle, k.ptr(times), k.ptr(times, 8), k.ptr(times, 16), k.ptr(times, 24));
      return ok ? Number((times[0] ?? 0n) / 10_000n) - FILETIME_EPOCH_MS : null;
    } finally {
      k.CloseHandle(handle);
    }
  } catch {
    return null;
  }
}

export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const n = (constants.signals as Record<string, number | undefined>)[signal];
    return 128 + (n ?? 1);
  }
  return 1;
}

/** Runs a shell command on this machine; never throws (spawn failures come back as exit 127). */
export function runCommand(opts: ExecOptions): Promise<ExecReply> {
  return new Promise<ExecReply>((resolve) => {
    const shell = shellCommand(opts.command);
    const clean = opts.redact ?? ((text: string) => text);
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    let timedOut = false;
    let canceled = false;
    let done = false;
    let streamed = 0;
    const pending = { stdout: "", stderr: "" };
    const decoders = { stdout: new ConsoleDecoder(), stderr: new ConsoleDecoder() };
    const timers: ReturnType<typeof setTimeout>[] = [];

    const held = { stdout: "", stderr: "" };
    const hold = opts.redact ? Math.max(0, opts.redactHold ?? 0) : 0;
    const flush = (final = false) => {
      if (!opts.onOutput) return;
      for (const stream of ["stdout", "stderr"] as const) {
        // Redacted before cutting: the tail kept for next time can't split a value that was caught.
        let chunk = pending[stream];
        pending[stream] = "";
        if (opts.redact) {
          const out = clean(held[stream] + chunk);
          const cut = final ? out.length : Math.max(0, out.length - hold);
          held[stream] = out.slice(cut);
          chunk = out.slice(0, cut);
        }
        if (chunk && streamed < MAX_STREAMED_BYTES) {
          const room = MAX_STREAMED_BYTES - streamed;
          const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
          streamed += Buffer.byteLength(piece);
          try {
            opts.onOutput(stream, piece);
          } catch {
            // the connection went away; the result still has it
          }
        }
      }
    };
    const batch = opts.onOutput ? setInterval(flush, opts.batchMs ?? STREAM_BATCH_MS) : undefined;

    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim,
      });
    } catch (err) {
      if (batch) clearInterval(batch);
      resolve({ exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }

    // Redacted before it is kept (ADR 0144): the cut of a long output (its head and tail) can't split a value in
    // two and leave each half readable. The last `hold` characters wait for the next chunk, as live output does.
    const keptHeld = { stdout: "", stderr: "" };
    const keepDecoders = { stdout: new ConsoleDecoder(), stderr: new ConsoleDecoder() };
    const keep = (stream: "stdout" | "stderr", text: string, final = false) => {
      const out = clean(keptHeld[stream] + text);
      const cut = final ? out.length : Math.max(0, out.length - hold);
      keptHeld[stream] = out.slice(cut);
      if (cut > 0) (stream === "stdout" ? stdout : stderr).push(Buffer.from(out.slice(0, cut)));
    };
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (opts.redact) keep(stream, keepDecoders[stream].write(chunk));
      else (stream === "stdout" ? stdout : stderr).push(chunk);
      if (opts.onOutput && streamed < MAX_STREAMED_BYTES) pending[stream] += decoders[stream].write(chunk);
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));

    const stop = () => {
      killTree(child, "SIGTERM");
      timers.push(setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS));
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (batch) clearInterval(batch);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onOutput) {
        for (const stream of ["stdout", "stderr"] as const) pending[stream] += decoders[stream].end();
        flush(true);
      }
      if (opts.redact) {
        for (const stream of ["stdout", "stderr"] as const) keep(stream, keepDecoders[stream].end(), true);
      }
      // A background process may hold the pipes open; don't wait for it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (spawnError) {
        resolve({ exitCode: 127, stdout: clean(stdout.text()), stderr: spawnError.message, timedOut: false });
        return;
      }
      if (canceled) {
        resolve({
          exitCode: 130,
          stdout: clean(stdout.text()),
          stderr: clean(stderr.text()),
          timedOut: false,
          canceled: { killed: true },
        });
        return;
      }
      resolve({
        exitCode: timedOut ? 124 : exitCodeOf(code, signal),
        stdout: clean(stdout.text()),
        stderr: clean(stderr.text()),
        timedOut,
      });
    };

    const onAbort = () => {
      if (done || timedOut) return;
      canceled = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const seconds = Math.max(1, Math.min(opts.timeoutSeconds || 60, 24 * 3600));
    timers.push(
      setTimeout(() => {
        if (done || canceled) return;
        timedOut = true;
        stop();
      }, seconds * 1000),
    );

    // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
    const events = child as unknown as EventEmitter;
    events.on("error", (err: Error) => finish(null, null, err));
    events.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
    events.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      // `close` waits for the pipes; give them a moment, then answer anyway.
      timers.push(setTimeout(() => finish(code, signal), 1000));
    });
  });
}
