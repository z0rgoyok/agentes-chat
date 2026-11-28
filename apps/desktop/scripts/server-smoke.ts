/**
 * Runs the server here the way the desktop app does (`src-tauri/src/local_server.rs`), before the build ships:
 * the runner binary acting as Bun (`BUN_BE_BUN=1`) on the bundled `server/native.js`, with only the variables
 * the app passes, in a new data folder. It must answer `/api/health` as its own `server.json` names it, then
 * stop by itself, with exit 0, once its stdin closes (`--until-stdin-ends`, how the app stops it on Windows).
 *
 *   bun apps/desktop/scripts/server-smoke.ts <runner binary> <native folder>
 *
 * Run by the Desktop workflow on Windows and Linux. The bench (bench.ts) starts its server the same way.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The variables `Launch::command` keeps (the Unix ones and `WINDOWS_ENV`). */
const KEPT = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "TEMP",
  "TMP",
];

const ANSWER_MS = 180_000;
const STOP_MS = 40_000;

/** The last lines of the server's log in `data`, or nothing. */
export function serverLog(data: string): string {
  const log = join(data, "logs", "server.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-40).join("\n") : "";
}

/**
 * The server on `data`, started as the app starts it, once it answers health at the address its own `server.json`
 * names. Closing its stdin stops it (`stopServer`). Throws, the server ended, when it stops or doesn't answer within
 * 3 minutes.
 */
export async function startServer(runner: string, native: string, data: string) {
  const env: Record<string, string> = { BUN_BE_BUN: "1" };
  for (const key of KEPT) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const server = Bun.spawn([runner, join(native, "server", "native.js"), "--until-stdin-ends", "--data", data], {
    env,
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  const started = Date.now();
  for (;;) {
    if (server.exitCode !== null) throw new Error(`it stopped before it answered (exit ${server.exitCode})`);
    if (Date.now() - started > ANSWER_MS) {
      server.kill();
      throw new Error("it didn't answer within 3 minutes");
    }
    try {
      const ready = JSON.parse(readFileSync(join(data, "server.json"), "utf8")) as { pid?: number; url?: string };
      if (ready.pid === server.pid && ready.url && (await fetch(`${ready.url}/api/health`)).ok) {
        return { server, url: ready.url, seconds: Math.round((Date.now() - started) / 1000) };
      }
    } catch {
      // not written yet, or not listening yet
    }
    await Bun.sleep(500);
  }
}

/** Closes the server's stdin and waits for it to stop: its exit code, or null when it didn't within 40 s (ended then). */
export async function stopServer(server: Awaited<ReturnType<typeof startServer>>["server"]) {
  server.stdin.end();
  // Unref'd: once the server stopped, the limit never holds its caller open.
  const limit = new Promise<null>((done) => setTimeout(done, STOP_MS, null).unref());
  const code = await Promise.race([server.exited, limit]);
  if (code === null) server.kill();
  return code;
}

if (import.meta.main) {
  const [runner, native] = process.argv.slice(2);
  if (!runner || !native) {
    console.error("usage: bun apps/desktop/scripts/server-smoke.ts <runner binary> <native folder>");
    process.exit(2);
  }
  const data = mkdtempSync(join(tmpdir(), "agentes-smoke-"));
  const fail = (message: string): never => {
    console.error(`server smoke: ${message}`);
    console.error(serverLog(data));
    process.exit(1);
  };
  const { server, url, seconds } = await startServer(runner, native, data).catch((e: Error) => fail(e.message));
  console.log(`server smoke: answered at ${url} in ${seconds} s`);
  const code = await stopServer(server);
  if (code === null) fail(`it didn't stop within ${STOP_MS / 1000} s of its stdin closing`);
  if (code !== 0) fail(`it stopped with exit ${code}`);
  if (existsSync(join(data, "server.json"))) fail("it left server.json behind");
  console.log("server smoke: stopped when its stdin closed");
  rmSync(data, { recursive: true, force: true });
}
