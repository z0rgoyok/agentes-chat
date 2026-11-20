import { PEER_COLORS } from "@agenteschat/live";
import {
  type BorderPreset,
  type CellStyle,
  type CellValue,
  colName,
  formatValue,
  NUMBER_FORMATS,
  type NumberFormatPreset,
  numberFormatPreset,
  type SheetLocale,
} from "@agenteschat/live/spreadsheet";
import {
  Button,
  cx,
  Icon,
  type IconName,
  isApple,
  Menu,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  Popover,
  useScrollSides,
} from "@agenteschat/ui";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The spreadsheet's toolbar (ADR 0196): undo and redo, number formats and decimals, bold, italic, underline and
 * strikethrough, text and fill colors, alignment and wrapping, merging and borders, frozen panes, sorting and the
 * common functions. One row of 32 px icon buttons in groups, scrolling sideways with faded edges when it doesn't
 * fit, a single tab stop moved with the arrow keys (`role="toolbar"`). Every tip says the button's name and its keys.
 */

/** The colors a cell's text can take: the live files' ten hues, each readable on white. */
export const TEXT_COLORS: readonly string[] = PEER_COLORS.map((c) => c.light);
/** Their soft fills, light enough for any text color. */
export const FILL_COLORS: readonly string[] = PEER_COLORS.map((c) => tint(c.light, 0.18));
/** The swatches' names (`live.sheet.colors.*`), in the palette's order. */
export const COLOR_KEYS = [
  "red",
  "emerald",
  "magenta",
  "orange",
  "cyan",
  "olive",
  "plum",
  "lime",
  "slate",
  "brown",
] as const;

/** A color mixed with white (`share` of the color), as `#rrggbb`. */
export function tint(hex: string, share: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = Number.parseInt(m[1] as string, 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 255;
    return Math.round(v * share + 255 * (1 - share))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const PRESETS: readonly NumberFormatPreset[] = [
  "general",
  "number",
  "integer",
  "percent",
  "percent2",
  "currency",
  "date",
  "time",
  "datetime",
  "scientific",
  "text",
];

/** What each format looks like, shown beside its name ("R$ 1.234,56"). */
const SAMPLES: Record<NumberFormatPreset, CellValue> = {
  general: 1234.5,
  number: 1234.56,
  integer: 1234,
  percent: 0.12,
  percent2: 0.1234,
  currency: 1234.56,
  date: 46343,
  time: 0.6041666667,
  datetime: 46343.6041666667,
  scientific: 123456,
  text: "abc",
};

const BORDERS: readonly BorderPreset[] = [
  "all",
  "outer",
  "inner",
  "horizontal",
  "vertical",
  "top",
  "bottom",
  "left",
  "right",
  "none",
];

const FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"] as const;
export type QuickFunction = (typeof FUNCTIONS)[number];

export interface ToolbarProps {
  locale: SheetLocale;
  /** The active cell's style and value (what the buttons show as on). */
  style: CellStyle | undefined;
  value: CellValue;
  /** The selection holds a merge. */
  merged: boolean;
  frozen: { rows: number; cols: number };
  /** The active cell (freezing up to it). */
  active: { r: number; c: number };
  canUndo: boolean;
  canRedo: boolean;
  /** The functions' names in the reader's language. */
  functionName(canonical: QuickFunction): string;
  onUndo(): void;
  onRedo(): void;
  onFormat(patch: Partial<CellStyle>): void;
  onNumberFormat(preset: NumberFormatPreset): void;
  onDecimals(delta: 1 | -1): void;
  onBorders(preset: BorderPreset): void;
  onMerge(): void;
  onFreeze(rows: number, cols: number): void;
  onSort(desc: boolean): void;
  onFunction(name: QuickFunction): void;
  /** Focus goes back to the grid after a menu. */
  onDone(): void;
}

export function SheetToolbar(props: ToolbarProps) {
  const { t } = useTranslation();
  const { style, locale } = props;
  const bar = useRef<HTMLDivElement>(null);
  const sides = useScrollSides(bar);
  useRoving(bar);
  const apple = isApple();
  /** A shortcut as the platform writes it ("⌘⇧Z", "Ctrl+Shift+Z") and as `aria-keyshortcuts` names it. */
  const keys = (key: string, shift = false) => ({
    shown: apple ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`,
    aria: `${apple ? "Meta" : "Control"}+${shift ? "Shift+" : ""}${key}`,
  });
  const preset = numberFormatPreset(style?.nf, locale);
  const keep = (e: { preventDefault(): void }) => e.preventDefault();

  const tool = (
    icon: IconName,
    name: string,
    run: () => void,
    opts: { pressed?: boolean; disabled?: boolean; shortcut?: { shown: string; aria: string } } = {},
  ) => (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={name}
      title={opts.shortcut ? `${name} (${opts.shortcut.shown})` : name}
      aria-keyshortcuts={opts.shortcut?.aria}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onMouseDown={keep}
      onClick={() => {
        run();
        props.onDone();
      }}
    />
  );

  const menuButton = (icon: IconName, name: string, extra?: ReactNode) => (
    <Button size="sm" variant="ghost" className="sheet-tools__menu" aria-label={name} title={name} onMouseDown={keep}>
      <Icon name={icon} size={20} />
      {extra}
      <Icon name="chevronDown" size={14} className="sheet-tools__chev" />
    </Button>
  );

  const sep = <span className="sheet-tools__sep" aria-hidden="true" />;
  const freezeRow = props.active.r + 1;
  const freezeCol = props.active.c + 1;

  return (
    <div
      ref={bar}
      className="sheet-tools"
      data-sides={sides}
      role="toolbar"
      aria-label={t("live.sheet.toolbar")}
      aria-orientation="horizontal"
    >
      {tool("undo", t("live.sheet.undo"), props.onUndo, { disabled: !props.canUndo, shortcut: keys("Z") })}
      {tool("redo", t("live.sheet.redo"), props.onRedo, {
        disabled: !props.canRedo,
        shortcut: apple ? keys("Z", true) : keys("Y"),
      })}
      {sep}
      <Menu
        label={t("live.sheet.numberFormat")}
        onClosed={props.onDone}
        trigger={menuButton("numberFormat", t("live.sheet.numberFormat"))}
      >
        {PRESETS.map((p) => (
          <MenuItem
            key={p}
            icon={preset === p ? "check" : undefined}
            leading={preset === p ? undefined : <span className="sheet-tools__blank" />}
            hint={formatValue(SAMPLES[p], NUMBER_FORMATS[p](locale), locale).text}
            onSelect={() => props.onNumberFormat(p)}
          >
            {t(`live.sheet.formats.${p}`)}
          </MenuItem>
        ))}
        {preset === null && (
          <>
            <MenuSeparator />
            <MenuItem icon="check" disabled hint={style?.nf}>
              {t("live.sheet.formats.custom")}
            </MenuItem>
          </>
        )}
      </Menu>
      {tool("decimalsLess", t("live.sheet.decimalsLess"), () => props.onDecimals(-1))}
      {tool("decimalsMore", t("live.sheet.decimalsMore"), () => props.onDecimals(1))}
      {sep}
      {tool("bold", t("live.sheet.bold"), () => props.onFormat({ b: style?.b ? undefined : 1 }), {
        pressed: !!style?.b,
        shortcut: keys("B"),
      })}
      {tool("italic", t("live.sheet.italic"), () => props.onFormat({ i: style?.i ? undefined : 1 }), {
        pressed: !!style?.i,
        shortcut: keys("I"),
      })}
      {tool("underline", t("live.sheet.underline"), () => props.onFormat({ u: style?.u ? undefined : 1 }), {
        pressed: !!style?.u,
        shortcut: keys("U"),
      })}
      {tool("strike", t("live.sheet.strike"), () => props.onFormat({ x: style?.x ? undefined : 1 }), {
        pressed: !!style?.x,
      })}
      {sep}
      <ColorButton
        icon="textColor"
        name={t("live.sheet.textColor")}
        colors={TEXT_COLORS}
        value={style?.fc}
        none={t("live.sheet.automatic")}
        onPick={(color) => props.onFormat({ fc: color ?? undefined })}
        onDone={props.onDone}
      />
      <ColorButton
        icon="fillColor"
        name={t("live.sheet.fillColor")}
        colors={FILL_COLORS}
        value={style?.bg}
        none={t("live.sheet.noFill")}
        onPick={(color) => props.onFormat({ bg: color ?? undefined })}
        onDone={props.onDone}
      />
      {sep}
      {tool("alignLeft", t("live.sheet.alignLeft"), () => props.onFormat({ ha: style?.ha === "l" ? undefined : "l" }), {
        pressed: style?.ha === "l",
      })}
      {tool(
        "alignCenter",
        t("live.sheet.alignCenter"),
        () => props.onFormat({ ha: style?.ha === "c" ? undefined : "c" }),
        { pressed: style?.ha === "c" },
      )}
      {tool(
        "alignRight",
        t("live.sheet.alignRight"),
        () => props.onFormat({ ha: style?.ha === "r" ? undefined : "r" }),
        { pressed: style?.ha === "r" },
      )}
      {tool("wrap", t("live.sheet.wrap"), () => props.onFormat({ w: style?.w ? undefined : 1 }), {
        pressed: !!style?.w,
      })}
      {sep}
      {tool("merge", props.merged ? t("live.sheet.unmerge") : t("live.sheet.merge"), props.onMerge, {
        pressed: props.merged,
      })}
      <Menu
        label={t("live.sheet.borders")}
        onClosed={props.onDone}
        trigger={menuButton("borders", t("live.sheet.borders"))}
      >
        {BORDERS.map((preset) => (
          <MenuItem key={preset} onSelect={() => props.onBorders(preset)}>
            {t(`live.sheet.border.${preset}`)}
          </MenuItem>
        ))}
      </Menu>
      {sep}
      <Menu
        label={t("live.sheet.freeze")}
        onClosed={props.onDone}
        trigger={menuButton("freeze", t("live.sheet.freeze"))}
      >
        <MenuItem
          icon={props.frozen.rows === 0 && props.frozen.cols === 0 ? "check" : undefined}
          onSelect={() => props.onFreeze(0, 0)}
        >
          {t("live.sheet.frozen.none")}
        </MenuItem>
        <MenuSeparator />
        <MenuHeading>{t("live.sheet.frozen.rows")}</MenuHeading>
        <MenuItem
          icon={props.frozen.rows === 1 ? "check" : undefined}
          onSelect={() => props.onFreeze(1, props.frozen.cols)}
        >
          {t("live.sheet.frozen.row", { count: 1 })}
        </MenuItem>
        <MenuItem
          icon={props.frozen.rows === 2 ? "check" : undefined}
          onSelect={() => props.onFreeze(2, props.frozen.cols)}
        >
          {t("live.sheet.frozen.row", { count: 2 })}
        </MenuItem>
        {freezeRow > 2 && (
          <MenuItem
            icon={props.frozen.rows === freezeRow ? "check" : undefined}
            onSelect={() => props.onFreeze(freezeRow, props.frozen.cols)}
          >
            {t("live.sheet.frozen.upToRow", { n: freezeRow })}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuHeading>{t("live.sheet.frozen.cols")}</MenuHeading>
        <MenuItem
          icon={props.frozen.cols === 1 ? "check" : undefined}
          onSelect={() => props.onFreeze(props.frozen.rows, 1)}
        >
          {t("live.sheet.frozen.col", { count: 1 })}
        </MenuItem>
        <MenuItem
          icon={props.frozen.cols === 2 ? "check" : undefined}
          onSelect={() => props.onFreeze(props.frozen.rows, 2)}
        >
          {t("live.sheet.frozen.col", { count: 2 })}
        </MenuItem>
        {freezeCol > 2 && (
          <MenuItem
            icon={props.frozen.cols === freezeCol ? "check" : undefined}
            onSelect={() => props.onFreeze(props.frozen.rows, freezeCol)}
          >
            {t("live.sheet.frozen.upToCol", { name: colName(freezeCol - 1) })}
          </MenuItem>
        )}
      </Menu>
      {sep}
      {tool("sortAsc", t("live.sheet.sortAsc"), () => props.onSort(false))}
      {tool("sortDesc", t("live.sheet.sortDesc"), () => props.onSort(true))}
      {sep}
      <Menu
        label={t("live.sheet.functions")}
        onClosed={props.onDone}
        trigger={menuButton("sigma", t("live.sheet.functions"))}
      >
        {FUNCTIONS.map((name) => (
          <MenuItem key={name} onSelect={() => props.onFunction(name)}>
            {props.functionName(name)}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

/** A color menu: "Automático" and ten swatches, the chosen one checked. */
function ColorButton({
  icon,
  name,
  colors,
  value,
  none,
  onPick,
  onDone,
}: {
  icon: IconName;
  name: string;
  colors: readonly string[];
  value: string | undefined;
  none: string;
  onPick(color: string | null): void;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pick = (color: string | null) => {
    onPick(color);
    setOpen(false);
    onDone();
  };
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const step =
      e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowDown"
            ? 5
            : e.key === "ArrowUp"
              ? -5
              : 0;
    if (!step) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  };
  return (
    <Popover
      label={name}
      side="bottom"
      align="start"
      open={open}
      onOpenChange={setOpen}
      className="sheet-colors"
      trigger={
        // Square as every glyph-only button of the bar: its glyph and the color's bar under it.
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          className="sheet-tools__color"
          aria-label={name}
          title={name}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Icon name={icon} size={20} />
          <span className="sheet-tools__swatch" style={{ background: value ?? "transparent" }} aria-hidden="true" />
        </Button>
      }
    >
      <button type="button" className="sheet-colors__auto" aria-pressed={!value} onClick={() => pick(null)}>
        <span className="sheet-colors__none" aria-hidden="true" />
        {none}
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the swatches it holds */}
      <div className="sheet-colors__grid" onKeyDown={onGridKey}>
        {colors.map((color, i) => (
          <button
            key={color}
            type="button"
            className={cx("sheet-colors__swatch", value?.toLowerCase() === color.toLowerCase() && "is-on")}
            style={{ background: color }}
            aria-label={t(`live.sheet.colors.${COLOR_KEYS[i] ?? "slate"}`)}
            title={t(`live.sheet.colors.${COLOR_KEYS[i] ?? "slate"}`)}
            aria-pressed={value?.toLowerCase() === color.toLowerCase()}
            onClick={() => pick(color)}
          />
        ))}
      </div>
    </Popover>
  );
}

/** One tab stop for a toolbar: the arrow keys, Home and End move between its buttons. */
export function useRoving(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = () =>
      [...el.querySelectorAll<HTMLElement>("button, [role='button']")].filter(
        (b) => !(b as HTMLButtonElement).disabled && b.closest("[role='toolbar']") === el,
      );
    const settle = (current: HTMLElement | null) => {
      const list = items();
      const keep = current && list.includes(current) ? current : list[0];
      for (const b of list) b.tabIndex = b === keep ? 0 : -1;
    };
    settle(null);
    const onFocus = (e: FocusEvent) => settle(e.target as HTMLElement);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? list.length - 1
            : (at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    };
    // Buttons that turn disabled or come back keep one stop.
    const watch = new MutationObserver(() => settle(document.activeElement as HTMLElement));
    watch.observe(el, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
    el.addEventListener("focusin", onFocus);
    el.addEventListener("keydown", onKey);
    return () => {
      watch.disconnect();
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("keydown", onKey);
    };
  }, [ref]);
}
