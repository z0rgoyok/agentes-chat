import { describe, expect, test } from "bun:test";
import { isManagedPlace, MANAGED_SERVER, requireManagedPlace } from "../src/lib/managed-server";
import { claimedPrefixes, currentServer, prefixesFrom, withPrefix } from "../src/lib/server-choice";

describe("managed mobile service", () => {
  test("keeps accounts on Rooms", () => {
    for (const place of [MANAGED_SERVER, `${MANAGED_SERVER}#account-2`]) {
      expect(isManagedPlace(place)).toBe(true);
      expect(requireManagedPlace(place)).toBe(place);
    }
  });
  test("rejects other servers and misleading addresses", () => {
    for (const place of [
      "https://app.agentes.chat",
      "http://rooms.tich.app",
      "https://rooms.tich.app.evil.test",
      "https://rooms.tich.app@evil.test",
      `${MANAGED_SERVER}/other`,
      `${MANAGED_SERVER}?server=other`,
      `${MANAGED_SERVER}#invalid/id`,
    ]) {
      expect(isManagedPlace(place)).toBe(false);
      expect(() => requireManagedPlace(place)).toThrow();
    }
  });
  test("existing Rooms sessions keep their storage prefix", () => {
    const account = `${MANAGED_SERVER}#account-2`;
    const saved = JSON.stringify({ [MANAGED_SERVER]: "agenteschat", [account]: "agenteschat_account2" });
    const restored = currentServer(account, MANAGED_SERVER);
    const prefixes = claimedPrefixes(prefixesFrom(saved, restored, "agenteschat"), [account], "agenteschat");
    expect(prefixes[restored]).toBe("agenteschat_account2");
  });
  test("an old foreign session is never relabelled as a Rooms session", () => {
    const old = currentServer("https://app.agentes.chat", MANAGED_SERVER);
    const prefixes = prefixesFrom(null, old, "agenteschat");
    const next = withPrefix(prefixes, MANAGED_SERVER, "agenteschat", () => "fresh");
    expect(next[MANAGED_SERVER]).toBe("agenteschat_fresh");
    expect(next[old]).toBe("agenteschat");
  });
});
