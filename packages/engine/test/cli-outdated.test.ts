import { expect, test } from "bun:test";
import { CLI_FLOORS } from "@agenteschat/providers/cli-floors";
import { cliOutdated } from "../src/brains/claude-code";
import { UNAVAILABLE_CODES } from "../src/brains/select";
import { rightHandNoAiReason } from "../src/right-hand";

const floors = { ...CLI_FLOORS, claude: { min: "2.1.206" }, grok: { blocked: ["1.0.73"] } };

test("a CLI below its floor or on a blocked version: the turn waits, with how to update it", () => {
  const mac = (version: string) => ({ name: "mac", executors: { claude: { version } } });
  const old = cliOutdated(mac("2.1.100 (Claude Code)"), "claude", "Claude Code", floors);
  expect(old).toEqual({
    code: "cli_outdated",
    message:
      "Claude Code 2.1.100 on mac is older than 2.1.206, the oldest version agentes.chat works with. Update it there (claude update).",
  });
  const grok = { executors: { grok: { version: "grok 1.0.73 (abc) [stable]" } } };
  const blocked = cliOutdated(grok, "grok", "Grok Build", floors);
  expect(blocked?.message).toBe(
    "Grok Build 1.0.73 on the computer has a known problem with agentes.chat. Update it there, from the agent's settings or with the installer it came from.",
  );
  expect(cliOutdated(mac("2.1.300"), "claude", "Claude Code", floors)).toBeNull();
  // Not installed is another reason (`cli_missing`), never this one.
  expect(cliOutdated({ name: "mac", executors: {} }, "claude", "Claude Code", floors)).toBeNull();
  // It waits for the update (the runner's `executors.changed` resumes it); the right hand says its program needs one.
  expect(UNAVAILABLE_CODES.has("cli_outdated")).toBe(true);
  expect(rightHandNoAiReason("cli_outdated")).toBe("runner_outdated");
});
