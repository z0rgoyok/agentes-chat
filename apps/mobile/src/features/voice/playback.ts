import { type AudioPlayer, type AudioSource, createAudioPlayer } from "expo-audio";
import { releaseVoiceAudio, voiceAudio } from "@/lib/audio-mode";

/**
 * One voice plays at a time, in the whole app: a single player that rows take turns on, so a list scrolling past
 * never holds one per message. Where each clip stands lives here too (`placeOf`), moved by a timer outside React.
 */
export interface PlayRequest {
  id: string;
  source: AudioSource;
  durationMs: number;
  from: number;
  speed: number;
  /** Each tick of the timer with where the clip is (0–1); a seek on its way holds the ticks back. */
  onProgress?: (fraction: number) => void;
  onEnd?: () => void;
  /** It didn't load or play: playback stopped, and the row says so. */
  onError: () => void;
}

const TICK_MS = 50;
/** Moved this far past where it started (s), the clip is playing: its button stops showing it starting. */
const MOVED_S = 0.05;
let player: AudioPlayer | null = null;
let now: PlayRequest | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** Goes up with every stop (each start begins with one): a start that waited sees it was overtaken. */
let turn = 0;
/** The clip asked to play that hasn't moved yet (the audio mode, the file loading, its first frames), or null. */
let starting: string | null = null;
/** The seek on its way: until the player lands on it, it still reads its old place, which would pull the wave back. */
let seeking: Promise<unknown> | null = null;
const listeners = new Set<() => void>();
const say = () => {
  for (const listener of listeners) listener();
};

export const subscribePlayback = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const playingId = () => now?.id ?? null;
/** The clip whose play button spins: asked to play, not moving yet. */
export const startingId = () => starting;

/**
 * Where each clip stands (0–1), here and not in its row: the one playing moves on the timer and with a seek, a stopped
 * one keeps its place for its next play, an ended one goes back to its start. The list recycles rows, and a row drawn
 * again reads this whatever happened while it was away (a clip that played on, ended, or was paused by another).
 */
const places = new Map<string, number>();
const placeListeners = new Set<(id: string) => void>();
/** Hears every move of any clip's place, with its id: per tick while one plays, so a row keeps it off React. */
export const subscribePlace = (listener: (id: string) => void) => {
  placeListeners.add(listener);
  return () => {
    placeListeners.delete(listener);
  };
};
export const placeOf = (id: string) => places.get(id) ?? 0;
/** A sound's length (ms) as its player read it, for one whose length wasn't known before it played (an audio file). */
const lengths = new Map<string, number>();
export const lengthOf = (id: string) => lengths.get(id) ?? 0;
function setPlace(id: string, at: number) {
  if (at > 0) places.set(id, at);
  else places.delete(id);
  for (const listener of placeListeners) listener(id);
}

/**
 * The message's own length first, the player's only when it has none (an audio file), as the seek and the clock do. A
 * file a browser recorded (a fragmented MP4 or a WebM written as it records) has no full length in its header, and
 * Android's player reads only its first part: a 17 s clip read as 1 s ended after a second.
 */
const fraction = (p: AudioPlayer, durationMs: number) => {
  const total = durationMs > 0 ? durationMs / 1000 : p.duration;
  return total > 0 ? Math.min(1, p.currentTime / total) : 0;
};

/** The clip playing reached its end: it stops and goes back to its start. */
function ended() {
  if (!now) return;
  const { onEnd, id } = now;
  stopPlayback();
  setPlace(id, 0);
  onEnd?.();
}

export function stopPlayback() {
  turn++;
  if (timer) clearInterval(timer);
  timer = null;
  seeking = null;
  player?.pause();
  if (!now && !starting) return;
  now = null;
  starting = null;
  // The app's own sounds get the session back (silent in silent mode, with the music), unless a voice takes it again.
  releaseVoiceAudio();
  say();
}

function makePlayer() {
  const p = createAudioPlayer(null, { updateInterval: 100 });
  // A source that fails, and a clip that ends, say so only in this event: `currentStatus`, which the timer reads, never
  // carries the error or `didJustFinish` (expo-audio 58). Without it a row would stay on pause with its wave still.
  p.addListener("playbackStatusUpdate", (status) => {
    if (status.didJustFinish) ended();
    if (!status.error || !now) return;
    const { onError } = now;
    stopPlayback();
    onError();
  });
  return p;
}

/**
 * Plays a clip, from `from`. Its button shows it starting at once (`startingId`, before the audio mode and the file are
 * ready) and until the clip moves; a start overtaken by another, or by a stop, plays nothing.
 */
export async function startPlayback(request: PlayRequest) {
  stopPlayback();
  const mine = turn;
  starting = request.id;
  say();
  const from = (request.from * request.durationMs) / 1000;
  let p: AudioPlayer;
  try {
    await voiceAudio(false);
    // Stopped, or another one started, while this waited: that one has the player (and the one timer).
    if (mine !== turn) return;
    p = player ?? makePlayer();
    player = p;
    p.replace(request.source);
    p.setPlaybackRate(request.speed);
    if (request.from > 0) await p.seekTo(from);
    if (mine !== turn) return;
    p.play();
  } catch (error) {
    // Its button stops spinning; the caller says why.
    if (mine === turn) stopPlayback();
    throw error;
  }
  now = request;
  say();
  timer = setInterval(() => {
    if (!now) return;
    const status = p.currentStatus;
    // The end is the player's (the event, or Android's state), never the place: a length a little off would cut it.
    if (status.playbackState === "ended") {
      ended();
      return;
    }
    const at = fraction(p, now.durationMs);
    if (
      starting === now.id &&
      (p.currentTime > from + MOVED_S || (status.isLoaded && status.playing && !status.isBuffering))
    ) {
      starting = null;
      say();
    }
    if (now.durationMs <= 0 && p.duration > 0 && !lengths.has(now.id)) {
      lengths.set(now.id, p.duration * 1000);
      say();
    }
    if (seeking) return;
    setPlace(now.id, at);
    now.onProgress?.(at);
  }, TICK_MS);
}

/**
 * Moves a clip to `at` (0–1): its place at once, so the next play starts there too; the player when it holds that clip,
 * and until it has landed the timer reports nothing (it would read the old place for a moment).
 */
export function seekPlayback(id: string, at: number) {
  setPlace(id, at);
  if (now?.id !== id || !player) return;
  const total = now.durationMs > 0 ? now.durationMs / 1000 : player.duration;
  const seek = player.seekTo(at * total).catch(() => undefined);
  seeking = seek;
  void seek.then(() => {
    if (seeking === seek) seeking = null;
  });
}

export function setPlaybackSpeed(id: string, speed: number) {
  if (now?.id === id) player?.setPlaybackRate(speed);
}
