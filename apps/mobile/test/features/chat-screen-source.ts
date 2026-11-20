import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHAT = join(import.meta.dir, "../../src/features/chat");

/**
 * The conversation screen's source as one text: `ChatScreen.tsx` and the pieces it is split into (`screen/`), for the
 * tests that read how the screen is written wherever the code now lives.
 */
export function chatScreenSource(): string {
  const dir = join(CHAT, "screen");
  const pieces = readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
  return [readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8"), ...pieces].join("\n");
}

/** One piece of the conversation screen (`screen/<file>`), for a test about that piece alone. */
export function chatScreenPiece(file: string): string {
  return readFileSync(join(CHAT, "screen", file), "utf8");
}
