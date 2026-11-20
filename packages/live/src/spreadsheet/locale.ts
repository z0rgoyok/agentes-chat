/**
 * How a person reads and types numbers, dates and formulas (ADR 0196): "1.234,5", "17/11/2026" and `=SOMA(A1;B1)` in
 * Brazil, "1,234.5", "11/17/2026" and `=SUM(A1,B1)` in the US. The document keeps one invariant form; these settings
 * only shape what is shown and typed. The app's languages are in a fixed table, so the server and every device read
 * them the same; other tags fall back to `Intl`.
 */

export interface SheetLocale {
  tag: string;
  decimal: "." | ",";
  group: "," | "." | " ";
  argSep: "," | ";";
  dateOrder: "dmy" | "mdy" | "ymd";
  currency: string;
  fnNames: "en" | "pt";
}

interface Known {
  decimal: "." | ",";
  group: "," | "." | " ";
  dateOrder: "dmy" | "mdy" | "ymd";
  currency: string;
  /** The currency sign goes after the number ("1.234,50 €"). */
  after?: boolean;
}

const KNOWN: Record<string, Known> = {
  "en-US": { decimal: ".", group: ",", dateOrder: "mdy", currency: "$" },
  "en-GB": { decimal: ".", group: ",", dateOrder: "dmy", currency: "£" },
  "pt-BR": { decimal: ",", group: ".", dateOrder: "dmy", currency: "R$" },
  "pt-PT": { decimal: ",", group: " ", dateOrder: "dmy", currency: "€", after: true },
  "es-ES": { decimal: ",", group: ".", dateOrder: "dmy", currency: "€", after: true },
  "es-MX": { decimal: ".", group: ",", dateOrder: "dmy", currency: "$" },
  "fr-FR": { decimal: ",", group: " ", dateOrder: "dmy", currency: "€", after: true },
  "de-DE": { decimal: ",", group: ".", dateOrder: "dmy", currency: "€", after: true },
  "it-IT": { decimal: ",", group: ".", dateOrder: "dmy", currency: "€", after: true },
  "nl-NL": { decimal: ",", group: ".", dateOrder: "dmy", currency: "€" },
  "ja-JP": { decimal: ".", group: ",", dateOrder: "ymd", currency: "¥" },
  "ko-KR": { decimal: ".", group: ",", dateOrder: "ymd", currency: "₩" },
  "zh-CN": { decimal: ".", group: ",", dateOrder: "ymd", currency: "¥" },
  "id-ID": { decimal: ",", group: ".", dateOrder: "dmy", currency: "Rp" },
  "tr-TR": { decimal: ",", group: ".", dateOrder: "dmy", currency: "₺" },
  "pl-PL": { decimal: ",", group: " ", dateOrder: "dmy", currency: "zł", after: true },
  "ru-RU": { decimal: ",", group: " ", dateOrder: "dmy", currency: "₽", after: true },
};

/** The app's language codes (and bare languages) to the regional tag their numbers and dates follow. */
const ALIASES: Record<string, string> = {
  en: "en-US",
  pt: "pt-BR",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  nl: "nl-NL",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hant": "zh-CN",
  id: "id-ID",
  in: "id-ID",
  tr: "tr-TR",
  pl: "pl-PL",
  ru: "ru-RU",
};

/** Currency signs by region, for tags outside the table. */
const REGION_CURRENCY: Record<string, string> = {
  US: "$",
  BR: "R$",
  GB: "£",
  JP: "¥",
  CN: "¥",
  KR: "₩",
  IN: "₹",
  ID: "Rp",
  TR: "₺",
  PL: "zł",
  RU: "₽",
  CH: "CHF",
  CA: "$",
  AU: "$",
  NZ: "$",
  MX: "$",
  AR: "$",
  CL: "$",
  CO: "$",
  UY: "$",
  PE: "S/",
  ZA: "R",
  SE: "kr",
  NO: "kr",
  DK: "kr",
};

const EURO = new Set("AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" "));

function canonicalTag(tag: string): string {
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean);
  if (parts.length === 0) return "en-US";
  const lang = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p.length === 4 ? p : p.toLowerCase()));
  const full = [lang, ...rest].join("-");
  const lower = full.toLowerCase();
  return ALIASES[lower] ?? (rest.length === 0 ? (ALIASES[lang] ?? full) : full);
}

function fromIntl(tag: string): Known | null {
  try {
    const parts = new Intl.NumberFormat(tag).formatToParts(1234567.5);
    const decimalPart = parts.find((p) => p.type === "decimal")?.value;
    const groupPart = parts.find((p) => p.type === "group")?.value;
    const decimal: "." | "," = decimalPart === "," ? "," : ".";
    let group: "," | "." | " " = decimal === "," ? "." : ",";
    if (groupPart !== undefined) {
      if (/^[\s  ]$/.test(groupPart)) group = " ";
      else if (groupPart === "." || groupPart === ",") group = groupPart === decimal ? group : groupPart;
    }
    const dateParts = new Intl.DateTimeFormat(tag, { timeZone: "UTC" }).formatToParts(new Date(Date.UTC(2026, 10, 17)));
    const order = dateParts
      .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
      .map((p) => p.type.charAt(0))
      .join("");
    const dateOrder = order === "mdy" ? "mdy" : order === "ymd" ? "ymd" : "dmy";
    const region = tag.split("-").find((p, i) => i > 0 && p.length === 2) ?? "";
    const currency = REGION_CURRENCY[region] ?? (EURO.has(region) ? "€" : "$");
    return { decimal, group, dateOrder, currency, after: currency === "€" && region !== "NL" && region !== "IE" };
  } catch {
    return null;
  }
}

const CACHE = new Map<string, SheetLocale>();
/** What each resolved tag follows, also for tags read from `Intl` (for `currencyAfter`). */
const RESOLVED = new Map<string, Known>();

function build(tag: string, known: Known): SheetLocale {
  RESOLVED.set(tag, known);
  return {
    tag,
    decimal: known.decimal,
    group: known.group,
    argSep: known.decimal === "," ? ";" : ",",
    dateOrder: known.dateOrder,
    currency: known.currency,
    fnNames: tag.split("-")[0]?.toLowerCase() === "pt" ? "pt" : "en",
  };
}

function resolve(canonical: string): SheetLocale {
  const known = KNOWN[canonical];
  if (known) return build(canonical, known);
  const intl = fromIntl(canonical);
  if (intl) return build(canonical, intl);
  const alias = ALIASES[canonical.split("-")[0]?.toLowerCase() ?? ""] ?? "en-US";
  return build(alias, KNOWN[alias] ?? (KNOWN["en-US"] as Known));
}

/**
 * A language tag's settings: "pt-BR" → decimal ",", group ".", `;` between arguments, day/month/year, "R$", Portuguese
 * function names; "en-US" → ".", ",", ",", month/day/year, "$", English names. The app's codes ("en", "pt-BR", "es",
 * "zh-Hans") map to their regional tags; any other tag is read from `Intl`, with `;` between arguments wherever the
 * decimal is a comma.
 */
export function sheetLocale(tag: string): SheetLocale {
  const cached = CACHE.get(tag);
  if (cached) return cached;
  const locale = resolve(canonicalTag(tag));
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(tag, locale);
  return locale;
}

/** The currency sign's side for a locale: after the number in most of Europe ("1.234,50 €"). */
export function currencyAfter(locale: SheetLocale): boolean {
  const known = KNOWN[locale.tag] ?? RESOLVED.get(locale.tag);
  return known ? known.after === true : false;
}

export interface LocaleNames {
  /** January first. */
  months: readonly string[];
  monthsShort: readonly string[];
  /** Sunday first. */
  days: readonly string[];
  daysShort: readonly string[];
}

const EN_NAMES: LocaleNames = {
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

/** Excel's Brazilian names, lower-case as it shows them. */
const PT_NAMES: LocaleNames = {
  months: [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ],
  monthsShort: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
  days: ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"],
  daysShort: ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"],
};

const NAMES = new Map<string, LocaleNames>();

function intlNames(tag: string): LocaleNames | null {
  try {
    const month = (style: "long" | "short") => {
      const f = new Intl.DateTimeFormat(tag, { month: style, timeZone: "UTC" });
      return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2026, i, 15))).replace(/\.$/, ""));
    };
    const day = (style: "long" | "short") => {
      const f = new Intl.DateTimeFormat(tag, { weekday: style, timeZone: "UTC" });
      // 2026-11-15 is a Sunday.
      return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2026, 10, 15 + i))).replace(/\.$/, ""));
    };
    return { months: month("long"), monthsShort: month("short"), days: day("long"), daysShort: day("short") };
  } catch {
    return null;
  }
}

/** Month and weekday names for formats like `mmm` and `dddd`, in the reader's language (English when unknown). */
export function localeNames(locale: Pick<SheetLocale, "tag">): LocaleNames {
  const lang = locale.tag.split("-")[0]?.toLowerCase();
  if (lang === "en") return EN_NAMES;
  if (lang === "pt") return PT_NAMES;
  const cached = NAMES.get(locale.tag);
  if (cached) return cached;
  const names = intlNames(locale.tag) ?? EN_NAMES;
  NAMES.set(locale.tag, names);
  return names;
}

/** English names, which typing and pasting accept in every language. */
export const ENGLISH_NAMES: LocaleNames = EN_NAMES;
