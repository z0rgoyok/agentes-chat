import { expect, test } from "bun:test";
import { CLI_PINS, ownCopyServes, PIN_CLIS, parseCliPins, pinPlatformOf } from "../src/cli-pins";

/* The coding CLIs' pins (ADR 0228 §6): one version and each system's build per CLI, checked as the runner takes it. */

test("every CLI is pinned, each build at https with a hash of its algorithm's size and a program inside", () => {
  expect(Object.keys(CLI_PINS).sort()).toEqual([...PIN_CLIS].sort());
  for (const pin of Object.values(CLI_PINS)) {
    expect(Object.keys(pin.builds).length).toBeGreaterThan(0);
    for (const b of Object.values(pin.builds)) {
      expect(b?.url.startsWith("https://")).toBe(true);
      expect(b?.hash.value).toMatch(b?.hash.algorithm === "sha512" ? /^[0-9a-f]{128}$/ : /^[0-9a-f]{64}$/);
      expect(b?.executable).not.toContain("..");
    }
  }
  // As the runner gets them from the wire: nothing is lost.
  expect(parseCliPins(JSON.parse(JSON.stringify(CLI_PINS)))).toEqual(CLI_PINS);
});

test("from the wire: only https, a well-formed hash and a program path inside the copy's folder", () => {
  const good = {
    url: "https://x.example/c",
    hash: { algorithm: "sha256", value: "a".repeat(64) },
    archive: "file",
    executable: "c",
  };
  const parsed = parseCliPins({
    claude: { version: "1.2.3", builds: { "linux-x64": good, "darwin-arm64": { ...good, url: "http://x.example/c" } } },
    codex: { version: "1.2.3", builds: { "linux-x64": { ...good, executable: "../../bin/sh" } } },
    grok: { version: "1.2.3", builds: { "linux-x64": { ...good, hash: { algorithm: "md5", value: "a" } } } },
    opencode: { version: "1.2.3", builds: { "linux-x64": { ...good, strip: 9 } } },
  });
  expect(Object.keys(parsed ?? {}).sort()).toEqual(["claude", "opencode"]);
  expect(Object.keys(parsed?.claude?.builds ?? {})).toEqual(["linux-x64"]);
  expect(parsed?.opencode?.builds["linux-x64"]?.strip).toBeUndefined();
  expect(parseCliPins("nope")).toBeNull();
  expect(parseCliPins({ claude: { version: "x" } })).toBeNull();
});

test("this system's name in the pins", () => {
  expect(pinPlatformOf("darwin", "arm64", false)).toBe("darwin-arm64");
  expect(pinPlatformOf("linux", "x64", false)).toBe("linux-x64");
  expect(pinPlatformOf("linux", "arm64", true)).toBe("linux-arm64-musl");
  expect(pinPlatformOf("win32", "x64", false)).toBe("win32-x64");
  expect(pinPlatformOf("freebsd", "x64", false)).toBeNull();
  expect(pinPlatformOf("linux", "ia32", false)).toBeNull();
});

test("the person's own copy runs at the pinned version or newer; a line with no version never does", () => {
  const pin = { version: "2.1.325", builds: {} };
  expect(ownCopyServes(pin, "2.1.325 (Claude Code)")).toBe(true);
  expect(ownCopyServes(pin, "2.2.0 (Claude Code)")).toBe(true);
  expect(ownCopyServes(pin, "2.1.300 (Claude Code)")).toBe(false);
  expect(ownCopyServes(pin, "unknown")).toBe(false);
});

test("every coding CLI has its vendor's Windows builds; Git for Windows' portable build is pinned for Windows only", () => {
  for (const cli of ["claude", "codex", "cursor", "opencode", "grok", "antigravity"] as const) {
    expect(CLI_PINS[cli].builds["win32-x64"]).toBeDefined();
    expect(CLI_PINS[cli].builds["win32-arm64"]).toBeDefined();
  }
  // Cursor's Windows package starts as Node and its `index.js`, never through its `.cmd` launcher.
  expect(CLI_PINS.cursor.builds["win32-x64"]).toMatchObject({
    archive: "zip",
    executable: "node.exe",
    launch: ["index.js"],
  });
  // The Antigravity CLI: one version everywhere, Google's sha512 of each build, a bare `agy.exe` on Windows.
  for (const b of Object.values(CLI_PINS.antigravity.builds)) expect(b?.hash.algorithm).toBe("sha512");
  expect(Object.keys(CLI_PINS.antigravity.builds)).toHaveLength(8);
  expect(CLI_PINS.antigravity.builds["win32-x64"]).toMatchObject({ archive: "file", executable: "agy.exe" });
  // MinGit ships bash as `sh.exe`: the program is a copy named `bash.exe`.
  expect(Object.keys(CLI_PINS.git.builds).sort()).toEqual(["win32-arm64", "win32-x64"]);
  expect(CLI_PINS.git.builds["win32-x64"]).toMatchObject({ executable: "usr/bin/bash.exe", from: "usr/bin/sh.exe" });
});

test("from the wire: launch files and the file a program is made from stay inside the copy's folder", () => {
  const good = {
    url: "https://x.example/c.zip",
    hash: { algorithm: "sha256", value: "a".repeat(64) },
    archive: "zip",
    executable: "node.exe",
  };
  const parsed = parseCliPins({
    cursor: { version: "1.2.3", builds: { "win32-x64": { ...good, launch: ["index.js"] } } },
    git: {
      version: "1.2.3",
      builds: { "win32-x64": { ...good, executable: "usr/bin/bash.exe", from: "usr/bin/sh.exe" } },
    },
    grok: { version: "1.2.3", builds: { "win32-x64": { ...good, launch: ["../evil.js"] } } },
    codex: { version: "1.2.3", builds: { "win32-x64": { ...good, from: "/etc/passwd" } } },
  });
  expect(Object.keys(parsed ?? {}).sort()).toEqual(["cursor", "git"]);
  expect(parsed?.cursor?.builds["win32-x64"]?.launch).toEqual(["index.js"]);
  expect(parsed?.git?.builds["win32-x64"]?.from).toBe("usr/bin/sh.exe");
});
