import type { AppLocale } from "@agenteschat/i18n/locale";
import type { LocaleStrings } from "@agenteschat/i18n/plurals";
import { featureKeysEn } from "./keys.en";
import { featureKeysPtBR } from "./keys.pt-BR";

/**
 * The screens' strings per language. The other languages are getters: Metro bundles every file but runs one only on
 * its first `require`, so the phone parses only the language it shows (as the shared strings, `providers/i18n.ts`).
 */
export const FEATURES: Record<AppLocale, LocaleStrings> = {
  en: featureKeysEn,
  "pt-BR": featureKeysPtBR,
  get es() {
    return require("./locales/es.json");
  },
  get fr() {
    return require("./locales/fr.json");
  },
  get de() {
    return require("./locales/de.json");
  },
  get it() {
    return require("./locales/it.json");
  },
  get nl() {
    return require("./locales/nl.json");
  },
  get ja() {
    return require("./locales/ja.json");
  },
  get ko() {
    return require("./locales/ko.json");
  },
  get "zh-Hans"() {
    return require("./locales/zh-Hans.json");
  },
  get id() {
    return require("./locales/id.json");
  },
  get tr() {
    return require("./locales/tr.json");
  },
  get pl() {
    return require("./locales/pl.json");
  },
  get ru() {
    return require("./locales/ru.json");
  },
};
