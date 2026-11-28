import { describe, expect, test } from "bun:test";
import {
  dayMonthOrder,
  formatList,
  formatMoneyUsd,
  formatPhone,
  formatSpan,
  formatTime,
  joinList,
  maskPhone,
  plural,
  relativeTime,
} from "../src/format";
import { LOCALES } from "../src/locale";

describe("Intl formatting", () => {
  test("lists in each language's own way", () => {
    expect(formatList("ja-JP", ["a", "b", "c"])).toBe("a、b、c");
    expect(formatList("en-US", ["Ada", "Atlas", "Theo"])).toBe("Ada, Atlas, and Theo");
    expect(formatList("pt-BR", ["Ada", "Theo"])).toBe("Ada e Theo");
  });

  test("without Intl.ListFormat (the phone's Hermes), each language's own list words, as Intl.ListFormat says them", () => {
    for (const { code, intl } of LOCALES)
      for (const type of ["conjunction", "disjunction"] as const)
        for (const items of [[], ["Ada"], ["Ada", "Bruno"], ["Ada", "Bruno", "Theo"], ["Ada", "Bruno", "Theo", "Zoe"]])
          expect([code, type, joinList(intl, items, type)]).toEqual([
            code,
            type,
            new Intl.ListFormat(intl, { type, style: "long" }).format(items),
          ]);
    const listFormat = Object.getOwnPropertyDescriptor(Intl, "ListFormat") as PropertyDescriptor;
    Reflect.deleteProperty(Intl, "ListFormat");
    try {
      expect(formatList("en-US", ["Ada", "Atlas", "Theo"])).toBe("Ada, Atlas, and Theo");
      expect(formatList("pt-BR", ["Ada", "Theo"], "disjunction")).toBe("Ada ou Theo");
      expect(formatList("ja", ["a", "b", "c"])).toBe("a、b、c");
      expect(formatList("xx", ["a", "b"])).toBe("a and b");
    } finally {
      Object.defineProperty(Intl, "ListFormat", listFormat);
    }
  });

  test("dollars where each language writes them, more decimals for tiny amounts", () => {
    expect(formatMoneyUsd("de-DE", 0.42)).toBe("0,42 $");
    expect(formatMoneyUsd("en-US", 0.42)).toBe("$0.42");
    expect(formatMoneyUsd("en-US", 0.004)).toBe("$0.004");
    expect(formatMoneyUsd("en-US", 0.0003)).toBe("$0.0003");
  });

  test("day before or after the month", () => {
    expect(dayMonthOrder("en-US")).toBe("md");
    expect(dayMonthOrder("en-GB")).toBe("dm");
    expect(dayMonthOrder("pt-BR")).toBe("dm");
    expect(dayMonthOrder("ja-JP")).toBe("md");
  });

  test("relative times", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(relativeTime("fr-FR", new Date("2026-11-02T11:58:00Z"), now)).toMatch(/^il y a 2\smin$/);
    expect(relativeTime("ru-RU", new Date("2026-11-01T12:00:00Z"), now)).toBe("вчера");
    expect(relativeTime("en-US", new Date("2026-11-02T11:59:50Z"), now)).toBe("now");
    expect(relativeTime("en-US", new Date("2026-11-05T12:00:00Z"), now)).toBe("in 3 days");
  });

  test("plural picks zero, then the language's category", () => {
    const forms = { zero: "none", one: "one", few: "few", many: "many", other: "other" };
    expect(plural("ru", 0, forms)).toBe("none");
    expect(plural("ru", 3, forms)).toBe("few");
    expect(plural("ru", 5, forms)).toBe("many");
    expect(plural("ja", 1, { other: "x" })).toBe("x");
  });

  test("time by the language's clock", () => {
    const d = new Date(2026, 10, 2, 15, 5);
    expect(formatTime("en-US", d)).toMatch(/^3:05\s?PM$/);
    expect(formatTime("de-DE", d)).toBe("15:05");
  });
});

describe("phone numbers", () => {
  test("each listed country in the way it prints numbers", () => {
    const cases: [string, string][] = [
      ["5511900000001", "+55 (11) 90000-0001"],
      ["551134567890", "+55 (11) 3456-7890"],
      ["12025550123", "+1 (202) 555-0123"],
      ["447700900123", "+44 7700 900123"],
      ["442079460958", "+44 20 7946 0958"],
      ["351912345678", "+351 912 345 678"],
      ["34612345678", "+34 612 345 678"],
      ["33612345678", "+33 6 12 34 56 78"],
      ["4915123456789", "+49 151 23456789"],
      ["493012345678", "+49 30 12345678"],
      ["393123456789", "+39 312 345 6789"],
      ["390212345678", "+39 02 1234 5678"],
      ["31612345678", "+31 6 12345678"],
      ["525512345678", "+52 55 1234 5678"],
      ["5491112345678", "+54 9 11 1234-5678"],
      ["819012345678", "+81 90-1234-5678"],
      ["821012345678", "+82 10-1234-5678"],
      ["6281234567890", "+62 812-3456-7890"],
      ["905321234567", "+90 532 123 45 67"],
      ["48512345678", "+48 512 345 678"],
      ["919876543210", "+91 98765 43210"],
    ];
    for (const [stored, shown] of cases) expect(formatPhone(stored)).toBe(shown);
  });

  test("any other country gets the generic grouping, never a bare run", () => {
    expect(formatPhone("971501234567")).toBe("+971 50 123 4567");
    expect(formatPhone("79161234567")).toBe("+7 916 123 4567");
    expect(formatPhone("5511123")).toBe("5511123");
    expect(formatPhone("55119000000")).toBe("+55 11 900 0000");
  });

  test("a leading + reads the same, a handle comes back as given", () => {
    expect(formatPhone("+5511900000001")).toBe("+55 (11) 90000-0001");
    expect(formatPhone("ana.example")).toBe("ana.example");
    expect(formatPhone("@ana")).toBe("@ana");
    expect(formatPhone("1234567890123456")).toBe("1234567890123456");
    expect(formatPhone("+0012345678")).toBe("+0012345678");
  });

  test("masked: the country and area codes and the last four digits", () => {
    expect(maskPhone("5511900000001")).toBe("+55 (11) •••••-0001");
    expect(maskPhone("551134567890")).toBe("+55 (11) ••••-7890");
    expect(maskPhone("+12025550123")).toBe("+1 (202) •••-0123");
    expect(maskPhone("447700900123")).toBe("+44 •••• ••0123");
    expect(maskPhone("ana.example")).toBe("ana.example");
  });
});

test("formatSpan: how long something lasted, to the minute, in the language's own units", () => {
  expect(formatSpan("en", 20_000)).toBe("1 min");
  expect(formatSpan("en", 42 * 60_000)).toBe("42 min");
  expect(formatSpan("en", 120 * 60_000)).toBe("2 hr");
  expect(formatSpan("pt-BR", 125 * 60_000)).toBe("2 h 5 min");
  // ICU's data spaces Japanese units differently by platform.
  expect(formatSpan("ja", 125 * 60_000)).toMatch(/^2 ?時間 5 ?分$/);
});
