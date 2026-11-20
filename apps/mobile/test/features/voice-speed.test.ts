import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone's storage helper over SecureStore, held in memory here: what the app kept when it last closed.
const kept = new Map<string, string>([["agenteschat.voice-speed", "1.5"]]);
mock.module("expo-secure-store", () => ({
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  getItemAsync: async (key: string) => kept.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void kept.set(key, value),
  deleteItemAsync: async (key: string) => void kept.delete(key),
}));
mock.module("expo-constants", () => ({ default: {} }));
// The app's one shared player, counting the speeds it is given. A test moves its clock (`currentTime`, of a 9 s clip)
// and can hold its seeks until it lets them land.
const rates: number[] = [];
const clock = { currentTime: 0, holdSeeks: false, land: null as null | (() => void) };
mock.module("expo-audio", () => ({
  setAudioModeAsync: async () => undefined,
  createAudioPlayer: () => ({
    addListener: () => undefined,
    replace: () => undefined,
    setPlaybackRate: (rate: number) => void rates.push(rate),
    seekTo: (seconds: number) =>
      new Promise<void>((done) => {
        const land = () => {
          clock.currentTime = seconds;
          done();
        };
        if (clock.holdSeeks) clock.land = land;
        else land();
      }),
    play: () => undefined,
    pause: () => undefined,
    currentStatus: { didJustFinish: false },
    get currentTime() {
      return clock.currentTime;
    },
    duration: 9,
  }),
}));

const { STORAGE_PREFIX } = await import("../../src/config");
const { STORED } = await import("../../src/lib/storage");
const { setVoiceSpeed, subscribeVoiceSpeed, voiceSpeed } = await import("../../src/features/voice/speed");
const { placeOf, playingId, seekPlayback, setPlaybackSpeed, startingId, startPlayback, stopPlayback, subscribePlace } =
  await import("../../src/features/voice/playback");

/** A few of the player's 50 ms ticks. */
const ticks = () => Bun.sleep(160);
const request = (id: string, from = 0) => ({
  id,
  source: null,
  durationMs: 9000,
  from,
  speed: 1,
  onError: () => undefined,
});

describe("voice messages remember the speed picked on this phone", () => {
  test("the speed kept when the app closed is where every voice message starts", () => {
    expect(`${STORAGE_PREFIX}.${STORED.voiceSpeed}`).toBe("agenteschat.voice-speed");
    expect(voiceSpeed()).toBe(1.5);
  });

  test("a new pick is kept on the phone and reaches every player on screen", async () => {
    let told = 0;
    const stop = subscribeVoiceSpeed(() => told++);
    setVoiceSpeed(2);
    stop();
    expect(voiceSpeed()).toBe(2);
    expect(told).toBe(1);
    await Promise.resolve();
    expect(kept.get("agenteschat.voice-speed")).toBe("2");
  });

  test("a new speed reaches only the voice message playing, never the listen-back of a take", async () => {
    const play = (id: string) =>
      startPlayback({
        id,
        source: null,
        durationMs: 9000,
        from: 0,
        speed: 1,
        onProgress: () => undefined,
        onEnd: () => undefined,
        onError: () => undefined,
      });
    await play("voice-take");
    rates.length = 0;
    setPlaybackSpeed("clip-other", 2);
    expect(rates).toEqual([]);
    stopPlayback();
    await play("clip-playing");
    rates.length = 0;
    setPlaybackSpeed("clip-playing", 2);
    expect(rates).toEqual([2]);
    stopPlayback();
    // The playing row applies the shared speed itself, so a pick on another row, or one made while it was starting,
    // reaches it.
    const row = readFileSync(join(import.meta.dir, "../../src/features/voice/VoiceMessage.tsx"), "utf8");
    expect(row).toContain("if (playing) setPlaybackSpeed(clipId, rate);");
    expect(row).toContain("}, [playing, rate, clipId]);");
  });
});

describe("where a voice message stands lives in the playback module, not in its row", () => {
  test("each tick moves the clip's place and is heard with its id; another clip starting keeps it for the next play", async () => {
    clock.currentTime = 0;
    const heard = new Set<string>();
    const unsubscribe = subscribePlace((id) => heard.add(id));
    await startPlayback(request("clip-a"));
    clock.currentTime = 3;
    await ticks();
    // A row drawn again while it plays (the list recycles rows) reads this, whatever its row saw before.
    expect(placeOf("clip-a")).toBeCloseTo(1 / 3, 5);
    expect(heard.has("clip-a")).toBe(true);
    await startPlayback(request("clip-b"));
    expect(playingId()).toBe("clip-b");
    expect(placeOf("clip-a")).toBeCloseTo(1 / 3, 5);
    stopPlayback();
    unsubscribe();
  });

  test("a seek places the clip at once and holds the player's stale ticks back until it lands", async () => {
    clock.currentTime = 0;
    clock.holdSeeks = true;
    await startPlayback(request("clip-c"));
    clock.currentTime = 1;
    await ticks();
    expect(placeOf("clip-c")).toBeCloseTo(1 / 9, 5);
    seekPlayback("clip-c", 0.8);
    expect(placeOf("clip-c")).toBe(0.8);
    // The player still reads where it was: the handle doesn't jump back.
    clock.currentTime = 1.1;
    await ticks();
    expect(placeOf("clip-c")).toBe(0.8);
    clock.land?.();
    await ticks();
    expect(placeOf("clip-c")).toBeCloseTo(0.8, 5);
    clock.holdSeeks = false;
    stopPlayback();
    // A clip not playing takes the seek as its place: its next play starts there.
    seekPlayback("clip-c", 0.5);
    expect(placeOf("clip-c")).toBe(0.5);
  });

  test("the play button spins from the tap until the clip moves; a stop while starting plays nothing", async () => {
    clock.currentTime = 0;
    const started = startPlayback(request("clip-d"));
    // At once, before the audio mode and the file are ready.
    expect(startingId()).toBe("clip-d");
    await started;
    expect(playingId()).toBe("clip-d");
    expect(startingId()).toBe("clip-d");
    clock.currentTime = 0.5;
    await ticks();
    expect(startingId()).toBeNull();
    stopPlayback();
    const again = startPlayback(request("clip-e"));
    expect(startingId()).toBe("clip-e");
    stopPlayback();
    await again;
    expect(startingId()).toBeNull();
    expect(playingId()).toBeNull();
  });

  test("a clip that ends goes back to its start", async () => {
    clock.currentTime = 0;
    let ended = 0;
    await startPlayback({ ...request("clip-f"), onEnd: () => ended++ });
    clock.currentTime = 4.5;
    await ticks();
    expect(placeOf("clip-f")).toBeCloseTo(0.5, 5);
    clock.currentTime = 9;
    await ticks();
    expect([placeOf("clip-f"), playingId(), ended]).toEqual([0, null, 1]);
  });
});
