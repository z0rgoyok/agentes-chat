import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Which of `steps` forms of a one-line text fits its box, the longest first: it steps down before paint while the
 * text runs past its box (`part`, a selector inside `ref`, or `ref` itself), and starts over when `key` (the text) or
 * the box's width changes. A form that still doesn't fit is the last one.
 */
export function useFitStep(ref: RefObject<HTMLElement | null>, steps: number, key: string, part?: string): number {
  const [state, setState] = useState({ key, step: 0 });
  if (state.key !== key) setState({ key, step: 0 });
  const step = state.key === key ? state.step : 0;
  useLayoutEffect(() => {
    const box = ref.current;
    const el = part && box ? box.querySelector(part) : box;
    if (el && step < steps - 1 && el.scrollWidth > el.clientWidth + 0.5) setState({ key, step: step + 1 });
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setState((s) => ({ ...s, step: 0 }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return Math.min(step, steps - 1);
}
