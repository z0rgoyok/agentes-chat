import type { schema } from "@agenteschat/db";
import { z } from "@hono/zod-openapi";

type ClientVitalStat = schema.ClientVitalStat;
type ClientVitalsSummary = schema.ClientVitalsSummary;

const ms = z.number().min(0).max(600_000);
const count = z.number().int().min(0).max(100_000);

/** An app's report (`POST /api/app/client-vitals`): what it measured since its last one, all optional. */
export const ClientVitalsReport = z
  .object({
    platform: z.enum(["ios", "android", "web"]),
    coldStartMs: ms.optional().openapi({ description: "From the app's start to its first frame." }),
    firstRowsMs: ms.optional().openapi({ description: "From the app's start to its first list drawn with rows." }),
    jsLagP95Ms: ms
      .optional()
      .openapi({ description: "How late its JavaScript thread ran what was due, 95th percentile." }),
    jsLagMaxMs: ms.optional(),
    heapBytes: z.number().int().min(0).max(1e11).optional(),
    getsPerReturn: count
      .optional()
      .openapi({ description: "Reads (GETs) in the 10 s after it came back to the front." }),
    reconnects: count.optional().openapi({ description: "Its realtime socket's reconnects since the last report." }),
  })
  .openapi("ClientVitalsReport");

export type ClientVitalsReport = z.infer<typeof ClientVitalsReport>;

type Measure = Exclude<keyof ClientVitalsReport, "platform">;
const MEASURES: Measure[] = [
  "coldStartMs",
  "firstRowsMs",
  "jsLagP95Ms",
  "jsLagMaxMs",
  "heapBytes",
  "getsPerReturn",
  "reconnects",
];
/** Values kept per measure and platform until the next minute's summary: enough for a percentile, bounded. */
const KEPT = 2000;

const stat = (values: number[]): ClientVitalStat => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number };
};

/**
 * The apps' reports to this process, summed up once a minute into its vitals (`watchProcessHealth`): numbers only,
 * nobody's id, kept in memory until then.
 */
export function createClientVitals() {
  let byPlatform = new Map<string, { reports: number; values: Partial<Record<Measure, number[]>> }>();
  return {
    add(report: ClientVitalsReport) {
      let bucket = byPlatform.get(report.platform);
      if (!bucket) {
        bucket = { reports: 0, values: {} };
        byPlatform.set(report.platform, bucket);
      }
      bucket.reports++;
      for (const measure of MEASURES) {
        const value = report[measure];
        if (value === undefined) continue;
        const values = bucket.values[measure] ?? [];
        bucket.values[measure] = values;
        if (values.length < KEPT) values.push(value);
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
  };
}

/** This process's: the route adds, the vitals take (`watchProcessHealth`). */
export const clientVitals = createClientVitals();
