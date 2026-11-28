import type { Readable } from "node:stream";

/**
 * Calls `onLine` with each line of a stream (UTF-8, without its newline). A
 * line longer than `max` bytes is never held whole: `onTooLong` is called
 * once and the rest of that line is skipped, so whoever writes to the stream
 * can't grow the reader's memory.
 */
export function readLines(stream: Readable, max: number, onLine: (line: string) => void, onTooLong: () => void) {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  stream.on("data", (data: Buffer | string) => {
    let chunk = typeof data === "string" ? Buffer.from(data) : data;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10)) {
      const head = chunk.subarray(0, nl);
      if (!skipping && size + head.length <= max) onLine(Buffer.concat([...parts, head]).toString("utf8"));
      else if (!skipping) onTooLong();
      parts = [];
      size = 0;
      skipping = false;
      chunk = chunk.subarray(nl + 1);
    }
    if (skipping || chunk.length === 0) return;
    if (size + chunk.length > max) {
      parts = [];
      size = 0;
      skipping = true;
      onTooLong();
      return;
    }
    parts.push(chunk);
    size += chunk.length;
  });
}

/** A text stream's lines as `cat -n`, `grep -n` and rg count them: only `\n` ends one, and one `\r` before it goes. */
export async function* fileLines(stream: AsyncIterable<string>): AsyncGenerator<string> {
  const line = (text: string) => (text.endsWith("\r") ? text.slice(0, -1) : text);
  let rest = "";
  for await (const chunk of stream) {
    const parts = chunk.split("\n");
    parts[0] = rest + parts[0];
    rest = parts.pop() ?? "";
    yield* parts.map(line);
  }
  if (rest) yield line(rest);
}

/** The last line of a program's output with words on it, its terminal colors taken out. */
export const lastLine = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colors
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);

/** Where two texts first differ (the shorter one's length when it is the other's start). */
export function firstDifference(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
