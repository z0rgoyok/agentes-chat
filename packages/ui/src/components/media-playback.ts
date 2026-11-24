/** Only one thing plays at a time (a voice message or a video): starting one stops the one before. */
let current: (() => void) | null = null;

/** `stop` is about to play: stops whatever else was playing. */
export function claimPlayback(stop: () => void) {
  if (current && current !== stop) current();
  current = stop;
}

/** `stop` stopped by itself (paused, ended, gone): nothing to stop anymore. */
export function releasePlayback(stop: () => void) {
  if (current === stop) current = null;
}

/** Stops whatever plays: called by anything else about to make sound (listening back to a recording). */
export function stopPlayback() {
  const stop = current;
  current = null;
  stop?.();
}

/** Where a video is and how it plays: what passes from a chat tile to the viewer opened over it, and back. */
export interface PlaybackState {
  time: number;
  playing: boolean;
  speed: number;
  muted: boolean;
  volume: number;
}

export const playbackOf = (v: HTMLVideoElement): PlaybackState => ({
  time: v.currentTime,
  playing: !v.paused && !v.ended,
  speed: v.playbackRate,
  muted: v.muted,
  volume: v.volume,
});

interface Seat {
  video: HTMLVideoElement;
  take: (state: PlaybackState) => void;
}

/** The chat tiles on screen, by file. */
const tiles = new Map<string, Seat[]>();

/** A chat tile of the file `key` is on screen. Returns its leaving. */
export function seatTile(key: string, seat: Seat): () => void {
  tiles.set(key, [...(tiles.get(key) ?? []), seat]);
  return () => {
    const left = (tiles.get(key) ?? []).filter((s) => s !== seat);
    if (left.length) tiles.set(key, left);
    else tiles.delete(key);
  };
}

/**
 * A viewer of the file `key` opens over the chat (`video` is its own): the tile that plays it, or else the one started
 * and paused, stops and the viewer goes on from there. Returns the closing, which gives the tile the viewer's moment,
 * paused (the tile's own state back when the viewer never loaded). A tile never started hands nothing over.
 */
export function takeOver(key: string, video: HTMLVideoElement, take: (state: PlaybackState) => void) {
  const seats = tiles.get(key) ?? [];
  const from = seats.find((s) => !s.video.paused) ?? seats.find((s) => s.video.currentTime > 0);
  if (!from) return undefined;
  const state = playbackOf(from.video);
  from.video.pause();
  take(state);
  return () => {
    if (!tiles.get(key)?.includes(from)) return;
    from.take(video.readyState >= 1 ? { ...playbackOf(video), playing: false } : state);
  };
}
