import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_HOME_ONLY } from "@agenteschat/adapters/machine-protocol";
import { agentsCopy, agentsReach, type RunAs } from "../../runner/agent-reach";
import { AGENT_USERS_FILE, PROBE_AGENT_UID } from "../../runner/agent-users";
import { cachedExecutors, codexCandidates, type RunResult, setCliPick } from "../../runner/executors";
import { removeDirs, tempDir } from "./helpers";

/*
 * System mode: a coding CLI counts as the computer's only when its agents' users can start it, each as itself with
 * its own PATH. A computer here is a list of programs, each with who may run it; a run looks the command up on the
 * PATH it was given, as the user `setpriv` names, the way the real launcher's `execvp` does.
 */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const ANA = { id: "0193aaaa-0000-7000-8000-000000000001", user: "ag-0193aaaa", uid: 21000 };
const BIA = { id: "0193bbbb-0000-7000-8000-000000000002", user: "ag-0193bbbb", uid: 21001 };

function runnerHome(users: (typeof ANA)[]) {
  const home = tempDir("reach-");
  dirs.push(home);
  writeFileSync(path.join(home, AGENT_USERS_FILE), JSON.stringify(users));
  return home;
}

/** `files`: a program's full path and who may run it (`all`, or only these users; root always). */
function computer(files: Record<string, "all" | string[]>) {
  const asked: { user: string; path: string }[] = [];
  const run: RunAs = async (argv, env) => {
    const reuid = argv.find((a) => a.startsWith("--reuid="))?.slice("--reuid=".length) ?? "root";
    const user = reuid === String(PROBE_AGENT_UID) ? "stand-in" : reuid;
    const at = argv.indexOf("--version");
    const command = argv[at - 1] ?? "";
    asked.push({ user, path: env.PATH ?? "" });
    for (const dir of (env.PATH ?? "").split(":")) {
      const who = files[path.join(dir, command)];
      if (who === "all" || who?.includes(user)) return { status: 0, stdout: `${command} 1.2.3\n` };
    }
    // setpriv's own exit when execvp finds nothing it may run.
    return { status: 127, stdout: "", stderr: `setpriv: failed to execute ${command}: No such file or directory` };
  };
  return { run, asked };
}

const found = {
  claude: { version: "2.1.325 (Claude Code)" },
  codex: { version: "codex-cli 0.190.0" },
};

test("a CLI only root can start isn't the agents': it leaves the list and says so", async () => {
  // Codex in root's own ~/.local/bin (root's look found it there); Claude Code where every agent's PATH has it.
  const home = runnerHome([ANA]);
  const { run } = computer({ "/root/.local/bin/codex": [], "/usr/local/bin/claude": "all" });
  expect(await agentsReach(found, home, run)).toEqual({
    claude: { version: "2.1.325 (Claude Code)" },
    broken: { codex: CLI_HOME_ONLY },
  });
});

test("each agent is asked as its own user with its own PATH, only when the shared PATH doesn't have it", async () => {
  // Ana installed Codex in her own ~/.local/bin; Bia has none.
  const home = runnerHome([ANA, BIA]);
  const { run, asked } = computer({ "/home/ag-0193aaaa/.local/bin/codex": ["ag-0193aaaa"] });
  expect(await agentsReach({ codex: found.codex }, home, run)).toEqual({ broken: { codex: CLI_HOME_ONLY } });
  expect(asked).toEqual([
    { user: "stand-in", path: "/usr/local/bin:/usr/bin:/bin" },
    { user: "ag-0193aaaa", path: "/usr/local/bin:/usr/bin:/bin:/home/ag-0193aaaa/.local/bin" },
    { user: "ag-0193bbbb", path: "/usr/local/bin:/usr/bin:/bin:/home/ag-0193bbbb/.local/bin" },
  ]);
  // Both have it: it is the computer's.
  const both = computer({
    "/home/ag-0193aaaa/.local/bin/codex": ["ag-0193aaaa"],
    "/home/ag-0193bbbb/.local/bin/codex": ["ag-0193bbbb"],
  });
  expect(await agentsReach({ codex: found.codex }, home, both.run)).toEqual({ codex: found.codex });
  // On every agent's PATH: one look, as the stand-in.
  const shared = computer({ "/usr/local/bin/codex": "all" });
  expect(await agentsReach({ codex: found.codex }, home, shared.run)).toEqual({ codex: found.codex });
  expect(shared.asked).toHaveLength(1);
});

test("a check that can't tell keeps what root found, and a CLI root lacks isn't asked about", async () => {
  const home = runnerHome([ANA]);
  const asked: string[] = [];
  const slow: RunAs = async (argv) => {
    asked.push(argv.at(-2) ?? "");
    return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  };
  const broken = { grok: "segfault" };
  expect(await agentsReach({ ...found, broken }, home, slow)).toEqual({ ...found, broken });
  expect(asked).toEqual(["claude", "codex"]);
});

test("a launch that couldn't start at all (no setpriv) never takes a CLI from the agents", async () => {
  const home = runnerHome([ANA]);
  const gone: RunAs = async () => ({
    status: null,
    stdout: "",
    error: Object.assign(new Error("spawn /usr/bin/setpriv ENOENT"), { code: "ENOENT" }),
  });
  expect(await agentsReach(found, home, gone)).toEqual(found);
});

test("the copy the agents reach, for the runner's own copies: none until every agent can start one", async () => {
  const home = runnerHome([ANA]);
  expect(await agentsCopy("codex", home, computer({ "/root/.local/bin/codex": [] }).run)).toBeNull();
  expect(await agentsCopy("codex", home, computer({ "/usr/local/bin/codex": "all" }).run)).toBe("codex 1.2.3");
});

test("the computer's list is what the agents reach, look after look", async () => {
  const runAsRoot = async (command: string): Promise<RunResult> =>
    command.endsWith("codex")
      ? { status: 0, stdout: "codex-cli 0.190.0\n" }
      : { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) };
  const home = runnerHome([ANA]);
  const { run } = computer({ "/root/.local/bin/codex": [] });
  const executors = cachedExecutors({ run: runAsRoot, reach: (f) => agentsReach(f, home, run) });
  expect(await executors.ready()).toEqual({ broken: { codex: CLI_HOME_ONLY } });
});

test("the copy the runner picked is the one asked about, as an agent's turn starts it", async () => {
  const home = runnerHome([ANA]);
  writeFileSync(path.join(home, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  setCliPick("codex", path.join(home, "codex"));
  try {
    const asked: string[] = [];
    const run: RunAs = async (argv) => {
      asked.push(argv.at(-2) ?? "");
      return { status: 0, stdout: "codex-cli 0.190.0\n" };
    };
    expect(await agentsReach({ codex: found.codex }, home, run)).toEqual({ codex: found.codex });
    expect(asked).toEqual([path.join(home, "codex")]);
  } finally {
    setCliPick("codex", undefined);
  }
});

test("a Codex in the runner's own home is never the one the agents are given", () => {
  const root = tempDir("root-");
  dirs.push(root);
  const shared = tempDir("usr-bin-");
  dirs.push(shared);
  for (const dir of [path.join(root, ".local", "bin"), shared]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const pathList = `${path.join(root, ".local", "bin")}:${shared}`;
  expect(codexCandidates(pathList, "linux", undefined, null)[0]).toBe(path.join(root, ".local", "bin", "codex"));
  const forAgents = codexCandidates(pathList, "linux", undefined, root);
  expect(forAgents).toContain(path.join(shared, "codex"));
  expect(forAgents.filter((f) => f.startsWith(`${root}/`))).toEqual([]);
});
