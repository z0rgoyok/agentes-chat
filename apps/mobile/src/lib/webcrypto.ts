import { getRandomValues as fill } from "expo-crypto";

/**
 * `lib0/webcrypto` for the phone (aliased in metro.config.js): Yjs takes each document's client id from
 * `getRandomValues`, and Hermes has no global `crypto` (ADR 0196 §2). Nothing in Yjs uses `subtle`.
 */
export const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => fill(array as never) as T;

export const subtle = undefined as unknown as SubtleCrypto;
