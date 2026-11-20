import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_MAX_MS } from "@agenteschat/client/lib/voice";
import { hidesBody } from "../../src/features/chat/logic";
import {
  handleAt,
  hasWords,
  levelOf,
  localVoiceMessage,
  nextSpeed,
  peaksOf,
  playedColumns,
  retryDelayMs,
  secondsLeft,
  slideIntent,
  spokenWords,
  takeBack,
  uploadVerdict,
  voiceFields,
  WAVE_CELL,
  WAVE_HANDLE,
  WAVE_PITCH,
  waveAt,
} from "../../src/features/voice/logic";
import { joinM4a } from "../../src/features/voice/m4a";
import { chatScreenSource } from "./chat-screen-source";

const u32 = (...v: number[]) => {
  const out = new Uint8Array(v.length * 4);
  const d = new DataView(out.buffer);
  v.forEach((n, i) => {
    d.setUint32(i * 4, n);
  });
  return out;
};
function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An AAC file reduced to what the join reads: samples of `sizes` bytes filled with `fill`, 1024 ticks each. */
function m4a(sizes: number[], fill: number) {
  const ftyp = box("ftyp", new TextEncoder().encode("M4A "));
  const stsd = box("stsd", u32(0, 0));
  const tables = (at: number) =>
    box(
      "stbl",
      stsd,
      box("stts", u32(0, 1, sizes.length, 1024)),
      box("stsc", u32(0, 1, 1, sizes.length, 1)),
      box("stsz", u32(0, 0, sizes.length, ...sizes)),
      box("stco", u32(0, 1, at)),
    );
  const moov = (at: number) =>
    box(
      "moov",
      box("mvhd", u32(0, 0, 0, 1000, 0)),
      box(
        "trak",
        box("tkhd", u32(0, 0, 0, 1, 0, 0)),
        box("edts", u32(0)),
        box("mdia", box("mdhd", u32(0, 0, 0, 44_100, 0)), box("minf", tables(at))),
      ),
    );
  const dataAt = ftyp.length + moov(0).length + 8;
  const total = sizes.reduce((s, n) => s + n, 0);
  const mdat = box("mdat", new Uint8Array(total).fill(fill));
  const out = new Uint8Array(ftyp.length + moov(0).length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov(dataAt), ftyp.length);
  out.set(mdat, ftyp.length + moov(0).length);
  return out;
}

const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("voice gestures and wave", () => {
  test("sliding far enough deletes or locks, and deleting wins", () => {
    expect(slideIntent(-40, -20)).toBeNull();
    expect(slideIntent(-110, 0)).toBe("cancel");
    expect(slideIntent(0, -70)).toBe("lock");
    expect(slideIntent(-120, -90)).toBe("cancel");
  });
  test("levels stay in range, and silence still draws a bar", () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(-160)).toBe(0.04);
    expect(levelOf(undefined)).toBe(0.04);
  });
  test("peaks keep the loudest of each stretch", () => {
    const peaks = peaksOf([0.1, 0.9, 0.1, 0.1, 0.2, 0.1], 2);
    expect(peaks).toEqual([0.9, 0.2]);
    expect(peaksOf([], 4)).toEqual([]);
  });
  test("the countdown shows only near the limit", () => {
    expect(secondsLeft(0)).toBeNull();
    expect(secondsLeft(VOICE_MAX_MS - 13_000)).toBe(13);
    expect(secondsLeft(VOICE_MAX_MS + 1000)).toBe(0);
  });
  test("speed goes round", () => {
    expect([nextSpeed(1), nextSpeed(1.5), nextSpeed(2)]).toEqual([1.5, 2, 1]);
  });
  test("a played wave's handle stands flush with its left end before the first column at 0:00, and flush with its right end after the last at the end", () => {
    // Every room the columns leave over (0 to 5), a width between whole points, and the phones' own.
    for (const width of [180, 181, 182, 183, 184, 185, 233.5, 300]) {
      const { count, start } = playedColumns(width);
      const end = start + count * WAVE_PITCH - (WAVE_PITCH - WAVE_CELL);
      expect([width, handleAt(0, width), handleAt(1, width) + WAVE_HANDLE]).toEqual([width, 0, width]);
      // Never on a column: 2 or more between the handle and the first column, and the last column and the handle.
      expect(start - WAVE_HANDLE).toBeGreaterThanOrEqual(2);
      expect(handleAt(1, width) - end).toBeGreaterThanOrEqual(2);
      expect(Number.isInteger(start)).toBe(true);
      // A finger on the handle's middle keeps it there; past the ends it holds there.
      expect(waveAt(handleAt(0.5, width) + WAVE_HANDLE / 2, width)).toBeCloseTo(0.5, 9);
      expect([waveAt(0, width), waveAt(WAVE_HANDLE / 2, width)]).toEqual([0, 0]);
      expect([waveAt(width - WAVE_HANDLE / 2, width), waveAt(width, width)]).toEqual([0.999, 0.999]);
    }
    // The drawing goes through the same numbers: the columns where `playedColumns` puts them, the handle at
    // `handleAt`, the played tones up to its middle.
    const bars = readFileSync(join(import.meta.dir, "../../src/features/voice/VoiceBars.tsx"), "utf8");
    expect(bars).toContain("const spread = tail ? null : playedColumns(width);");
    expect(bars).toContain("handleAt(progress.value, width) + HANDLE / 2");
    expect(bars).toContain("const handleX = useDerivedValue(() => at.value - HANDLE / 2);");
  });
});

describe("voice upload", () => {
  test("a server that took it, can't now, or never will", () => {
    expect(uploadVerdict(202)).toBe("done");
    expect(uploadVerdict(503)).toBe("retry");
    expect(uploadVerdict(422)).toBe("refused");
  });
  test("waits grow and stop growing", () => {
    expect(retryDelayMs(0)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(99)).toBe(30_000);
  });
});

describe("voice messages hold no text", () => {
  const voice = { clipId: "c", durationMs: 1200, peaks: [] };
  test("the normal body is hidden", () => {
    expect(hidesBody({ body: "palavras", meta: { voice } } as never)).toBe(true);
  });
  test("words open only when there are any", () => {
    expect(hasWords({ body: "palavras", meta: { voice } })).toBe(true);
    expect(hasWords({ body: "(sem palavras)", meta: { voice: { ...voice, noWords: true } } })).toBe(false);
    expect(hasWords({ body: "", meta: { voice }, local: "pending" })).toBe(false);
  });
});

describe("a voice note with typed text and files", () => {
  const voice = { clipId: "c", durationMs: 1200, peaks: [] };
  const typed = "Veja a captura, por favor.";
  const sent = { body: `${typed}\n\nOlá Atlas, revise o painel.`, meta: { voice: { ...voice, text: typed } } };
  const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

  test("the typed part is the row's text; the player opens only the words said", () => {
    expect(hidesBody(sent as never)).toBe(false);
    expect(spokenWords(sent)).toBe("Olá Atlas, revise o painel.");
    expect(spokenWords({ body: typed, meta: sent.meta })).toBeNull();
    expect(hasWords({ body: typed, meta: sent.meta })).toBe(false);
    // From before typed text could go with a take: all of it is words.
    expect(spokenWords({ body: "palavras", meta: { voice } })).toBe("palavras");
  });

  const item = {
    clientId: "k1",
    orgId: "o",
    channelId: "ch",
    threadId: null,
    replyTo: null,
    authorId: "u1",
    file: "k1.m4a",
    durationMs: 1200,
    peaks: [0.5],
    language: "pt",
    createdAt: "2026-11-15T10:00:00.000Z",
  };
  const files = [
    { id: "a1", version: 1, title: "captura.png" },
    { id: "a2", version: 1, title: "relatorio.pdf" },
  ];

  test("the upload carries the text and the files' ids, and nothing new when there are none", () => {
    const fields = Object.fromEntries(voiceFields({ ...item, text: typed, artifacts: files }));
    expect(fields.text).toBe(typed);
    expect(JSON.parse(fields.attachments ?? "")).toEqual(["a1", "a2"]);
    const plain = Object.fromEntries(voiceFields({ ...item, text: "  " }));
    expect(plain).toEqual({ durationMs: "1200", peaks: "[0.5]", clientId: "k1", language: "pt" });
  });

  test("a take the server refuses gives its typed text and files back to the composer it was sent from, and nowhere else", () => {
    const here = { channelId: "ch", threadId: null };
    expect(takeBack({ ...item, text: typed }, here)).toEqual({ text: typed, artifacts: [] });
    expect(takeBack({ ...item, artifacts: files }, here)).toEqual({ text: "", artifacts: files });
    expect(takeBack({ ...item, text: typed }, { channelId: "other", threadId: null })).toBeNull();
    expect(takeBack({ ...item, text: typed }, { channelId: "ch", threadId: "t1" })).toBeNull();
    expect(takeBack(item, here)).toBeNull();
    const take = src("features/voice/useVoiceTake.ts");
    expect(take).toMatch(
      /const back = item \? takeBack\(item, targetRef\.current\) : null;\s*if \(back\) targetRef\.current\.takeBack\?\.\(back\);/,
    );
    expect(src("features/voice/outbox.ts")).toContain('onRefused(verdict === "limit" ? "limit" : "refused", item);');
    const chat = chatScreenSource();
    expect(chat).toContain("takeBack: voiceTakeBack,");
    // The files come back from what was uploaded for the take, to wait above the field again.
    expect(chat).toMatch(/sentWithVoice\.current\.set\(a\.id, file\)/);
    expect(chat).toMatch(
      /sentWithVoice\.current\.get\(a\.id\)[\s\S]{0,200}setPending\(\(now\) => \[\.\.\.files, \.\.\.now\]/,
    );
  });

  test("the bubble until the server answers shows the typed text, the take and the files", () => {
    const local = localVoiceMessage({ ...item, text: typed, artifacts: files });
    expect(local.body).toBe(typed);
    expect(local.meta?.voice).toMatchObject({ clipId: "local:k1", text: typed });
    expect(local.meta?.artifacts).toEqual(files);
    expect(hidesBody(local)).toBe(false);
    expect(localVoiceMessage(item).body).toBe("");
    expect(localVoiceMessage(item).meta?.artifacts).toBeUndefined();
  });

  test('the take is a row above the field, which stays usable with its "+", and the trash is in the row', () => {
    const composer = src("ui/Composer.tsx");
    expect(composer).not.toContain("styles.hidden");
    expect(composer).not.toContain("voice.leading");
    // The take's row comes before the row of the "+" and the field.
    expect(composer.indexOf("{voice.bar}")).toBeLessThan(composer.indexOf("<View style={styles.row}>"));
    // A take may start while files wait; with words typed the send button holds the slot.
    expect(composer).toContain("const mic = voice && !typed ? voice.mic : null;");
    // The field's send hands its words to the take; a take that didn't go gives them back.
    expect(composer).toMatch(
      /if \(take\) \{[\s\S]{0,200}take\(value\)\.then\(\(sent\) => \{[\s\S]{0,80}put\(joinDrafts\(value, textRef\.current\)\)/,
    );
    const bar = src("features/voice/useVoiceComposer.tsx");
    expect(bar).toContain('const trash = control("trash", t("voice.delete"), () => void take.cancel(true));');
    expect(bar).toContain("send: (locked || paused) && !folding ? take.send : null,");
    // The swipe to cancel on the held mic is unchanged.
    expect(bar).toContain('if (intent === "cancel") scheduleOnRN(take.cancel, true);');
  });

  test("sending uploads the waiting files first, and a failed upload keeps the take", () => {
    const screen = chatScreenSource();
    expect(screen).toMatch(/const withVoice = async \(typed: string\) => \{[\s\S]{0,600}uploadPending\(pending\)/);
    expect(screen).toContain("prepare: prepareVoice,");
    const take = src("features/voice/useVoiceTake.ts");
    expect(take).toMatch(/if \(!extra\) \{\s*await held\(\);\s*return false;/);
    expect(take).toContain("...(file === files[0] && extra.text ? { text: extra.text } : {}),");
    expect(src("features/voice/outbox.ts")).toContain(
      "for (const [name, value] of voiceFields(item)) form.append(name, value);",
    );
  });

  test("the sent message: the typed words above the player, the words said alone in it; lists show the typed part", () => {
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("serverBody(t, listedText(m.body, meta), meta, i18n.language, names)");
    expect(row).toMatch(/\{lead\}\s*\{body \? player : null\}/);
    expect(src("features/voice/VoiceMessage.tsx")).toContain(
      "const words = useMemo(() => spokenWords(message), [message]);",
    );
    expect(src("features/chat/sheets.tsx")).toContain("const text = previewOf(listedText(m.body, m.meta));");
  });
});

describe("joinM4a", () => {
  test("keeps every sample, in order, and adds the durations", () => {
    const out = joinM4a(m4a([3, 4], 0xaa), m4a([5], 0xbb));
    const s = text(out);
    expect(s).not.toContain("edts");
    const mdat = s.indexOf("mdat") + 4;
    expect([...out.subarray(mdat)]).toEqual([...new Array(7).fill(0xaa), ...new Array(5).fill(0xbb)]);
    const d = new DataView(out.buffer);
    const stsz = s.indexOf("stsz") + 4;
    expect(d.getUint32(stsz + 8)).toBe(3);
    const stco = s.indexOf("stco") + 4;
    expect(d.getUint32(stco + 8)).toBe(mdat);
    const mdhd = s.indexOf("mdhd") + 4;
    expect(d.getUint32(mdhd + 16)).toBe(3072);
  });
  test("refuses what it can't read", () => {
    expect(() => joinM4a(new Uint8Array(12), m4a([1], 1))).toThrow();
  });
});
