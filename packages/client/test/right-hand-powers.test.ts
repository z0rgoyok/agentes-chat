import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  memoryAudienceGroups,
  RIGHT_HAND_POWERS,
  rightHandComputerLine,
  rightHandNoComputer,
} from "../src/lib/right-hand";

test("why it has no computer for anyone is told by its own line, and any other state by none", () => {
  expect(rightHandNoComputer("no_home")).toBe("rightHand.computerNoHome");
  // A self-hosted server's own computer is the way to one: its line says so.
  expect(rightHandNoComputer("no_home", true)).toBe("rightHand.computerNoHomeServer");
  for (const reason of [null, undefined, "offline", "no_desktop", "not_allowed", "not_system"]) {
    expect(rightHandNoComputer(reason)).toBeNull();
  }
  // The reason is the one its desktop's state gives where it has no seat.
  const engine = readFileSync(new URL("../../engine/src/desktop.ts", import.meta.url), "utf8");
  expect(engine).toContain('if ("reason" in agent) return refused(STREAM_CLOSE.notFound, "no_home");');
});

test("a computer that runs every agent as one user gives a place that says so", () => {
  expect(rightHandComputerLine({ mode: "single" })).toBe("rightHand.computerOneUser");
  expect(rightHandComputerLine({ mode: "system" })).toBe("rightHand.computerYours");
  expect(rightHandComputerLine(null)).toBe("rightHand.computerYours");
});

test("every power the page lists stands on a grant the server gives the right hand", () => {
  const source = readFileSync(new URL("../../engine/src/right-hand.ts", import.meta.url), "utf8");
  const list = /RIGHT_HAND_GRANTS: readonly string\[\] = \[([\s\S]*?)\];/.exec(source);
  const given = new Set(list?.[1]?.match(/"[a-z]+:[a-z]+"/g)?.map((s) => s.slice(1, -1)));
  expect(given.size).toBeGreaterThan(0);
  for (const power of RIGHT_HAND_POWERS) for (const grant of power.grants) expect(given.has(grant)).toBe(true);
  // The list is scopes it holds in code: nothing in it turns a tool off, and a computer's are not among them (they
  // are grant rows it is made with, `RIGHT_HAND_COMPUTER_GRANTS`, so an admin turns them off).
  expect(list?.[1]).not.toContain("deny:");
  for (const scope of ["sandbox:run", "browser:use", "desktop:use"]) expect(given.has(scope)).toBe(false);
  const rows = /RIGHT_HAND_COMPUTER_GRANTS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  for (const scope of ["sandbox:run", "browser:use", "desktop:use"]) expect(rows).toContain(`"${scope}"`);
  expect(source).toContain("export const rightHandReaches");
});

test("the right hand's memories group as Only you first, then one group per channel; an older server's by channel", () => {
  const base = {
    agentId: "lodi",
    kind: "fact" as const,
    source: "",
    uses: 0,
    lastUsedAt: null,
    pinned: false,
    archived: false,
    lowTrust: false,
    verified: true,
    supersedes: null,
    editedByUserId: null,
    updatedAt: "2026-11-24T10:00:00.000Z",
  };
  const at = (id: string, channel: string | null, onlyYou?: boolean) => ({
    ...base,
    id,
    text: id,
    channelId: channel ? `c-${channel}` : null,
    origin: { by: "agent" as const, name: null, channel, at: base.updatedAt },
    ...(onlyYou === undefined ? {} : { onlyYou }),
  });
  const groups = memoryAudienceGroups([
    at("a", "eng", false),
    at("b", null, true),
    at("c", "ops", false),
    at("d", "eng", false),
  ]);
  expect(groups.map((g) => [g.key, g.channel, g.items.map((m) => m.id)])).toEqual([
    ["you", null, ["b"]],
    ["c-eng", "eng", ["a", "d"]],
    ["c-ops", "ops", ["c"]],
  ]);
  expect(memoryAudienceGroups([at("x", "eng")]).map((g) => g.key)).toEqual(["c-eng"]);
});
