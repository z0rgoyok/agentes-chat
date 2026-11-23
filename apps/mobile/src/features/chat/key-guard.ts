import type { FoundKey } from "@agenteschat/client/lib/api-key-text";

/**
 * The key guard's choices, top to bottom (the web's `KeyGuardDialog`): the Vault for anyone, the workspace's AI key
 * only for an AI provider's key and who manages the workspace's keys (with no billing hold on plans), then taking it out
 * of the text or sending it as typed.
 */
export type KeyGuardChoice = "vault" | "ai" | "remove" | "send";

export const keyGuardChoices = (found: FoundKey, managesKeys: boolean): KeyGuardChoice[] =>
  found.ai && managesKeys ? ["vault", "ai", "remove", "send"] : ["vault", "remove", "send"];

export const keyGuardTitle = (found: FoundKey) => (found.ai ? "keyGuard.title" : "keyGuard.titleSecret");

/**
 * A key the chat caught reaches the Vault's new item here, never in a link (a route would carry the secret in its
 * address). The new item's screen takes it as it opens.
 */
let handed: { keyName: string; secret: string } | null = null;

export function handKeyToVault(found: FoundKey) {
  handed = { keyName: found.name, secret: found.key };
}

export function takeKeyForVault() {
  const key = handed;
  handed = null;
  return key;
}
