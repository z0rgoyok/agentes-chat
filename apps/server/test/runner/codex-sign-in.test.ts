import { afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCodexAccount } from "../../runner/codex-account";
import { codexAccountOf, codexLoginStatusOf } from "../../runner/codex-sign-in";
import { detectExecutors } from "../../runner/executors";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const ACCOUNT = process.env.FAKE_CODEX_ACCOUNT;
const NO_APP = process.env.FAKE_CODEX_NO_APP;
afterEach(() => {
  if (ACCOUNT === undefined) delete process.env.FAKE_CODEX_ACCOUNT;
  else process.env.FAKE_CODEX_ACCOUNT = ACCOUNT;
  if (NO_APP === undefined) delete process.env.FAKE_CODEX_NO_APP;
  else process.env.FAKE_CODEX_NO_APP = NO_APP;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-codex-app.mjs");
const NOT_FOUND = { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) };

function fakeCodex() {
  const root = tempDir("codex-sign-in-");
  dirs.push(root);
  const bin = path.join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("codex login status: ChatGPT and an API key are signed in, anything else isn't", () => {
  expect(codexLoginStatusOf(0, "Logged in using ChatGPT\n")).toEqual({ loggedIn: true, authMethod: "chatgpt" });
  // An `auth.json` with a key only (an older `codex login --api-key`): its hint is never kept.
  expect(codexLoginStatusOf(0, "API key configured - sk-proj-***abcd\n")).toEqual({
    loggedIn: true,
    authMethod: "api_key",
  });
  expect(codexLoginStatusOf(0, "Logged in using an API key - sk-***abcd\n")).toEqual({
    loggedIn: true,
    authMethod: "api_key",
  });
  expect(codexLoginStatusOf(1, "Not logged in\n")).toEqual({ loggedIn: false });
  expect(codexLoginStatusOf(0, "Not logged in\n")).toEqual({ loggedIn: false });
  expect(codexLoginStatusOf(null, "")).toEqual({ loggedIn: false });
});

test("account/read: a ChatGPT plan, an API key, a model provider of its own, or signed out", () => {
  const chatgpt = { account: { type: "chatgpt", planType: "pro", email: null }, requiresOpenaiAuth: true };
  expect(codexAccountOf(chatgpt)).toEqual({ loggedIn: true, authMethod: "chatgpt", plan: "pro" });
  expect(codexAccountOf({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toEqual({
    loggedIn: true,
    authMethod: "api_key",
  });
  // A provider in config.toml that needs no OpenAI sign-in thinks as it is.
  expect(codexAccountOf({ account: null, requiresOpenaiAuth: false })).toEqual({
    loggedIn: true,
    authMethod: "provider",
  });
  expect(codexAccountOf({ account: null, requiresOpenaiAuth: true })).toEqual({ loggedIn: false });
  expect(codexAccountOf({ account: null })).toEqual({ loggedIn: false });
  // A plan word that isn't one is left out.
  expect(codexAccountOf({ account: { type: "chatgpt", planType: "a b c" } })).toEqual({
    loggedIn: true,
    authMethod: "chatgpt",
  });
  expect(codexAccountOf(null)).toBeNull();
  expect(codexAccountOf({ account: "x" })).toBeNull();
});

test.if(posix)("readCodexAccount asks the app-server, and says nothing where it can't", async () => {
  const bin = fakeCodex();
  expect(await readCodexAccount({ bin, version: "codex-cli 0.169.0" })).toEqual({
    loggedIn: true,
    authMethod: "chatgpt",
    plan: "plus",
  });
  process.env.FAKE_CODEX_ACCOUNT = "apiKey";
  expect(await readCodexAccount({ bin, version: "codex-cli 0.169.0" })).toEqual({
    loggedIn: true,
    authMethod: "api_key",
  });
  process.env.FAKE_CODEX_ACCOUNT = "provider";
  expect(await readCodexAccount({ bin, version: "codex-cli 0.169.0" })).toEqual({
    loggedIn: true,
    authMethod: "provider",
  });
  process.env.FAKE_CODEX_ACCOUNT = "none";
  expect(await readCodexAccount({ bin, version: "codex-cli 0.169.0" })).toEqual({ loggedIn: false });
  // Too old for the app-server this reads: never started.
  expect(await readCodexAccount({ bin, version: "codex-cli 0.100.0" })).toBeNull();
  // No app-server (an older CLI that says otherwise): no answer, not "signed out".
  process.env.FAKE_CODEX_NO_APP = "1";
  expect(await readCodexAccount({ bin, version: "codex-cli 0.169.0", timeoutMs: 3000 })).toBeNull();
});

test("detection: the computer's own Codex says how it is signed in, only when asked", async () => {
  const run = (command: string, args: string[]) => {
    if (command !== "codex") return { ...NOT_FOUND };
    if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.169.0\n" };
    if (args[0] === "login") return { status: 0, stdout: "", stderr: "API key configured - sk-***abcd\n" };
    return { ...NOT_FOUND };
  };
  // Without the question, only its version (as before).
  expect((await detectExecutors(run)).found.codex).toEqual({ version: "codex-cli 0.169.0" });
  // The app-server answers: its word stands, a sign-out included.
  const provider = async () => ({ loggedIn: true, authMethod: "provider" as const });
  expect((await detectExecutors(run, {}, {}, undefined, undefined, undefined, provider)).found.codex).toEqual({
    version: "codex-cli 0.169.0",
    loggedIn: true,
    authMethod: "provider",
  });
  const out = async () => ({ loggedIn: false });
  expect((await detectExecutors(run, {}, {}, undefined, undefined, undefined, out)).found.codex).toEqual({
    version: "codex-cli 0.169.0",
    loggedIn: false,
  });
  // It couldn't tell: `codex login status`, believed on a sign-in only.
  const unknown = async () => null;
  expect((await detectExecutors(run, {}, {}, undefined, undefined, undefined, unknown)).found.codex).toEqual({
    version: "codex-cli 0.169.0",
    loggedIn: true,
    authMethod: "api_key",
  });
  const signedOut = (command: string, args: string[]) =>
    args[0] === "login" ? { status: 1, stdout: "Not logged in\n" } : run(command, args);
  expect((await detectExecutors(signedOut, {}, {}, undefined, undefined, undefined, unknown)).found.codex).toEqual({
    version: "codex-cli 0.169.0",
  });
});
