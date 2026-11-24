import { useCallback, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/** A bubble's padding over and under what it holds (`lookRows.bubble`). */
export const BUBBLE_PAD_V = 8;

/** The room a cap leaves over the content: within it the content fits as it is; reaching it, the content grew. */
export const BUBBLE_CAP_SLACK = 2;

/**
 * A bubble's height cap after a measure, or `cap` itself when nothing changes; null: no cap. `box`: the bubble's
 * laid-out height; `content`: the height of what it holds; `pad`: its padding over and under.
 *
 * A bubble laid out taller than what it holds gets capped just over it. Capped, content that reaches the cap may need
 * more room than it has (a text reads no taller than its room): the cap goes and the bubble is measured again. Content
 * that shrank pulls the cap down with it.
 */
export function bubbleCapAfter(cap: number | null, box: number, content: number, pad: number): number | null {
  if (!(box > 0) || !(content > 0)) return cap;
  const fit = Math.ceil(content + pad + BUBBLE_CAP_SLACK);
  if (cap === null) return box > fit ? fit : null;
  if (content + pad >= cap - 1) return null;
  return fit < cap ? fit : cap;
}

/**
 * Keeps someone else's bubble no taller than what it holds. On a phone, a long message's words laid out at their own
 * height while the box right around them came out thousands of points taller (measured layer by layer: the words 1707
 * points, the bubble around them 12459; with a view put between the two, that view grew instead), an empty block under
 * the last line that pushed the message's file away. So what the bubble holds is read where its words end (their top
 * plus their height, `ClippedMessage`'s `onEnd`: the words come last), never from a box around them, and the bubble's
 * height is checked against it after every layout (once per frame, both measures from the same layout) and capped
 * when it runs over.
 */
export function useBubbleCap() {
  const [cap, setCap] = useState<number | null>(null);
  const capNow = useRef<number | null>(null);
  const box = useRef(0);
  const content = useRef(0);
  const pending = useRef(false);
  const check = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      // Where the words end counts the bubble's padding over them already: only the padding under them is added.
      const next = bubbleCapAfter(capNow.current, box.current, content.current, BUBBLE_PAD_V);
      if (next === capNow.current) return;
      capNow.current = next;
      setCap(next);
    });
  }, []);
  const onBubble = useCallback(
    (e: LayoutChangeEvent) => {
      box.current = e.nativeEvent.layout.height;
      check();
    },
    [check],
  );
  const onEnd = useCallback(
    (end: number) => {
      content.current = end;
      check();
    },
    [check],
  );
  return { cap, capStyle: cap === null ? null : { maxHeight: cap }, onBubble, onEnd };
}
