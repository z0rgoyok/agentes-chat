import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_LIMITS, parseAccess, type RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { allowedFor, foldersFor } from "../../runner/access";
import { lookFiles } from "../../runner/desktop-look";
import type { RunCommand } from "../../runner/service";
import {
  applySharedBin,
  duGb,
  ensureSingleShared,
  ensureSystemShared,
  OWN_FILES_FIX,
  shareAgentFiles,
  sharedSizeGb,
  systemShared,
  withShared,
} from "../../runner/shared-folder";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const NOTHING: RunnerAccess = { folders: [], tools: { claude: true, codex: true, commands: true } };

function fakeRun(fail: Record<string, number> = {}) {
  const calls: string[] = [];
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args].join(" "));
    const code = fail[file] ?? 0;
    return { code, output: code ? `${file}: not found` : "" };
  };
  return { run, calls };
}

test("system mode: the group, the folder (root and the group, setgid) with its default ACLs, then bin/ by umask", () => {
  const { run, calls } = fakeRun();
  expect(ensureSystemShared(systemShared(), run)).toEqual([]);
  expect(calls).toEqual([
    "groupadd --system -f agentes-shared",
    "install -d -m 0755 -o root -g root /srv/agentes",
    "install -d -m 2770 -o root -g agentes-shared /srv/agentes/shared",
    "setfacl -m g:agentes-shared:rwx,d:g:agentes-shared:rwX,d:m::rwX,d:o::- /srv/agentes/shared",
    'sh -c umask 007 && mkdir -p -- "$1" sh /srv/agentes/shared/bin',
  ]);
  // Nothing inside the folder is ever chmodded or chowned: an agent may have put a link there.
  expect(calls.filter((c) => /^(chmod|chown|install)/.test(c) && c.includes("/srv/agentes/shared/"))).toEqual([]);
});

test("without setfacl the folder is still made (and said); a group that can't be made stops there", () => {
  const noAcl = fakeRun({ setfacl: 127 });
  expect(ensureSystemShared(systemShared(), noAcl.run)).toEqual(["setfacl failed (127): setfacl: not found"]);
  expect(noAcl.calls.at(-1)).toStartWith("sh -c umask 007");

  const noGroup = fakeRun({ groupadd: 10 });
  expect(ensureSystemShared(systemShared(), noGroup.run)).toHaveLength(1);
  expect(noGroup.calls).toEqual(["groupadd --system -f agentes-shared"]);
});

test("the server's own computer: a folder and a group per organization's runner", () => {
  expect(systemShared("0a1b2c3d")).toEqual({ path: "/srv/agentes/shared-0a1b2c3d", group: "agentes-sh-0a1b2c3d" });
  expect(systemShared()).toEqual({ path: "/srv/agentes/shared", group: "agentes-shared" });
});

test("single-user mode: <workspace>/shared with its bin/", () => {
  const ws = tempDir("shared-ws-");
  dirs.push(ws);
  expect(ensureSingleShared(ws)).toBe(path.join(ws, "shared"));
  expect(existsSync(path.join(ws, "shared", "bin"))).toBe(true);
  // Again: what is there stays.
  writeFileSync(path.join(ws, "shared", "notes.txt"), "kept");
  ensureSingleShared(ws);
  expect(existsSync(path.join(ws, "shared", "notes.txt"))).toBe(true);
});

test("the shared folder is granted to every agent, once; file access follows the grant", () => {
  const ws = tempDir("shared-grant-");
  dirs.push(ws);
  const shared = ensureSingleShared(ws);
  const access = withShared(
    {
      ...NOTHING,
      folders: [
        { path: "/data", agents: ["agent-1"] },
        { path: shared, agents: ["agent-1"] },
      ],
    },
    shared,
  );
  expect(access.folders).toEqual([
    { path: shared, agents: ["*"] },
    { path: "/data", agents: ["agent-1"] },
  ]);
  expect(withShared(access, shared)).toBe(access);
  expect(withShared(NOTHING, null)).toBe(NOTHING);

  expect(foldersFor(access, "agent-2")).toEqual([shared]);
  expect(foldersFor(access, "agent-1")).toEqual([shared, "/data"]);
  // First: the server keeps only the first ACCESS_LIMITS.folders of a report, so 100 folders never hide it.
  const full = withShared(
    { ...NOTHING, folders: Array.from({ length: ACCESS_LIMITS.folders }, (_, i) => ({ path: `/d${i}`, agents: [] })) },
    shared,
  );
  expect(parseAccess(full)?.folders[0]).toEqual({ path: shared, agents: ["*"] });
  expect(foldersFor(access, undefined)).toEqual([]);
  expect(allowedFor(access, "agent-2", path.join(shared, "repo", "README.md"))).toBe(true);
  expect(allowedFor(access, "agent-2", "/data/x")).toBe(false);
});

test("du's total: kilobytes to GB with one decimal, even after its complaints; nothing printed is unknown", async () => {
  expect(duGb("1048576\t/srv/agentes/shared\n")).toBe(1);
  expect(duGb("209716\t/x\n")).toBe(0.2);
  expect(duGb("")).toBeNull();
  if (process.platform === "win32") return;
  const dir = tempDir("shared-du-");
  dirs.push(dir);
  writeFileSync(path.join(dir, "a"), Buffer.alloc(4096));
  expect(await sharedSizeGb(dir)).toBe(0);
});

test("the desktop's file manager has a Shared bookmark only where there is a shared folder", () => {
  const o = {
    theme: "stock" as const,
    dock: "panel" as const,
    agent: { handle: "ada", name: "Ada" },
    shell: "/bin/bash",
    browser: ["/bin/true"],
  };
  const bookmarks = (shared?: string) =>
    lookFiles("/home/ag-01a142cb", { ...o, ...(shared ? { shared } : {}) })
      .find((f) => f.path === ".config/gtk-3.0/bookmarks")
      ?.data.toString();
  expect(bookmarks("/srv/agentes/shared")).toBe("file:///srv/agentes/shared Shared\n");
  expect(bookmarks()).toBeUndefined();
});

test("files agents moved or copied in are handed to the group, each agent fixing its own, only where some are", async () => {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    // Root's listing: who owns what the group can't change (uid 0's bin/ never is an agent).
    return { stdout: args.includes("runuser") || args.includes("/usr/sbin/runuser") ? "" : "0\n20001\n" };
  };
  const users = [
    { user: "ag-0a1b2c3d", uid: 20001 },
    { user: "ag-4e5f6a7b", uid: 20002 },
  ];
  expect(await shareAgentFiles(systemShared(), users, exec)).toEqual([]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.slice(0, 5)).toEqual(["nice", "-n", "19", "sh", "-c"]);
  expect(calls[0]?.slice(-2)).toEqual(["/srv/agentes/shared", "agentes-shared"]);
  // As the owner itself, never root: only ag-0a1b2c3d has such files.
  expect(calls[1]?.slice(0, 7)).toEqual(["nice", "-n", "19", "/usr/sbin/runuser", "-u", "ag-0a1b2c3d", "--"]);
  expect(calls[1]?.slice(-3)).toEqual([
    "/srv/agentes/shared",
    "agentes-shared",
    "g:agentes-shared:rwx,d:g:agentes-shared:rwX,d:m::rwX,d:o::-",
  ]);
  const failing = async () => {
    throw new Error("find: not found");
  };
  expect(await shareAgentFiles(systemShared(), users, failing)).toEqual([
    "couldn't list the shared folder: find: not found",
  ]);
});

test("the owner's fix: a moved-in folder gets setgid and the group's rwx, a 644 file the group's read and write", () => {
  if (process.platform === "win32") return;
  const dir = tempDir("shared-fix-");
  dirs.push(dir);
  const group = spawnSync("id", ["-gn"]).stdout.toString().trim();
  mkdirSync(path.join(dir, "render"));
  chmodSync(path.join(dir, "render"), 0o755);
  writeFileSync(path.join(dir, "render", "cut.mp4"), "x");
  chmodSync(path.join(dir, "render", "cut.mp4"), 0o644);
  writeFileSync(path.join(dir, "run.sh"), "x");
  chmodSync(path.join(dir, "run.sh"), 0o755);
  const r = spawnSync("sh", ["-c", OWN_FILES_FIX, "sh", dir, group, `g:${group}:rwx`]);
  expect(r.status).toBe(0);
  const mode = (p: string) => statSync(path.join(dir, p)).mode & 0o7777;
  expect(mode("render") & 0o2070).toBe(0o2070);
  expect(mode("render/cut.mp4") & 0o060).toBe(0o060);
  expect(mode("run.sh") & 0o070).toBe(0o070);
});

test("applySharedBin preserves Windows Path casing instead of overwriting PATH with only shared/bin", () => {
  // Folders without a drive letter: on the POSIX machine the test runs on, `path.delimiter` is the drive's colon.
  const existing = ["/windows/system32", "/users/user/.local/bin"].join(path.delimiter);
  const env: Record<string, string | undefined> = { Path: existing };
  const shared = path.join("/users/user/agentes", "shared");
  applySharedBin(env, shared, "win32");

  expect(env.PATH).toBeUndefined();
  expect(env.Path).toBe(`${existing}${path.delimiter}${path.join(shared, "bin")}`);

  // Idempotent on second call.
  applySharedBin(env, shared, "win32");
  expect(env.Path).toBe(`${existing}${path.delimiter}${path.join(shared, "bin")}`);

  // POSIX still uses PATH directly.
  const posixEnv: Record<string, string | undefined> = { PATH: "/usr/bin" };
  applySharedBin(posixEnv, "/srv/shared", "linux");
  expect(posixEnv.PATH).toBe(`/usr/bin${path.delimiter}${path.join("/srv/shared", "bin")}`);
});
