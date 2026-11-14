import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RIGHT_HAND_POWERS, rightHandNoComputer } from "../src/lib/right-hand";

test("why it has no computer for anyone is told by its own line, and any other state by none", () => {
  expect(rightHandNoComputer("no_home")).toBe("rightHand.computerNoHome");
  expect(rightHandNoComputer("not_system")).toBe("rightHand.computerOneUser");
  for (const reason of [null, undefined, "offline", "no_desktop", "not_allowed"]) {
    expect(rightHandNoComputer(reason)).toBeNull();
  }
  // The reasons are the ones its desktop's state gives where it has no seat.
  const engine = readFileSync(new URL("../../engine/src/desktop.ts", import.meta.url), "utf8");
  expect(engine).toContain('agent.reason === "not_system" ? "not_system" : "no_home"');
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
