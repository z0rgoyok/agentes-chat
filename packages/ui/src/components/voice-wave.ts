import { useEffect } from "react";

const BAR = 3;
const GAP = 2;

function resample(peaks: readonly number[], n: number) {
  if (peaks.length === 0) return Array.from({ length: n }, () => 0.06);
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    return Math.max(...peaks.slice(from, to));
  });
}

/** How many bars fit in `width`. */
const barsIn = (width: number) => Math.max(1, Math.floor((width + GAP) / (BAR + GAP)));

/** The handle's radius. */
const HANDLE = 6;
/**
 * With a handle, the bars leave its width and 2px at both ends: at 0:00 it stands before the first bar and at the end
 * after the last, flush with the canvas's edges, as WhatsApp's dot does.
 */
const INSET = 2 * HANDLE + 2;

/** Where `clientX` falls on a wave drawn with its handle: its middle there, 0 flush left, 1 flush right. */
export function waveAt(canvas: HTMLElement, clientX: number) {
  const r = canvas.getBoundingClientRect();
  return (clientX - r.left - HANDLE) / (r.width - 2 * HANDLE);
}

/**
 * Draws a recording's wave on a canvas in bars. Live: the newest bars at the right, quiet dots before the first sound,
 * so the line is never half empty. Otherwise the whole recording, played up to `progress`. Colors come from the
 * canvas's `--voice-on` and `--voice-off`.
 */
export function drawVoiceWave(
  canvas: HTMLCanvasElement | null,
  peaks: readonly number[],
  { progress = 0, live = false, handle = false }: { progress?: number; live?: boolean; handle?: boolean } = {},
) {
  if (!canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(w * dpr);
  const ch = Math.round(h * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const on = css.getPropertyValue("--voice-on").trim() || css.color;
  const off = css.getPropertyValue("--voice-off").trim() || on;
  const n = barsIn(handle ? w - 2 * INSET : w);
  const data = live ? peaks.slice(-n) : resample(peaks, n);
  const span = data.length * (BAR + GAP) - GAP;
  // Live: the newest bar at the right edge. Otherwise centred on whole pixels, the same room at both ends.
  const x0 = live ? w - span : Math.round((w - span) / 2);
  // Where the audio is: the handle's middle, or the bars' own span without one. A bar is played once its middle is
  // behind it.
  const at = handle ? HANDLE + progress * (w - 2 * HANDLE) : x0 + progress * span;
  if (live) {
    g.fillStyle = off;
    for (let px = x0 - (BAR + GAP); px > -BAR; px -= BAR + GAP) {
      g.beginPath();
      g.arc(px + BAR / 2, h / 2, 1.2, 0, 7);
      g.fill();
    }
  }
  data.forEach((v, i) => {
    const bar = Math.max(3, Math.min(h, v * h));
    g.fillStyle = live || x0 + i * (BAR + GAP) + BAR / 2 <= at ? on : off;
    g.beginPath();
    if (g.roundRect) g.roundRect(x0 + i * (BAR + GAP), (h - bar) / 2, BAR, bar, 1.5);
    else g.rect(x0 + i * (BAR + GAP), (h - bar) / 2, BAR, bar);
    g.fill();
  });
  // Where the audio is, to grab and drag.
  if (handle) {
    g.fillStyle = on;
    g.beginPath();
    g.arc(at, h / 2, HANDLE, 0, 7);
    g.fill();
  }
}

/** Calls `paint` again when the canvas changes size or the app's theme changes, since its colors are read to draw. */
export function useWaveRepaint(canvas: { current: HTMLCanvasElement | null }, paint: () => void) {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    paint();
    const size = typeof ResizeObserver === "function" ? new ResizeObserver(paint) : null;
    size?.observe(el);
    const theme = typeof MutationObserver === "function" ? new MutationObserver(paint) : null;
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      size?.disconnect();
      theme?.disconnect();
    };
  }, [canvas, paint]);
}
