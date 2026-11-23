import {
  LAYOUTS,
  SLIDE_H,
  SLIDE_LAYOUTS,
  SLIDE_W,
  type SlideLayout,
  type SlideTheme,
  THEME_IDS,
  THEMES,
  type ThemeId,
} from "@agenteschat/live/slides";
import { cx } from "@agenteschat/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fontStack } from "./render";

/**
 * The small pickers of the slides' toolbar (ADR 0196 §2): layouts drawn as little slides, the six themes as previews,
 * a table's size on a grid, and color swatches. All buttons, so the keys reach every choice.
 */

export const LAYOUT_KEYS: Record<SlideLayout, string> = {
  title: "title",
  "title-body": "titleBody",
  section: "section",
  "two-columns": "twoColumns",
  "image-left": "imageLeft",
  "image-right": "imageRight",
  "big-number": "bigNumber",
  quote: "quote",
  "title-only": "titleOnly",
  blank: "blank",
};

/** A layout's schematic in the theme's colors: bars where the title and the text go, a frame for the picture. */
export function LayoutSketch({ layout, theme }: { layout: SlideLayout; theme: SlideTheme }) {
  const c = theme.colors;
  const parts = LAYOUTS[layout].map((slot, i) => {
    const b = slot.box;
    const key = `${layout}-${i}`;
    if (slot.type === "image") {
      return <rect key={key} x={b.x} y={b.y} width={b.w} height={b.h} fill={c.surface} />;
    }
    const role = slot.role;
    if (role === "number") {
      return <rect key={key} x={b.x} y={b.y + b.h - 260} width={b.w * 0.42} height={220} rx={24} fill={c.accent} />;
    }
    if (role === "title" || role === "quote") {
      const h = (slot.style?.size ?? 72) * 0.9;
      return <rect key={key} x={b.x} y={b.y + b.h - h - 24} width={b.w * 0.66} height={h} rx={h / 4} fill={c.text} />;
    }
    if (role === "subtitle" || role === "caption") {
      return <rect key={key} x={b.x} y={b.y + 16} width={b.w * 0.5} height={40} rx={10} fill={c.muted} />;
    }
    const lines = Math.max(2, Math.min(5, Math.floor(b.h / 120)));
    return (
      <g key={key} fill={c.muted}>
        {Array.from({ length: lines }, (_, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static lines of a sketch
          <rect key={j} x={b.x} y={b.y + 16 + j * 92} width={b.w * (j % 2 ? 0.72 : 0.88)} height={36} rx={10} />
        ))}
      </g>
    );
  });
  return (
    <svg className="sl-sketch" viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} aria-hidden="true">
      <rect width={SLIDE_W} height={SLIDE_H} fill={c.bg} />
      {parts}
    </svg>
  );
}

/** The ten layouts as little slides in the deck's theme; `current` outlined. */
export function LayoutPicker({
  theme,
  current,
  onPick,
}: {
  theme: SlideTheme;
  current?: SlideLayout;
  onPick: (layout: SlideLayout) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="sl-picker sl-picker--layouts" aria-label={t("live.slides.layout.label")}>
      {SLIDE_LAYOUTS.map((layout) => (
        <button
          key={layout}
          type="button"
          className="sl-pick"
          aria-pressed={current === layout}
          onClick={() => onPick(layout)}
        >
          <span className="sl-pick__art">
            <LayoutSketch layout={layout} theme={theme} />
          </span>
          <span className="sl-pick__name">
            {t(`live.slides.layouts.${LAYOUT_KEYS[layout]}` as "live.slides.layouts.title")}
          </span>
        </button>
      ))}
    </fieldset>
  );
}

/** A theme's look on a little slide: its background, a title in its heading font, text lines and its accent. */
function ThemeSketch({ theme }: { theme: SlideTheme }) {
  const c = theme.colors;
  return (
    <svg className="sl-sketch" viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} aria-hidden="true">
      <rect width={SLIDE_W} height={SLIDE_H} fill={c.bg} />
      <text
        x={160}
        y={470}
        fill={c.text}
        fontFamily={fontStack(theme.fonts.heading)}
        fontWeight={theme.weights.heading}
        fontSize={300}
      >
        {/* A type specimen, the same in every language. */}
        {"Aa"}
      </text>
      <rect x={160} y={600} width={1000} height={52} rx={14} fill={c.muted} />
      <rect x={160} y={700} width={760} height={52} rx={14} fill={c.muted} />
      <rect x={1400} y={300} width={360} height={360} rx={180} fill={c.accent} />
      <rect x={1400} y={720} width={360} height={60} rx={14} fill={c.accent2} />
    </svg>
  );
}

export function ThemePicker({ current, onPick }: { current: ThemeId; onPick: (theme: ThemeId) => void }) {
  const { t } = useTranslation();
  return (
    <fieldset className="sl-picker sl-picker--themes" aria-label={t("live.slides.theme.label")}>
      {THEME_IDS.map((id) => (
        <button key={id} type="button" className="sl-pick" aria-pressed={current === id} onClick={() => onPick(id)}>
          <span className="sl-pick__art">
            <ThemeSketch theme={THEMES[id]} />
          </span>
          <span className="sl-pick__name">{t(`live.slides.themes.${id}` as "live.slides.themes.sky")}</span>
        </button>
      ))}
    </fieldset>
  );
}

const TABLE_COLS = 8;
const TABLE_ROWS = 8;

/** A table's size: hover or arrow keys over the grid, a press inserts it. */
export function TableSizePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const { t } = useTranslation();
  const [size, setSize] = useState({ rows: 3, cols: 3 });
  const grid = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, [number, number]> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
    };
    const move = step[e.key];
    if (move) {
      e.preventDefault();
      setSize((s) => ({
        rows: Math.min(TABLE_ROWS, Math.max(1, s.rows + move[0])),
        cols: Math.min(TABLE_COLS, Math.max(1, s.cols + move[1])),
      }));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(size.rows, size.cols);
    }
  };
  return (
    <div className="sl-tablepick">
      <div
        ref={grid}
        className="sl-tablepick__grid"
        role="slider"
        tabIndex={0}
        aria-label={t("live.slides.table.size")}
        aria-valuetext={t("live.slides.table.dims", { rows: size.rows, cols: size.cols })}
        aria-valuenow={size.rows * TABLE_COLS + size.cols}
        onKeyDown={onKey}
      >
        {Array.from({ length: TABLE_ROWS }, (_, r) =>
          Array.from({ length: TABLE_COLS }, (_, c) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid
              key={`${r}:${c}`}
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              className={cx("sl-tablepick__cell", r < size.rows && c < size.cols && "is-on")}
              onPointerEnter={() => setSize({ rows: r + 1, cols: c + 1 })}
              onClick={() => onPick(r + 1, c + 1)}
            />
          )),
        )}
      </div>
      <div className="sl-tablepick__dims tabular" aria-hidden="true">
        {t("live.slides.table.dims", { rows: size.rows, cols: size.cols })}
      </div>
    </div>
  );
}

/** Colors anyone can pick, beside the theme's own. */
export const SWATCHES: readonly { key: string; color: string }[] = [
  { key: "red", color: "#d93025" },
  { key: "orange", color: "#e8710a" },
  { key: "yellow", color: "#f2b705" },
  { key: "green", color: "#188038" },
  { key: "teal", color: "#00838f" },
  { key: "blue", color: "#1a5fb4" },
  { key: "purple", color: "#7b3fa0" },
  { key: "pink", color: "#c2185b" },
  { key: "white", color: "#ffffff" },
  { key: "black", color: "#000000" },
];

/**
 * Color swatches: the theme's text, quiet text and accents first (they follow a change of theme), then fixed colors,
 * and "Automatic" (the box's own color) or "No fill".
 */
export function Swatches({
  theme,
  value,
  onPick,
  none,
}: {
  theme: SlideTheme;
  value: string | null;
  onPick: (color: string | null) => void;
  /** The empty choice's words ("Automático", "Sem preenchimento"); its value is `null`. */
  none: string;
}) {
  const { t } = useTranslation();
  const own = [
    { key: "text", color: theme.colors.text },
    { key: "muted", color: theme.colors.muted },
    { key: "accent", color: theme.colors.accent },
    { key: "accent2", color: theme.colors.accent2 },
  ];
  const all = [...own, ...SWATCHES];
  return (
    <div className="sl-swatches">
      <button type="button" className="sl-swatches__none" aria-pressed={value === null} onClick={() => onPick(null)}>
        <span className="sl-swatch sl-swatch--none" aria-hidden="true" />
        {none}
      </button>
      <fieldset className="sl-swatches__grid" aria-label={t("live.slides.colors.label")}>
        {all.map((s) => (
          <button
            key={s.key}
            type="button"
            className="sl-swatch"
            style={{ background: s.color }}
            aria-label={t(`live.slides.colors.${s.key}` as "live.slides.colors.red")}
            aria-pressed={value?.toLowerCase() === s.color.toLowerCase()}
            onClick={() => onPick(s.color)}
          />
        ))}
      </fieldset>
    </div>
  );
}
