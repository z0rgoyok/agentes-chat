import type { Message } from "@agenteschat/client";
import { VOICE_COUNTDOWN_MS, VOICE_MAX_MS, VOICE_SPEEDS, voiceParts } from "@agenteschat/client/lib/voice";
import type { VoiceSend } from "./outbox";

/**
 * Voice messages on the phone (ADR 0100), the part with no device in it: how a recording's gestures read and how
 * levels become a wave. What the web shares is in `@agenteschat/client/lib/voice`.
 */
/** How long a press is held before it records. */
export const HOLD_MS = 220;
/**
 * The take's start sound (`record`) rings for under this long, and the recorder starts after it: the microphone would
 * take it into the take. Below the time a person takes to start speaking after the haptic.
 */
export const START_SOUND_MS = 90;
/** How far left deletes, and how far up locks. */
export const CANCEL_X = -110;
export const LOCK_Y = -70;

/** A level from 0 to 1 from the recorder's decibels (-160 to 0); what is below -50 is silence. */
export function levelOf(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0.04;
  return Math.min(1, Math.max(0.04, (db + 50) / 50));
}

/** `levels` in `n` bars, each the loudest of its stretch, so a short word stays visible. */
export function peaksOf(levels: readonly number[], n = 48): number[] {
  if (levels.length === 0) return [];
  if (levels.length <= n) return levels.map((l) => Math.round(l * 1000) / 1000);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * levels.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
    let top = 0;
    for (let k = from; k < to; k++) top = Math.max(top, levels[k] ?? 0);
    out.push(Math.round(top * 1000) / 1000);
  }
  return out;
}

/** The wave's grid (ADR 0100): square cells of 4, columns 6 apart, and the square handle a played wave moves by. */
export const WAVE_CELL = 4;
export const WAVE_PITCH = 6;
export const WAVE_HANDLE = 8;

/** How many columns fit in `width`. */
export function columnsIn(width: number): number {
  "worklet";
  return Math.max(1, Math.floor((width + WAVE_PITCH - WAVE_CELL) / WAVE_PITCH));
}

/**
 * A played wave's columns on `width`: how many, and where the first starts. They leave the handle's width and 2 at
 * both ends, centred on whole points, so at 0:00 the handle stands before the first column and at the end after the
 * last, flush with the wave's ends: the handle never covers a column at either end.
 */
export function playedColumns(width: number): { count: number; start: number } {
  const count = columnsIn(width - 2 * (WAVE_HANDLE + 2));
  return { count, start: Math.round((width - (count * WAVE_PITCH - (WAVE_PITCH - WAVE_CELL))) / 2) };
}

/** Where a played wave's handle starts at `progress`: flush with its left end at 0:00, with its right end at the end. */
export function handleAt(progress: number, width: number): number {
  "worklet";
  return progress * (width - WAVE_HANDLE);
}

/** Where `x` falls on a played wave `width` wide: the handle's middle there, up to 0.999 at the end. */
export function waveAt(x: number, width: number): number {
  "worklet";
  return Math.max(0, Math.min(0.999, (x - WAVE_HANDLE / 2) / (width - WAVE_HANDLE)));
}

/** A finger's position during a hold: what it asks for now. */
export function slideIntent(dx: number, dy: number): "cancel" | "lock" | null {
  "worklet";
  if (dx <= CANCEL_X) return "cancel";
  if (dy <= LOCK_Y) return "lock";
  return null;
}

/** What the clock shows: seconds left near the limit, else null. */
export function secondsLeft(ms: number): number | null {
  const left = VOICE_MAX_MS - ms;
  return left <= VOICE_COUNTDOWN_MS ? Math.max(0, Math.ceil(left / 1000)) : null;
}

export const nextSpeed = (speed: number) =>
  VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed as (typeof VOICE_SPEEDS)[number]) + 1) % VOICE_SPEEDS.length] ?? 1;

/**
 * The words said in a voice message, for its player: not what was typed beside the take, not when no engine could make
 * them out, nor before the server answers.
 */
export function spokenWords(message: Pick<Message, "body" | "meta" | "local">): string | null {
  return message.local ? null : voiceParts(message).words;
}

export const hasWords = (message: Pick<Message, "body" | "meta" | "local">) => spokenWords(message) !== null;

/** The upload's form fields besides the recording; an older server ignores `text` and `attachments`. */
export function voiceFields(item: VoiceSend): [string, string][] {
  const fields: [string, string][] = [
    ["durationMs", String(item.durationMs)],
    ["peaks", JSON.stringify(item.peaks)],
    ["clientId", item.clientId],
  ];
  if (item.threadId) fields.push(["threadId", item.threadId]);
  if (item.replyTo) fields.push(["replyTo", item.replyTo]);
  if (item.language) fields.push(["language", item.language]);
  if (item.text?.trim()) fields.push(["text", item.text]);
  if (item.artifacts?.length) fields.push(["attachments", JSON.stringify(item.artifacts.map((a) => a.id))]);
  return fields;
}

/** A refused take's typed text and files, for the composer of the conversation it was sent from (null anywhere else). */
export const takeBack = (
  item: Pick<VoiceSend, "text" | "artifacts" | "channelId" | "threadId">,
  here: { channelId: string; threadId: string | null },
) => {
  const text = item.text ?? "";
  const artifacts = item.artifacts ?? [];
  const same = item.channelId === here.channelId && item.threadId === here.threadId;
  return same && (text || artifacts.length > 0) ? { text, artifacts } : null;
};

/** Tries before the bubble says it didn't go (the first miss is often a blip the next try fixes). */
const FAILED_AFTER = 2;

/** The bubble until the real message arrives: my audio, not playable yet, no words; what I typed above it, my files. */
export const localVoiceMessage = (item: VoiceSend): Message => ({
  id: `local-${item.clientId}`,
  channelId: item.channelId,
  threadId: item.threadId,
  author: { type: "person", id: item.authorId },
  body: item.text ?? "",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {
    voice: {
      clipId: `local:${item.clientId}`,
      durationMs: item.durationMs,
      peaks: item.peaks,
      ...(item.text ? { text: item.text } : {}),
    },
    ...(item.artifacts?.length ? { artifacts: item.artifacts } : {}),
    // Why it didn't go yet, under "Não foi enviada" once it failed: a sender is never left guessing.
    ...(item.lastError ? { sendError: item.lastError } : {}),
    // The server has it (it answered 202): it posts the message once the words are made out, which can take a moment;
    // the bubble stops saying "Enviando…" meanwhile (the recording is safe there).
    ...(item.accepted ? { voiceAccepted: true } : {}),
  },
  clientId: item.clientId,
  local: (item.tries ?? 0) >= FAILED_AFTER ? "failed" : "pending",
  createdAt: item.createdAt,
});

/** Waits between upload tries, while the phone has no way through. */
export function retryDelayMs(attempt: number): number {
  return [2_000, 5_000, 15_000, 30_000][Math.min(attempt, 3)] ?? 30_000;
}

/** An answer to an upload: done, wait and try again, or never going to work. */
export function uploadVerdict(status: number): "done" | "retry" | "refused" {
  if (status >= 200 && status < 300) return "done";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "refused";
}
