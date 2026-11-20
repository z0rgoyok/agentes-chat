import * as random from "lib0/random";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const LENGTH = 10;
/** Five base-36 digits come out of each 32-bit draw. */
const FIVE_DIGITS = 36 ** 5;
/** The largest multiple of 36^5 under 2^32: a draw at or above it is drawn again, so every digit is equally likely. */
const FAIR_LIMIT = Math.floor(2 ** 32 / FIVE_DIGITS) * FIVE_DIGITS;

/**
 * A new id for a sheet, row, column, slide, element or shape (ADR 0196 §2): 10 characters of [0-9a-z] from lib0's
 * crypto-backed randomness, which works on the server, the web and the phone (Hermes, through the Metro alias of
 * `lib0/webcrypto`). 36^10 ids make a collision between two people adding rows at once vanishingly unlikely.
 */
export function newId(): string {
  let out = "";
  while (out.length < LENGTH) {
    const draw = random.uint32();
    if (draw >= FAIR_LIMIT) continue;
    let value = draw % FIVE_DIGITS;
    for (let i = 0; i < 5; i++) {
      out += ALPHABET.charAt(value % 36);
      value = Math.floor(value / 36);
    }
  }
  return out;
}

const ID_SHAPE = /^[0-9a-z]{10}$/;

/** Whether `value` looks like an id `newId` makes. */
export function isNewId(value: unknown): value is string {
  return typeof value === "string" && ID_SHAPE.test(value);
}
