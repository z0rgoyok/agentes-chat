import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MACHINE_PROTOCOL_VERSION,
  OWN_USAGE_ID,
  PLAN_USAGE_PROTOCOL,
  type PlanUsage,
  parsePlanUsage,
  parseRunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { planState } from "@agenteschat/ui/plan-state";
import { AccountManager, type AccountManagerOptions } from "../../runner/accounts";
import {
  antigravityUsage,
  CLAUDE_PROBE_ARGS,
  CLAUDE_TOKEN_CHECK_ARGS,
  checkClaudeToken,
  claudeUsage,
  codexUsage,
  fetchPlanKeyUsage,
  oldestRead,
  probeClaudeUsage,
  probeCodexUsage,
  usageCrossed,
  withRateLimit,
} from "../../runner/plan-usage";
import { removeDirs, tempDir, waitFor } from "./helpers";

/**
 * Plan usage (protocol 19): what Claude Code's turns and `get_usage` say,
 * Codex's rate limits, the coding plans' endpoints, and the manager that keeps
 * it (probes at most every few minutes, two at a time, backing off on 429; the
 * turns' news throttled unless a limit line is crossed).
 */

const posix = process.platform !== "win32";
const FAKE_CLAUDE = path.join(import.meta.dir, "fake-claude.mjs");
const FAKE_CODEX = path.join(import.meta.dir, "fake-codex-app.mjs");
const ACCOUNT = "0193eeee-0000-7000-8000-000000000001";
const OTHER = "0193eeee-0000-7000-8000-000000000002";
const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const RESET = 1900000000;

const dirs: string[] = [];
const managers: AccountManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  for (const k of ["FAKE_CLAUDE_USAGE", "FAKE_CLAUDE_LOG", "FAKE_CODEX_LOG"]) delete process.env[k];
  removeDirs(dirs);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const logged = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// ── What the CLIs and providers say ──────────────────────────────────────────

test("a turn's rate_limit_event: its window replaced (a fraction ×100), the limit as its status says", () => {
  const at = new Date(NOW).toISOString();
  const first = withRateLimit(
    undefined,
    { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.84, resetsAt: RESET },
    NOW,
  );
  expect(first).toEqual({
    windows: [{ kind: "five_hour", usedPercent: 84, resetsAt: new Date(RESET * 1000).toISOString() }],
    source: "turn",
    at,
  });
  // Another window joins, full (a fraction of 1); the limit hit.
  const week = withRateLimit(
    first ?? undefined,
    { status: "rejected", rateLimitType: "seven_day", utilization: 1 },
    NOW,
  );
  expect(week?.windows.map((w) => [w.kind, w.usedPercent])).toEqual([
    ["five_hour", 84],
    ["seven_day", 100],
  ]);
  expect(week?.limited).toBe(true);
  // Allowed again (no window said): the limit clears, the windows stay.
  const again = withRateLimit(week ?? undefined, { status: "allowed" }, NOW);
  expect(again?.limited).toBeUndefined();
  expect(again?.windows).toHaveLength(2);
  // Nothing new: nothing to store.
  expect(withRateLimit(again ?? undefined, { status: "allowed_warning" }, NOW)).toBeNull();
  expect(withRateLimit(undefined, "garbage", NOW)).toBeNull();
  // Refused with no utilization: that window is full; the overage window and the weekly one that includes it.
  expect(
    withRateLimit(undefined, { status: "rejected", rateLimitType: "five_hour" }, NOW)?.windows[0]?.usedPercent,
  ).toBe(100);
  expect(
    withRateLimit(undefined, { status: "allowed", rateLimitType: "overage", utilization: 0.3 }, NOW)?.windows,
  ).toEqual([{ kind: "other", label: "Extra usage", usedPercent: 30 }]);
  // Every utilization is a fraction: 1% is 0.01, and past the limit (1.2) is full, never 1%.
  const used = (utilization: number) =>
    withRateLimit(undefined, { status: "allowed", rateLimitType: "five_hour", utilization }, NOW)?.windows[0]
      ?.usedPercent;
  expect([used(0.01), used(1), used(1.2), used(0)]).toEqual([1, 100, 100, 0]);
  expect(
    withRateLimit(undefined, { status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.5 }, NOW)
      ?.windows[0]?.kind,
  ).toBe("seven_day");
});

test("a turn's rate_limit_event below every warning: each window's reading (unifiedWindows), as Codex's turns tell", () => {
  const WEEK = RESET + 500_000;
  // As Claude Code 2.1.316 sends it under its warnings, on a `claude setup-token` sign-in too.
  const quiet = {
    status: "allowed",
    resetsAt: RESET,
    rateLimitType: "five_hour",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.12, resetsAt: RESET, status: "allowed" },
      seven_day: { utilization: 0.31, resetsAt: WEEK },
      seven_day_overage_included: { utilization: 0.4, resetsAt: WEEK },
    },
  };
  const known = {
    windows: [
      { kind: "seven_day", usedPercent: 20 },
      { kind: "other", label: "Fable", usedPercent: 7 },
    ],
    source: "probe",
    at: new Date(NOW).toISOString(),
  } satisfies PlanUsage;
  expect(withRateLimit(known, quiet, NOW)).toEqual({
    windows: [
      // What only a probe tells stays; the week counts as itself, never as its overage-included twin.
      { kind: "other", label: "Fable", usedPercent: 7 },
      { kind: "five_hour", usedPercent: 12, resetsAt: new Date(RESET * 1000).toISOString() },
      { kind: "seven_day", usedPercent: 31, resetsAt: new Date(WEEK * 1000).toISOString() },
    ],
    source: "turn",
    at: new Date(NOW).toISOString(),
  });
  // A reading that isn't a number is no window.
  expect(withRateLimit(undefined, { status: "allowed", unifiedWindows: { five_hour: { resetsAt: RESET } } }, NOW)).toBe(
    null,
  );
});

test("a window a turn's event didn't name keeps the time it was read: a fresh 5 hours never makes an old week fresh", () => {
  const H = 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const five = (u: number) => ({ five_hour: { utilization: u, resetsAt: RESET } });
  const first = withRateLimit(
    undefined,
    {
      status: "allowed",
      unifiedWindows: { ...five(0.1), seven_day: { utilization: 0.73, resetsAt: RESET + 500_000 } },
    },
    NOW,
  );
  const later = withRateLimit(first ?? undefined, { status: "allowed", unifiedWindows: five(0.2) }, NOW + 7 * H);
  expect(later?.at).toBe(iso(NOW + 7 * H));
  expect(later?.windows.find((w) => w.kind === "five_hour")?.at).toBeUndefined();
  expect(later?.windows.find((w) => w.kind === "seven_day")).toMatchObject({ usedPercent: 73, at: iso(NOW) });
  // Carried again: still its own first time, not the last event's.
  const again = withRateLimit(later ?? undefined, { status: "rejected", rateLimitType: "five_hour" }, NOW + 8 * H);
  expect(again?.windows.find((w) => w.kind === "seven_day")?.at).toBe(iso(NOW));
  // Read again: fresh, no time of its own.
  const read = withRateLimit(
    again ?? undefined,
    { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.03, resetsAt: RESET + 900_000 } } },
    NOW + 9 * H,
  );
  expect(read?.windows.find((w) => w.kind === "seven_day")).toEqual({
    kind: "seven_day",
    usedPercent: 3,
    resetsAt: new Date((RESET + 900_000) * 1000).toISOString(),
  });
  // Known as of its oldest window (how often the runner may read it again).
  expect(oldestRead(later ?? undefined)).toBe(NOW);
  expect(oldestRead(read ?? undefined)).toBe(NOW + 8 * H);
  expect(oldestRead(undefined)).toBe(0);
  // On the wire a window's own time is kept only when it is older than its reading.
  const wire = parsePlanUsage({
    windows: [
      { kind: "seven_day", usedPercent: 73, at: iso(NOW) },
      { kind: "five_hour", usedPercent: 5, at: iso(NOW + 9 * H) },
      { kind: "seven_day_opus", usedPercent: 5, at: "garbage" },
    ],
    source: "turn",
    at: iso(NOW + H),
  });
  expect(wire?.windows.map((w) => w.at)).toEqual([iso(NOW), undefined, undefined]);
});

test("get_usage: each window 0–100 with its reset, per-model and extra usage as named windows; no plan limits → null", () => {
  const usage = claudeUsage(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.4, resets_at: "2030-01-01T15:40:00Z" },
        seven_day: { utilization: 81.6, resets_at: "2030-01-04T10:00:00Z" },
        seven_day_opus: null,
        seven_day_oauth_apps: { utilization: 3, resets_at: null },
        model_scoped: [
          { display_name: "  Fable  ", utilization: 5, resets_at: null },
          { display_name: "", utilization: 9 },
        ],
        extra_usage: { is_enabled: true, utilization: 140, monthly_limit: 5000, used_credits: 7000 },
      },
    },
    NOW,
  );
  expect(usage).toEqual({
    windows: [
      { kind: "five_hour", usedPercent: 42, resetsAt: "2030-01-01T15:40:00.000Z" },
      { kind: "seven_day", usedPercent: 82, resetsAt: "2030-01-04T10:00:00.000Z" },
      { kind: "other", label: "OAuth apps", usedPercent: 3 },
      { kind: "other", label: "Fable", usedPercent: 5 },
      { kind: "other", label: "Extra usage", usedPercent: 100 },
    ],
    source: "probe",
    at: new Date(NOW).toISOString(),
  });
  // The server takes it as it is.
  expect(parsePlanUsage(usage)).toEqual(usage as PlanUsage);
  expect(claudeUsage({ rate_limits_available: false, rate_limits: null }, NOW)).toBeNull();
  expect(claudeUsage({ rate_limits_available: true, rate_limits: { five_hour: null } }, NOW)).toBeNull();
  expect(claudeUsage(null, NOW)).toBeNull();
});

test("Codex's rate limits: windows told apart by their length, else primary is the 5 hours and secondary the week", () => {
  expect(
    codexUsage(
      {
        primary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: RESET },
        secondary: { usedPercent: 12.2, windowDurationMins: 299, resetsAt: RESET },
      },
      "probe",
      NOW,
    )?.windows,
  ).toEqual([
    { kind: "seven_day", usedPercent: 55, resetsAt: new Date(RESET * 1000).toISOString() },
    { kind: "five_hour", usedPercent: 12, resetsAt: new Date(RESET * 1000).toISOString() },
  ]);
  expect(codexUsage({ primary: { usedPercent: 7 }, secondary: { usedPercent: 140 } }, "turn", NOW)?.windows).toEqual([
    { kind: "five_hour", usedPercent: 7 },
    { kind: "seven_day", usedPercent: 100 },
  ]);
  expect(codexUsage({ primary: null, secondary: null }, "turn", NOW)).toBeNull();
});

/** Google's usage panel for an Antigravity sign-in, line by line: every percentage is what is left. */
const agyPanel = (gemini: { week: number; five: number }, argon = 100, info = "", color = (s: string) => s) =>
  [
    color("Gemini Models"),
    `Weekly Limit Remaining${info}`,
    color(`${gemini.week}%`),
    `Five Hour Limit Remaining${info}`,
    color(`${gemini.five}%`),
    "",
    color(`Claude and GPT models${info}`),
    `Weekly Limit Remaining${info}`,
    color("100%"),
    `Five Hour Limit Remaining${info}`,
    color("100%"),
    "",
    color(`Gemini 4 Argon${info}`),
    `Gemini 4 Argon Weekly Limit${info}`,
    color(`${argon}%`),
  ].join("\n");
const ansi = (s: string) => `\u001b[1;36m${s}\u001b[0m`;

test("Antigravity's panel: every percentage is what is left; only Gemini's group is the plan's, the others are named", () => {
  for (const text of [agyPanel({ week: 100, five: 100 }), agyPanel({ week: 100, five: 100 }, 100, " ⓘ", ansi)]) {
    const usage = antigravityUsage(text, "probe", NOW);
    expect(usage?.windows).toEqual([
      { kind: "seven_day", usedPercent: 0 },
      { kind: "five_hour", usedPercent: 0 },
      { kind: "other", label: "Claude and GPT models · 7d", usedPercent: 0 },
      { kind: "other", label: "Claude and GPT models · 5h", usedPercent: 0 },
      { kind: "other", label: "Gemini 4 Argon · 7d", usedPercent: 0 },
    ]);
    expect(planState(usage as PlanUsage, NOW).state).toBe("ok");
  }
  // Gemini's week spent: the plan is at its limit.
  const spent = antigravityUsage(agyPanel({ week: 0, five: 100 }, 100, " ⓘ", ansi), "probe", NOW) as PlanUsage;
  expect(spent.windows[0]).toEqual({ kind: "seven_day", usedPercent: 100 });
  expect(planState(spent, NOW).state).toBe("limited");
  // Argon's own week spent: shown under its name, never the plan's limit.
  const argon = antigravityUsage(agyPanel({ week: 80, five: 100 }, 0), "probe", NOW) as PlanUsage;
  expect(argon.windows.at(-1)).toEqual({ kind: "other", label: "Gemini 4 Argon · 7d", usedPercent: 100 });
  expect(planState(argon, NOW)).toEqual({ state: "ok", until: null, used: 20 });
  // One line per limit, and a line that says "used" counts up.
  expect(
    antigravityUsage("Gemini Models\nWeekly Limit: 30% used\nFive Hour Limit Remaining 90%", "probe", NOW)?.windows,
  ).toEqual([
    { kind: "seven_day", usedPercent: 30 },
    { kind: "five_hour", usedPercent: 10 },
  ]);
});

test("Antigravity's rows: Gemini's group is the plan's wherever the CLI lists it, a row that says used counts up, an unstarted quota resets never", () => {
  // Another model group listed first: its spent five hours are its own, never the whole plan's.
  const report = [
    "Claude and GPT models\tWeekly Limit Remaining\t40%\t2030-01-05T10:00:00Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t0%\t2030-01-01T13:00:00Z",
    "Gemini Models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
    "Gemini Models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
    "",
  ].join("\n");
  const usage = antigravityUsage(report, "probe", NOW) as PlanUsage;
  expect(usage.windows).toEqual([
    { kind: "other", label: "Claude and GPT models · 7d", usedPercent: 60, resetsAt: "2030-01-05T10:00:00.000Z" },
    { kind: "other", label: "Claude and GPT models · 5h", usedPercent: 100, resetsAt: "2030-01-01T13:00:00.000Z" },
    { kind: "seven_day", usedPercent: 0 },
    { kind: "five_hour", usedPercent: 0 },
  ]);
  expect(planState(usage, NOW)).toEqual({ state: "ok", until: null, used: 0 });
  // A row whose quota says "used" is counted up, as the panel's lines are.
  expect(
    antigravityUsage("Gemini Models\tFive Hour Limit Used\t0%\t2030-01-01T13:00:00Z", "probe", NOW)?.windows,
  ).toEqual([{ kind: "five_hour", usedPercent: 0, resetsAt: "2030-01-01T13:00:00.000Z" }]);
});

test("people hear at once only when a limit is hit or cleared or a window crosses 80, 90 (its bar turns red) or 100", () => {
  const u = (used: number, limited?: boolean): PlanUsage => ({
    windows: [{ kind: "five_hour", usedPercent: used }],
    ...(limited ? { limited } : {}),
    source: "turn",
    at: "2030-01-01T00:00:00.000Z",
  });
  expect(usageCrossed(undefined, u(10))).toBe(true);
  expect(usageCrossed(u(10), u(40))).toBe(false);
  expect(usageCrossed(u(79), u(80))).toBe(true);
  expect(usageCrossed(u(85), u(89))).toBe(false);
  expect(usageCrossed(u(89), u(90))).toBe(true);
  expect(usageCrossed(u(91), u(99))).toBe(false);
  expect(usageCrossed(u(99), u(100))).toBe(true);
  expect(usageCrossed(u(100), u(100, true))).toBe(true);
});

test("on the wire: at most 8 known windows, 0–100, labels of 40 printable characters; the own sign-ins by brain", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(PLAN_USAGE_PROTOCOL);
  const windows = [
    { kind: "five_hour", usedPercent: 140.6, resetsAt: "2030-01-01T15:00:00Z" },
    { kind: "seven_day", usedPercent: -3, resetsAt: "not a date" },
    { kind: "other", label: `Fa\u0007ble ${"x".repeat(60)}`, usedPercent: 7 },
    { kind: "weekly", usedPercent: 1 },
    { kind: "monthly", usedPercent: Number.NaN },
    ...Array.from({ length: 10 }, () => ({ kind: "monthly", usedPercent: 1 })),
  ];
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "accounts.changed",
      accounts: [
        {
          id: ACCOUNT,
          kind: "claude_code",
          loggedIn: true,
          usage: { windows, source: "probe", at: "2030-01-01T10:00:00Z" },
        },
      ],
      ownUsage: { codex: { windows: [], at: "2030-01-01T10:00:00Z", limited: true }, opencode: { windows: [] } },
    }),
  );
  if (frame?.type !== "accounts.changed") throw new Error("not parsed");
  const usage = frame.accounts[0]?.usage;
  expect(usage?.windows.slice(0, 3)).toEqual([
    { kind: "five_hour", usedPercent: 100, resetsAt: "2030-01-01T15:00:00.000Z" },
    { kind: "seven_day", usedPercent: 0 },
    { kind: "other", label: `Fa ble ${"x".repeat(33)}`, usedPercent: 7 },
  ]);
  expect(usage?.windows.length).toBeLessThanOrEqual(8);
  expect(usage?.windows.every((w) => w.kind !== ("weekly" as never))).toBe(true);
  expect(usage?.source).toBe("probe");
  expect(frame.ownUsage).toEqual({
    codex: { windows: [], limited: true, source: "turn", at: "2030-01-01T10:00:00.000Z" },
  });
  // No time: no snapshot.
  expect(parsePlanUsage({ windows: [], source: "probe" })).toBeUndefined();
});

// ── The coding plans' endpoints ──────────────────────────────────────────────

/** A fetch that answers `body` (JSON) with `status` and keeps what it was asked. */
function scripted(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const KEY = "zk-test-1234567890abcdef";

test("coding plans: each provider's endpoint, the key only in Authorization, no redirects; 429 backs off, failures are null", async () => {
  const zai = scripted(200, {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1000, currentValue: 250, nextResetTime: 1893510000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 61 },
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, remaining: 90 },
      ],
    },
  });
  expect((await fetchPlanKeyUsage("zai", KEY, { fetch: zai.fetch, now: NOW })) as PlanUsage).toEqual({
    windows: [
      { kind: "five_hour", usedPercent: 25, resetsAt: new Date(1893510000000).toISOString() },
      { kind: "seven_day", usedPercent: 61 },
      { kind: "monthly", usedPercent: 10 },
    ],
    source: "probe",
    at: new Date(NOW).toISOString(),
  });
  const kimi = scripted(200, {
    usage: { limit: "100", used: "30", resetTime: "2030-01-05T00:00:00Z" },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 50, remaining: 5 } }],
  });
  expect(((await fetchPlanKeyUsage("kimi", KEY, { fetch: kimi.fetch, now: NOW })) as PlanUsage).windows).toEqual([
    { kind: "seven_day", usedPercent: 30, resetsAt: "2030-01-05T00:00:00.000Z" },
    { kind: "five_hour", usedPercent: 90 },
  ]);
  // A window that refuses requests is full, whatever its percent says.
  const opencode = scripted(200, {
    usage: {
      rolling: { status: "ok", percent: 4, resetsAt: "2030-01-01T14:00:00Z" },
      weekly: { status: "rate-limited", percent: 97 },
      monthly: { status: "ok", percent: 33 },
    },
  });
  expect(
    ((await fetchPlanKeyUsage("opencode", KEY, { fetch: opencode.fetch, now: NOW })) as PlanUsage).windows.map((w) => [
      w.kind,
      w.usedPercent,
    ]),
  ).toEqual([
    ["five_hour", 4],
    ["seven_day", 100],
    ["monthly", 33],
  ]);

  // Z.ai takes the raw key; the others a bearer. Never in the URL, and no redirect may carry it elsewhere.
  for (const [s, url, auth] of [
    [zai, "https://api.z.ai/api/monitor/usage/quota/limit", KEY],
    [kimi, "https://api.kimi.com/coding/v1/usages", `Bearer ${KEY}`],
    [opencode, "https://opencode.ai/zen/go/v1/usage", `Bearer ${KEY}`],
  ] as const) {
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe(url);
    expect(s.calls[0]?.url).not.toContain(KEY);
    expect((s.calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(auth);
    expect(s.calls[0]?.init?.body).toBeUndefined();
    expect(s.calls[0]?.init?.redirect).toBe("error");
  }

  expect(await fetchPlanKeyUsage("zai", KEY, { fetch: scripted(429, {}).fetch })).toBe("backoff");
  expect(await fetchPlanKeyUsage("kimi", KEY, { fetch: scripted(401, { error: KEY }).fetch })).toBeNull();
  expect(await fetchPlanKeyUsage("opencode", KEY, { fetch: scripted(200, { usage: {} }).fetch })).toBeNull();
  const thrown = (async () => {
    throw new Error(`refused ${KEY}`);
  }) as unknown as typeof fetch;
  expect(await fetchPlanKeyUsage("zai", KEY, { fetch: thrown })).toBeNull();
  // A plan with no endpoint, or a key that would split a header: nothing is asked.
  const none = scripted(200, {});
  expect(await fetchPlanKeyUsage("minimax", KEY, { fetch: none.fetch })).toBeNull();
  expect(await fetchPlanKeyUsage("zai", "a\nb", { fetch: none.fetch })).toBeNull();
  expect(await fetchPlanKeyUsage("__proto__", KEY, { fetch: none.fetch })).toBeNull();
  expect(none.calls).toHaveLength(0);
});

// ── Probes: a short-lived CLI ────────────────────────────────────────────────

function probeSetup() {
  const home = tempDir("usage-probe-");
  dirs.push(home);
  const log = path.join(home, "cli.log");
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CODEX_LOG = log;
  return { home, log };
}

test.if(posix)(
  "Claude Code's probe: get_usage after initialize, in the account's folder, with no settings, MCP servers or session",
  async () => {
    const { home, log } = probeSetup();
    const usage = await probeClaudeUsage({ command: [process.execPath, FAKE_CLAUDE], cwd: home, env: process.env });
    expect(usage?.windows.map((w) => [w.kind, w.label ?? null, w.usedPercent])).toEqual([
      ["five_hour", null, 42],
      ["seven_day", null, 82],
      ["seven_day_opus", null, 12],
      ["other", "Fable", 5],
    ]);
    expect(usage?.source).toBe("probe");
    const [run] = logged(log);
    expect(run?.args).toEqual(CLAUDE_PROBE_ARGS);
    expect(run?.args).toEqual(
      expect.arrayContaining(["--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"]),
    );
    expect(run?.cwd).toBe(home);
    // Gone once it answered.
    await waitFor(() => !alive(Number(run?.pid)));

    process.env.FAKE_CLAUDE_USAGE = "signed_out";
    expect(
      await probeClaudeUsage({ command: [process.execPath, FAKE_CLAUDE], cwd: home, env: process.env }),
    ).toBeNull();
    process.env.FAKE_CLAUDE_USAGE = "error";
    expect(
      await probeClaudeUsage({ command: [process.execPath, FAKE_CLAUDE], cwd: home, env: process.env }),
    ).toBeNull();
    // Not installed: null, at once.
    expect(
      await probeClaudeUsage({ command: [path.join(home, "no-such-cli")], cwd: home, env: process.env }),
    ).toBeNull();
  },
);

test.if(posix)(
  "a setup token's check: one turn on the cheapest model, the token on descriptor 3, the reading from its rate limit event",
  async () => {
    const { home, log } = probeSetup();
    const token = "sk-ant-oat01-fake-token-for-tests-only";
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" };
    const prev: PlanUsage = {
      windows: [{ kind: "seven_day", usedPercent: 100, resetsAt: "2030-01-05T00:00:00.000Z" }],
      limited: true,
      source: "turn",
      at: "2030-01-01T00:00:00.000Z",
    };
    try {
      process.env.FAKE_CLAUDE_RATE_INFO = JSON.stringify({
        status: "allowed",
        unifiedWindows: {
          seven_day: { utilization: 0.1, resetsAt: RESET },
          five_hour: { utilization: 0, resetsAt: RESET },
        },
      });
      const room = await checkClaudeToken(
        {
          command: [process.execPath, FAKE_CLAUDE],
          cwd: home,
          env: { ...env, ...{ FAKE_CLAUDE_RATE_INFO: process.env.FAKE_CLAUDE_RATE_INFO } },
          fd3: token,
        },
        prev,
      );
      expect(room?.limited).toBeUndefined();
      expect(room?.windows.find((w) => w.kind === "seven_day")?.usedPercent).toBe(10);
      const [run] = logged(log);
      expect(run?.args).toEqual(CLAUDE_TOKEN_CHECK_ARGS);
      expect(run?.args).toEqual(expect.arrayContaining(["--model", "haiku", "--tools", ""]));
      expect(run?.oauthToken).toBe(token);
      expect(run?.oauthEnv).toBeNull();
      expect(JSON.stringify(run?.args)).not.toContain(token);

      const refused = (before: PlanUsage) =>
        checkClaudeToken(
          {
            command: [process.execPath, FAKE_CLAUDE],
            cwd: home,
            env: { ...env, FAKE_CLAUDE_RATE_INFO: JSON.stringify({ status: "rejected", resetsAt: RESET }) },
            fd3: token,
          },
          before,
        );
      // Still full, as last read: nothing new to say.
      expect(await refused(prev)).toBeNull();
      // Read with room before, refused now: at the limit.
      expect((await refused({ ...prev, limited: undefined }))?.limited).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_RATE_INFO;
    }
    // Nothing said (no rate limit event): no reading.
    expect(
      await checkClaudeToken({ command: [process.execPath, FAKE_CLAUDE], cwd: home, env, fd3: token }, prev),
    ).toBeNull();
  },
);

test.if(posix)("a probe that hangs is killed at its timeout, its whole process with it", async () => {
  const { home, log } = probeSetup();
  process.env.FAKE_CLAUDE_USAGE = "hang";
  const started = Date.now();
  const usage = await probeClaudeUsage({
    command: [process.execPath, FAKE_CLAUDE],
    cwd: home,
    env: process.env,
    timeoutMs: 400,
  });
  expect(usage).toBeNull();
  expect(Date.now() - started).toBeLessThan(5000);
  const pid = Number(logged(log)[0]?.pid);
  expect(pid).toBeGreaterThan(0);
  await waitFor(() => !alive(pid));
});

test.if(posix)("Codex's probe: account/rateLimits/read on a short-lived app-server", async () => {
  const { home, log } = probeSetup();
  const usage = await probeCodexUsage({ command: [process.execPath, FAKE_CODEX], cwd: home, env: process.env });
  expect(usage?.windows).toEqual([
    { kind: "five_hour", usedPercent: 12, resetsAt: new Date(RESET * 1000).toISOString() },
    { kind: "seven_day", usedPercent: 55, resetsAt: new Date(1900500000 * 1000).toISOString() },
  ]);
  const rpc = logged(log).flatMap((l) => (typeof l.rpc === "string" ? [l.rpc] : []));
  expect(rpc).toEqual(["initialize", "account/rateLimits/read"]);
  const pid = Number(logged(log).find((l) => l.start === "app-server")?.pid);
  await waitFor(() => !alive(pid));
});

// ── The manager ──────────────────────────────────────────────────────────────

function manager(over: Partial<AccountManagerOptions> = {}) {
  const home = tempDir("usage-home-");
  dirs.push(home);
  const log = path.join(home, "cli.log");
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CODEX_LOG = log;
  let changes = 0;
  const m = new AccountManager({
    root: path.join(home, "accounts"),
    commands: { claude_code: [process.execPath, FAKE_CLAUDE], codex: [process.execPath, FAKE_CODEX] },
    onChange: () => {
      changes++;
    },
    ...over,
  });
  managers.push(m);
  const folder = (kind: "claude_code" | "codex", id: string) => {
    const dir = path.join(home, "accounts", kind, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const probes = () => {
    try {
      return logged(log).filter((l) => (l.args as string[] | undefined)?.[0] === "-p" || l.start === "app-server");
    } catch {
      return [];
    }
  };
  return { m, home, folder, probes, changes: () => changes };
}

test.if(posix)(
  "probes: on demand, in the account's own folder, the result listed and announced; again only after the TTL",
  async () => {
    const { m, home, folder, probes, changes } = manager();
    const dir = folder("claude_code", ACCOUNT);
    folder("codex", OTHER);
    await m.list();
    const before = changes();
    m.probeUsage([ACCOUNT, OTHER, OWN_USAGE_ID.claude_code, "../../etc", "own:nope"]);
    await waitFor(() => m.ownUsage().claude_code !== undefined && changes() >= before + 3, 8000);
    const list = await m.list();
    expect(list.find((a) => a.id === ACCOUNT)?.usage?.windows[0]).toMatchObject({ kind: "five_hour", usedPercent: 42 });
    expect(list.find((a) => a.id === OTHER)?.usage?.windows.map((w) => w.usedPercent)).toEqual([12, 55]);
    // Each in its own place: the account's folder, the runner's home for the computer's own sign-in.
    const cwds = probes().map((p) => p.cwd);
    expect(cwds).toContain(dir);
    expect(cwds).toContain(home);
    expect(probes()).toHaveLength(3);
    // Within the TTL: nobody runs again.
    m.probeUsage([ACCOUNT, OTHER, OWN_USAGE_ID.claude_code]);
    await new Promise((r) => setTimeout(r, 100));
    expect(probes()).toHaveLength(3);
  },
);

test.if(posix)("probes: at most two at a time", async () => {
  process.env.FAKE_CLAUDE_USAGE = "hang";
  const { m, folder, probes } = manager({ usageTimeoutMs: 600 });
  const ids = [1, 2, 3].map((n) => `0193eeee-0000-7000-8000-00000000010${n}`);
  for (const id of ids) folder("claude_code", id);
  m.probeUsage(ids);
  await waitFor(() => probes().length === 2);
  await new Promise((r) => setTimeout(r, 200));
  expect(probes()).toHaveLength(2);
  // The first two time out; the third starts then.
  await waitFor(() => probes().length === 3, 4000);
});

test.if(posix)("a coding plan's key account: its provider's endpoint; a 429 backs off past the TTL", async () => {
  let asked = 0;
  let status = 429;
  const fetch = (async () => {
    asked++;
    return new Response(JSON.stringify({ usage: { rolling: { percent: 30 }, weekly: { percent: 10 } } }), { status });
  }) as unknown as typeof globalThis.fetch;
  const { m, folder, probes } = manager({ fetch, usageTtlMs: 0 });
  const dir = folder("claude_code", ACCOUNT);
  writeFileSync(path.join(dir, "provider.json"), JSON.stringify({ provider: "opencode", key: KEY }), { mode: 0o600 });
  m.probeUsage([ACCOUNT]);
  await waitFor(() => asked === 1);
  // Backing off: asked again, nothing goes out (even with no TTL).
  status = 200;
  await new Promise((r) => setTimeout(r, 50));
  m.probeUsage([ACCOUNT]);
  await new Promise((r) => setTimeout(r, 100));
  expect(asked).toBe(1);
  expect(probes()).toHaveLength(0);
});

test("what turns say: the first news and a crossed line at once, the rest at most every interval", async () => {
  const { m, changes } = manager({ usageNotifyMs: 300 });
  const at = (utilization: number) => ({ status: "allowed", rateLimitType: "five_hour", utilization, resetsAt: RESET });
  m.noteRateLimit(ACCOUNT, at(0.1));
  expect(changes()).toBe(1);
  m.noteRateLimit(ACCOUNT, at(0.2));
  m.noteRateLimit(ACCOUNT, at(0.3));
  expect(changes()).toBe(1);
  // Crossing 80: at once (and the queued news with it).
  m.noteRateLimit(ACCOUNT, at(0.85));
  expect(changes()).toBe(2);
  m.noteRateLimit(ACCOUNT, at(0.86));
  await waitFor(() => changes() === 3, 2000);
  // The computer's own sign-ins, by brain.
  m.noteRateLimit(OWN_USAGE_ID.claude_code, at(0.5));
  m.noteCodexRateLimits(OWN_USAGE_ID.codex, { primary: { usedPercent: 91, windowDurationMins: 300 } });
  expect(m.ownUsage().claude_code?.windows[0]?.usedPercent).toBe(50);
  expect(m.ownUsage().codex?.windows[0]).toEqual({ kind: "five_hour", usedPercent: 91 });
});
