/** A voice message's wave in bars, the same numbers on the web (`drawVoiceWave`) and the phone. */
export const VOICE_BAR = 3;
export const VOICE_BAR_GAP = 2;
/** The handle's radius. */
export const VOICE_HANDLE = 6;

/** `peaks` as `n` bars: each the loudest of the peaks it stands for. */
export function resamplePeaks(peaks: readonly number[], n: number): number[] {
  if (peaks.length === 0) return Array.from({ length: n }, () => 0.06);
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    return Math.max(...peaks.slice(from, to));
  });
}

/** How many bars fit in `width`. */
export const barsIn = (width: number) => Math.max(1, Math.floor((width + VOICE_BAR_GAP) / (VOICE_BAR + VOICE_BAR_GAP)));

/**
 * A played wave's bars on `width`: how many, and where the first starts. They leave the handle's width and 2 at both
 * ends, centred on whole pixels, so at 0:00 the handle stands before the first bar and at the end after the last, as
 * WhatsApp's dot does.
 */
export function playedBars(width: number): { count: number; start: number } {
  const count = barsIn(width - 2 * (2 * VOICE_HANDLE + 2));
  return { count, start: Math.round((width - (count * (VOICE_BAR + VOICE_BAR_GAP) - VOICE_BAR_GAP)) / 2) };
}
