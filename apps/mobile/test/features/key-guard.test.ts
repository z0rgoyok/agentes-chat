import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeApiKey } from "@agenteschat/client/lib/api-key-text";
import { connectAiNow, handKeyToConnectAi, startConnectAi } from "../../src/features/ai/connect-flow";
import { handKeyToVault, keyGuardChoices, keyGuardTitle, takeKeyForVault } from "../../src/features/chat/key-guard";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

// Made-up keys with real shapes, joined at run time so secret scanners don't read them as real.
const ANTHROPIC = ["sk", "ant", "api03", "Zq8xW2pL5mN7vR1tY4uI9oP3aS6dF0gH"].join("-");
const GITHUB = ["ghp", "Fake0Fake1Fake2Fake3Fake4Fake5Fake6F"].join("_");

const found = (text: string) => {
  const key = looksLikeApiKey(text);
  if (!key) throw new Error(`no key in ${text}`);
  return key;
};

describe("the phone's key guard (the web's KeyGuardDialog)", () => {
  test("the Vault first for anyone; the AI key only for an AI key and who manages the workspace's keys", () => {
    expect(keyGuardChoices(found(ANTHROPIC), true)).toEqual(["vault", "ai", "remove", "send"]);
    expect(keyGuardChoices(found(ANTHROPIC), false)).toEqual(["vault", "remove", "send"]);
    expect(keyGuardChoices(found(GITHUB), true)).toEqual(["vault", "remove", "send"]);
    expect(keyGuardTitle(found(ANTHROPIC))).toBe("keyGuard.title");
    expect(keyGuardTitle(found(GITHUB))).toBe("keyGuard.titleSecret");
  });

  test("the key reaches the Vault's new item once, never in a link", () => {
    handKeyToVault(found(`o token ${GITHUB}`));
    expect(takeKeyForVault()).toEqual({ keyName: "GITHUB_TOKEN", secret: GITHUB });
    expect(takeKeyForVault()).toBeNull();
    const screen = src("features/vault/VaultNewScreen.tsx");
    expect(screen).toContain("useState(takeKeyForVault)");
    // Saved from the chat: one line on how agents use it, then back to the conversation.
    expect(screen).toMatch(/if \(handed\) \{[\s\S]*?keyGuard\.saved[\s\S]*?router\.back\(\)/);
  });

  test("Usar como chave de IA opens the flow's key page with the key typed, its maker guessed", () => {
    handKeyToConnectAi(ANTHROPIC);
    const id = startConnectAi({ intent: "api_key" });
    expect(connectAiNow(id)?.key).toMatchObject({ text: ANTHROPIC, provider: "anthropic" });
    expect(connectAiNow(startConnectAi({}))?.key.text).toBe("");
  });

  test("every way out of the composer asks first: a send, with files or a slash, and a voice take's words", () => {
    const chat = chatScreenSource();
    const send = chat.slice(chat.indexOf("const onSend = ("), chat.indexOf("const cmd = parseSlash(text);"));
    expect(send).toContain("const found = keyChecked ? null : looksLikeApiKey(text);");
    // Before the files' send, which would take the words along as their caption.
    expect(send.indexOf("guardKey(")).toBeLessThan(send.indexOf("sendWithFiles("));
    const voice = chat.slice(chat.indexOf("const withVoice = async"), chat.indexOf("const onRecording ="));
    expect(voice).toContain('const text = found ? "" : typed;');
    // A sheet dismissed with no pick gives the words back as typed.
    expect(chat).toContain("{ onClose: () => !picked && back(text) }");
  });
});
