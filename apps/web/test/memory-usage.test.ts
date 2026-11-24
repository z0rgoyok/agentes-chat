import { expect, test } from "bun:test";
import type { Memory } from "@agenteschat/client";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { usageLabel } from "../src/pages/MemoryPage";

test("unused memories resolve the locale's plural form, including Russian without an explicit zero key", async () => {
  for (const [lng, expected] of [
    ["ru", "использовано 0 раз"],
    ["en", "never used"],
  ] as const) {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources, initAsync: false });
    expect(usageLabel(i18n.t, { uses: 0, archived: false } as Memory)).toBe(expected);
  }
});
