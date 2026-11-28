import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MachineLoadRecord } from "./machines";
import { organizations } from "./tenancy";

/**
 * The usage report's state for the whole installation (ADR 0060 §5): one row, made at the server's
 * first start. Not a tenant's, so no `org_id`.
 */
export const instanceTelemetry = pgTable(
  "instance_telemetry",
  {
    id: integer().primaryKey().default(1),
    /** Random, made once: the only id the report carries. */
    instanceId: uuid().notNull().defaultRandom(),
    /** The installation owner's switch in Settings; `TELEMETRY=off` wins over it. */
    enabled: boolean().notNull().default(true),
    /** When the server last started (the report's uptime). */
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** How busy the server's host got over the last day, as its last sample left it. */
    hostLoad: jsonb().$type<MachineLoadRecord>(),
    /** The last day's samples behind `hostLoad` (epoch ms), so a restarted server keeps its day. */
    hostSamples: jsonb().$type<{ at: number; load: number; memory: number }[]>(),
    /** When the next report is due; kept so a restart neither delays it nor sends it twice in a day. */
    nextReportAt: timestamp({ withTimezone: true }),
    /**
     * Who has the installation's own settings (this switch, the Jev key, ADR 0073): its first account, pinned so
     * the next oldest never inherits them. No foreign key: a deleted owner's id keeps matching nobody.
     */
    ownerUserId: text(),
    /**
     * Whether the router may pick who answers on a person's own Claude or ChatGPT plan (`router-plan.ts`): true only
     * on installations that already had a workspace when it became opt-in (migration 0304), false on new ones.
     */
    routerPlanFallback: boolean().notNull().default(false),
    /**
     * The apps' speed reports since the last usage report (`client-vitals.ts`), kept so a restart keeps them: the
     * report sends their daily summary.
     */
    clientVitals: jsonb().$type<ClientVitalsDay>(),
  },
  (t) => [check("instance_telemetry_one_row", sql`${t.id} = 1`)],
);

/**
 * Each server process's own vitals (the app's and every worker's), written by the process about once a minute and
 * read by the operator API (`GET /vitals`): one row per process start. Rows a process stopped writing a day ago go.
 * The installation's own, so no `org_id`.
 */
export const serverProcesses = pgTable("server_processes", {
  /** Made at the process's start. */
  id: uuid().primaryKey(),
  /** `SERVER_ROLE`: `all` or `worker`. */
  role: text().notNull(),
  version: text().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  seenAt: timestamp({ withTimezone: true }).notNull(),
  rssBytes: bigint({ mode: "number" }).notNull(),
  heapUsedBytes: bigint({ mode: "number" }).notNull(),
  heapTotalBytes: bigint({ mode: "number" }).notNull(),
  /** The event loop's delay over its last minute (`event-loop-lag.ts`); null before its first minute ended. */
  eventLoopP99Ms: real(),
  eventLoopMaxMs: real(),
  /** When it wrote its heap snapshot (`HEAP_SNAPSHOT_MB`), and the file's name; null: none. */
  heapSnapshotAt: timestamp({ withTimezone: true }),
  heapSnapshotFile: text(),
  /**
   * The HTTP routes that took it the most time over its last minute (`route-times.ts`), each with its count, p95,
   * slowest and total in ms; null: a worker, which serves none, or a row from before.
   */
  routes: jsonb().$type<{ route: string; count: number; p95Ms: number; maxMs: number; totalMs: number }[]>(),
  /** What the apps that reported to this process over its last minute measured (`client-vitals.ts`); null: none did. */
  clientVitals: jsonb().$type<ClientVitalsSummary>(),
});

/**
 * Work a server process does for the whole database rather than for itself: a one-off left from an upgrade, recorded
 * once it finished so it runs once per database; a daily sweep, whose row says when one process last took its turn.
 * The installation's own, so no `org_id`.
 */
export const serverTasks = pgTable("server_tasks", {
  /** `once:<name>` or `sweep:<name>`. */
  name: text().primaryKey(),
  /** When the one-off finished, or the sweep last started. */
  ranAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * Every open app connection of every server process (`createPostgresPresence`), so "who has the app open" is the same
 * answer from each: the online dots, and the pushes held back from whoever is looking. Each process renews its own
 * rows' `seen_at` every half minute; a row it stopped renewing (the process died) stops counting after 90 s and goes.
 */
export const presenceConnections = pgTable(
  "presence_connections",
  {
    connectionId: text().primaryKey(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    processId: uuid().notNull(),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("presence_connections_org_idx").on(t.orgId, t.userId), index().on(t.processId)],
);

/**
 * Our endpoints' rate limits counted across every server process (`createPostgresRateLimiter`): a fixed window per
 * key, so a limit stays the limit however many processes answer. Rows past their window are swept. The installation's
 * own, like the limits themselves, so no `org_id`.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  resetAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * Where an app runs: the phone apps, a browser, and the desktop app on each system, kept apart so one system's web view
 * (WebView2, WebKit, WebKitGTK) is never averaged with another's.
 */
export const CLIENT_PLATFORMS = ["ios", "android", "web", "macos", "windows", "linux"] as const;

/** What an app measures in its speed report (`POST /api/app/client-vitals`). */
export const CLIENT_VITAL_MEASURES = [
  "coldStartMs",
  "firstRowsMs",
  "jsLagP95Ms",
  "jsLagMaxMs",
  "heapBytes",
  "webviewBytes",
  "getsPerReturn",
  "reconnects",
] as const;
export type ClientVitalMeasure = (typeof CLIENT_VITAL_MEASURES)[number];

/** One measure across the apps' reports of a minute: how many, the median, the 95th percentile and the worst. */
export interface ClientVitalStat {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * The apps' reports to one process over a minute, by platform (`ios`, `android`, `web`, and the desktop app's `macos`,
 * `windows`, `linux`): how long a cold start took to the first screen and to the first rows, how late the JavaScript
 * thread ran, the heap, the desktop's web view memory, the reads (GETs) after each return to the app, and the socket's
 * reconnects.
 */
export type ClientVitalsSummary = Record<
  string,
  { reports: number } & Partial<Record<ClientVitalMeasure, ClientVitalStat>>
>;

/**
 * The apps' reports since the last usage report, by platform: how many, and per measure how many values came and a
 * uniform sample of them (a few hundred at most, `client-vitals.ts`), for the report's median and 95th percentile.
 */
export type ClientVitalsDay = Record<
  string,
  { reports: number; values: Partial<Record<ClientVitalMeasure, { n: number; sample: number[] }>> }
>;
