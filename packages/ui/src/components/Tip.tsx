import { Slot } from "radix-ui";
import { type HTMLAttributes, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { hoverless, movesByKeys, trackInput } from "../device";
import { placeTip } from "../floating";
import { useHoverCard } from "../hooks/useHoverCard";

/** How long a mouse or a pen rests on a message's time before its details open. */
export const TIP_OPEN_MS = 250;
/** How long a finger rests on a button before its tip opens (`button`): that press then doesn't act. */
export const TIP_HOLD_MS = 500;
/** How far a finger may move during that press (px): farther is a scroll. */
export const HOLD_SLOP = 10;

export interface TipProps extends HTMLAttributes<HTMLElement> {
  /** What it says. Nothing: it never opens. */
  tip: ReactNode;
  /** The tip's look: `ac-msg__tip`, `ac-msg__note-tip ac-glass`. */
  look: string;
  /** Which of its edges lines up with the element's: its start, its middle or its end. */
  align?: "start" | "center" | "end";
  /** How long a resting mouse or pen waits before it opens. The keys' focus and a tap open it at once. */
  delay?: number;
  /** Shown whatever the pointer does, while true (a row of mine with the keys' focus in it). */
  open?: boolean;
  /**
   * About a button (`children`, one element): no wrapper of its own, so the button keeps its place in its row, and a
   * screen reader hears the words as the button's description. A finger opens it with a long press, since a tap acts.
   */
  button?: boolean;
}

/**
 * Words about the element they hang from (a message's time: its date, model and tokens) on the floating layer: in
 * <body>, fixed to the window at `--z-floating`, so no list, pane or dialog that scrolls or clips cuts them, no bar of
 * the row covers them, and `placeTip` keeps them `EDGE_ROOM` inside the window. A mouse or a pen resting on the element
 * opens them, the keys' focus or a tap at once (a touch screen has no hover), a long press on a `button`. One the
 * pointer opened stays while the pointer crosses to it and rests on it (`useHoverCard`: the gap, the triangle to its
 * near edge, a grace before it closes), so a link in it can be clicked. Its element's blur, a scroll, a resize or
 * Escape closes it, and a press anywhere but on it closes a button's. One held open stays closed after Escape until
 * its element is left or `open` changes, so it can be dismissed without moving the pointer or the focus (WCAG
 * 1.4.13). For the eye only: screen readers get the words from the element (`aria-describedby`, or a `button`'s own
 * description); a control in it takes `tabIndex={-1}` and the element does the same thing for the keys.
 */
export function Tip({
  tip,
  look,
  align = "start",
  delay = TIP_OPEN_MS,
  open: held = false,
  button = false,
  children,
  ...rest
}: TipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const hover = useHoverCard(delay);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** The long press opened it: the click that ends that press doesn't act. */
  const pressed = useRef(false);
  /** Opened by the keys' focus, a tap or a long press; the pointer's is `hover.open`. */
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const shown = Boolean(tip) && (open || hover.open !== false || held) && !dismissed;
  const { close: hoverClose } = hover;
  useEffect(() => trackInput(), []);
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a held tip Escape closed shows again when `open` changes
  useEffect(() => setDismissed(false), [held]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      hoverClose();
      setDismissed(true);
    };
    // A button's tip goes with the next press anywhere but on it: it never stands over what comes next.
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Node && bubble.current?.contains(e.target)) return;
      setOpen(false);
      hoverClose();
    };
    window.addEventListener("keydown", onKey, true);
    if (button) window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [shown, button, hoverClose]);
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const el = bubble.current;
      const at = anchor.current?.getBoundingClientRect();
      if (!el || !at) return;
      // Its layout size: the entrance's transform would measure it smaller.
      const to = placeTip(at, { width: el.offsetWidth, height: el.offsetHeight }, align, window.innerWidth);
      el.style.left = `${to.left}px`;
      el.style.top = `${to.top}px`;
    };
    place();
    // One the pointer or the focus opened goes as its element moves; one held open goes with it.
    const moved = held
      ? place
      : () => {
          setOpen(false);
          hoverClose();
        };
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [shown, held, align, hoverClose]);
  const endPress = () => {
    clearTimeout(press.current?.timer);
    press.current = null;
  };
  const props: HTMLAttributes<HTMLElement> = {
    ...rest,
    onPointerEnter: (e) => {
      rest.onPointerEnter?.(e);
      hover.trigger.onPointerEnter(e);
    },
    onPointerLeave: (e) => {
      rest.onPointerLeave?.(e);
      // A finger leaves as its tap ends: the tip the tap's focus opened stays until the focus goes.
      hover.trigger.onPointerLeave(e);
      setDismissed(false);
    },
    onFocus: (e) => {
      rest.onFocus?.(e);
      // A tap on a button acts: its focus opens nothing there (its long press does).
      if (movesByKeys() || (hoverless() && !button)) setOpen(true);
    },
    onBlur: (e) => {
      rest.onBlur?.(e);
      // To a control in the tip (its link, pressed): it stays for that press.
      if (e.relatedTarget instanceof Node && bubble.current?.contains(e.relatedTarget)) return;
      setOpen(false);
      setDismissed(false);
    },
  };
  const bubbleEl =
    shown &&
    createPortal(
      <span
        ref={(el) => {
          bubble.current = el;
          hover.content.ref(el);
        }}
        className={cx("ac-tip", look)}
        aria-hidden="true"
        onPointerEnter={hover.content.onPointerEnter}
        onPointerLeave={hover.content.onPointerLeave}
        // A button's tip is no child of its button, so the focus leaving the tip's link never reaches the button's blur.
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (to instanceof Node && (bubble.current?.contains(to) || anchor.current?.contains(to))) return;
          setOpen(false);
        }}
      >
        {tip}
      </span>,
      document.body,
    );
  if (button)
    return (
      <>
        <Slot.Root
          ref={anchor}
          {...props}
          data-hold-tip=""
          aria-description={typeof tip === "string" ? tip : undefined}
          onPointerDown={(e) => {
            rest.onPointerDown?.(e);
            pressed.current = false;
            endPress();
            if (e.pointerType !== "touch") return;
            press.current = {
              x: e.clientX,
              y: e.clientY,
              timer: setTimeout(() => {
                press.current = null;
                pressed.current = true;
                setDismissed(false);
                setOpen(true);
              }, TIP_HOLD_MS),
            };
          }}
          onPointerMove={(e) => {
            rest.onPointerMove?.(e);
            const at = press.current;
            if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > HOLD_SLOP) endPress();
          }}
          onPointerUp={(e) => {
            rest.onPointerUp?.(e);
            endPress();
          }}
          onPointerCancel={(e) => {
            rest.onPointerCancel?.(e);
            endPress();
          }}
          onClickCapture={(e) => {
            rest.onClickCapture?.(e);
            if (!pressed.current) return;
            pressed.current = false;
            e.preventDefault();
            e.stopPropagation();
          }}
          onContextMenu={(e) => {
            rest.onContextMenu?.(e);
            // Android's long press opens the page's menu: here it opened the tip instead.
            if (press.current || pressed.current) e.preventDefault();
          }}
        >
          {children}
        </Slot.Root>
        {bubbleEl}
      </>
    );
  return (
    <span ref={anchor} {...props}>
      {children}
      {bubbleEl}
    </span>
  );
}
