import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSpeech, type LocalSpeechDeps, SPEECH_MODELS } from "../src";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = () => {
  const d = mkdtempSync(join(tmpdir(), "speech-local-"));
  dirs.push(d);
  return join(d, "speech");
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const MODEL = new TextEncoder().encode("parakeet weights");
const TOKENS = new TextEncoder().encode("tokens");
const HELPER = new TextEncoder().encode("#!/bin/sh\n");
const models = [
  { path: "parakeet/encoder.int8.onnx", sha256: sha(MODEL), bytes: MODEL.length },
  { path: "parakeet/tokens.txt", sha256: sha(TOKENS), bytes: TOKENS.length },
];
const BIG = { memoryBytes: 16 * 2 ** 30, cpus: 8, target: "aarch64-apple-darwin" };

/** Our release: the manifest, the helper and the models; `serve` may answer otherwise for a file. */
function release(serve: (name: string, init?: RequestInit) => Response | null = () => null) {
  const asked: { name: string; range?: string }[] = [];
  const files: Record<string, Uint8Array> = {
    "agentes-speech-aarch64-apple-darwin": HELPER,
    "parakeet-encoder.int8.onnx": MODEL,
    "parakeet-tokens.txt": TOKENS,
  };
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const name = String(url).split("/").pop() ?? "";
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    asked.push({ name, ...(range ? { range } : {}) });
    const other = serve(name, init);
    if (other) return other;
    if (name === "manifest.json") {
      return Response.json({ helpers: { "aarch64-apple-darwin": { sha256: sha(HELPER) } } });
    }
    const body = files[name];
    if (!body) return new Response("no", { status: 404 });
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
    return new Response(body.slice(from), { status: from ? 206 : 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fake, asked };
}

/** A helper that says its port, or exits at once. */
function helper(how: "listens" | "dies") {
  const started: string[][] = [];
  const spawn = ((_bin: string, args: string[]) => {
    started.push(args);
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => proc.emit("exit", null, "SIGTERM"),
    });
    setTimeout(() => {
      if (how === "listens") proc.stdout.emit("data", Buffer.from('{"event":"listening","port":4321}\n'));
      else {
        proc.stderr.emit("data", Buffer.from("missing parakeet/encoder.int8.onnx\n"));
        proc.emit("exit", 1, null);
      }
    }, 1);
    return proc;
  }) as unknown as LocalSpeechDeps["spawn"];
  return { spawn, started };
}

const settled = async (local: ReturnType<typeof createLocalSpeech>) => {
  for (let i = 0; i < 200 && ["downloading", "starting", "off"].includes(local.status().state); i++) await Bun.sleep(5);
  return local.status();
};

test("set up here: the helper and the models come from our release, checked, then the helper runs as an engine", async () => {
  const dir = folder();
  const { fetch, asked } = release();
  const { spawn, started } = helper("listens");
  const local = createLocalSpeech({ dir, fetch, spawn, models, helperSha256: {}, machine: () => BIG });
  expect((await local.view()).fit).toBe("fits");
  await local.install();
  expect(await settled(local)).toEqual({ state: "ready" });
  expect(local.engine()?.id).toBe("local");
  expect(asked.map((a) => a.name)).toEqual([
    "manifest.json",
    "agentes-speech-aarch64-apple-darwin",
    "parakeet-encoder.int8.onnx",
    "parakeet-tokens.txt",
  ]);
  expect(readFileSync(join(dir, "models/parakeet/tokens.txt"), "utf8")).toBe("tokens");
  expect(readFileSync(join(dir, "models/NOTICE.txt"), "utf8")).toContain("CC BY 4.0");
  expect(started[0]).toEqual(["--models", join(dir, "models"), "--port", "0"]);

  // The server again: it starts what was set up, with nothing to download.
  const again = release();
  const after = createLocalSpeech({
    dir,
    helperSha256: {},
    fetch: again.fetch,
    spawn: helper("listens").spawn,
    models,
    machine: () => BIG,
  });
  await after.resume();
  expect(await settled(after)).toEqual({ state: "ready" });
  expect(again.asked.filter((a) => a.name !== "manifest.json")).toEqual([]);

  writeFileSync(join(dir, "kept.txt"), "not ours");
  await after.remove();
  // Only its own files: the folder itself may be a volume's mount point.
  expect(readdirSync(dir)).toEqual(["kept.txt"]);
  expect(after.status()).toEqual({ state: "off" });
});

test("a download stopped after its last byte, before its check, is checked as it is (the server answers 416)", async () => {
  const dir = folder();
  mkdirSync(join(dir, "models/parakeet"), { recursive: true });
  writeFileSync(join(dir, "models/parakeet/encoder.int8.onnx.part"), MODEL);
  const { fetch } = release((name, init) =>
    name === "parakeet-encoder.int8.onnx" && (init?.headers as Record<string, string> | undefined)?.range
      ? new Response(null, { status: 416 })
      : null,
  );
  const local = createLocalSpeech({
    dir,
    fetch,
    spawn: helper("listens").spawn,
    models,
    helperSha256: {},
    machine: () => BIG,
  });
  await local.install();
  expect(await settled(local)).toEqual({ state: "ready" });
  expect(readFileSync(join(dir, "models/parakeet/encoder.int8.onnx"))).toEqual(Buffer.from(MODEL));
});

test("a stopped download goes on from the same byte", async () => {
  const dir = folder();
  mkdirSync(join(dir, "models/parakeet"), { recursive: true });
  writeFileSync(join(dir, "models/parakeet/encoder.int8.onnx.part"), MODEL.slice(0, 5));
  const { fetch, asked } = release();
  const local = createLocalSpeech({
    dir,
    fetch,
    spawn: helper("listens").spawn,
    models,
    helperSha256: {},
    machine: () => BIG,
  });
  await local.install();
  expect(await settled(local)).toEqual({ state: "ready" });
  expect(asked).toContainEqual({ name: "parakeet-encoder.int8.onnx", range: "bytes=5-" });
  expect(readFileSync(join(dir, "models/parakeet/encoder.int8.onnx"))).toEqual(Buffer.from(MODEL));
});

test("a damaged file is fetched again once; twice is a download failure with the reason", async () => {
  let damaged = 1;
  const once = release((name) => (name === "parakeet-tokens.txt" && damaged-- > 0 ? new Response("garbage") : null));
  const local = createLocalSpeech({
    dir: folder(),
    helperSha256: {},
    fetch: once.fetch,
    spawn: helper("listens").spawn,
    models,
    machine: () => BIG,
  });
  await local.install();
  expect(await settled(local)).toEqual({ state: "ready" });

  const always = release((name) => (name === "parakeet-tokens.txt" ? new Response("garbage") : null));
  const broken = createLocalSpeech({
    dir: folder(),
    helperSha256: {},
    fetch: always.fetch,
    spawn: helper("listens").spawn,
    models,
    machine: () => BIG,
  });
  await broken.install();
  expect(await settled(broken)).toMatchObject({
    state: "failed",
    reason: "download",
    detail: expect.stringContaining("damaged"),
  });
});

test("a helper that stops is started again once, then fails with its own words", async () => {
  const { spawn, started } = helper("dies");
  const local = createLocalSpeech({
    dir: folder(),
    fetch: release().fetch,
    spawn,
    models,
    helperSha256: {},
    machine: () => BIG,
  });
  await local.install();
  expect(await settled(local)).toMatchObject({
    state: "failed",
    reason: "start",
    detail: expect.stringContaining("missing parakeet/encoder.int8.onnx"),
  });
  expect(started).toHaveLength(2);
  expect(local.engine()).toBeNull();
});

test("a machine too small or with no build says why, and nothing downloads", async () => {
  const { fetch, asked } = release();
  const small = createLocalSpeech({
    dir: folder(),
    helperSha256: {},
    fetch,
    models,
    machine: () => ({ ...BIG, memoryBytes: 4 * 2 ** 30 }),
  });
  expect((await small.install()).fit).toBe("memory");
  const other = createLocalSpeech({ dir: folder(), fetch, models, machine: () => ({ ...BIG, target: null }) });
  expect((await other.view()).fit).toBe("platform");
  expect(createLocalSpeech({ dir: null }).status()).toEqual({ state: "off" });
  expect(asked).toEqual([]);
});

test("the pinned models are tools/speech-helper/models.txt's", () => {
  const txt = readFileSync(join(import.meta.dir, "../../../tools/speech-helper/models.txt"), "utf8");
  const rows = txt
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const [sha256, bytes, path] = l.split(/\s+/);
      return { path, sha256, bytes: Number(bytes) };
    });
  expect(rows).toEqual(SPEECH_MODELS.map((m) => ({ ...m })));
});
