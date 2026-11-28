import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Bytes 0x80-0xFF of the DOS code pages Windows gives a console (its OEM code page) by system language, which
 * `TextDecoder` doesn't know: cmd.exe and many Windows programs write in it to a pipe (850 in Brazil and Western
 * Europe, 437 in the US).
 */
const OEM_TABLES: Readonly<Record<number, string>> = {
  437: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0",
  720: "\u0080\u0081éâ\u0084à\u0086çêëèïî\u008d\u008e\u008f\u0090ّْô¤ـûùءآأؤ£إئابةتثجحخدذرزسشص«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ضطظعغفµقكلمنهوىي≡ًٌٍَُِ≈°∙·√ⁿ²■\u00a0",
  737: "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψ░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀ωάέήϊίόύϋώΆΈΉΊΌΎΏ±≥≤ΪΫ÷≈°∙·√ⁿ²■\u00a0",
  775: "ĆüéāäģåćłēŖŗīŹÄÅÉæÆōöĢ¢ŚśÖÜø£Ø×¤ĀĪóŻżź”¦©®¬½¼Ł«»░▒▓│┤ĄČĘĖ╣║╗╝ĮŠ┐└┴┬├─┼ŲŪ╚╔╩╦╠═╬Žąčęėįšųūž┘┌█▄▌▐▀ÓßŌŃõÕµńĶķĻļņĒŅ’\u00ad±“¾¶§÷„°∙·¹³²■\u00a0",
  850: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0",
  852: "ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´\u00ad˝˛ˇ˘§÷¸°¨˙űŘř■\u00a0",
  855: "ђЂѓЃёЁєЄѕЅіІїЇјЈљЉњЊћЋќЌўЎџЏюЮъЪаАбБцЦдДеЕфФгГ«»░▒▓│┤хХиИ╣║╗╝йЙ┐└┴┬├─┼кК╚╔╩╦╠═╬¤лЛмМнНоОп┘┌█▄Пя▀ЯрРсСтТуУжЖвВьЬ№\u00adыЫзЗшШэЭщЩчЧ§■\u00a0",
  857: "ÇüéâäàåçêëèïîıÄÅÉæÆôöòûùİÖÜø£ØŞşáíóúñÑĞğ¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ºªÊËÈ�ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµ�×ÚÛÙìÿ¯´\u00ad±�¾¶§÷¸°¨·¹³²■\u00a0",
  862: "אבגדהוזחטיךכלםמןנסעףפץצקרשת¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0",
};

/** The other code pages a Windows console or program may write in, by `TextDecoder`'s label. */
const LABELS: Readonly<Record<number, string>> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
};

/** A system's console (OEM) and programs' (ANSI) code pages. */
export interface CodePages {
  oem: number;
  ansi: number;
}

/** When the registry can't say: Western Europe's and the Americas'. */
export const FALLBACK_CODE_PAGES: CodePages = { oem: 850, ansi: 1252 };

let cached: CodePages | undefined;

/** `HKLM\...\Nls\CodePage`'s `OEMCP` and `ACP` in `reg query`'s answer; the fallback for each one missing. */
export function codePagesOf(output: string): CodePages {
  const value = (name: string) => Number(new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(\\d+)\\s*$`, "im").exec(output)?.[1]);
  const oem = value("OEMCP");
  const ansi = value("ACP");
  return {
    oem: oem > 0 ? oem : FALLBACK_CODE_PAGES.oem,
    ansi: ansi > 0 ? ansi : FALLBACK_CODE_PAGES.ansi,
  };
}

/** This Windows' code pages, read once (only when a program wrote something that isn't UTF-8). */
export function windowsCodePages(): CodePages {
  if (cached) return cached;
  let output = "";
  try {
    // By its full path: a bare name is looked for in the current folder first.
    const reg = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    const key = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";
    output = `${spawnSync(reg, ["query", key], { encoding: "latin1", timeout: 5000, windowsHide: true }).stdout ?? ""}`;
  } catch {
    // the fallback
  }
  cached = codePagesOf(output);
  return cached;
}

function decodeWith(bytes: Uint8Array, page: number): string | null {
  const table = OEM_TABLES[page];
  if (table) {
    const codes = Uint16Array.from(bytes, (b) => (b < 0x80 ? b : table.charCodeAt(b - 0x80)));
    return Buffer.from(codes.buffer, codes.byteOffset, codes.byteLength).toString("utf16le");
  }
  const label = LABELS[page] as ConstructorParameters<typeof TextDecoder>[0];
  return label ? new TextDecoder(label).decode(bytes) : null;
}

/**
 * How unlike text a decoding reads: characters that are neither ASCII nor a letter (`‚` for an 850 `é` read as
 * 1252), and a capital right after a small letter (`nÒo` for a 1252 `não` read as 850).
 */
function oddness(text: string): number {
  let odd = 0;
  let prev = "";
  for (const c of text) {
    if (c > "\x7f" && !/\p{L}/u.test(c)) odd++;
    else if (c > "\x7f" && /\p{Lu}/u.test(c) && /\p{Ll}/u.test(prev)) odd++;
    prev = c;
  }
  return odd;
}

/**
 * The code page bytes a Windows program wrote that aren't UTF-8 are in: the console's (cmd.exe, `reg`, `dir`), or
 * the system's ANSI one (Python's, Java's), whichever reads as text; the console's when both do.
 */
function pageOf(bytes: Uint8Array, pages: CodePages): number {
  const oem = decodeWith(bytes, pages.oem) === null ? FALLBACK_CODE_PAGES.oem : pages.oem;
  const ansi = pages.ansi === oem ? null : decodeWith(bytes, pages.ansi);
  return ansi !== null && oddness(ansi) < oddness(decodeWith(bytes, oem) ?? "") ? pages.ansi : oem;
}

const utf8Of = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("utf8");

/**
 * Output with lines that aren't UTF-8, line by line: a UTF-8 CLI's lines and the cmd.exe that started it share one
 * pipe, and ripgrep's matches from a Latin-1 file sit among UTF-8 files' (0x0A is no part of a character in any of
 * these code pages). `cut`: the first line may start, and the last end, mid-character.
 */
function windowsText(bytes: Uint8Array, pages: CodePages, cut = false): string {
  const lines: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; ) {
    const nl = bytes.indexOf(0x0a, start);
    const end = nl < 0 ? bytes.length : nl + 1;
    lines.push(bytes.subarray(start, end));
    start = end;
  }
  const last = lines.length - 1;
  const utf8 = lines.map((l, i) => isUtf8(l, cut && i === 0, cut && i === last));
  const page = pageOf(Buffer.concat(lines.filter((_, i) => !utf8[i])), pages);
  return lines.map((l, i) => (utf8[i] ? utf8Of(l) : (decodeWith(l, page) ?? ""))).join("");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Where `bytes` stop being whole UTF-8 characters: the start of a last one cut short, else their length. */
function wholeEnd(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 3); i--) {
    const b = bytes[i] as number;
    if (b < 0x80) break;
    if (b >= 0xc0) return bytes.length - i < (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2) ? i : bytes.length;
  }
  return bytes.length;
}

/** Whether `bytes` are UTF-8; `head`/`tail`: a window into longer output, where a character cut short at that end is too. */
function isUtf8(bytes: Uint8Array, head: boolean, tail = head): boolean {
  let start = 0;
  while (head && start < 3 && start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
  try {
    UTF8.decode(bytes.subarray(start, tail ? wholeEnd(bytes) : bytes.length));
    return true;
  } catch {
    return false;
  }
}

export interface ConsoleTextOptions {
  /** The bytes are a window into longer output (its end, a part read from a log): they may start or end mid-character. */
  cut?: boolean;
  platform?: NodeJS.Platform;
  pages?: () => CodePages;
}

/**
 * A child process's output as text. UTF-8 (every program elsewhere, and Node's, Bun's, Go's and Rust's CLIs on
 * Windows) as it is; on Windows, anything else in the code page it was written in (`windowsText`), where reading it
 * as UTF-8 left `oper\ufffdvel` for cmd.exe's `operável`.
 */
export function consoleText(bytes: Uint8Array | string, opts: ConsoleTextOptions = {}): string {
  if (typeof bytes === "string") return bytes;
  const { cut = false, platform = process.platform, pages = windowsCodePages } = opts;
  if (platform !== "win32" || isUtf8(bytes, cut)) return utf8Of(bytes);
  return windowsText(bytes, pages(), cut);
}

/**
 * `consoleText` for a stream, as `StringDecoder` is for UTF-8: a character cut between two chunks waits for the
 * next.
 */
export class ConsoleDecoder {
  private held: Uint8Array = new Uint8Array(0);
  private readonly utf8 = new StringDecoder("utf8");

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pages: () => CodePages = windowsCodePages,
  ) {}

  write(chunk: Uint8Array | string): string {
    if (typeof chunk === "string") return chunk;
    if (this.platform !== "win32") return this.utf8.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    const end = wholeEnd(data);
    this.held = new Uint8Array(data.subarray(end));
    const whole = data.subarray(0, end);
    return isUtf8(whole, false) ? utf8Of(whole) : windowsText(whole, this.pages());
  }

  end(): string {
    if (this.platform !== "win32") return this.utf8.end();
    const rest = this.held;
    this.held = new Uint8Array(0);
    return rest.length ? consoleText(rest, { platform: this.platform, pages: this.pages }) : "";
  }
}
