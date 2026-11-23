import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const APP = join(import.meta.dir, "..", "..", "app", "(app)", "(main)");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("archived channels, on the phone too", () => {
  test("archived channels are listed for who may bring them back, each with Restaurar", () => {
    expect(existsSync(join(APP, "archived-channels.tsx"))).toBe(true);
    const list = src("features/chats/ArchivedChannelsScreen.tsx");
    expect(list).toContain("useArchivedChannels");
    expect(list).toContain("useUnarchiveChannel");
    // Reached from You › Work while there are some, no longer from the end of Conversas.
    expect(src("features/me/MeScreen.tsx")).toContain('onPress={() => open("/archived-channels")}');
    expect(src("features/chats/ChatsScreen.tsx")).not.toContain('"/archived-channels"');
    // An archived #channel's card, as the web's: Restaurar for who may.
    expect(src("features/chat/ChannelRefText.tsx")).toContain("useArchivedChannels");
  });
});
