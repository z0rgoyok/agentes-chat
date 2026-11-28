import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptWindowsPath,
  loginShellPath,
  mergePath,
  registryPathValue,
  usualDirs,
  usualWindowsDirs,
} from "../../runner/login-path";

test("mergePath: first wins, no empty or repeated entries", () => {
  expect(mergePath("/a:/b", null, "/b:/c::/a", undefined, "/d")).toBe("/a:/b:/c:/d");
  expect(mergePath("", "")).toBe("");
});

test("loginShellPath reads only what's between the marks, ignoring what the shell's rc files print", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(path.join(os.tmpdir(), "login-path-"));
  const shell = path.join(dir, "fake-shell");
  // A "shell" that prints a banner first, then runs the -c script like sh would.
  writeFileSync(shell, `#!/bin/sh\necho "Welcome!"\nPATH=/x/bin:/y/bin\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`);
  chmodSync(shell, 0o755);
  expect(loginShellPath(shell)).toBe("/x/bin:/y/bin");
  expect(loginShellPath(path.join(dir, "missing"))).toBeNull();
});

test("the usual folders include the ones Claude Code and Homebrew install into", () => {
  const dirs = usualDirs("/Users/ana");
  expect(dirs).toContain("/Users/ana/.local/bin");
  expect(dirs).toContain("/opt/homebrew/bin");
});

test("Windows: the registry's Path, %NAME% expanded, as reg query prints it", () => {
  const out =
    "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools;%NOPE%\r\n\r\n";
  expect(registryPathValue(out, { USERPROFILE: "C:\\Users\\ana" })).toBe(
    "C:\\Users\\ana\\.local\\bin;C:\\Tools;%NOPE%",
  );
  expect(registryPathValue("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
});

test("Windows: what the app started with stays first, then the registry's Path and the usual folders that exist", () => {
  const env: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\system32;C:\\Users\\ana\\AppData\\Roaming\\npm",
    USERPROFILE: "C:\\Users\\ana",
    APPDATA: "C:\\Users\\ana\\AppData\\Roaming",
  };
  const exists = (dir: string) => dir === "C:\\Users\\ana\\.local\\bin" || dir.endsWith("\\npm");
  adoptWindowsPath(env, () => "C:\\WINDOWS\\System32;C:\\Program Files\\Git\\cmd", exists);
  expect(env.PATH).toBe(
    "C:\\Windows\\system32;C:\\Users\\ana\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd;C:\\Users\\ana\\.local\\bin",
  );
  expect(usualWindowsDirs(env)).toEqual([
    "C:\\Users\\ana\\.local\\bin",
    "C:\\Users\\ana\\AppData\\Roaming\\npm",
    "C:\\Users\\ana\\.bun\\bin",
    "C:\\Users\\ana\\AppData\\Local\\agy\\bin",
    "C:\\Users\\ana\\.grok\\bin",
  ]);
});
