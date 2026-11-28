import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { createSpeechEngine, type SpeechEngine, type SpeechFetch } from "@agenteschat/adapters";
import { diskSpace } from "@agenteschat/adapters/host-stats";

/**
 * Voice into text on the server's own computer (ADR 0100): the installation's owner picks it, and the server
 * downloads agentes-speech (tools/speech-helper) and its models from our pinned GitHub release, checks every file's
 * sha256, and runs the helper on 127.0.0.1 as the `local` engine with warm on. Downloads resume where they stopped
 * (HTTP range); a damaged file is fetched again once by itself. The helper frees its memory when idle and is started
 * again once if it stops. Nothing of it reaches agentes.chat's own servers, whose engines are set.
 */

export const SPEECH_RELEASE = "speech-helper-v0.1.0";
const RELEASE_URL = `https://github.com/agentes-chat/agentes-chat/releases/download/${SPEECH_RELEASE}`;

/** tools/speech-helper/models.txt, file by file (a test keeps them the same). */
export const SPEECH_MODELS = [
  {
    path: "parakeet/encoder.int8.onnx",
    sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479",
    bytes: 652282294,
  },
  {
    path: "parakeet/decoder.int8.onnx",
    sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5",
    bytes: 11845274,
  },
  {
    path: "parakeet/joiner.int8.onnx",
    sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98",
    bytes: 6355277,
  },
  {
    path: "parakeet/tokens.txt",
    sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    bytes: 93939,
  },
  {
    path: "whisper/tiny-encoder.int8.onnx",
    sha256: "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434",
    bytes: 12937772,
  },
  {
    path: "whisper/tiny-decoder.int8.onnx",
    sha256: "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925",
    bytes: 89855401,
  },
] as const;

/** The helper's build for each platform the release has. */
export const SPEECH_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
} as const;

/** The helper's sha256 per target, from speech-helper-v0.1.0's SHA256SUMS. */
const HELPER_SHA256: Partial<Record<string, string>> = {
  "aarch64-apple-darwin": "8b4ed9687e2e0d5dda3d1df35ed00555bfba7fc2cd74578ea9e6611a9a02462b",
  "x86_64-apple-darwin": "745bcda55d078498a6a4c5f09a0bdd141eb7ee18dc84df09d9229238e1d84495",
  "x86_64-pc-windows-msvc": "899299fc4dd94618a8152f8edae06cafca8930c0aa97e72a608bd57783c438fe",
  "x86_64-unknown-linux-gnu": "bebe620b2a8715204429f64b58ab1bd24a6f6221dfbf3a82879bd3b599ffdd77",
  "aarch64-unknown-linux-gnu": "7d6137114978891b57b70d807abca25306732562dd77153527f5e73c2015e6af",
};

/** Above the download: the files are renamed into place, with room left over. */
export const SPEECH_DISK_BYTES = 2 * 2 ** 30;
/** A personal computer with 8 GB, or a container allowed as much: the models take 1.2 to 1.8 GB while loaded. */
export const SPEECH_MEMORY_BYTES = 7.5 * 2 ** 30;

/** Parakeet's CC BY 4.0 attribution, beside the files (tools/speech-helper/NOTICE has the whole text). */
const NOTICE = `Speech to text on this computer, for agentes.chat voice messages.
Parakeet TDT 0.6B v3 by NVIDIA, https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3, licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/); exported to ONNX with int8 weights by csukuangfj (k2-fsa),
https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.
Whisper tiny by OpenAI (MIT License), exported by csukuangfj (k2-fsa), https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.
agentes-speech: AGPL-3.0-only, https://github.com/agentes-chat/agentes-chat/tree/main/tools/speech-helper (its NOTICE).
`;

export type LocalSpeechFit = "fits" | "memory" | "disk" | "platform";

export type LocalSpeechStatus =
  | { state: "off" }
  | { state: "downloading"; doneBytes: number; totalBytes: number }
  | { state: "starting" }
  | { state: "ready" }
  /** `download`: the network stopped it (Resume goes on from the same byte). `start`: the helper's own words. */
  | { state: "failed"; reason: "download" | "disk" | "start"; detail: string };

export interface LocalSpeechView {
  fit: LocalSpeechFit;
  /** What the machine has, for the words beside a choice that doesn't fit. */
  memoryBytes: number;
  freeDiskBytes: number | null;
  needDiskBytes: number;
  /** The whole download. */
  sizeBytes: number;
  status: LocalSpeechStatus;
}

export interface LocalSpeech {
  view(): Promise<LocalSpeechView>;
  /** Downloads what is missing (or goes on with it) and starts the helper. Refused when it doesn't fit. */
  install(): Promise<LocalSpeechView>;
  /** Stops a download or the helper and removes the files. */
  remove(): Promise<LocalSpeechView>;
  /** The running helper as an engine; null when it isn't. */
  engine(): SpeechEngine | null;
  status(): LocalSpeechStatus;
  /** At boot: the helper again when it was set up here. */
  resume(): Promise<void>;
  stop(): void;
}

export interface LocalSpeechDeps {
  /** The folder it keeps everything in; null: nowhere to keep it (no files folder on this server). */
  dir: string | null;
  fetch?: SpeechFetch;
  /** Tests: the helper's process. */
  spawn?: typeof spawn;
  /** Tests: other files than `SPEECH_MODELS`. */
  models?: readonly { path: string; sha256: string; bytes: number }[];
  /** Tests: other helper pins than the release's (empty: the release's manifest.json is read). */
  helperSha256?: Partial<Record<string, string>>;
  /** Tests: the machine's size. */
  machine?: () => { memoryBytes: number; cpus: number; target: string | null };
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** This computer's platform as the release names it; null for one it has no build for. */
export function speechTarget(platform: string = process.platform, arch: string = process.arch): string | null {
  return (SPEECH_TARGETS as Record<string, string>)[`${platform}-${arch}`] ?? null;
}

const machineNow = () => ({
  // A container's memory limit counts, not the host's.
  memoryBytes: Math.min(os.totalmem(), process.constrainedMemory?.() || os.totalmem()),
  cpus: os.availableParallelism(),
  target: speechTarget(),
});

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const sizeOf = (file: string) =>
  stat(file).then(
    (s) => s.size,
    () => 0,
  );

class DownloadError extends Error {}

export function createLocalSpeech(deps: LocalSpeechDeps): LocalSpeech {
  const http = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const machine = deps.machine ?? machineNow;
  const files = deps.models ?? SPEECH_MODELS;
  const totalBytes = () => files.reduce((n, m) => n + m.bytes, 0);
  const dir = deps.dir;
  const bin = (target: string) => join(dir ?? "", `agentes-speech${target.includes("windows") ? ".exe" : ""}`);
  const models = join(dir ?? "", "models");
  const doneMark = join(dir ?? "", "installed.json");
  let status: LocalSpeechStatus = { state: "off" };
  let engine: SpeechEngine | null = null;
  let child: ChildProcess | null = null;
  let stopping = false;
  let aborter: AbortController | null = null;
  let working: Promise<void> | null = null;

  async function fit(): Promise<{ fit: LocalSpeechFit; memoryBytes: number; freeDiskBytes: number | null }> {
    const m = machine();
    const free = dir ? ((await diskSpace(dir))?.freeBytes ?? null) : null;
    const have = dir && existsSync(doneMark);
    const f: LocalSpeechFit =
      !dir || !m.target
        ? "platform"
        : m.memoryBytes < SPEECH_MEMORY_BYTES || m.cpus < 2
          ? "memory"
          : !have && free !== null && free < SPEECH_DISK_BYTES
            ? "disk"
            : "fits";
    return { fit: f, memoryBytes: m.memoryBytes, freeDiskBytes: free };
  }

  async function view(): Promise<LocalSpeechView> {
    return { ...(await fit()), needDiskBytes: SPEECH_DISK_BYTES, sizeBytes: totalBytes(), status };
  }

  /** One file into place, from where its `.part` stopped, checked against `sha256`; fetched again once if damaged. */
  async function fetchFile(url: string, to: string, sha256: string, onBytes: (n: number) => void, again = true) {
    if (existsSync(to) && (await sha256Of(to)) === sha256) return;
    const part = `${to}.part`;
    const had = await sizeOf(part);
    const res = await http(url, {
      headers: had > 0 ? { range: `bytes=${had}-` } : {},
      signal: aborter?.signal,
      redirect: "follow",
    }).catch((e: unknown) => {
      throw new DownloadError(e instanceof Error ? e.message : String(e));
    });
    // 416: the `.part` already holds the whole file (stopped before its check), so it is checked as it is.
    const whole = had > 0 && res.status === 416;
    if (!whole && (!res.ok || !res.body)) throw new DownloadError(`HTTP ${res.status} for ${url.split("/").pop()}`);
    if (!whole && res.body) {
      // A server that ignored the range sends it all again.
      const append = had > 0 && res.status === 206;
      if (!append) onBytes(-had);
      const file = await open(part, append ? "a" : "w");
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          await file.write(chunk);
          onBytes(chunk.byteLength);
        }
      } catch (e) {
        throw new DownloadError(e instanceof Error ? e.message : String(e));
      } finally {
        await file.close();
      }
    }
    if ((await sha256Of(part)) !== sha256) {
      const size = await sizeOf(part);
      await rm(part, { force: true });
      onBytes(-size);
      if (again) return fetchFile(url, to, sha256, onBytes, false);
      throw new DownloadError(`${url.split("/").pop()} arrived damaged twice`);
    }
    await rename(part, to);
  }

  async function helperSha(target: string): Promise<string> {
    const pinned = (deps.helperSha256 ?? HELPER_SHA256)[target];
    if (pinned) return pinned;
    const res = await http(`${RELEASE_URL}/manifest.json`, { redirect: "follow" }).catch(() => null);
    const manifest = (res?.ok ? await res.json().catch(() => null) : null) as {
      helpers?: Record<string, { sha256?: string }>;
    } | null;
    const sha = manifest?.helpers?.[target]?.sha256;
    if (!sha) throw new DownloadError(`the release ${SPEECH_RELEASE} has no helper for ${target}`);
    return sha;
  }

  async function download(target: string) {
    if (!dir) return;
    await mkdir(models, { recursive: true });
    aborter = new AbortController();
    let done = 0;
    for (const m of files) {
      const to = join(models, m.path);
      done += existsSync(to) ? m.bytes : await sizeOf(`${to}.part`);
    }
    const total = totalBytes();
    const onBytes = (n: number) => {
      done = Math.max(0, done + n);
      status = { state: "downloading", doneBytes: Math.min(done, total), totalBytes: total };
    };
    onBytes(0);
    const sha = await helperSha(target);
    const helper = bin(target);
    const name = `agentes-speech-${target}${target.includes("windows") ? ".exe" : ""}`;
    await fetchFile(`${RELEASE_URL}/${name}`, helper, sha, () => {});
    if (process.platform !== "win32") await chmod(helper, 0o755);
    for (const m of files) {
      const to = join(models, m.path);
      if (existsSync(to)) continue;
      await mkdir(dirname(to), { recursive: true });
      await fetchFile(`${RELEASE_URL}/${m.path.replace("/", "-")}`, to, m.sha256, onBytes);
    }
    await writeFile(join(models, "NOTICE.txt"), NOTICE);
    await writeFile(doneMark, JSON.stringify({ release: SPEECH_RELEASE, at: new Date().toISOString() }));
  }

  /** The helper, listening; its first line says where. */
  function start(target: string, restarts: number): Promise<void> {
    const key = randomBytes(24).toString("base64url");
    const cpus = machine().cpus;
    return new Promise((resolve) => {
      status = { state: "starting" };
      const proc: ChildProcess = (deps.spawn ?? spawn)(bin(target), ["--models", models, "--port", "0"], {
        env: {
          PATH: process.env.PATH ?? "",
          SPEECH_API_KEY: key,
          // One note at a time on a personal computer, two on a server with 8+ cores.
          SPEECH_WORKERS: cpus >= 8 ? "2" : "1",
          SPEECH_THREADS: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc;
      let said = "";
      let listening = false;
      const tail: string[] = [];
      proc.stderr?.on("data", (d: Buffer) => {
        tail.push(String(d));
        if (tail.length > 20) tail.shift();
      });
      proc.stdout?.on("data", (d: Buffer) => {
        if (listening) return;
        said += String(d);
        const line = said.split("\n")[0] ?? "";
        if (!said.includes("\n")) return;
        const port = (() => {
          try {
            return Number((JSON.parse(line) as { port?: unknown }).port);
          } catch {
            return 0;
          }
        })();
        if (!port) return;
        listening = true;
        engine = createSpeechEngine(
          "local",
          { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, warm: true },
          { fetch: deps.fetch },
        );
        status = { state: "ready" };
        log("speech helper ready", { port });
        resolve();
      });
      // ChildProcess's own events aren't in its types here (the runner does the same).
      const events = proc as unknown as EventEmitter;
      events.on("error", (e: Error) => {
        tail.push(e.message);
      });
      events.on("exit", (code: number | null, signal: string | null) => {
        engine = null;
        child = null;
        if (stopping) return resolve();
        const detail = (tail.join("").trim().split("\n").slice(-5).join("\n") || `exit ${code ?? signal}`).slice(
          0,
          2000,
        );
        log("speech helper stopped", { code, signal });
        if (restarts < 1) {
          void start(target, restarts + 1).then(resolve);
          return;
        }
        status = { state: "failed", reason: "start", detail };
        resolve();
      });
    });
  }

  function stop() {
    stopping = true;
    aborter?.abort();
    child?.kill();
    child = null;
    engine = null;
  }

  async function run() {
    const target = machine().target;
    if (!target || !dir) return;
    stopping = false;
    try {
      await download(target);
      if (stopping) return;
      await start(target, 0);
    } catch (e) {
      if (stopping) return;
      const detail = e instanceof Error ? e.message : String(e);
      const full = /ENOSPC/.test(detail);
      status = { state: "failed", reason: full ? "disk" : e instanceof DownloadError ? "download" : "start", detail };
      log("speech helper setup failed", { detail });
    }
  }

  process.once("exit", () => child?.kill());

  return {
    view,
    engine: () => engine,
    status: () => status,
    stop,
    async install() {
      if ((await fit()).fit !== "fits") return view();
      if (status.state !== "downloading" && status.state !== "starting" && status.state !== "ready") {
        working = run().finally(() => {
          working = null;
        });
      }
      return view();
    },
    async remove() {
      stop();
      await working;
      status = { state: "off" };
      // Only what was put here: the folder may be a volume's mount point (`/data/speech`), which can't be removed.
      const target = machine().target;
      if (dir) {
        await Promise.all(
          [models, doneMark, ...(target ? [bin(target)] : [])].map((p) => rm(p, { recursive: true, force: true })),
        );
      }
      return view();
    },
    async resume() {
      if (!dir || !existsSync(doneMark)) return;
      const mark = await readFile(doneMark, "utf8").catch(() => "");
      if (!mark.includes(SPEECH_RELEASE)) return;
      working = run().finally(() => {
        working = null;
      });
    },
  };
}
