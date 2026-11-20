/**
 * Dates, numbers, money, lists and plurals through the built-in Intl APIs, for the apps and the engine alike. `locale`
 * is an Intl tag (`intlLocale`) or an app code: both work.
 */

/** A plural form from `forms`: `zero` at 0 when given, else the language's category, else `other`. */
export function plural(
  locale: string,
  n: number,
  forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string },
): string {
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  return forms[new Intl.PluralRules(locale).select(n)] ?? forms.other;
}

/** "Ada, Atlas and Theo", "Ada、Atlas、Theo". */
export const formatList = (
  locale: string,
  items: readonly string[],
  type: Intl.ListFormatType = "conjunction",
): string => new Intl.ListFormat(locale, { type, style: "long" }).format(items);

/**
 * US dollars in the language's own way ("$0.42", "US$ 0,42", "0,42 $"), with more decimals for tiny amounts: 3 under
 * a cent, 4 under a tenth of one.
 */
export function formatMoneyUsd(locale: string, n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 || abs >= 0.01 ? 2 : abs >= 0.001 ? 3 : 4;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export const formatDate = (locale: string, d: Date | string | number, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, opts).format(new Date(d));

/** "10:42", "10:42 AM", by the language's own clock. */
export const formatTime = (locale: string, d: Date | string | number) =>
  formatDate(locale, d, { hour: "numeric", minute: "2-digit" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 min ago", "yesterday", "in 3 days", "now" (under a minute). */
export function relativeTime(locale: string, d: Date | string | number, now: Date = new Date()): string {
  const diff = new Date(d).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit);
  return rtf.format(0, "second");
}

/** Whether the language writes the day before the month ("24/10") or after it ("10/24", "10月24日"). */
export function dayMonthOrder(locale: string): "dm" | "md" {
  const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric" }).formatToParts(
    new Date(2026, 9, 24),
  );
  const day = parts.findIndex((p) => p.type === "day");
  const month = parts.findIndex((p) => p.type === "month");
  return day < month ? "dm" : "md";
}

/** Country calling codes of one or two digits. Every other code has three: the codes are prefix-free (ITU-T E.164). */
const SHORT_CALLING_CODES = new Set(
  "1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(
    " ",
  ),
);

/**
 * How each country groups its national number, as a pattern of `#`, one per digit; digits past the pattern join its
 * last group, and null falls back to the generic grouping. Exact for the shapes they test: Brazil, the US and Canada,
 * Portugal, France, Turkey, India's mobiles. Common print for mobiles and big cities, generic elsewhere: the United
 * Kingdom, Spain, Germany, Italy, the Netherlands, Mexico, Argentina, Japan, South Korea, Indonesia, Poland.
 * ponytail: a small table, not a numbering-plan library. Unknown plans and odd lengths get the generic grouping;
 * libphonenumber's metadata is the upgrade when exact national formats matter everywhere.
 */
const PHONE_PATTERNS: Record<string, (n: string) => string | null> = {
  "1": (n) => (n.length === 10 ? "(###) ###-####" : null),
  "55": (n) => (n.length === 11 ? "(##) #####-####" : n.length === 10 ? "(##) ####-####" : null),
  "44": (n) => (n.length === 10 ? (n.startsWith("2") ? "## #### ####" : "#### ######") : null),
  "351": (n) => (n.length === 9 ? "### ### ###" : null),
  "34": (n) => (n.length === 9 ? "### ### ###" : null),
  "48": (n) => (n.length === 9 ? "### ### ###" : null),
  "33": (n) => (n.length === 9 ? "# ## ## ## ##" : null),
  "90": (n) => (n.length === 10 ? "### ### ## ##" : null),
  "91": (n) => (n.length === 10 ? "##### #####" : null),
  "49": (n) => (n.length >= 9 ? (/^(30|40|69|89)/.test(n) ? "## #" : "### #") : null),
  "39": (n) => (n.length >= 9 ? (n.startsWith("3") ? "### ### #" : "## #### #") : null),
  "31": (n) => (n.length === 9 ? (n.startsWith("6") ? "# ########" : "## ### ####") : null),
  "52": (n) => (n.length === 10 ? (/^(55|33|81)/.test(n) ? "## #### ####" : "### ### ####") : null),
  "54": (n) =>
    n.length === 11 && n.startsWith("9")
      ? n.startsWith("911")
        ? "# ## ####-####"
        : "# ### ###-####"
      : n.length === 10
        ? n.startsWith("11")
          ? "## ####-####"
          : "### ###-####"
        : null,
  "81": (n) => (n.length === 10 && /^[789]0/.test(n) ? "##-####-####" : n.length === 9 ? "#-####-####" : null),
  "82": (n) =>
    n.startsWith("2") ? (n.length === 9 ? "#-###-####" : "#-####-####") : n.length === 10 ? "##-####-####" : null,
  "62": (n) => (n.startsWith("8") ? "###-####-#" : null),
};

/** The last four digits, groups of three before them: "12 345 6789". */
function genericPhonePattern(length: number): string {
  const groups = ["####"];
  for (let left = length - 4; left > 0; left -= 3) groups.unshift("#".repeat(Math.min(3, left)));
  return groups.join(" ");
}

/** A phone number as a surface stores it: 8 to 15 digits, a leading "+" optional. No calling code starts with 0. */
export const isPhoneNumber = (value: string) => /^\+?[1-9]\d{7,14}$/.test(value);

function printPhone(value: string, masked: boolean): string {
  if (!isPhoneNumber(value)) return value;
  const digits = value.replace("+", "");
  const codeLength = SHORT_CALLING_CODES.has(digits.slice(0, 1))
    ? 1
    : SHORT_CALLING_CODES.has(digits.slice(0, 2))
      ? 2
      : 3;
  const national = digits.slice(codeLength);
  const rule = PHONE_PATTERNS[digits.slice(0, codeLength)]?.(national);
  const holes = rule?.split("#").length ?? 0;
  const pattern =
    rule && holes - 1 <= national.length
      ? rule + "#".repeat(national.length - holes + 1)
      : genericPhonePattern(national.length);
  // The mask keeps the first group (an area code) while at least three digits stay hidden, and always the last four.
  const first = pattern.match(/#+/)?.[0].length ?? 0;
  const keep = national.length - first - 4 >= 3 ? first : 0;
  let i = 0;
  const filled = pattern.replace(/#/g, () => {
    const at = i++;
    return masked && at >= keep && at < national.length - 4 ? "•" : (national[at] ?? "");
  });
  return `+${digits.slice(0, codeLength)} ${filled}`;
}

/** "+55 (11) 90000-0001" from "5511900000001"; anything that isn't a phone number (a handle) comes back as given. */
export const formatPhone = (value: string) => printPhone(value, false);

/**
 * "+55 (11) •••••-0001": the country code, the area code and the last four digits, the rest dots. A value that isn't a
 * phone number comes back as given, unmasked: the caller masks it some other way.
 */
export const maskPhone = (value: string) => printPhone(value, true);
