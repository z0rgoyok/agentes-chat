/**
 * The desktop app's bench: opens the app several times on a seeded server and reports how long it takes to open,
 * its memory and its idle CPU, beside a floor (the app on a blank page of its own instead of the site, which
 * separates the shell and its web view from the site's own cost). The Desktop bench workflow runs it on GitHub's
 * macOS, Windows and Ubuntu runners; it only records, it never fails on a number.
 *
 *   bun apps/desktop/scripts/bench.ts <app> <runner> <native folder> <seeded folder> <out folder> [warm openings]
 *
 * <app> is the app's own executable, or on macOS its `.app`, opened through Launch Services as people open it;
 * <runner> and <native folder> the server it carries, started as it starts it (server-smoke.ts) on a copy of <seeded
 * folder> (apps/server/scripts/perf/seed.ts). Each opening runs the app with `AGENTES_BENCH_OUT` and
 * `AGENTES_BENCH_URL` (src-tauri/src/bench.rs): the first on a new profile, signing in through a one-time link on its
 * way to the workspace's busiest channel, the warm ones signed in and straight there, then the floor. The app's list
 * of servers is replaced and its first opening needs a new profile, so a computer where the app ever opened is
 * refused; the app is left with no servers, as it was. Writes `bench.json` (each opening as the app wrote it, and the
 * summary), `bench.md` (the table, also added to the job's summary on GitHub) and each opening's output in <out folder>.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { percentile } from "../../../packages/engine/src/format";
import { serverLog, startServer, stopServer } from "./server-smoke";

/** What the app writes (bench.rs `Record`): times in ms from the top of its `run`. */
export interface Usage {
  bytes: number | null;
  cpuMs: number | null;
  processes: number;
}
export interface Sample {
  ms: number;
  app: Usage;
  webview: Usage;
}
export interface Opening {
  version: string;
  startedAtMs: number;
  setupMs: number | null;
  windowMs: number | null;
  pageReadyMs: number | null;
  coverGoneMs: number | null;
  paints: [string, number][];
  shown: Sample[];
  hidden: Sample[];
  error: string | null;
}
export type Kind = "first" | "warm" | "floor";
/** One opening: what the app wrote, when it was started, and what went wrong. */
export interface Run extends Partial<Opening> {
  kind: Kind;
  spawnedAtMs: number;
  failed?: string;
}

const last = (samples: Sample[] | undefined) => samples?.[samples.length - 1];
const plus = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a + b);
const total = (s: Sample | undefined) => (s ? plus(s.app.bytes, s.webview.bytes) : null);

/** The CPU the app and its web view used over an idle stretch (its two samples), in % of one core. */
export function idleCpu(samples: Sample[] | undefined): number | null {
  const [start, end] = samples ?? [];
  if (!start || !end || end.ms <= start.ms) return null;
  const used = plus(end.app.cpuMs, end.webview.cpuMs);
  const before = plus(start.app.cpuMs, start.webview.cpuMs);
  return used === null || before === null ? null : ((used - before) / (end.ms - start.ms)) * 100;
}

type Unit = "ms" | "bytes" | "%" | "count";
interface Metric {
  label: string;
  unit: Unit;
  of: (run: Run) => number | null | undefined;
}

export const METRICS: Metric[] = [
  { label: "The system starts the app", unit: "ms", of: (r) => r.startedAtMs && r.startedAtMs - r.spawnedAtMs },
  { label: "Setup done", unit: "ms", of: (r) => r.setupMs },
  { label: "Main window built", unit: "ms", of: (r) => r.windowMs },
  { label: "**Opening**: the site's first screen", unit: "ms", of: (r) => r.pageReadyMs },
  { label: "Cover gone", unit: "ms", of: (r) => r.coverGoneMs },
  { label: "Memory shown: the app", unit: "bytes", of: (r) => last(r.shown)?.app.bytes },
  { label: "Memory shown: web view", unit: "bytes", of: (r) => last(r.shown)?.webview.bytes },
  { label: "**Memory shown: total**", unit: "bytes", of: (r) => total(last(r.shown)) },
  { label: "Memory hidden: the app", unit: "bytes", of: (r) => last(r.hidden)?.app.bytes },
  { label: "Memory hidden: web view", unit: "bytes", of: (r) => last(r.hidden)?.webview.bytes },
  { label: "**Memory hidden: total**", unit: "bytes", of: (r) => total(last(r.hidden)) },
  { label: "**Idle CPU shown**", unit: "%", of: (r) => idleCpu(r.shown) },
  { label: "**Idle CPU hidden**", unit: "%", of: (r) => idleCpu(r.hidden) },
  { label: "Web view processes", unit: "count", of: (r) => last(r.shown)?.webview.processes },
];

/** Each metric: the first opening's, the warm ones' median and 95th percentile (nearest rank), the floor's. */
export function summarize(runs: Run[]) {
  const ok = (kind: Kind) => runs.filter((r) => r.kind === kind && !r.failed);
  const value = (metric: Metric, run: Run | undefined) => (run ? (metric.of(run) ?? null) : null);
  return METRICS.map((metric) => {
    const warm = ok("warm")
      .map((r) => value(metric, r))
      .filter((v) => v !== null);
    return {
      label: metric.label,
      unit: metric.unit,
      first: value(metric, ok("first")[0]),
      median: warm.length ? percentile(warm, 0.5) : null,
      p95: warm.length ? percentile(warm, 0.95) : null,
      floor: value(metric, ok("floor")[0]),
    };
  });
}

const cell = (unit: Unit, v: number | null) => {
  if (v === null) return "–";
  if (unit === "bytes") return `${Math.round(v / 2 ** 20)} MB`;
  if (unit === "%") return `${v.toFixed(1)} %`;
  return `${Math.round(v)}${unit === "ms" ? " ms" : ""}`;
};

/** The job summary: the machine, the table, what its numbers cover, the openings that failed and pages loaded again. */
export function report(runs: Run[], heading: string): string {
  const failed = runs.filter((r) => r.failed);
  const again = runs.flatMap((r) =>
    (r.paints ?? [])
      .filter(([, ms]) => r.pageReadyMs != null && ms > r.pageReadyMs)
      .map(([path, ms]) => `- A ${r.kind} opening's page loaded again: \`${path}\` painted at ${ms} ms`),
  );
  const lines = [
    heading,
    "",
    "| | First | Warm median | Warm p95 | Floor |",
    "|---|---:|---:|---:|---:|",
    ...summarize(runs).map(
      (r) =>
        `| ${r.label} | ${cell(r.unit, r.first)} | ${cell(r.unit, r.median)} | ${cell(r.unit, r.p95)} | ${cell(r.unit, r.floor)} |`,
    ),
    "",
    `${runs.filter((r) => r.kind === "warm").length} warm openings. First: a new profile, signing in through a one-time link on its way to the busiest channel. Warm: signed in, straight there. Floor: the app on a blank page of its own instead of the site.`,
    "",
    "Times from the top of the app's `run`, except the first row (from the bench starting it). Memory at the end of a 30 s idle stretch, shown (it starts 20 s after the site painted) and hidden (it starts after 30 s hidden); idle CPU over that stretch, the app and its web view together. Memory is macOS's footprint, Windows' private bytes, Linux's anonymous resident memory; the web view is WebKit's processes working for the app on macOS, every process under it elsewhere.",
    ...(failed.length || again.length ? ["", ...failed.map((r) => `- A ${r.kind} opening failed: ${r.failed}`)] : []),
    ...again,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The app's folders here, Tauri's for its identifier: its config, where its list of servers is, and its web view's
 * profile (cache, cookies, storage): Tauri's local data folder, WebKit's own folders on macOS.
 */
function appDirs(): { config: string; profile: string[] } {
  const { identifier } = JSON.parse(readFileSync(join(import.meta.dir, "../src-tauri/tauri.conf.json"), "utf8"));
  const home = os.homedir();
  if (process.platform === "darwin") {
    const library = (folder: string) => join(home, "Library", folder, identifier);
    return { config: library("Application Support"), profile: [library("WebKit"), library("Caches")] };
  }
  if (process.platform === "win32") {
    return {
      config: join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), identifier),
      profile: [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), identifier)],
    };
  }
  return {
    config: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), identifier),
    profile: [join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), identifier)],
  };
}

/** A macOS app's own executable in its `.app`. */
function bundleExecutable(app: string): string {
  const plist = join(app, "Contents", "Info.plist");
  const name = Bun.spawnSync(["plutil", "-extract", "CFBundleExecutable", "raw", plist]).stdout.toString().trim();
  if (!name) throw new Error(`${plist} names no executable`);
  return join(app, "Contents", "MacOS", name);
}

/** This machine, in a line: GitHub's runner image when it is one, the system, its CPUs and memory. */
function machine(version: string): string {
  const system =
    process.platform === "darwin"
      ? `macOS ${Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim()}`
      : process.platform === "win32"
        ? `${os.version()} (${os.release()})`
        : `${/^PRETTY_NAME="?([^"\n]*)/m.exec(existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "")?.[1] ?? "Linux"} (kernel ${os.release()})`;
  const image = process.env.ImageOS
    ? `GitHub's ${process.env.ImageOS} runner (image ${process.env.ImageVersion}), `
    : "";
  const cpus = os.cpus();
  const memory = (os.totalmem() / 2 ** 30).toFixed(0);
  return `**${image}${system}, ${process.arch}, ${cpus.length} CPUs (${cpus[0]?.model.trim()}), ${memory} GB**: agentes.chat ${version}.`;
}

/** A blank page that says it painted as the site does (two frames after it rendered): the floor's site. */
const FLOOR_PAGE = `<!doctype html><meta charset="utf-8"><title>Floor</title><script>
requestAnimationFrame(() => requestAnimationFrame(() => window.__TAURI_INTERNALS__?.invoke("page_ready", { site: true })));
</script>`;

/** An opening that hasn't quit by now is ended: the app's own deadline and measuring take under 5 minutes. */
const RUN_LIMIT_MS = 6 * 60_000;
/** The web view's processes go a moment after the app. */
const BETWEEN_MS = 5_000;

/** A file's last lines, or nothing. */
const tail = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-30).join("\n") : "");

async function main() {
  const [app, runner, native, seeded, outArg, warmArg] = process.argv.slice(2);
  if (!app || !runner || !native || !seeded || !outArg) {
    console.error(
      "usage: bun apps/desktop/scripts/bench.ts <app> <runner> <native folder> <seeded folder> <out folder> [warm openings]",
    );
    process.exit(2);
  }
  const { config, profile } = appDirs();
  const servers = join(config, "servers.json");
  const used = [servers, ...profile].find((path) => existsSync(path));
  if (used) {
    console.error(
      `The app has opened on this computer before (${used}): the bench would replace its servers, and its first opening wouldn't be on a new profile.`,
    );
    process.exit(2);
  }
  const executable = app.endsWith(".app") ? bundleExecutable(app) : app;
  // Whole: an app opened through Launch Services starts in `/`.
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  mkdirSync(config, { recursive: true });
  const choose = (origin: string) => writeFileSync(servers, JSON.stringify({ current: origin, servers: [origin] }));

  const runs: Run[] = [];
  /** Opens the app on `page`: its opening must end on `ends` (a warm one that lost its sign-in would paint `/login`). */
  const open = async (kind: Kind, page: string, ends: string) => {
    const name = join(out, `${kind}-${runs.length + 1}`);
    const file = `${name}.json`;
    const bundle = app.endsWith(".app");
    const spawnedAtMs = Date.now();
    // Only an app opened through Launch Services is its own responsible process, the one macOS counts WebKit's
    // processes against (vitals.rs `tree`): started from a shell, they would be the shell's.
    const child = bundle
      ? Bun.spawn([
          "open",
          ...["-W", "-n", "--stdout", `${name}.out.log`, "--stderr", `${name}.err.log`],
          ...["--env", `AGENTES_BENCH_OUT=${file}`, "--env", `AGENTES_BENCH_URL=${page}`, app],
        ])
      : Bun.spawn([app], {
          env: { ...process.env, AGENTES_BENCH_OUT: file, AGENTES_BENCH_URL: page },
          stdout: Bun.file(`${name}.out.log`),
          stderr: Bun.file(`${name}.err.log`),
        });
    // Unref'd: once the app quit, the limit never holds the bench open.
    const limit = new Promise<null>((done) => setTimeout(done, RUN_LIMIT_MS, null).unref());
    const code = await Promise.race([child.exited, limit]);
    if (code === null) {
      child.kill();
      // The app's own executable alone: the server it carries runs from the same folder.
      if (bundle) Bun.spawnSync(["pkill", "-f", executable]);
    }
    const run: Run = { kind, spawnedAtMs };
    try {
      Object.assign(run, JSON.parse(readFileSync(file, "utf8")) as Opening);
    } catch {
      run.failed = code === null ? "it didn't quit within 6 minutes" : `it quit (exit ${code}) without its numbers`;
    }
    const painted = run.paints?.find(([, ms]) => ms === run.pageReadyMs)?.[0];
    run.failed ??=
      run.error ??
      (run.pageReadyMs == null
        ? "the site never painted"
        : painted !== ends
          ? `it opened on ${painted} instead of ${ends}`
          : undefined);
    console.log(`bench: ${kind} opening: ${run.failed ?? `the site painted at ${run.pageReadyMs} ms`}`);
    if (run.failed) console.log(`${tail(`${name}.out.log`)}\n${tail(`${name}.err.log`)}`);
    runs.push(run);
    await Bun.sleep(BETWEEN_MS);
  };

  const data = mkdtempSync(join(os.tmpdir(), "agentes-bench-"));
  try {
    cpSync(seeded, data, { recursive: true });
    const { orgId, channelId } = JSON.parse(readFileSync(join(data, "seed.json"), "utf8"));
    const { server, url, seconds } = await startServer(runner, native, data).catch((e: Error) => {
      throw new Error(`the server didn't start: ${e.message}\n${serverLog(data)}`);
    });
    console.log(`bench: the server answers at ${url} after ${seconds} s`);
    try {
      choose(url);
      const key = readFileSync(join(data, "owner-key"), "utf8").trim();
      const minted = await fetch(`${url}/api/auth/owner-key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!minted.ok) throw new Error(`the owner key was refused: ${minted.status} ${await minted.text()}`);
      const { token } = (await minted.json()) as { token: string };
      const channel = `${url}/org/${orgId}/c/${channelId}`;
      const path = new URL(channel).pathname;
      await open("first", `${url}/desktop/handover?to=${encodeURIComponent(path)}#token=${token}`, path);
      const warm = Number(warmArg ?? 5);
      for (let i = 0; i < warm; i++) await open("warm", channel, path);

      const floor = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/"
            ? new Response(FLOOR_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
            : new Response(null, { status: 404 }),
      });
      choose(`http://127.0.0.1:${floor.port}`);
      await open("floor", `http://127.0.0.1:${floor.port}/`, "/");
      floor.stop(true);
    } finally {
      await stopServer(server);
    }
  } finally {
    // The app opens on its welcome window again.
    rmSync(servers, { force: true });
    try {
      rmSync(data, { recursive: true, force: true });
    } catch {
      // Left in the temporary folder: on Windows a file the server just let go of can still be busy.
    }
  }

  const heading = machine(runs.find((r) => r.version)?.version ?? "?");
  const text = report(runs, heading);
  writeFileSync(join(out, "bench.md"), text);
  writeFileSync(
    join(out, "bench.json"),
    `${JSON.stringify({ machine: heading, runs, summary: summarize(runs) }, null, 2)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
  // A kind with no numbers at all is a broken bench, not a slow app.
  const missing = (["first", "warm", "floor"] as const).filter(
    (kind) => !runs.some((r) => r.kind === kind && !r.failed),
  );
  if (missing.length) {
    console.error(`bench: no numbers from the ${missing.join(", ")} opening(s)`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
