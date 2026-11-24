import { expect, test } from "bun:test";
import { canMakeTeamMemory } from "../src/lib/team-memory";

test("an explicit server decision overrides the legacy kind projection", () => {
  expect(canMakeTeamMemory({ kind: "fact", archived: false, canMakeTeam: false })).toBe(false);
  expect(canMakeTeamMemory({ kind: "fact", archived: false, canMakeTeam: true })).toBe(true);
});

test("older servers retain sharing for supported memories", () => {
  for (const kind of ["fact", "decision", "preference", "rule"] as const) {
    expect(canMakeTeamMemory({ kind, archived: false })).toBe(true);
  }
});

test("the legacy fallback keeps archived, internal and lesson records excluded", () => {
  expect(canMakeTeamMemory({ kind: "fact", archived: true })).toBe(false);
  expect(canMakeTeamMemory({ kind: "fact", archived: false, howTo: true })).toBe(false);
  expect(canMakeTeamMemory({ kind: "fact", archived: false, playbook: true })).toBe(false);
  expect(canMakeTeamMemory({ kind: "lesson", archived: false })).toBe(false);
});
