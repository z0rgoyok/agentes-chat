import { schema } from "@agenteschat/db";
import { z } from "@hono/zod-openapi";

type ClientVitalStat = schema.ClientVitalStat;
type ClientVitalsSummary = schema.ClientVitalsSummary;
type ClientVitalsDay = schema.ClientVitalsDay;

const ms = z.number().min(0).max(600_000);
const count = z.number().int().min(0).max(100_000);

/** An app's report (`POST /api/app/client-vitals`): what it measured since its last one, all optional. */
export const ClientVitalsReport = z
  .object({
    platform: z.enum(schema.CLIENT_PLATFORMS),
    coldStartMs: ms.optional().openapi({
      description:
        "From the app's start to its first screen: a phone's to its splash leaving, a browser's page from its navigation, the desktop app from its process's start to the site's first screen painted.",
    }),
    firstRowsMs: ms.optional().openapi({ description: "From the app's start to its first list drawn with rows." }),
    jsLagP95Ms: ms
      .optional()
      .openapi({ description: "How late its JavaScript thread ran what was due, 95th percentile." }),
    jsLagMaxMs: ms.optional(),
    heapBytes: z.number().int().min(0).max(1e11).optional(),
    webviewBytes: z.number().int().min(0).max(1e11).optional().openapi({
      description:
        "The desktop app's: the memory of the processes behind its main window's web view (macOS: its web content process's footprint; Windows: WebView2's processes; Linux: WebKitGTK's web processes).",
    }),
    getsPerReturn: count
      .optional()
      .openapi({ description: "Reads (GETs) in the 10 s after it came back to the front." }),
    reconnects: count.optional().openapi({ description: "Its realtime socket's reconnects since the last report." }),
  })
  .openapi("ClientVitalsReport");

export type ClientVitalsReport = z.infer<typeof ClientVitalsReport>;

type Measure = schema.ClientVitalMeasure;
const MEASURES = schema.CLIENT_VITAL_MEASURES;
/** Values kept per measure and platform until the next minute's summary: enough for a percentile, bounded. */
const KEPT = 2000;
/** Values a day's sample keeps per measure and platform: enough for its median and 95th percentile, a small row. */
export const DAY_KEPT = 200;

const stat = (values: number[]): ClientVitalStat => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number };
};

/**
 * The apps' reports to this process, numbers only and nobody's id: summed up once a minute into its vitals
 * (`watchProcessHealth`), and sampled over the usage report's day for its summary (`instance_telemetry.client_vitals`,
 * kept in the row by `startTelemetry`).
 */
export function createClientVitals(random = Math.random) {
  let byPlatform = new Map<string, { reports: number; values: Partial<Record<Measure, number[]>> }>();
  let day: ClientVitalsDay = {};
  let dayChanged = false;
  return {
    add(report: ClientVitalsReport) {
      let bucket = byPlatform.get(report.platform);
      if (!bucket) {
        bucket = { reports: 0, values: {} };
        byPlatform.set(report.platform, bucket);
      }
      bucket.reports++;
      const today = day[report.platform] ?? { reports: 0, values: {} };
      day[report.platform] = today;
      today.reports++;
      dayChanged = true;
      for (const measure of MEASURES) {
        const value = report[measure];
        if (value === undefined) continue;
        const values = bucket.values[measure] ?? [];
        bucket.values[measure] = values;
        if (values.length < KEPT) values.push(value);
        // Reservoir sampling: every value of the day has the same chance to be in the sample, however many came.
        const kept = today.values[measure] ?? { n: 0, sample: [] };
        today.values[measure] = kept;
        kept.n++;
        if (kept.sample.length < DAY_KEPT) kept.sample.push(value);
        else {
          const at = Math.floor(random() * kept.n);
          if (at < DAY_KEPT) kept.sample[at] = value;
        }
      }
    },
    /** The minute's summary, and a fresh minute; null when no app reported. */
    take(): ClientVitalsSummary | null {
      if (byPlatform.size === 0) return null;
      const summary: ClientVitalsSummary = {};
      for (const [platform, { reports, values }] of byPlatform) {
        summary[platform] = { reports };
        for (const measure of MEASURES) {
          const list = values[measure];
          if (list?.length) summary[platform][measure] = stat(list);
        }
      }
      byPlatform = new Map();
      return summary;
    },
    /** The day so far, for its row, when it changed since the last call; null when it didn't. */
    dayToSave(): ClientVitalsDay | null {
      if (!dayChanged) return null;
      dayChanged = false;
      return day;
    },
    /** A restarted process goes on with the day its row kept (unless reports came in first). */
    restoreDay(saved: ClientVitalsDay | null | undefined) {
      if (saved && Object.keys(day).length === 0) day = saved;
    },
    /** The usage report went, or came due while off: the next day starts empty. */
    newDay() {
      day = {};
      dayChanged = true;
    },
  };
}

/** This process's: the route adds, the vitals take (`watchProcessHealth`). */
export const clientVitals = createClientVitals();
