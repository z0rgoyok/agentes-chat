import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type { Database, schema } from "@agenteschat/db";
import { recordProcessVitals } from "@agenteschat/engine";
import type { EventLoopLag } from "./event-loop-lag";
import type { Logger } from "./logger";
import type { RouteTime } from "./route-times";

export const PROCESS_VITALS_EVERY_MS = 60_000;
/**
 * Snapshots already in the folder past which no process writes another: each is about the heap's size, and every
 * restart of a leaking process (and each process of a split deployment) would add one until the disk is full.
 */
export const HEAP_SNAPSHOTS_KEPT = 3;

const snapshotsIn = (dir: string) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".heapsnapshot")).length;
  } catch {
    return 0;
  }
};

export interface ProcessHealthDeps {
  db: Database;
  log: Pick<Logger, "info" | "warn" | "error">;
  role: string;
  version: string;
  eventLoopLag: () => EventLoopLag | null;
  /** The apps' reports of the minute (`client-vitals.ts`), taken at each write. */
  clientVitals?: () => schema.ClientVitalsSummary | null;
  /** `HEAP_SNAPSHOT_MB`: past this heap, one snapshot; absent: never. */
  heapSnapshotMb?: number;
  heapSnapshotDir?: string;
  memoryUsage?: () => NodeJS.MemoryUsage;
  writeSnapshot?: (path: string) => string;
  /** The routes that took the most time since the last tick (`takeRouteTimes`); absent: a process that serves none. */
  routeTimes?: () => RouteTime[];
}

/**
 * Writes this process's memory, event loop delay and slowest routes to `server_processes` once a minute, for the
 * operator's `GET /vitals`, and its one heap snapshot once its heap passes `HEAP_SNAPSHOT_MB`. Returns a tick (tests)
 * and a stop.
 */
export function watchProcessHealth(deps: ProcessHealthDeps, everyMs = PROCESS_VITALS_EVERY_MS) {
  const id = crypto.randomUUID();
  const startedAt = new Date();
  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage());
  const writeSnapshot = deps.writeSnapshot ?? writeHeapSnapshot;
  let snapshot: { at: Date; file: string } | null = null;
  let snapshotTried = false;

  const tick = async () => {
    const memory = memoryUsage();
    const limit = deps.heapSnapshotMb;
    if (limit && !snapshotTried && memory.heapUsed > limit * 1024 * 1024) {
      // Once per process start, failed or not: a second one would pause the process again for what the first showed.
      snapshotTried = true;
      const dir = deps.heapSnapshotDir ?? tmpdir();
      const file = `heap-${deps.role}-${startedAt.toISOString().replace(/[:.]/g, "-")}-${process.pid}.heapsnapshot`;
      const path = join(dir, file);
      if (snapshotsIn(dir) >= HEAP_SNAPSHOTS_KEPT) {
        deps.log.warn("heap past HEAP_SNAPSHOT_MB, but no snapshot written: remove the ones in the folder first", {
          heapUsed: memory.heapUsed,
          dir,
          kept: HEAP_SNAPSHOTS_KEPT,
        });
      } else {
        deps.log.warn("heap past HEAP_SNAPSHOT_MB: writing a heap snapshot", { heapUsed: memory.heapUsed, path });
        // The snapshot holds everything in memory in clear (decrypted keys, sessions, messages): readable by this
        // user alone. Synchronous, so nothing else in the process runs under this umask.
        const umask = process.umask(0o077);
        try {
          writeSnapshot(path);
          snapshot = { at: new Date(), file };
          deps.log.warn("heap snapshot written", { path });
        } catch (error) {
          // A disk that filled midway leaves a partial file that would only take more room.
          rmSync(path, { force: true });
          deps.log.error("heap snapshot failed", { path, error });
        } finally {
          process.umask(umask);
        }
      }
    }
    const lag = deps.eventLoopLag();
    await recordProcessVitals(deps.db, {
      id,
      role: deps.role,
      version: deps.version,
      startedAt,
      seenAt: new Date(),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      eventLoopP99Ms: lag?.p99Ms ?? null,
      eventLoopMaxMs: lag?.maxMs ?? null,
      heapSnapshotAt: snapshot?.at ?? null,
      heapSnapshotFile: snapshot?.file ?? null,
      routes: deps.routeTimes?.() ?? null,
      clientVitals: deps.clientVitals?.() ?? null,
    });
  };
  const run = () =>
    void tick().catch((error: unknown) => deps.log.warn("process vitals not recorded", { error: String(error) }));
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return { id, tick, stop: () => clearInterval(timer) };
}
