import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("Conversas asks who is working only while its socket is down: `agent.status` brings every run's start and end", () => {
  const home = src("features/chats/ChatsScreen.tsx");
  expect(home).toContain('const socketOpen = useRealtime().status === "open";');
  expect(home).toContain("if (!focused || socketOpen) return;");
});

test("Rotinas asks again every minute while its socket is open, every 15 s without it", () => {
  const routines = src("features/routines/RoutinesScreen.tsx");
  expect(routines).toContain("socketOpen ? WORKING_POLL_LIVE_MS : WORKING_POLL_MS");
  expect(routines).toContain("const WORKING_POLL_LIVE_MS = 60_000;");
});

test("Você counts its tasks without the 10 s look that the task screens keep while agents work", () => {
  expect(src("features/me/MeScreen.tsx")).toContain('useIssues(org.orgId, "", "", { poll: false })');
  const queries = readFileSync(new URL("../../../../packages/client/src/api/queries.ts", import.meta.url), "utf8");
  expect(queries.replace(/\s+/g, " ")).toContain(
    'poll && query.state.data?.some((i) => i.work && i.work.state !== "stalled") ? 10_000 : false',
  );
});

test("a long Setores section's rows jump to their places; a short one's glide", () => {
  const home = src("features/chats/ChatsScreen.tsx");
  expect(home).toContain("const MOVING_ROWS = 30;");
  expect(home).toContain("moves={section.rows.length <= MOVING_ROWS}");
});

test("the conversations snapshot is saved at most every minute while the app is in use", () => {
  expect(src("providers/AppProviders.tsx")).toContain("const SNAPSHOT_EVERY_MS = 60_000;");
});
