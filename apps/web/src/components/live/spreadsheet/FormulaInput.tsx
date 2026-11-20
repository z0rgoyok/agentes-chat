import { cx } from "@agenteschat/ui";
import {
  type CSSProperties,
  forwardRef,
  type ReactNode,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { FnOption, SignaturePart } from "./formula-ui";

/**
 * A cell's text as typed (ADR 0196 §2), in the cell itself or in the formula bar: a plain textarea whose words are
 * drawn by a layer behind it while it holds a formula, so each reference takes the color of its outline on the grid.
 * The textarea keeps everything a field does (the caret, selection, IME, undo of what is typed, the clipboard).
 */

export interface ColoredSpan {
  start: number;
  end: number;
  color: string;
}

export interface FormulaInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  /** References to color (only drawn while the text is a formula). */
  spans: readonly ColoredSpan[];
  onText(text: string, caret: number): void;
  /** The caret moved without the text changing (clicks, arrows). */
  onCaret?(caret: number): void;
  /** The wrapper's class. */
  boxClassName?: string;
  boxStyle?: CSSProperties;
}

export const FormulaInput = forwardRef<HTMLTextAreaElement, FormulaInputProps>(function FormulaInput(
  { value, spans, onText, onCaret, boxClassName, boxStyle, className, onScroll, onSelect, onKeyUp, onClick, ...rest },
  ref,
) {
  const back = useRef<HTMLDivElement>(null);
  const formula = value.startsWith("=");
  const pieces: ReactNode[] = [];
  if (formula) {
    let at = 0;
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    for (const span of sorted) {
      if (span.start < at || span.end > value.length) continue;
      if (span.start > at) pieces.push(value.slice(at, span.start));
      pieces.push(
        <span key={span.start} style={{ color: span.color }}>
          {value.slice(span.start, span.end)}
        </span>,
      );
      at = span.end;
    }
    pieces.push(value.slice(at));
    // A last line break still takes a line, as in the textarea.
    pieces.push("​");
  }
  const caretOf = (el: HTMLTextAreaElement) => el.selectionStart ?? el.value.length;
  return (
    <div className={cx("sheet-fx", formula && "sheet-fx--formula", boxClassName)} style={boxStyle}>
      {formula && (
        <div ref={back} className="sheet-fx__back" aria-hidden="true">
          {pieces}
        </div>
      )}
      <textarea
        ref={ref}
        className={cx("sheet-fx__input", className)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        rows={1}
        onChange={(e) => onText(e.target.value, caretOf(e.target))}
        onScroll={(e) => {
          if (back.current) {
            back.current.scrollTop = e.currentTarget.scrollTop;
            back.current.scrollLeft = e.currentTarget.scrollLeft;
          }
          onScroll?.(e);
        }}
        onSelect={(e) => {
          onCaret?.(caretOf(e.currentTarget));
          onSelect?.(e);
        }}
        onKeyUp={(e) => {
          onCaret?.(caretOf(e.currentTarget));
          onKeyUp?.(e);
        }}
        onClick={(e) => {
          onCaret?.(caretOf(e.currentTarget));
          onClick?.(e);
        }}
        {...rest}
      />
    </div>
  );
});

/**
 * Under the field being typed in: the functions the name typed may be (↑ ↓ to choose, Tab or Enter to put one in),
 * the signature of the function the cursor is in with the current argument in bold, or what is wrong with the
 * formula. On the floating layer, so the grid's edges never cut it.
 */
export function FormulaAssist({
  anchor,
  options,
  highlight,
  describe,
  onPick,
  signature,
  problem,
  label,
}: {
  anchor: HTMLElement | null;
  options: readonly FnOption[];
  highlight: number;
  /** A function's one-line description, if there is one. */
  describe(option: FnOption): string | null;
  onPick(option: FnOption): void;
  signature: readonly SignaturePart[] | null;
  problem: string | null;
  label: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  const shown = !!anchor && (options.length > 0 || !!signature || !!problem);
  useLayoutEffect(() => {
    if (!shown || !anchor) {
      setAt(null);
      return;
    }
    // Follows the field each frame: the cell's editor moves when the grid scrolls under it.
    let id = 0;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setAt((prev) =>
        prev && prev.x === r.left && prev.y === r.bottom && prev.w === r.width
          ? prev
          : { x: r.left, y: r.bottom, w: r.width },
      );
      id = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(id);
  }, [shown, anchor]);
  if (!shown || !at || typeof document === "undefined") return null;
  return createPortal(
    <div className="sheet-assist ac-glass" style={{ left: at.x, top: at.y + 4 }} data-pointer-keep="">
      {problem && (
        <p className="sheet-assist__problem" role="alert">
          {problem}
        </p>
      )}
      {!problem && signature && options.length === 0 && (
        <p className="sheet-assist__sig">
          {signature.map((part, i) =>
            part.current ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed sequence for one function
              <b key={i}>{part.text}</b>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed sequence for one function
              <span key={i}>{part.text}</span>
            ),
          )}
        </p>
      )}
      {!problem && options.length > 0 && (
        <div className="sheet-assist__list" role="listbox" aria-label={label}>
          {options.map((option, i) => {
            const words = describe(option);
            return (
              <div
                key={option.canonical}
                role="option"
                aria-selected={i === highlight}
                tabIndex={-1}
                data-active={i === highlight || undefined}
                className="ac-menu__item"
                onPointerDown={(e) => {
                  // The field keeps the focus and the caret.
                  e.preventDefault();
                  onPick(option);
                }}
              >
                <span className="ac-menu__label">
                  <span className="sheet-assist__name">{option.name}</span>
                  {words && <span className="ac-menu__desc">{words}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
