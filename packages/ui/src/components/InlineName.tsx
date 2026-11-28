import { type InputHTMLAttributes, useEffect, useRef, useState } from "react";
import { cx } from "../cx";

export interface InlineNameProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "defaultValue" | "onChange" | "onBlur" | "onKeyDown" | "autoFocus" | "aria-label"
  > {
  /** The name as it is now: the field starts with it, selected. */
  value: string;
  /**
   * Called with the new name, trimmed, only when it changed and isn't empty. A promise keeps the field (read only)
   * until it settles; a rejection leaves it open with what was typed, the caller having said why.
   */
  onSave: (name: string) => unknown;
  /** The field is done: saved, cancelled (Esc) or left unchanged. */
  onDone: () => void;
  "aria-label": string;
  /** As wide as what is typed (a tab's name) instead of the whole line. */
  fit?: boolean;
}

/**
 * A name renamed where it stands: the field takes the font and line of what it replaces (a title, a tab, a column's
 * head), no box, only the focus ring. Enter or leaving the field saves, Esc goes back to the name as it was. No Save
 * button. Esc stops here, so a dialog around it stays open.
 */
export function InlineName({ value, onSave, onDone, fit, className, maxLength = 80, ...rest }: InlineNameProps) {
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  // Refs, not state: Enter's save and the blur that follows it run before a render would tell them apart.
  const settled = useRef(false);
  const pending = useRef(false);
  const latest = useRef({ draft, value, onSave, onDone });
  latest.current = { draft, value, onSave, onDone };

  const finish = async (save: boolean) => {
    if (settled.current || pending.current) return;
    const { draft: typed, value: was, onSave: store, onDone: done } = latest.current;
    const next = typed.trim();
    if (!save || !next || next === was) {
      settled.current = true;
      return done();
    }
    pending.current = true;
    setBusy(true);
    try {
      await store(next);
      settled.current = true;
      done();
    } catch {
      pending.current = false;
      setBusy(false);
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const el = field.current;
    el?.focus();
    el?.select();
    // Ahead of any layer's own Esc (a dialog closes on it from the document): this one only goes back to the name.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement !== field.current) return;
      e.preventDefault();
      e.stopPropagation();
      void finishRef.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <input
      ref={field}
      type="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={maxLength}
      // For the app's own panels that close on Esc (`useEscClose`): this field's Esc is its own.
      data-esc-own=""
      {...rest}
      className={cx("ac-inlinename", fit && "ac-inlinename--fit", className)}
      size={fit ? Math.max(6, draft.length + 1) : undefined}
      value={draft}
      readOnly={busy}
      aria-busy={busy || undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        void finish(true);
      }}
    />
  );
}
