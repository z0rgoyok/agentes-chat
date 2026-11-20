import { expect, test } from "bun:test";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { formatClock, formatTime } from "../src/lib/format";

const AT = "2026-11-14T23:43:00Z";

test("a gutter's clock drops only the day period: digits and their separator, never a space to wrap at", () => {
  for (const locale of [...LOCALE_CODES, "en-US", "ko", "ar", "hi", "es-MX"]) {
    const clock = formatClock(locale, AT);
    // Hours and minutes as the whole time writes them, in its digits.
    expect(formatTime(locale, AT)).toContain(clock);
    expect(clock).toMatch(/^\p{Nd}{1,2}[^\s\p{Nd}]\p{Nd}{2}$/u);
  }
  expect(formatTime("en-US", AT)).toMatch(/[AP]M$/);
  expect(formatClock("pt-BR", AT)).toBe(formatTime("pt-BR", AT));
});

test("a time made after the device changes time zone is in the new zone", () => {
  const was = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    expect(formatTime("en-GB", AT)).toBe("23:43");
    process.env.TZ = "Asia/Tokyo";
    expect(formatTime("en-GB", AT)).toBe("08:43");
  } finally {
    process.env.TZ = was;
  }
});
