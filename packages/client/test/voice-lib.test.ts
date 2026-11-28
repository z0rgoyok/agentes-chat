import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Message } from "../src/api/types";
import { createHttpApi } from "../src/index";
import { previewKind } from "../src/lib/files";
import { quoteText, textOrMedia } from "../src/lib/media";
import { previewBody } from "../src/lib/message-body";
import { localMeta } from "../src/lib/reply";
import {
  listedText,
  micShown,
  voiceAudioGone,
  voiceClock,
  voiceExpired,
  voiceOf,
  voiceParts,
  voiceSetupAsk,
  voiceSpeedOf,
  wavePeaks,
} from "../src/lib/voice";

const t = ((key: string, params?: { time?: string }) =>
  key === "voice.wordTime" ? `Voz · ${params?.time}` : key === "voice.word" ? "Voz" : key) as unknown as TFunction;
const voice = { clipId: "c1", durationMs: 12_000, peaks: [0.2, 0.5] };

describe("voice messages' helpers (ADR 0100)", () => {
  test("voiceOf reads what the server writes and refuses anything else", () => {
    expect(voiceOf({ voice: { ...voice, noWords: true, expiresAt: "2030-01-01T00:00:00Z" } })).toEqual({
      ...voice,
      noWords: true,
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(voiceOf({ voice: { clipId: 1 } })).toBeNull();
    expect(voiceOf({})).toBeNull();
    expect(voiceOf(null)).toBeNull();
  });

  test("expires by its date, and a recording with no date doesn't", () => {
    expect(voiceExpired({ expiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(true);
    expect(voiceExpired({ expiresAt: "2026-01-03T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(false);
    expect(voiceExpired({})).toBe(false);
  });

  test("the words never reach a line: lists, quotes and previews name the audio", () => {
    expect(textOrMedia(t, "the secret words", { voice })).toBe("Voz · 0:12");
    expect(previewBody(t, "the secret words", { voice: { durationMs: 12_000 } })).toBe("Voz · 0:12");
    expect(previewBody(t, "", null, "voice")).toBe("Voz");
    expect(quoteText(t, { excerpt: "the secret words", media: "voice" })).toBe("Voz");
  });

  test("quoting a voice message carries no words", () => {
    const quote = { id: "m1", threadId: null, author: { type: "person", id: "u" }, body: "words", meta: { voice } };
    const meta = localMeta(quote as unknown as Message, "Ana", []);
    expect(meta.replyTo).toMatchObject({ excerpt: "", media: "voice" });
  });

  test("a kept speed counts only when it is one the player offers: anything else plays at 1x", () => {
    expect([voiceSpeedOf("1"), voiceSpeedOf("1.5"), voiceSpeedOf("2")]).toEqual([1, 1.5, 2]);
    for (const kept of [null, "", "3", "0.5", "1.50x", "fast", "NaN"]) expect(voiceSpeedOf(kept)).toBe(1);
  });

  test("voiceParts: the typed part above the player, the words alone in its transcript", () => {
    const typed = "Veja a tela\n\nE responda:\n- sim\n- não";
    const words = "e o deploy de ontem";
    const message = { body: `${typed}\n\n${words}`, meta: { voice: { ...voice, text: typed } } };
    expect(voiceParts(message)).toEqual({ typed, words });
    // A message from before typed text could go with a take: all of its body is words.
    expect(voiceParts({ body: words, meta: { voice } })).toEqual({ typed: "", words });
    // Typed text and a take with nothing said in it.
    expect(voiceParts({ body: typed, meta: { voice: { ...voice, text: typed } } })).toEqual({ typed, words: null });
    // No engine made out the words: the placeholder after the typed text is never offered.
    const noWords = { body: `${typed}\n\n(placeholder)`, meta: { voice: { ...voice, text: typed, noWords: true } } };
    expect(voiceParts(noWords)).toEqual({ typed, words: null });
    // The server marks it `unheard` when text was typed, so apps that predate `text` show the body whole.
    const unheard = { ...noWords, meta: { voice: { ...voice, text: typed, unheard: true } } };
    expect(voiceParts(unheard)).toEqual({ typed, words: null });
    // A body that doesn't start with the typed text loses nothing: it all shows as words.
    expect(voiceParts({ body: "other", meta: { voice: { ...voice, text: typed } } })).toEqual({
      typed,
      words: "other",
    });
  });

  test("with typed text beside it, lines show that text, never the words", () => {
    const meta = { voice: { ...voice, text: "Veja a tela" } };
    const body = "Veja a tela\n\nthe secret words";
    expect(listedText(body, meta)).toBe("Veja a tela");
    expect(listedText(body, { voice })).toBe("");
    expect(listedText("plain", {})).toBe("plain");
    expect(textOrMedia(t, body, meta)).toBe("Veja a tela");
    expect(previewBody(t, body, meta)).toBe("Veja a tela");
    const quote = { id: "m1", threadId: null, author: { type: "person", id: "u" }, body, meta };
    const reply = localMeta(quote as unknown as Message, "Ana", []).replyTo as Record<string, unknown>;
    expect(reply.excerpt).toBe("Veja a tela");
    expect(reply.media).toBeUndefined();
  });

  test("a take goes with its typed text and files in the same upload, and without them as before", async () => {
    const forms: FormData[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return Response.json({ clipId: "c1" }, { status: 202 });
    };
    const api = createHttpApi({ fetch });
    const take = { blob: new Blob([new Uint8Array(4)], { type: "audio/mp4" }), durationMs: 1200, peaks: [0.1] };
    await api.voice.send("o1", "ch1", { ...take, clientId: "k1", text: "Veja", attachments: ["a1", "a2"] });
    await api.voice.send("o1", "ch1", { ...take, clientId: "k2", text: "  ", attachments: [] });
    expect(forms[0]?.get("text")).toBe("Veja");
    expect(JSON.parse(String(forms[0]?.get("attachments")))).toEqual(["a1", "a2"]);
    expect(forms[1]?.has("text")).toBe(false);
    expect(forms[1]?.has("attachments")).toBe(false);
  });

  test("the clock", () => {
    expect(voiceClock(0)).toBe("0:00");
    expect(voiceClock(65_400)).toBe("1:05");
  });

  test("only a 410 reads as gone: a redirect or no connection doesn't", async () => {
    const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await voiceAudioGone("/a", answer(410))).toBe(true);
    expect(await voiceAudioGone("/a", answer(200))).toBe(false);
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await voiceAudioGone("/a", offline)).toBe(false);
  });
});

describe("audio files", () => {
  test("a file's wave: each slice's loudness, the loudest at 1; silence is flat", () => {
    const samples = [0, 0, 0.5, -0.5, 0.25, -0.25, 0, 0];
    expect(wavePeaks(samples, 4)).toEqual([0, 1, 0.5, 0]);
    expect(wavePeaks(new Float32Array(10), 5)).toEqual([0, 0, 0, 0, 0]);
    expect(wavePeaks([], 4)).toEqual([]);
    expect(wavePeaks([0.1, 0.2], 48)).toHaveLength(2);
  });

  test("audio stored untyped plays by its name, as the server reads it", () => {
    expect(previewKind("application/octet-stream", "entrevista.m4a")).toBe("audio");
    expect(previewKind("application/octet-stream", "nota.opus")).toBe("audio");
    expect(previewKind("application/octet-stream", "faixa.flac")).toBe("audio");
    expect(previewKind("audio/mpeg")).toBe("audio");
    expect(previewKind("application/octet-stream", "video.mp4")).toBeNull();
  });
});

describe("the microphone where voice doesn't become text yet", () => {
  const base = { voiceMessages: true, voiceAvailable: false, speechOwner: { userId: "u-w", name: "Walter" } };
  test("it shows with the workspace's switch alone; an older server still needs an engine", () => {
    expect(micShown({ ...base, speechState: "none" })).toBe(true);
    expect(micShown({ ...base, speechState: "none", voiceMessages: false })).toBe(false);
    expect(micShown(base)).toBe(false);
    expect(micShown({ ...base, voiceAvailable: true })).toBe(true);
  });
  test("the first press asks once, the owner to choose, anyone else to ask them", () => {
    expect(voiceSetupAsk({ ...base, speechState: "none" }, "u-a", true)).toEqual({
      isOwner: false,
      owner: base.speechOwner,
    });
    expect(voiceSetupAsk({ ...base, speechState: "failed" }, "u-w", true)?.isOwner).toBe(true);
    expect(voiceSetupAsk({ ...base, speechState: "none" }, "u-a", false)).toBeNull();
    expect(voiceSetupAsk({ ...base, speechState: "ready" }, "u-a", true)).toBeNull();
    expect(voiceSetupAsk(base, "u-a", true)).toBeNull();
  });
});
