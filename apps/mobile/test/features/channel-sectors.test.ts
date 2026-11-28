import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectorHref } from "../../src/features/channel-sectors/logic";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("a channel's section on the phone (ADR 0260)", () => {
  test("the long press and the ⋯ sheet open Seção, for every channel: the sections are the person's own", () => {
    expect(sectorHref("c 1")).toBe("/channel-sector?channelId=c%201");
    const menus = src("features/channel-sectors/menus.tsx");
    expect(menus).toContain('label: t("sidebarSections.moveTo"),');
    expect(menus).toContain("run: () => router.push(sectorHref(channel.id)),");
    expect(menus).toContain('label: pinned ? t("sidebarFavorites.remove") : t("sidebarFavorites.add"),');
    const sheets = src("features/chat/sheets.tsx");
    expect(sheets).toContain("router.push(sectorHref(channelId));");
    expect(sheets).toContain('label: t("mobile.sections.title"),');
  });

  test("Seção moves the channel among my sections, makes a new one with it, and steps it inside its section", () => {
    const pick = src("features/channel-sectors/PickSectorScreen.tsx");
    expect(pick).toContain("placeInSection(now.sections ?? [], channelId, sectionId)");
    expect(pick).toContain("addSection(now.sections ?? [], name, [channelId]).sections");
    expect(pick).toContain("moveChannelBy(now.sections ?? [], channelId, delta)");
    // Nothing goes to the server's sectors from here.
    expect(pick).not.toContain("usePlaceChannel");
  });

  test("Conversas' Seções: a closed section keeps its live rows and counts them as one, with no sector's mark", () => {
    const home = src("features/chats/ChatsScreen.tsx");
    expect(home).toContain("kept: section.rows.filter(keptWhenClosed).map((r, i) => rowOf(r, i, true)),");
    expect(home).toContain("count: unread,");
    expect(home).not.toContain("<RoleMark");
    expect(home).toContain("sectorSections(withoutQuietGeneral(pinned.rows, hideGeneral), ownSections ?? [])");
  });
});
