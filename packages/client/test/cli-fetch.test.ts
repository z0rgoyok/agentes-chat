import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { activityVerb, toolActivity } from "../src/lib/activity";
import { cliFetchLine, shownFetch } from "../src/lib/cli-fetch";
import { cliFetchOf } from "../src/realtime/machines";

/* A computer fetching a coding CLI (ADR 0228 §6), as both apps say it. */

const t = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o ?? {})}`) as unknown as TFunction;

test("while it comes: the program, the computer and how far; why when it failed; nothing once it is ready", () => {
  const half = cliFetchLine(t, { state: "fetching", version: "2.1.325", done: 45, total: 100 }, "claude", "MacBook");
  expect(half).toEqual({
    text: 'connectAi.cliFetch.preparingPct {"program":"Claude Code","computer":"MacBook","percent":45}',
    percent: 45,
    failed: false,
  });
  const unknown = cliFetchLine(t, { state: "fetching", version: "2.1.325", done: 45, total: null }, "grok", "PC");
  expect(unknown?.percent).toBeNull();
  expect(unknown?.text).toStartWith("connectAi.cliFetch.preparing ");
  const failed = cliFetchLine(t, { state: "failed", version: "1", reason: "disk_full" }, "codex", "PC");
  expect(failed).toMatchObject({ failed: true, percent: null });
  expect(failed?.text).toStartWith("connectAi.cliFetch.failed.disk_full ");
  expect(cliFetchLine(t, { state: "ready", version: "1" }, "codex", "PC")).toBeNull();
  expect(cliFetchLine(t, undefined, "codex", "PC")).toBeNull();
});

test("the conversation: a run waiting for its CLI says it is being prepared there, with the percent once known", () => {
  const a = toolActivity("prepare_cli", null, "claude|MacBook|45");
  expect(a).toMatchObject({ kind: "preparingCli", app: "Claude Code", computer: "MacBook", percent: 45 });
  expect(activityVerb(t, a)).toStartWith("chat.activity.preparingCliPct ");
  const b = toolActivity("prepare_cli", null, "opencode|PC|");
  expect(b).toMatchObject({ kind: "preparingCli", app: "OpenCode", percent: null });
  expect(activityVerb(t, b)).toStartWith("chat.activity.preparingCli ");
});

test("a fetch's state from the live event, checked", () => {
  expect(
    cliFetchOf({
      claude: { state: "fetching", version: "2.1.325", done: 10, total: 100 },
      grok: { state: "failed", version: "1", reason: "nope" },
      "bad key": { state: "ready", version: "1" },
      codex: { state: "unknown", version: "1" },
    }),
  ).toEqual({
    claude: { state: "fetching", version: "2.1.325", done: 10, total: 100 },
    grok: { state: "failed", version: "1", reason: "failed" },
  });
  expect(cliFetchOf("x")).toBeUndefined();
  expect(cliFetchOf({})).toBeUndefined();
});

test("Claude Code on Windows shows Git for Windows' fetch while it isn't ready, its own after", () => {
  const fetching = { state: "fetching" as const, version: "2.56.1", done: 1, total: 4 };
  expect(shownFetch({ os: "windows", cliFetch: { git: fetching } }, "claude")).toBe("git");
  expect(shownFetch({ os: "windows", cliFetch: { git: { state: "ready", version: "2.56.1" } } }, "claude")).toBe(
    "claude",
  );
  expect(shownFetch({ os: "darwin", cliFetch: { git: fetching } }, "claude")).toBe("claude");
  expect(shownFetch({ os: "windows", cliFetch: { git: fetching } }, "codex")).toBe("codex");
  expect(shownFetch({ os: "windows", cliFetch: null }, "claude")).toBe("claude");
});
