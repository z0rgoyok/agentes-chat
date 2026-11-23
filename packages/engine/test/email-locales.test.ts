import { describe, expect, test } from "bun:test";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { deepMerge } from "@agenteschat/i18n/tree";
import { type EmailTemplate, emailLocale, renderEmail } from "../src";
import { WORDS, wordsFor } from "../src/email/words";
import { en } from "../src/email/words/en";
import { EMAIL_SAMPLES } from "./email-samples";

/** Each sample once (its English variant), in every language of the app. */
const SAMPLES = Object.entries(EMAIL_SAMPLES).filter(([id]) => !id.includes(".pt-BR"));

describe("every email in every language (ADR 0122)", () => {
  for (const locale of LOCALE_CODES) {
    test(locale, () => {
      for (const [id, sample] of SAMPLES) {
        const e = renderEmail({ ...sample, locale } as EmailTemplate);
        const all = `${e.subject}\n${e.preheader}\n${e.html}\n${e.text}`;
        expect({ id, bad: all.match(/undefined|NaN|\{\{|\[object Object\]/)?.[0] ?? null }).toEqual({ id, bad: null });
        expect(e.html).toContain(`<html lang="${locale}"`);
        // With the pictures off, the phone's alt is the stage's only words.
        if (id.startsWith("surface_")) {
          const alt = e.html.match(/\/phone(?:-off)?\.png" [^>]*alt="([^"]*)"/)?.[1] ?? "";
          expect({ id, alt: alt.length > 0, punctuation: /[;!—]/.test(alt) }).toEqual({
            id,
            alt: true,
            punctuation: false,
          });
        }
      }
    });
  }

  test("counts read right at 0, 1, 2, 5 and 21 in every language", () => {
    for (const locale of LOCALE_CODES) {
      const w = wordsFor(locale);
      for (const n of [0, 1, 2, 5, 21]) {
        for (const s of [w.digest.subject(n), w.digest.headline(n), w.digest.button(n)])
          expect(s).not.toMatch(/undefined|\{\{/);
      }
    }
    expect(wordsFor("en").digest.subject(1)).toBe("A request is waiting for your approval");
    expect(wordsFor("en").digest.subject(2)).toBe("2 requests are waiting for your approval");
  });

  test("an answer to a support request: every language has the four sentences and the frame in its own words", () => {
    const keys = (group: object): string[] =>
      Object.entries(group).flatMap(([key, value]) =>
        value && typeof value === "object" ? keys(value).map((k) => `${key}.${k}`) : [key],
      );
    const all = keys(en.supportReply);
    expect(all).toEqual([
      "subject",
      "preheader",
      "headline",
      "answers.received",
      "answers.need_more",
      "answers.resolved",
      "answers.handed_over",
      "from",
      "ai",
      "reply",
      "why",
    ]);
    const said = (locale: (typeof LOCALE_CODES)[number]) => {
      const c = wordsFor(locale).supportReply;
      const texts = [c.subject, c.preheader, c.headline, ...Object.values(c.answers), c.ai, c.why];
      const built = [c.from(null), c.from("chat.example.com"), c.reply("help@example.com")];
      return [...texts, ...built.map((text) => JSON.stringify(text))];
    };
    for (const locale of LOCALE_CODES) {
      // Its own file holds each one: none is English's by fallback.
      expect({ locale, has: keys(WORDS[locale].supportReply ?? {}) }).toEqual({ locale, has: all });
      if (locale === "en") continue;
      const same = said(locale).filter((text, i) => text === said("en")[i]);
      expect({ locale, same }).toEqual({ locale, same: [] });
      // No semicolon or em dash in our words.
      expect({ locale, mark: said(locale).join("\n").match(/—|;/)?.[0] ?? null }).toEqual({ locale, mark: null });
    }
  });

  test("a language without a word falls back to English's", () => {
    const partial = deepMerge(en, { verify: { headline: "Bestätige" } });
    expect(partial.verify.subject).toBe(en.verify.subject);
    expect(wordsFor("pt-BR").verify.subject).not.toBe(wordsFor("en").verify.subject);
  });

  test("the recipient's language: any of the app's, else English", () => {
    expect(emailLocale("ja")).toBe("ja");
    expect(emailLocale("pt-PT")).toBe("pt-BR");
    expect(emailLocale("xx")).toBe("en");
    expect(emailLocale(null)).toBe("en");
  });
});
