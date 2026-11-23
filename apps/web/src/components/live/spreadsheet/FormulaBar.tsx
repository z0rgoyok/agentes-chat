import { Icon } from "@agenteschat/ui";
import { type KeyboardEvent, type Ref, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ColoredSpan, FormulaInput } from "./FormulaInput";

/**
 * The formula bar (ADR 0196), on one line with no boxes: the selection's address as quiet text (a click turns it into
 * its field: type a cell or a range and Enter goes there, Esc comes back), a hairline, the fx mark, and the active
 * cell's content as typed, in the person's language, editable here as in the cell; a formula in the code face.
 */
export interface FormulaBarProps {
  /** "B4", "B2:E9". */
  address: string;
  /** Goes to an address typed in the name box; false when it isn't one (the box says so). */
  onJump(text: string): boolean;
  /** Back to the grid (Esc in the name box). */
  onLeave(): void;
  value: string;
  spans: readonly ColoredSpan[];
  editable: boolean;
  inputRef: Ref<HTMLTextAreaElement>;
  /** The bar's field wraps this (the assist hangs under it). */
  boxRef?: Ref<HTMLDivElement>;
  onFocusInput(): void;
  onText(text: string, caret: number): void;
  onCaret(caret: number): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
  /** Copy, cut and paste typed in the bar stay the field's own. */
  onBlurInput?(): void;
}

export function FormulaBar(props: FormulaBarProps) {
  const { t } = useTranslation();
  const [typing, setTyping] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  return (
    <div className="sheet-bar">
      <input
        className="sheet-bar__name"
        aria-label={t("live.sheet.nameBox")}
        title={t("live.sheet.nameBox")}
        aria-invalid={wrong || undefined}
        value={typing ?? props.address}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          setTyping(props.address);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setTyping(e.target.value);
          setWrong(false);
        }}
        onBlur={() => {
          setTyping(null);
          setWrong(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (props.onJump(typing ?? "")) {
              setTyping(null);
              props.onLeave();
            } else {
              setWrong(true);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            setTyping(null);
            props.onLeave();
          }
        }}
      />
      <span className="sheet-bar__sep" aria-hidden="true" />
      <span className="sheet-bar__fx" title={t("live.sheet.fx")}>
        <Icon name="formula" size={18} label={t("live.sheet.fx")} />
      </span>
      <div ref={props.boxRef} className="sheet-bar__field">
        <FormulaInput
          ref={props.inputRef}
          boxClassName="sheet-bar__fx-box"
          className="sheet-bar__input"
          aria-label={t("live.sheet.formula")}
          value={props.value}
          spans={props.spans}
          readOnly={!props.editable}
          wrap="off"
          onFocus={props.onFocusInput}
          onBlur={props.onBlurInput}
          onText={props.onText}
          onCaret={props.onCaret}
          onKeyDown={props.onKeyDown}
        />
      </div>
    </div>
  );
}
