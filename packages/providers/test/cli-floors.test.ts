import { expect, test } from "bun:test";
import { CLI_FLOORS, type CliFloor, cliVersionProblem, type FloorCli } from "../src/cli-floors";

const floors = (claude: CliFloor): Record<FloorCli, CliFloor> => ({ ...CLI_FLOORS, claude });

test("a version below the floor or a blocked one gets no turn; any other, or a line with no version, does", () => {
  const f = floors({ min: "2.1.206", blocked: ["2.1.300"] });
  expect(cliVersionProblem("claude", "2.1.205 (Claude Code)", f)).toEqual({
    kind: "too_old",
    version: "2.1.205",
    min: "2.1.206",
  });
  expect(cliVersionProblem("claude", "2.0.999 (Claude Code)", f)).toMatchObject({ kind: "too_old" });
  expect(cliVersionProblem("claude", "2.1.206 (Claude Code)", f)).toBeNull();
  expect(cliVersionProblem("claude", "3.0.0", f)).toBeNull();
  expect(cliVersionProblem("claude", "2.1.300 (Claude Code)", f)).toEqual({ kind: "blocked", version: "2.1.300" });
  // Never held back on a guess.
  expect(cliVersionProblem("claude", "unknown", f)).toBeNull();
  expect(cliVersionProblem("claude", null, f)).toBeNull();
  // A CLI with no floor runs at any version; Cursor's dated versions read as numbers too.
  expect(cliVersionProblem("cursor", "2026.10.28-1a2b3c4", f)).toBeNull();
  const dated = { ...f, cursor: { min: "2026.11.01" } };
  expect(cliVersionProblem("cursor", "2026.10.28-1a2b3c4", dated)).toMatchObject({ kind: "too_old", min: "2026.11.1" });
});

test("the shipped floors: Claude Code from 2.1.206, Codex from 0.164.0, the others at any version", () => {
  expect(cliVersionProblem("claude", "2.1.205 (Claude Code)")).toMatchObject({ kind: "too_old", min: "2.1.206" });
  expect(cliVersionProblem("claude", "2.1.206 (Claude Code)")).toBeNull();
  expect(cliVersionProblem("codex", "codex-cli 0.163.0")).toMatchObject({ kind: "too_old", min: "0.164.0" });
  expect(cliVersionProblem("codex", "codex-cli 0.164.0")).toBeNull();
  for (const cli of ["cursor", "opencode", "grok", "antigravity"] as FloorCli[])
    expect(cliVersionProblem(cli, "0.0.1")).toBeNull();
});
