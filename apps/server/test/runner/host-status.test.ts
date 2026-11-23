import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { removeDirs, tempDir } from "./helpers";

/**
 * `agentes-runner status`, `tools` and `folders` on the server's own computer (`agentes-runner host`, ADR 0153 §5):
 * the machine's top-level config is in system mode with no token, and each organization it serves keeps its own
 * connection in `<home>/orgs/<orgId>`. They read the organization's, not the machine's (issue #329).
 */
const RUNNER = path.join(import.meta.dir, "../../runner/main.ts");
const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const SERVER = "https://app.example.com";

function machineConfig(home: string) {
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ mode: "system", agentUidRange: [20000, 29999] }));
}

/** A home as `host` leaves it: the machine's config, and one home per organization, each with a token. */
function hostHome(orgs: { id: string; name: string }[]) {
  const home = tempDir("host-status-");
  dirs.push(home);
  machineConfig(home);
  for (const org of orgs) {
    const orgHome = path.join(home, "orgs", org.id);
    mkdirSync(orgHome, { recursive: true });
    writeFileSync(
      path.join(orgHome, "config.json"),
      JSON.stringify({
        server: SERVER,
        machineId: `machine-${org.id}`,
        name: "studio-server",
        token: `agm_${org.id}`,
        workspace: path.join(home, "work"),
        orgId: org.id,
        orgName: org.name,
        managedBy: "host",
        mode: "system",
        exec: true,
        access: {
          folders: [],
          tools: { claude: true, codex: true, commands: true, browser: true, desktop: true, terminal: true },
        },
      }),
    );
  }
  return home;
}

const orgConfig = (home: string, id: string) => path.join(home, "orgs", id, "config.json");
const readOrg = (home: string, id: string) => JSON.parse(readFileSync(orgConfig(home, id), "utf8"));

/** `agentes-runner <args>` in `home`, as whoever runs the server's computer does. */
async function runner(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, RUNNER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTES_RUNNER_HOME: home, HOME: home, TERM: "dumb" },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit, output: stdout + stderr };
}

test("status: the organization's connection, its tools and its config, never 'Not connected'", async () => {
  const home = hostHome([{ id: "org-a", name: "Acme" }]);
  const r = await runner(home, "status");
  expect(r.exit).toBe(0);
  expect(r.output).toContain('Connected to Acme as "studio-server"');
  expect(r.output).toContain(SERVER);
  expect(r.output).toContain(`Config: ${orgConfig(home, "org-a")}`);
  expect(r.output).toContain("desktop on");
  expect(r.output).toContain("terminal on");
  expect(r.output).not.toContain("Not connected");
  // The desktops and the terminal are the organization's switches too: never off. Desktops show "unavailable" on a
  // machine without their packages, as on CI.
  expect(r.output).not.toContain("Desktops: off");
  expect(r.output).toContain("Terminal: on");
});

test("tools list: the organization's switches (with no --org, the only one there)", async () => {
  const home = hostHome([{ id: "org-a", name: "Acme" }]);
  const r = await runner(home, "tools", "list");
  expect(r.exit).toBe(0);
  expect(r.stderr).toBe("");
  expect(r.stdout).toContain("desktop   on");
  expect(r.stdout).toContain("terminal  on");
});

test("tools disable: writes the organization's access.tools, leaving the machine's config alone", async () => {
  const home = hostHome([{ id: "org-a", name: "Acme" }]);
  const r = await runner(home, "tools", "disable", "desktop");
  expect(r.exit).toBe(0);
  expect(readOrg(home, "org-a").access.tools.desktop).toBe(false);
  expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
    mode: "system",
    agentUidRange: [20000, 29999],
  });
  // And status reads it back as off.
  const after = await runner(home, "status");
  expect(after.output).toContain("desktop off");
});

test("two organizations: tools needs --org and lists them; the one it names is the one written", async () => {
  const home = hostHome([
    { id: "org-a", name: "Acme" },
    { id: "org-b", name: "Beta" },
  ]);
  const refused = await runner(home, "tools", "disable", "browser");
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toContain("--org");
  expect(refused.stderr).toContain("Acme (org-a)");
  expect(refused.stderr).toContain("Beta (org-b)");
  expect(readOrg(home, "org-a").access.tools.browser).toBe(true);
  expect(readOrg(home, "org-b").access.tools.browser).toBe(true);

  const byName = await runner(home, "tools", "disable", "browser", "--org", "Beta");
  expect(byName.exit).toBe(0);
  expect(readOrg(home, "org-b").access.tools.browser).toBe(false);
  expect(readOrg(home, "org-a").access.tools.browser).toBe(true);

  // folders too, by id.
  const list = await runner(home, "folders", "list", "--org", "org-a");
  expect(list.exit).toBe(0);
  expect(list.stdout).toContain("No folders allowed");

  // status lists each organization's connection.
  const status = await runner(home, "status");
  expect(status.output).toContain("Connected to Acme");
  expect(status.output).toContain("Connected to Beta");
});

test("no organization yet: not connected, and where each organization's switches are", async () => {
  const home = tempDir("host-status-");
  dirs.push(home);
  machineConfig(home);
  const status = await runner(home, "status");
  expect(status.output).toContain("Not connected");
  expect(status.output).toContain("Settings > Devices > Tools");
  const tools = await runner(home, "tools", "list");
  expect(tools.exit).toBe(1);
  expect(tools.stderr).toContain("Settings > Devices > Tools");
});

test("a runner of one's own in system mode is not the server's computer: its token is read as ever", async () => {
  const home = tempDir("system-runner-");
  dirs.push(home);
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      mode: "system",
      agentUidRange: [20000, 29999],
      server: SERVER,
      machineId: "m1",
      name: "own-pc",
      token: "agm_own",
      workspace: path.join(home, "work"),
      orgId: "org-own",
      orgName: "Acme",
      exec: true,
      access: {
        folders: [],
        tools: { claude: true, codex: true, commands: true, browser: true, desktop: true, terminal: true },
      },
    }),
  );
  const status = await runner(home, "status");
  expect(status.output).toContain('Connected to Acme as "own-pc"');
  const tools = await runner(home, "tools", "list");
  expect(tools.exit).toBe(0);
  expect(tools.stdout).toContain("desktop   on");
});
