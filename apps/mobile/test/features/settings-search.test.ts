import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgSummary } from "@agenteschat/client";
import { resources } from "@agenteschat/i18n";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { findSettings, settingsIndex } from "../../src/features/settings/settings-search";
import { withMobileKeys } from "../../src/i18n/merge";

const ALL = ["read", "invite_people", "view_audit", "view_usage", "manage_agents", "configure", "create_agents"];
const org = (
  permissions: string[],
  more: Partial<Pick<OrgSummary, "mode" | "start" | "showActivity" | "chatPrefs" | "agentStyle">> = {},
) => ({ id: "o", name: "Acme", role: "owner" as const, permissions, ...more }) as unknown as OrgSummary;
const merged = withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn });
/** The phone's words for a key, in a language, as `t` reads them (nested objects by its dots). */
const words = (lng: "pt-BR" | "en") => (key: string) => {
  const found = key
    .split(".")
    .reduce<unknown>(
      (at, k) => (at && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined),
      merged[lng]?.translation,
    );
  return typeof found === "string" ? found : key;
};
const t = words("pt-BR");
const src = (file: string) => readFileSync(join(import.meta.dir, "..", "..", file), "utf8");

describe("settings found by name (Você's magnifier, the Buscar tab)", () => {
  test("every name, place and word it reads exists in both languages", () => {
    const everything = settingsIndex({
      org: org([...ALL, "manage_roles"], {
        start: "home",
        showActivity: true,
        chatPrefs: {},
        agentStyle: "simple",
      } as never),
      appIcon: true,
      about: true,
    });
    for (const lng of ["pt-BR", "en"] as const) {
      const say = words(lng);
      const keys = everything.flatMap((e) => [e.label, ...e.path, ...(e.words ? [e.words] : [])]);
      expect(keys.filter((k) => say(k) === k)).toEqual([]);
    }
  });

  test("only what this person has here: the workspace's as its settings list them, Você's rows as Você shows them", () => {
    const ids = (permissions: string[], more = {}) => settingsIndex({ org: org(permissions, more) }).map((e) => e.id);
    // A member who may not configure: no Geral, no Cargos, no audit; what everyone opens is there.
    const member = ids(["read"]);
    expect(member).not.toContain("general");
    expect(member).not.toContain("roles");
    expect(member).not.toContain("audit");
    expect(member).toEqual(
      expect.arrayContaining(["usage", "connectors", "vault", "aiAccounts", "language", "account"]),
    );
    // Rows Você leaves out on a server from before them, and the ones this phone or server doesn't offer.
    expect(member).not.toContain("start");
    expect(member).not.toContain("appIcon");
    expect(member).not.toContain("about");
    expect(ids(["read"], { start: "home" })).toContain("start");
    // An admin's include the workspace itself.
    expect(ids([...ALL, "manage_roles"])).toEqual(expect.arrayContaining(["general", "roles", "audit", "members"]));
  });

  test("each says where it lives: Você's under Você, a team's under Configurações and its group", () => {
    const index = settingsIndex({ org: org([...ALL, "manage_roles"]) });
    const where = (id: string) =>
      index
        .find((e) => e.id === id)
        ?.path.map(t)
        .join(" › ");
    expect(where("notifications")).toBe("Você › Preferências");
    expect(where("deleteAccount")).toBe("Você › Conta");
    expect(where("vault")).toBe("Configurações › Conectores");
    expect(where("roles")).toBe("Configurações › Pessoas");
    expect(where("aiAccounts")).toBe("Configurações › IA e uso");
    // A personal workspace (ADR 0159 §3): its short list under Configurações, the rest under Avançado.
    const personal = settingsIndex({ org: org([...ALL, "manage_roles"], { mode: "personal" }), others: 0 });
    expect(personal.find((e) => e.id === "usage")?.path.map(t)).toEqual(["Configurações"]);
    expect(personal.find((e) => e.id === "audit")?.path.map(t)).toEqual(["Configurações", "Avançado"]);
    expect(personal.find((e) => e.id === "approvals")?.path.map(t)).toEqual(["Configurações", "Avançado"]);
  });

  test("a name that starts with the words comes first, then a word inside it, then the other words, then the place", () => {
    const index = settingsIndex({ org: org([...ALL, "manage_roles"]) });
    const names = (q: string) => findSettings(q, index, t).map((f) => f.name);
    // "conta": Conta and Contas de IA by their names before anything that only says it elsewhere.
    expect(names("conta").slice(0, 2)).toEqual(["Conta", "Contas de IA"]);
    expect(names("conta")).toContain("Apagar conta");
    // Accents and case aside, and every word must be somewhere.
    expect(names("NOTIFICACOES")).toEqual(["Notificações"]);
    expect(names("tema escuro")).toEqual(["Aparência"]);
    expect(names("senhas")[0]).toBe("Cofre");
    expect(names("")).toEqual([]);
    expect(names("zzz")).toEqual([]);
    // Sons and Aparência change in their menu: no screen to push.
    const look = findSettings("aparência", index, t)[0]?.entry;
    expect(look?.pick).toBe("appearance");
    expect(look?.href).toBeUndefined();
  });

  test("Você's magnifier pushes the search; the Buscar tab lists Configurações before the conversations", () => {
    const me = src("src/features/me/MeScreen.tsx");
    expect(me).toContain('sf: "magnifyingglass",');
    expect(me).toContain('onPress: () => pushScreen("/me/search"),');
    expect(me).toContain('action={{ label: t("mobile.me.edit"), onPress: () => open("/me/account"), opens: true }}');
    expect(src("app/(app)/(main)/me/search.tsx")).toContain("<SettingsSearchScreen />");
    const results = src("src/features/search/SearchResults.tsx");
    expect(results.indexOf('t("settings.title")')).toBeLessThan(results.indexOf('t("mobile.find.conversations")'));
    expect(results).toContain("isEmpty(r) && settingItems.length === 0");
  });
});
