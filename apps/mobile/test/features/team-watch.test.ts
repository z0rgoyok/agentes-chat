import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { notificationHref, notificationWebPath } from "../../src/features/links/logic";
import { notification } from "./fixtures";

const found = (reason: string, source = {}) =>
  notification({ kind: "team_watch", waiting: true, source, latest: { reason, names: ["X"], text: "stored" } });

test("what the right hand found opens where it is fixed", () => {
  expect(notificationHref(found("sign_in"))).toBe("/ai-accounts");
  for (const reason of ["connector", "mailbox"]) expect(notificationHref(found(reason))).toBe("/connectors");
  expect(notificationHref(found("budget_out", { agentId: "a1" }))).toBe("/agent/a1");
  expect(notificationHref(found("budget_low"))).toBe("/usage");
  expect(notificationHref(found("computer", { machineId: "m1" }))).toBe("/settings/devices/m1");
  expect(notificationHref(found("computer"))).toBe("/settings/devices");
});

test("a database is reconnected on the web: no screen here, so the tap opens its page there", () => {
  const n = found("database");
  expect(notificationHref(n)).toBeNull();
  expect(notificationWebPath(n, "o1")).toBe("/org/o1/settings/connectors");
});

test("a cause this build does not know opens nothing, here or on the web", () => {
  const n = found("something_new");
  expect(notificationHref(n)).toBeNull();
  expect(notificationWebPath(n, "o1")).toBeNull();
});

test("the phone says the problem itself, once, and its card's button names the way out", () => {
  const read = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  // The title of the row, the card and the island: the cause's sentence in the reader's language, the server's own
  // for a cause this build doesn't know.
  const title = read("activity/noticeTitle.ts");
  expect(title).toContain("const problem = teamWatchLine(t, n);");
  // Nothing under the title says it again, in the list or on the island.
  const screen = read("activity/ActivityScreen.tsx");
  expect(screen).toMatch(/n\.kind === "team_watch"\s+\? ""/);
  expect(read("island/NoticeIsland.tsx")).toContain('n.kind === "team_watch" ? "" : noticeLine(');
  // The waiting card's one button is the cause's own ("Entrar de novo", "Reconectar"), "Abrir" only without one.
  expect(screen).toContain("const button = found?.act");
  expect(screen).toContain('card.kind === "limit" || found');
});
