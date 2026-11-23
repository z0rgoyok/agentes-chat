import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { categoryHrefs, channelSteps, movesChannel, stepBefore } from "../../src/features/categories/logic";

const screens = () => readFileSync(join(import.meta.dir, "../../src/features/categories/CategoryScreens.tsx"), "utf8");

describe("arranging categories", () => {
  test("moving one step up or down says what it then sits before", () => {
    const ids = ["a", "b", "c"];
    expect(stepBefore(ids, "c", -1)).toBe("b");
    expect(stepBefore(ids, "a", 1)).toBe("c");
    expect(stepBefore(ids, "b", 1)).toBeNull();
    expect(stepBefore(ids, "a", -1)).toBeUndefined();
    expect(stepBefore(ids, "c", 1)).toBeUndefined();
  });

  test("a channel moves one step among the ones of its category, or the ones with none", () => {
    const list = [
      { id: "general", categoryId: null },
      { id: "bugs", categoryId: "eng" },
      { id: "avisos" },
      { id: "tech", categoryId: "eng" },
      { id: "vendas", categoryId: null },
    ];
    expect(channelSteps(list, "avisos")).toEqual({
      at: 1,
      count: 3,
      up: { channelId: "avisos", categoryId: null, beforeChannelId: "general" },
      down: { channelId: "avisos", categoryId: null, beforeChannelId: null },
    });
    expect(channelSteps(list, "general").up).toBeUndefined();
    expect(channelSteps(list, "tech")).toEqual({
      at: 1,
      count: 2,
      up: { channelId: "tech", categoryId: "eng", beforeChannelId: "bugs" },
      down: undefined,
    });
  });

  test("a channel's creator still in it, or who manages channels, may move it", () => {
    const member = { role: "member" as const, permissions: ["read", "post"] };
    const manager = { role: "member" as const, permissions: ["read", "manage_channels"] };
    expect(movesChannel({ isMember: true, createdByUserId: "u1" }, "u1", member)).toBe(true);
    expect(movesChannel({ isMember: false, createdByUserId: "u1" }, "u1", member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", manager)).toBe(true);
    expect(movesChannel({ createdByUserId: null }, null, member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", undefined)).toBe(false);
  });

  test("the screens' addresses", () => {
    expect(categoryHrefs.pick("c 1")).toBe("/channel-category?channelId=c%201");
    expect(categoryHrefs.create()).toBe("/channel-category-new");
    expect(categoryHrefs.edit("x")).toBe("/channel-category-edit?id=x");
    expect(categoryHrefs.manage).toBe("/channel-categories");
  });

  test("with no category sections on the home, admins reach Categorias from a channel's Categoria", () => {
    const code = screens();
    const pick = code.slice(
      code.indexOf("export function PickCategoryScreen"),
      code.indexOf("export function CategoriesScreen"),
    );
    const admins = pick.slice(pick.indexOf("{arrangesCategories(org) ? ("));
    expect(admins).toContain("onPress={() => router.push(categoryHrefs.create(channelId))}");
    expect(admins).toContain('label={t("mobile.categories.title")}');
    expect(admins).toContain("onPress={() => router.push(categoryHrefs.manage)}");
    // The home's category header menu is gone with its sections.
    const menus = readFileSync(join(import.meta.dir, "../../src/features/categories/menus.tsx"), "utf8");
    expect(menus).not.toContain("categoryMenu");
    expect(menus).toContain("return { openRowMenu, rowActionsOf, pinLabelOf };");
  });
});

describe("Nova categoria on the phone", () => {
  test("the category being made never reads as taken: the name is checked against the list from before Criar", () => {
    expect(screens()).toMatch(
      /const taken = useHeldWhile\(\s*\(categories\.data \?\? \[\]\)\.some\([^;]*\),\s*create\.isPending \|\| create\.isSuccess,\s*\);/,
    );
  });
});
