import { randomInt } from "node:crypto";

/** Unambiguous code alphabet (no I/O/0/1) for codes people read off one screen and type or compare on another. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONFIRMATION_CODE_LENGTH = 8;

/** A short code of `CODE_ALPHABET` with a dash in the middle (`KQ7M-3XPF`). */
export function newConfirmationCode(): string {
  let code = "";
  for (let i = 0; i < CONFIRMATION_CODE_LENGTH; i++) {
    if (i === CONFIRMATION_CODE_LENGTH / 2) code += "-";
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
