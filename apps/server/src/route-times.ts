import { percentile } from "@agenteschat/engine";
import type { Context, Next } from "hono";
import { routeOf } from "./http/errors";

/** One route's requests in this process since the last `takeRouteTimes`, in ms. */
export interface RouteTime {
  route: string;
  count: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

/** Durations kept per route between takes: past it each new one replaces a random kept one, so the p95 stays fair. */
const SAMPLES = 512;
/** Routes `takeRouteTimes` returns: those that took the most time. */
export const ROUTES_KEPT = 20;

const times = new Map<string, { count: number; totalMs: number; maxMs: number; samples: number[] }>();

/** Times every API request by the route it matched (`GET /api/app/organizations/:orgId/agent-status`), ids left out. */
export async function timeRoutes(c: Context, next: Next) {
  const started = performance.now();
  try {
    await next();
  } finally {
    const ms = performance.now() - started;
    const route = `${c.req.method} ${routeOf(c)}`;
    const t = times.get(route) ?? { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    times.set(route, t);
    t.count++;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    if (t.samples.length < SAMPLES) t.samples.push(ms);
    else {
      const i = Math.floor(Math.random() * t.count);
      if (i < SAMPLES) t.samples[i] = ms;
    }
  }
}

/** The routes that took the most time since the last call, the most first, and a fresh start for the next. */
export function takeRouteTimes(kept = ROUTES_KEPT): RouteTime[] {
  const taken = [...times].map(([route, t]) => ({
    route,
    count: t.count,
    p95Ms: Math.round(percentile(t.samples, 0.95)),
    maxMs: Math.round(t.maxMs),
    totalMs: Math.round(t.totalMs),
  }));
  times.clear();
  return taken.sort((a, b) => b.totalMs - a.totalMs).slice(0, kept);
}
