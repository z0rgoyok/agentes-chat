/**
 * Base64 without `Buffer` (not on the web or the phone) or `atob`/`btoa` (not everywhere on Hermes, and slow on large
 * input): document states and updates travel as base64 text in JSON and in Postgres (ADR 0196 §3, §4), up to the
 * 32 MiB a document may hold, so both directions work in chunks.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENCODE = new Uint8Array(64);
const DECODE = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  const code = ALPHABET.charCodeAt(i);
  ENCODE[i] = code;
  DECODE[code] = i;
}
// The URL-safe alphabet reads the same.
DECODE["-".charCodeAt(0)] = 62;
DECODE["_".charCodeAt(0)] = 63;

const PAD = "=".charCodeAt(0);
/** Bytes per chunk: a multiple of 3, so only the last chunk is padded; 8192 characters out per chunk. */
const CHUNK = 6144;

/** `bytes` as standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const codes = new Uint16Array((CHUNK / 3) * 4);
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    let j = 0;
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      codes[j++] = ENCODE[(n >> 18) & 63] ?? PAD;
      codes[j++] = ENCODE[(n >> 12) & 63] ?? PAD;
      codes[j++] = ENCODE[(n >> 6) & 63] ?? PAD;
      codes[j++] = ENCODE[n & 63] ?? PAD;
    }
    const left = end - i;
    if (left === 1) {
      const n = (bytes[i] ?? 0) << 16;
      codes[j++] = ENCODE[(n >> 18) & 63] ?? PAD;
      codes[j++] = ENCODE[(n >> 12) & 63] ?? PAD;
      codes[j++] = PAD;
      codes[j++] = PAD;
    } else if (left === 2) {
      const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
      codes[j++] = ENCODE[(n >> 18) & 63] ?? PAD;
      codes[j++] = ENCODE[(n >> 12) & 63] ?? PAD;
      codes[j++] = ENCODE[(n >> 6) & 63] ?? PAD;
      codes[j++] = PAD;
    }
    parts.push(String.fromCharCode.apply(null, codes.subarray(0, j) as unknown as number[]));
  }
  return parts.join("");
}

/**
 * The bytes of a base64 text: standard or URL-safe alphabet, padding optional, whitespace ignored. Anything else
 * throws, so a corrupt state is never read as a shorter one.
 */
export function fromBase64(text: string): Uint8Array {
  let length = text.length;
  while (length > 0 && isSpace(text.charCodeAt(length - 1))) length--;
  let padding = 0;
  while (length > 0 && text.charCodeAt(length - 1) === PAD && padding < 2) {
    length--;
    padding++;
    while (length > 0 && isSpace(text.charCodeAt(length - 1))) length--;
  }
  let digits = 0;
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    if (code < 256 && (DECODE[code] ?? -1) >= 0) digits++;
    else if (!isSpace(code)) throw new Error(`Invalid base64 at character ${i}`);
  }
  if (digits % 4 === 1) throw new Error("Invalid base64 length");
  const out = new Uint8Array(Math.floor((digits * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < length; i++) {
    const value = DECODE[text.charCodeAt(i)] ?? -1;
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}
