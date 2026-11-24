import { expect, mock, test } from "bun:test";

// A phone set to Brazilian Portuguese, with nothing chosen in the app yet.
mock.module("expo-localization", () => ({ getLocales: () => [{ languageTag: "pt-BR" }] }));
mock.module("expo-constants", () => ({ default: {} }));
mock.module("expo-secure-store", () => ({
  getItem: () => null,
  setItem: () => undefined,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

const { setupI18n } = await import("../src/providers/i18n");

test("a launch in another language parses only that one; English comes the first time a key needs it", () => {
  const i18n = setupI18n();
  expect(i18n.language).toBe("pt-BR");
  expect(i18n.hasResourceBundle("pt-BR", "translation")).toBe(true);
  expect(i18n.hasResourceBundle("en", "translation")).toBe(false);
  const t = i18n.t as (key: string, options?: Record<string, unknown>) => string;
  expect(t("mobile.time.yesterday")).toBe("Ontem");
  expect(i18n.hasResourceBundle("en", "translation")).toBe(false);

  // A key this language lacks (here: its strings swapped for one line): English's, interpolated as it would be.
  i18n.removeResourceBundle("pt-BR", "translation");
  i18n.addResourceBundle("pt-BR", "translation", { onlyHere: "só aqui" });
  expect(t("onlyHere")).toBe("só aqui");
  expect(t("mobile.time.yesterday")).toBe("Yesterday");
  expect(i18n.hasResourceBundle("en", "translation")).toBe(true);
  // Missing everywhere: the key, or the default asked for, as i18next shows it.
  expect(t("nowhere.at.all")).toBe("nowhere.at.all");
  expect(t("nowhere.at.all", { defaultValue: "Olá {{name}}", name: "Ana" })).toBe("Olá Ana");
});
