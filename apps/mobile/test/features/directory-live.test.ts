import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyWorkspaceEvent, keys } from "@agenteschat/client";
import { QueryClient } from "@tanstack/react-query";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

test("the phone hears the team and the channels change, whatever screen is open", () => {
  const events = src("features/shared/userEvents.ts");
  expect(events).toContain("applyWorkspaceEvent(qc, orgId, event)");
  const qc = new QueryClient();
  const lists = [keys.agents("o1"), keys.channels("o1"), keys.dms("o1"), keys.roster("o1", "c1")];
  for (const key of lists) qc.setQueryData(key, []);
  applyWorkspaceEvent(qc, "o1", { type: "agents.changed" });
  applyWorkspaceEvent(qc, "o1", { type: "channels.changed" });
  for (const key of lists) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
});

test("a reconnect reads everything again, as does the socket started again when the app comes back", () => {
  expect(src("providers/realtime.tsx").replace(/\s+/g, " ")).toContain(
    "c.onCatchUp((full) => void catchUpQueries(queryClient, full))",
  );
  const query = src("providers/query.ts").replace(/\s+/g, " ");
  expect(query).toContain(
    'full ? queryClient.invalidateQueries(undefined, options) : queryClient.refetchQueries({ type: "active" }, options)',
  );
});

test("the channel's members screen and the mention picker read the shared roster", () => {
  for (const f of ["features/chat/ChannelMembers.tsx", "features/chat/MentionPicker.tsx"])
    expect(src(f)).toContain("useRoster");
});

test("adding to a channel: the ones being added keep their rows, and nobody reads as in already, until the sheet moves on", () => {
  expect(src("features/chat/ChannelMembers.tsx")).toMatch(
    /const inChannel = useHeldWhile\(\s*new Set\(\(roster\.data \?\? \[\]\)[^;]*\),\s*add\.isPending \|\| add\.isSuccess,\s*\);/,
  );
});

test("the channel's members: agents out of office, paused or with no AI and people not here sit under Offline, in faint", () => {
  const sheet = src("features/chat/ChannelMembers.tsx");
  // The shared rules: who is off (`isAgentOff`, `isConnected`), the groups and their counts (`sheetGroups`).
  expect(sheet).toContain("isAgentOff(a.presence)");
  expect(sheet).toContain("!isConnected(p.presence)");
  expect(sheet).toContain("sheetGroups(all, shown, off)");
  expect(sheet).toContain('t("presence.offline")');
  expect(sheet).toContain("faint={off(w)}");
  // An off agent's line by the web column's rule (its work, its own line while it lasts, why it is off), in place of how
  // it answers here.
  expect(sheet).toContain("agentMemberLine(workText(w.id), own && agentStatusShort(");
  expect(sheet).toContain("liveLine(a.noAi ? null : a.status?.status, now)");
});
