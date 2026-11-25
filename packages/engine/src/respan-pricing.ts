import { readFileSync, statSync } from "node:fs";
import type { ModelInfo, TokenPrices } from "@agenteschat/providers";
import { z } from "zod";

// The operator installs a verified /v1/models snapshot. A workspace endpoint
// cannot assign prices to other credentials or to the computer's plan.
const rate = z.number().finite().nonnegative().max(10_000);
const prices = z.object({ input: rate, output: rate, cached_input: rate.optional(), cache_write: rate.optional() });
const date = z.iso.date();
const card = z.object({
  pricing: prices,
  rate_card: z.object({
    source: z.url(),
    verified_on: date,
    long_context: z.object({ above_input_tokens: z.int().positive(), pricing: prices }).optional(),
    off_peak: z
      .object({
        holidays: z.array(date),
        peak_hours_utc: z.array(z.tuple([z.int().min(0).max(23), z.int().min(1).max(24)])),
        pricing: prices,
      })
      .optional(),
    next: z.object({ from: date, pricing: prices }).optional(),
  }),
});
const catalog = z.object({
  endpoints: z.record(z.uuid(), z.url()),
  data: z.array(
    z.object({
      id: z.string(),
      route: z.object({ to: z.array(z.string()).min(1), pricing_by_target: z.record(z.string(), card) }),
    }),
  ),
});
type Catalog = z.infer<typeof catalog>;
let loaded: { path: string; version: string; catalog: Catalog } | undefined;
function operatorCatalog() {
  const path = process.env.RESPAN_PRICE_CATALOG;
  if (!path) return;
  const file = statSync(path, { bigint: true });
  const version = file.ino + ":" + file.mtimeNs;
  if (!loaded || loaded.path !== path || loaded.version !== version) {
    loaded = { path, version, catalog: catalog.parse(JSON.parse(readFileSync(path, "utf8"))) };
  }
  return loaded.catalog;
}

export const respanEndpoint = (credential: string, url: string) => operatorCatalog()?.endpoints[credential] === url;
export const usesRespanPricing = () => Boolean(process.env.RESPAN_PRICE_CATALOG);

const nano = (n: number) => Math.round(n * 1000);
function tokenPrices(p: z.infer<typeof prices>): TokenPrices {
  return {
    input: nano(p.input),
    output: nano(p.output),
    cacheRead: nano(p.cached_input ?? p.input),
    cacheWrite: nano(p.cache_write ?? p.input),
  };
}

/** Primary route rates for estimates and reservations. The receipt settles the actual upstream. */
export function respanPrimary(model: string) {
  const row = operatorCatalog()?.data.find((m) => m.id === model);
  const primary = row?.route.to[0];
  return primary ? row?.route.pricing_by_target[primary] : undefined;
}

export function respanRates(
  model: string,
  at = new Date(),
): Pick<ModelInfo, "prices" | "longContext" | "offPeak"> | undefined {
  const item = respanPrimary(model);
  if (!item) return;
  const { long_context: long, off_peak: off, next } = item.rate_card;
  return {
    prices: tokenPrices(next && at.toISOString().slice(0, 10) >= next.from ? next.pricing : item.pricing),
    ...(long ? { longContext: { aboveInputTokens: long.above_input_tokens, prices: tokenPrices(long.pricing) } } : {}),
    ...(off
      ? { offPeak: { prices: tokenPrices(off.pricing), peakHoursUtc: off.peak_hours_utc, holidays: off.holidays } }
      : {}),
  };
}
