import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ScrollView, type ScrollViewInstance } from "react-native";
import { SheetContent, useSheetBody, useSheetProps } from "@/ui";

/**
 * One bottom sheet per screen, opened from anywhere inside it (a card in a list row, a header button), with steps:
 * `open(content)` starts a sheet, `push(content)` presents the next step as a sheet over it (the conversation's
 * options to its pins, a member's options), `back()` takes the top one away, and `close()` all of them. Every sheet
 * is the system's own (`Sheet`'s TrueSheet): a step stacks over the one before as the system's sheets do, and a flick
 * down on it goes back. Keeps sheets out of list cells, where they would be clipped or recycled.
 */
export interface SheetHost {
  /** A new sheet, or the open one starting over with this content. `onClose`: once, when this sheet closes. */
  open: (content: ReactNode, options?: { onClose?: () => void }) => void;
  /** The next step, as a sheet over the open one (a sheet of its own when none is open). */
  push: (content: ReactNode) => void;
  /** The step before: the top sheet goes; on the first, the sheet closes. */
  back: () => void;
  /**
   * `then`, when a function: once the sheet is gone from the screen (before presenting the photo library, the camera,
   * a picker). Anything else is ignored, so `close` can be a button's or the scrim's press handler as it is.
   */
  close: (then?: unknown) => void;
  /**
   * Hears the sheet open (before it does anything, the keyboard leaving included) and close: the screen under it
   * keeps still meanwhile (a conversation freezes its list). Returns the unsubscribe.
   */
  subscribe: (listener: (open: boolean) => void) => () => void;
}

interface Step {
  key: string;
  content: ReactNode;
}

const SheetContext = createContext<SheetHost | null>(null);

export function SheetHostProvider({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [open, setOpen] = useState(false);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const sheets = useRef(new Map<string, TrueSheet>());
  const seq = useRef(0);
  const isOpen = useRef(false);
  const onClosed = useRef<(() => void) | null>(null);
  const listeners = useRef(new Set<(open: boolean) => void>());
  // What waits for the sheet to be gone from the screen.
  const afterGone = useRef<(() => void)[]>([]);
  const flush = useCallback(() => {
    const waiting = afterGone.current;
    afterGone.current = [];
    for (const then of waiting) then();
  }, []);
  const announceClosed = useCallback(() => {
    if (!isOpen.current) return;
    isOpen.current = false;
    setOpen(false);
    for (const l of listeners.current) l(false);
    const closed = onClosed.current;
    onClosed.current = null;
    closed?.();
  }, []);
  // `then` only when a function: the scrim's press passes its event here.
  const close = useCallback(
    (then?: unknown) => {
      if (typeof then === "function") {
        if (stepsRef.current.length > 0) afterGone.current.push(then as () => void);
        else then();
      }
      // The first sheet's `open` turning false dismisses it, and the steps over it with it.
      announceClosed();
    },
    [announceClosed],
  );
  // A step is gone (taken back, flicked down, or with the sheet under it): it and the ones over it leave.
  const stepGone = useCallback(
    (key: string) => {
      setSteps((list) => {
        const at = list.findIndex((s) => s.key === key);
        return at < 0 ? list : list.slice(0, at);
      });
      if (stepsRef.current[0]?.key === key) flush();
    },
    [flush],
  );
  const host = useMemo<SheetHost>(() => {
    const start = (next: ReactNode, options?: { onClose?: () => void }) => {
      for (const l of listeners.current) l(true);
      onClosed.current = options?.onClose ?? null;
      const list = stepsRef.current;
      const first = list[0];
      if (isOpen.current && first) {
        // The open sheet starts over: its first step shows this, and the steps over it go.
        setSteps((now) => [{ key: first.key, content: next }, ...now.slice(1)]);
        const over = list[1];
        if (over) void sheets.current.get(over.key)?.dismiss();
      } else {
        // The screen's own field (the composer) lets go of the keyboard first, after the listeners (they read it still
        // up): a step presents as it mounts, so the sheet's own present no longer does it.
        Keyboard.dismiss();
        // A sheet still leaving makes way: what waited for it runs now.
        flush();
        setSteps([{ key: `step-${++seq.current}`, content: next }]);
      }
      isOpen.current = true;
      setOpen(true);
    };
    return {
      open: start,
      push: (next) => {
        if (!isOpen.current || stepsRef.current.length === 0) {
          start(next);
          return;
        }
        setSteps((list) => [...list, { key: `step-${++seq.current}`, content: next }]);
      },
      back: () => {
        const list = stepsRef.current;
        const top = list[list.length - 1];
        if (list.length > 1 && top) void sheets.current.get(top.key)?.dismiss();
        else close();
      },
      close,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    };
  }, [close, flush]);
  const register = useCallback((key: string, sheet: TrueSheet | null) => {
    if (sheet) sheets.current.set(key, sheet);
    else sheets.current.delete(key);
  }, []);
  return (
    <SheetContext.Provider value={host}>
      {children}
      {steps.map((step, i) => (
        <StepSheet
          key={step.key}
          step={step}
          open={i === 0 ? open : true}
          onClose={i === 0 ? announceClosed : noop}
          onGone={stepGone}
          register={register}
        />
      ))}
    </SheetContext.Provider>
  );
}

const noop = () => {};

/**
 * One step: a sheet of the system's, sized to its content, which scrolls. Every step presents as it mounts, the first
 * one too: a first step opened while the last sheet is still sliding away gets that sheet's recycled native view, and a
 * `present()` call then answers "already presented" with nothing on the screen, leaving the host open for good (every
 * sheet button dead, the conversation's list frozen). Presenting on mount, the system waits for it to be gone.
 */
function StepSheet({
  step,
  open,
  onClose,
  onGone,
  register,
}: {
  step: Step;
  open: boolean;
  onClose: () => void;
  onGone: (key: string) => void;
  register: (key: string, sheet: TrueSheet | null) => void;
}) {
  const ref = useRef<TrueSheet>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const body = useSheetBody();
  const props = useSheetProps({ open, onClose, onGone: () => onGone(step.key), ref, presentOnMount: true });
  useEffect(() => {
    register(step.key, ref.current);
    return () => register(step.key, null);
  }, [register, step.key]);
  return (
    <TrueSheet ref={ref} {...props} scrollableRef={scroll}>
      <SheetContent>
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          // A sheet with a field (an answer, a fix): a drag down its content puts the keyboard away.
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={body}
        >
          {step.content}
        </ScrollView>
      </SheetContent>
    </TrueSheet>
  );
}

export function useSheet(): SheetHost {
  const host = useContext(SheetContext);
  if (!host) throw new Error("useSheet must be used inside SheetHostProvider");
  return host;
}

/** The screen's sheet host, or null on a screen without one (a text shown outside a conversation). */
export function useSheetIfAny(): SheetHost | null {
  return useContext(SheetContext);
}
