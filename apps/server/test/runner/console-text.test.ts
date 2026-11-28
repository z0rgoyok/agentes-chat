import { expect, test } from "bun:test";
import { type CodePages, ConsoleDecoder, codePagesOf, consoleText } from "../../runner/console-text";

const brazil = (): CodePages => ({ oem: 850, ansi: 1252 });
const win = { platform: "win32" as const, pages: brazil };

// cmd.exe's not found on a Brazilian Windows, as it writes it to a pipe: code page 850 ("á" is 0xA0, "ã" 0xC6).
const CMD_850 = Buffer.concat([
  Buffer.from("'node' n"),
  Buffer.from([0xc6]),
  Buffer.from("o "),
  Buffer.from([0x82]),
  Buffer.from(" reconhecido como um comando interno\r\nou externo, um programa oper"),
  Buffer.from([0xa0]),
  Buffer.from("vel ou um arquivo em lotes.\r\n"),
]);
const CMD_TEXT =
  "'node' não é reconhecido como um comando interno\r\nou externo, um programa operável ou um arquivo em lotes.\r\n";

test("cmd.exe's words in the console's code page (850) read as written, not as U+FFFD", () => {
  expect(CMD_850.toString("utf8")).toContain("oper�vel");
  expect(consoleText(CMD_850, win)).toBe(CMD_TEXT);
});

test("a program writing in the system's ANSI code page (1252) reads as written too", () => {
  const ansi = Buffer.from("Não foi possível abrir o arquivo: ação negada\r\n", "latin1");
  expect(consoleText(ansi, win)).toBe("Não foi possível abrir o arquivo: ação negada\r\n");
  // A German 1252 line: "ü" and "ö" are no letters in 850.
  expect(consoleText(Buffer.from("Zugriff verweigert: Datei für Benutzer gelöscht", "latin1"), win)).toBe(
    "Zugriff verweigert: Datei für Benutzer gelöscht",
  );
});

test("UTF-8 stays UTF-8 on Windows, and nothing changes elsewhere", () => {
  const utf8 = Buffer.from("Erro: não é possível — 文件 ✓\n");
  expect(consoleText(utf8, win)).toBe("Erro: não é possível — 文件 ✓\n");
  expect(consoleText(CMD_850, { platform: "linux", pages: brazil })).toBe(CMD_850.toString("utf8"));
  expect(consoleText("already text", win)).toBe("already text");
});

test("the US console (437) and others the registry names", () => {
  // "Ã" in 850 (0xC7) is "╟" in 437; "é" (0x82) is the same in both.
  expect(
    consoleText(Buffer.from([0x63, 0x61, 0x66, 0x82]), { platform: "win32", pages: () => ({ oem: 437, ansi: 1252 }) }),
  ).toBe("café");
  // Russian: 866 console, 1251 programs.
  const russian = { platform: "win32" as const, pages: () => ({ oem: 866, ansi: 1251 }) };
  expect(consoleText(Buffer.from([0xae, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]), russian)).toBe("ошибка");
  // An unknown code page reads as the fallback console's.
  expect(consoleText(Buffer.from([0x82]), { platform: "win32", pages: () => ({ oem: 99, ansi: 99 }) })).toBe("é");
});

test("a window into UTF-8 output cut mid-character is still UTF-8", () => {
  const whole = Buffer.from("ação concluí");
  const cut = whole.subarray(2, whole.length - 1);
  expect(consoleText(cut, { ...win, cut: true })).toBe("�ão conclu�");
  // Not a window: the same bytes are a whole output, read in the console's code page.
  expect(consoleText(Buffer.from([0x41, 0xc7]), win)).toBe("AÃ");
});

test("the stream decoder joins a character split between chunks, and reads each chunk on its own", () => {
  const decoder = new ConsoleDecoder("win32", brazil);
  const utf8 = Buffer.from("operável");
  const split = utf8.indexOf(0xc3) + 1;
  let text = decoder.write(utf8.subarray(0, split));
  text += decoder.write(utf8.subarray(split));
  // cmd.exe's own words after a UTF-8 CLI's, on one pipe.
  text += decoder.write(Buffer.from("\n"));
  text += decoder.write(CMD_850);
  text += decoder.end();
  expect(text).toBe(`operável\n${CMD_TEXT}`);
  // A console byte that looks like the start of a UTF-8 character at the end comes out at the end.
  const last = new ConsoleDecoder("win32", brazil);
  expect(last.write(Buffer.from([0x41, 0xc7])) + last.end()).toBe("AÃ");
  // Elsewhere: StringDecoder's UTF-8.
  const posix = new ConsoleDecoder("linux", brazil);
  expect(posix.write(utf8.subarray(0, split)) + posix.write(utf8.subarray(split)) + posix.end()).toBe("operável");
});

test("the registry's code pages, and the fallback when it can't say", () => {
  const reg = [
    "",
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
    "    ACP    REG_SZ    1252",
    "    OEMCP    REG_SZ    850",
    "    MACCP    REG_SZ    10000",
    "",
  ].join("\r\n");
  expect(codePagesOf(reg)).toEqual({ oem: 850, ansi: 1252 });
  expect(codePagesOf("    OEMCP    REG_SZ    437\r\n")).toEqual({ oem: 437, ansi: 1252 });
  expect(codePagesOf("")).toEqual({ oem: 850, ansi: 1252 });
});

test("UTF-8 lines and console lines in one output each read as written", () => {
  // A UTF-8 CLI's line, then the cmd.exe that started it saying the next program isn't there.
  const mixed = Buffer.concat([Buffer.from("Instalando o pacote — ação concluída\n"), CMD_850]);
  const text = `Instalando o pacote — ação concluída\n${CMD_TEXT}`;
  expect(consoleText(mixed, win)).toBe(text);
  const decoder = new ConsoleDecoder("win32", brazil);
  expect(decoder.write(mixed) + decoder.end()).toBe(text);
  // ripgrep's matches: a UTF-8 file's, then a Latin-1 file's.
  const rg = Buffer.concat([Buffer.from("a.txt:ação\n"), Buffer.from("b.txt:café\n", "latin1")]);
  expect(consoleText(rg, win)).toBe("a.txt:ação\nb.txt:café\n");
  // A window into it cut mid-character at both ends.
  const cut = Buffer.concat([Buffer.from("ção\n").subarray(1), CMD_850, Buffer.from("fim é").subarray(0, -1)]);
  expect(consoleText(cut, { ...win, cut: true })).toBe(`�ão\n${CMD_TEXT}fim �`);
});
