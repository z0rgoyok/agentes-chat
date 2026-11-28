import type { Agent } from "@agenteschat/client";
import { formatInt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type ArrowRoute,
  CANVAS_SHAPE_KINDS,
  type CanvasShapeKind,
  NOTE_COLORS,
  type NoteColor,
  type ShapeView,
} from "@agenteschat/live/canvas";
import { Button, type ButtonProps, Icon, type IconName, Menu, MenuItem, MenuSeparator, Popover } from "@agenteschat/ui";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FontChoices, FontPicker, fontWeights } from "../type/FontPicker";
import {
  EffectsMenu,
  type EffectsPatch,
  TextStyleMenu,
  TYPE_WEIGHTS,
  TypeGlyph,
  type TypePatch,
} from "../type/TypeMenus";
import type { Size } from "./camera";
import { inkSwatch, rovingKeys } from "./chrome";
import { DARK_INK, isInk, SOFT } from "./palette";
import {
  CORNER_RADII,
  HEADS_CHOICES,
  type HeadsChoice,
  headsOf,
  INKS,
  KIND_ICONS,
  PEN_SIZES,
  type PenSize,
  penSizeOf,
  ROUTE_CHOICES,
  STROKE_WIDTHS,
} from "./tools";

/**
 * The bar over what is selected on a canvas (ADR 0196 §2), with what that kind of thing takes: a picture asks its
 * agent for variations or about it, is cropped, replaced or downloaded; a shape changes form, fill, border and corners
 * and effects and takes a label; an arrow or a line its route, dash, ends, color and label; a note its color; a text
 * its font, its style ("Aa") and its size (ADR 0220 §8); a pen stroke its color and size; several kinds what they share. Then Arrange and ⋯ (duplicate, lock, delete) for all.
 * It sits above the selection, kept inside the plane (below it when there is no room above), with the selection's size
 * under it.
 */

export type BarAction =
  | { kind: "color"; color: NoteColor }
  | { kind: "fill"; fill: string | null }
  | { kind: "stroke"; stroke: string | null }
  | { kind: "strokeWidth"; width: number }
  | { kind: "radius"; radius: number }
  | { kind: "size"; size: number }
  | { kind: "font"; font: string }
  | { kind: "type"; patch: TypePatch }
  | { kind: "effects"; patch: EffectsPatch }
  | { kind: "bringFont" }
  | { kind: "shapeKind"; shapeKind: CanvasShapeKind }
  | { kind: "route"; route: ArrowRoute }
  | { kind: "heads"; heads: HeadsChoice }
  | { kind: "dashed"; dashed: boolean }
  | { kind: "penSize"; size: PenSize }
  | { kind: "editText" }
  | { kind: "label" }
  | { kind: "rename" }
  | { kind: "variations" }
  | { kind: "ask" }
  | { kind: "crop" }
  | { kind: "replace" }
  | { kind: "download" }
  | { kind: "copyImage" }
  | { kind: "open" }
  | { kind: "details" }
  | { kind: "arrange"; how: "front" | "forward" | "backward" | "back" }
  | { kind: "duplicate" }
  | { kind: "lock"; locked: boolean }
  | { kind: "delete" };

/** Text sizes a text box offers (world units). */
export const TEXT_SIZES = [
  { size: 16, key: "s" },
  { size: 24, key: "m" },
  { size: 40, key: "l" },
  { size: 64, key: "xl" },
] as const;

/** The bars' height, and the room kept between them and the selection or the plane's edges (screen pixels). */
const BAR_H = 40;
const GAP = 12;
const EDGE = 8;
/** Room the size tag under a selection takes. */
const TAG_ROOM = 28;
/** Room the dock takes at the plane's bottom. */
const DOCK_ROOM = 80;
/** Where a bar goes when the selection fills the plane: under the zoom island. */
const PINNED_TOP = 64;

/** Where a selection is on screen, for what is drawn around it. */
export interface Anchor {
  /** Its middle, across. */
  x: number;
  top: number;
  bottom: number;
}

/**
 * Places a bar over a selection: centered above it, kept inside the plane (from `left`, the layers panel's edge when
 * open); below it when there is no room above, else at the plane's top.
 */
export function BarSpot({
  anchor,
  stage,
  left = EDGE,
  children,
}: {
  anchor: Anchor;
  stage: Size;
  left?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    if (w !== width) setWidth(w);
  });
  const half = width / 2;
  const x = Math.max(left + half, Math.min(anchor.x, stage.w - EDGE - half));
  let style: CSSProperties;
  if (anchor.top - GAP - BAR_H >= EDGE) style = { left: x, top: anchor.top - GAP, transform: "translate(-50%, -100%)" };
  else if (anchor.bottom + GAP + TAG_ROOM + BAR_H <= stage.h - DOCK_ROOM) {
    style = { left: x, top: anchor.bottom + GAP + TAG_ROOM, transform: "translate(-50%, 0)" };
  } else style = { left: x, top: PINNED_TOP, transform: "translate(-50%, 0)" };
  return (
    <div ref={ref} className="cnv-barspot" style={style}>
      {children}
    </div>
  );
}

/** The size tag's height (`.cnv-sizetag`: a 16 px line and 1 px above and below). */
const SIZE_TAG_H = 18;

/** "1024 × 1024" under the selection: its box in world units (a picture: the pixels it shows). */
export function SizeTag({ anchor, stage, w, h }: { anchor: Anchor; stage: Size; w: number; h: number }) {
  const { i18n } = useTranslation();
  const x = Math.max(48, Math.min(anchor.x, stage.w - 48));
  // Under the selection, or held inside the plane when that would run past its bottom.
  const top = Math.max(EDGE, Math.min(anchor.bottom + EDGE, stage.h - SIZE_TAG_H - EDGE));
  return (
    <span className="cnv-sizetag tabular" style={{ left: x, top }}>
      {`${formatInt(i18n.language, w)} × ${formatInt(i18n.language, h)}`}
    </span>
  );
}

/** The size a selection's tag says: one picture its pixels shown, anything else its box. */
export function sizeOf(shapes: readonly ShapeView[], bounds: { w: number; h: number }): { w: number; h: number } {
  const only = shapes.length === 1 ? shapes[0] : undefined;
  if (only?.type === "image" && only.nw && only.nh) {
    return { w: only.nw * (only.crop?.w ?? 1), h: only.nh * (only.crop?.h ?? 1) };
  }
  return { w: bounds.w, h: bounds.h };
}

const Divider = () => <span className="cnv-bar__divider" aria-hidden="true" />;

/** A swatch to pick: its value (null: the default look; "none": nothing), its name and its look in each theme. */
interface SwatchChoice {
  value: string | null;
  name: string;
  light: string;
  dark: string;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null)?.toLowerCase() === (b ?? null)?.toLowerCase();

/** The value all the shapes share for a key, else undefined (a mix). */
function shared<K extends keyof ShapeView>(shapes: readonly ShapeView[], key: K): ShapeView[K] | null | undefined {
  const first = shapes[0]?.[key] ?? null;
  return shapes.every((s) => (s[key] ?? null) === first) ? first : undefined;
}

/** A grid of round swatches (radio buttons): ← → ↑ ↓ move between them. */
function SwatchGrid({
  label,
  choices,
  value,
  onPick,
}: {
  label: string;
  choices: readonly SwatchChoice[];
  value: string | null | undefined;
  onPick(value: string | null): void;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
    if (!step) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  };
  return (
    <div className="cnv-colors__grid" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {choices.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
        <button
          key={c.value ?? "auto"}
          type="button"
          role="radio"
          className="cnv-colors__swatch"
          data-none={c.value === "none" || undefined}
          data-auto={c.value === null || undefined}
          aria-checked={value !== undefined && same(value, c.value)}
          aria-label={c.name}
          title={c.name}
          style={{ "--swatch": c.light, "--swatch-dark": c.dark } as CSSProperties}
          onClick={() => onPick(c.value)}
        />
      ))}
    </div>
  );
}

/** Numbers to pick (a border's width, corners' radius) as radio buttons. */
function NumberRow({
  label,
  values,
  value,
  onPick,
}: {
  label: string;
  values: readonly number[];
  value: number | undefined;
  onPick(value: number): void;
}) {
  const { i18n } = useTranslation();
  return (
    <div className="cnv-colors__numbers" role="radiogroup" aria-label={label}>
      {values.map((v) => (
        // biome-ignore lint/a11y/useSemanticElements: a number button in a radio group
        <button
          key={v}
          type="button"
          role="radio"
          className="cnv-bar__size tabular"
          aria-checked={value === v}
          onClick={() => onPick(v)}
        >
          {formatInt(i18n.language, v)}
        </button>
      ))}
    </div>
  );
}

/** A round dot showing a color in the bar (a ring for a border; crossed out for none). */
function Dot({ choice, ring }: { choice: SwatchChoice | null; ring?: boolean }) {
  return (
    <span
      className="cnv-dot"
      data-ring={ring || undefined}
      data-none={choice?.value === "none" || undefined}
      data-auto={!choice || choice.value === null || undefined}
      style={choice ? ({ "--dot": choice.light, "--dot-dark": choice.dark } as CSSProperties) : undefined}
      aria-hidden="true"
    />
  );
}

/** The colors a shape is filled with: none and the default, the canvas's soft tones, the inks. */
function useFills(): { plain: SwatchChoice[]; soft: SwatchChoice[]; strong: SwatchChoice[] } {
  const { t } = useTranslation();
  return {
    plain: [
      { value: "none", name: t("live.canvas.bar.noFill"), light: "transparent", dark: "transparent" },
      { value: null, name: t("live.canvas.bar.auto"), light: "var(--raised)", dark: "var(--raised)" },
    ],
    soft: NOTE_COLORS.map((c) => ({ value: SOFT[c].light, name: t(`live.canvas.colors.${c}`), ...SOFT[c] })),
    strong: INKS.map((ink) => ({
      value: ink.color,
      name: t(`live.canvas.inks.${ink.key}`),
      light: ink.color,
      dark: isInk(ink.color) ? DARK_INK : ink.color,
    })),
  };
}

/** The colors a border, a line or a pen stroke takes: the default, the inks (and none, for a border). */
function useStrokes(withNone: boolean): SwatchChoice[] {
  const { t } = useTranslation();
  return [
    ...(withNone
      ? [{ value: "none", name: t("live.canvas.bar.noStroke"), light: "transparent", dark: "transparent" }]
      : []),
    { value: null, name: t("live.canvas.bar.auto"), light: "var(--line-strong)", dark: "var(--line-strong)" },
    ...INKS.map((ink) => ({
      value: ink.color,
      name: t(`live.canvas.inks.${ink.key}`),
      light: ink.color,
      dark: isInk(ink.color) ? DARK_INK : ink.color,
    })),
  ];
}

/** The swatch for a value (a color from outside the palette: as it is); undefined, a mix: none. */
function choiceOf(choices: readonly SwatchChoice[], value: string | null | undefined): SwatchChoice | null {
  if (value === undefined) return null;
  return choices.find((c) => same(c.value, value)) ?? { value, name: "", light: value ?? "", dark: value ?? "" };
}

/** Preenchimento: the fill's dot and ▾, its swatches in a popover. */
function FillPicker({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fills = useFills();
  const all = [...fills.plain, ...fills.soft, ...fills.strong];
  const value = shared(shapes, "fill");
  const name = t("live.canvas.bar.fill");
  const pick = (fill: string | null) => {
    onAction({ kind: "fill", fill });
    setOpen(false);
  };
  return (
    <Popover
      label={name}
      side="top"
      align="center"
      open={open}
      onOpenChange={setOpen}
      className="cnv-colors"
      trigger={
        <Button size="sm" variant="ghost" className="cnv-bar__pick" aria-label={name} title={name}>
          <Dot choice={choiceOf(all, value)} />
          <Icon name="chevronDown" size={16} />
        </Button>
      }
    >
      <SwatchGrid label={name} choices={fills.plain} value={value} onPick={pick} />
      <SwatchGrid label={t("live.canvas.bar.soft")} choices={fills.soft} value={value} onPick={pick} />
      <SwatchGrid label={t("live.canvas.bar.strong")} choices={fills.strong} value={value} onPick={pick} />
    </Popover>
  );
}

/** Borda (or a line's Cor): the stroke's ring, its width and ▾; colors and widths in a popover. */
function StrokePicker({
  shapes,
  border,
  onAction,
}: {
  shapes: readonly ShapeView[];
  /** A shape's border (it may have none); else a line's or a stroke's color. */
  border: boolean;
  onAction(a: BarAction): void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const strokes = useStrokes(border);
  const value = shared(shapes, "stroke");
  const width = shared(shapes, "strokeWidth");
  const name = border ? t("live.canvas.bar.stroke") : t("live.canvas.bar.lineColor");
  const shownWidth = width === undefined ? undefined : (width ?? 2);
  return (
    <Popover
      label={name}
      side="top"
      align="center"
      open={open}
      onOpenChange={setOpen}
      className="cnv-colors"
      trigger={
        <Button size="sm" variant="ghost" className="cnv-bar__pick" aria-label={name} title={name}>
          <Dot choice={choiceOf(strokes, value)} ring />
          {shownWidth !== undefined && (
            <span className="cnv-bar__num tabular">{formatInt(i18n.language, shownWidth)}</span>
          )}
          <Icon name="chevronDown" size={16} />
        </Button>
      }
    >
      <SwatchGrid
        label={name}
        choices={strokes}
        value={value}
        onPick={(stroke) => onAction({ kind: "stroke", stroke })}
      />
      <NumberRow
        label={t("live.canvas.bar.strokeWidth")}
        values={STROKE_WIDTHS}
        value={shownWidth}
        onPick={(w) => onAction({ kind: "strokeWidth", width: w })}
      />
    </Popover>
  );
}

/** Cantos: a rectangle's corner radius. */
function CornersPicker({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const radius = shared(shapes, "radius");
  const name = t("live.canvas.bar.corners");
  return (
    <Popover
      label={name}
      side="top"
      align="center"
      open={open}
      onOpenChange={setOpen}
      className="cnv-colors"
      trigger={<Button size="sm" variant="ghost" iconOnly icon="corners" aria-label={name} title={name} />}
    >
      <NumberRow
        label={name}
        values={CORNER_RADII}
        value={radius === undefined ? undefined : (radius ?? 8)}
        onPick={(r) => {
          onAction({ kind: "radius", radius: r });
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** Pontas: an arrow's heads (none, at the end, at both, at the start). */
function HeadsMenu({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const heads = shapes.map(headsOf);
  const current = heads.every((h) => h === heads[0]) ? heads[0] : undefined;
  const name = t("live.canvas.heads.label");
  const icon = HEADS_CHOICES.find((h) => h.heads === current)?.icon ?? "arrowTool";
  return (
    <Menu
      label={name}
      align="center"
      side="top"
      trigger={<Button size="sm" variant="ghost" iconOnly icon={icon} aria-label={name} title={name} />}
    >
      {HEADS_CHOICES.map((h) => (
        <MenuItem key={h.heads} icon={h.icon} onSelect={() => onAction({ kind: "heads", heads: h.heads })}>
          {t(`live.canvas.heads.${h.heads}`)}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** Organizar: the stacking menu. */
function ArrangeMenu({ onAction }: { onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const name = t("live.canvas.arrange.label");
  return (
    <Menu
      label={name}
      align="end"
      side="top"
      trigger={<Button size="sm" variant="ghost" iconOnly icon="layers" aria-label={name} title={name} />}
    >
      <MenuItem icon="bringFront" onSelect={() => onAction({ kind: "arrange", how: "front" })}>
        {t("live.canvas.arrange.front")}
      </MenuItem>
      <MenuItem onSelect={() => onAction({ kind: "arrange", how: "forward" })}>
        {t("live.canvas.arrange.forward")}
      </MenuItem>
      <MenuItem onSelect={() => onAction({ kind: "arrange", how: "backward" })}>
        {t("live.canvas.arrange.backward")}
      </MenuItem>
      <MenuItem icon="sendBack" onSelect={() => onAction({ kind: "arrange", how: "back" })}>
        {t("live.canvas.arrange.back")}
      </MenuItem>
    </Menu>
  );
}

/** ⋯: a picture's details, copy and full view; then duplicate, lock and delete. */
function MoreMenu({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const name = t("live.canvas.bar.more");
  const locked = shapes.every((s) => s.locked);
  const picture = shapes.length === 1 && shapes[0]?.type === "image" && shapes[0].asset;
  return (
    <Menu
      label={name}
      align="end"
      side="top"
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={name} title={name} />}
    >
      {picture && (
        <>
          <MenuItem icon="info" onSelect={() => onAction({ kind: "details" })}>
            {t("live.canvas.image.details")}
          </MenuItem>
          <MenuItem icon="copy" onSelect={() => onAction({ kind: "copyImage" })}>
            {t("live.canvas.inspector.copy")}
          </MenuItem>
          <MenuItem icon="expand" onSelect={() => onAction({ kind: "open" })}>
            {t("live.canvas.inspector.open")}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem icon="copy" onSelect={() => onAction({ kind: "duplicate" })}>
        {t("live.canvas.actions.duplicate")}
      </MenuItem>
      <MenuItem icon="lock" onSelect={() => onAction({ kind: "lock", locked: !locked })}>
        {locked ? t("live.canvas.actions.unlock") : t("live.canvas.actions.lock")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="trash" danger onSelect={() => onAction({ kind: "delete" })}>
        {t("live.canvas.actions.delete")}
      </MenuItem>
    </Menu>
  );
}

/** The note colors as swatches (the note bar). */
function NoteColors({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const current = shared(shapes, "color") ?? null;
  return (
    <div className="cnv-bar__swatches" role="radiogroup" aria-label={t("live.canvas.bar.color")}>
      {NOTE_COLORS.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={current === c}
          aria-label={t(`live.canvas.colors.${c}`)}
          title={t(`live.canvas.colors.${c}`)}
          className="cnv-bar__swatch"
          data-color={c}
          style={{ "--swatch": SOFT[c].light, "--swatch-dark": SOFT[c].dark } as CSSProperties}
          onClick={() => onAction({ kind: "color", color: c })}
        />
      ))}
    </div>
  );
}

/** A pen stroke's inks and sizes (the pen bar's own). */
function StrokeInks({ shapes, onAction }: { shapes: readonly ShapeView[]; onAction(a: BarAction): void }) {
  const { t } = useTranslation();
  const color = shared(shapes, "stroke");
  const sizes = shapes.map((s) => penSizeOf(s.tool ?? "pen", s.strokeWidth));
  const size = sizes.every((s) => s === sizes[0]) ? sizes[0] : undefined;
  return (
    <>
      <div className="cnv-bar__swatches" role="radiogroup" aria-label={t("live.canvas.pen.color")}>
        {INKS.map((ink) => (
          // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
          <button
            key={ink.key}
            type="button"
            role="radio"
            className="cnv-bar__swatch"
            aria-checked={same(color, ink.color)}
            aria-label={t(`live.canvas.inks.${ink.key}`)}
            title={t(`live.canvas.inks.${ink.key}`)}
            style={inkSwatch(ink.color)}
            onClick={() => onAction({ kind: "stroke", stroke: ink.color })}
          />
        ))}
      </div>
      <Divider />
      <div className="cnv-bar__sizes" role="radiogroup" aria-label={t("live.canvas.pen.size")}>
        {PEN_SIZES.map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: a size button in a radio group
          <button
            key={s}
            type="button"
            role="radio"
            className="cnv-bar__size"
            aria-checked={size === s}
            aria-label={t(`live.canvas.pen.sizes.${s}`)}
            title={t(`live.canvas.pen.sizes.${s}`)}
            onClick={() => onAction({ kind: "penSize", size: s })}
          >
            {t(`live.canvas.pen.short.${s}`)}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The bar over the selection. `agent` is the file's agent ("Pedir ao Atlas", null: none to ask); `canAsk` says the
 * file's conversation takes requests (not on a saved version).
 */
export function SelectionBar({
  shapes,
  agent,
  canAsk,
  fonts,
  onAction,
}: {
  shapes: readonly ShapeView[];
  agent: Agent | null;
  canAsk: boolean;
  /** The font list's choices: the canvas's fonts in use, the file's own. */
  fonts: FontChoices;
  onAction(action: BarAction): void;
}) {
  const { t } = useTranslation();
  const first = shapes[0];
  if (!first) return null;
  const type = shapes.every((s) => s.type === first.type) ? first.type : null;
  const single = shapes.length === 1;
  const ask = canAsk && agent ? t("live.conversation.ask", agentGrammar(agent.name)) : null;
  const icon = (key: string, glyph: IconName, name: string, extra: ButtonProps = {}) => (
    <Button key={key} size="sm" variant="ghost" iconOnly icon={glyph} aria-label={name} title={name} {...extra} />
  );
  let tools: ReactNode = null;
  let end: ReactNode = null;
  if (type === "image" && (single || ask)) {
    tools = (
      <>
        {canAsk && single && (
          <Button size="sm" variant="ghost" icon="sparkle" onClick={() => onAction({ kind: "variations" })}>
            {t("live.canvas.inspector.variations")}
          </Button>
        )}
        {ask && (
          <Button size="sm" variant="ghost" icon="message" onClick={() => onAction({ kind: "ask" })}>
            {ask}
          </Button>
        )}
        {canAsk && single && <Divider />}
        {single &&
          icon("crop", "crop", t("live.canvas.image.crop"), {
            disabled: Boolean(first.rot) || !first.asset,
            onClick: () => onAction({ kind: "crop" }),
          })}
        {single &&
          icon("replace", "swap", t("live.canvas.image.replace"), { onClick: () => onAction({ kind: "replace" }) })}
        {single &&
          icon("download", "download", t("live.canvas.inspector.download"), {
            disabled: !first.asset,
            onClick: () => onAction({ kind: "download" }),
          })}
      </>
    );
  } else if (type === "shape") {
    const rects = shapes.every((s) => (s.kind ?? "rect") === "rect");
    tools = (
      <>
        {CANVAS_SHAPE_KINDS.map((k) =>
          icon(k, KIND_ICONS[k], t(`live.canvas.shapeKinds.${k}`), {
            className: "cnv-bar__kind",
            "aria-pressed": shapes.every((s) => (s.kind ?? "rect") === k),
            onClick: () => onAction({ kind: "shapeKind", shapeKind: k }),
          }),
        )}
        <Divider />
        <FillPicker shapes={shapes} onAction={onAction} />
        <StrokePicker shapes={shapes} border onAction={onAction} />
        {rects && <CornersPicker shapes={shapes} onAction={onAction} />}
        <EffectsMenu
          look={{ shadow: first.shadow, gradient: first.gradient, dash: first.dash }}
          scale="canvas"
          border={shapes.every((s) => s.stroke !== "none")}
          onChange={(patch) => onAction({ kind: "effects", patch })}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              className="cnv-bar__pick"
              aria-label={t("live.type.effects")}
              title={t("live.type.effects")}
            >
              <Icon name="sparkle" size={18} />
              <Icon name="chevronDown" size={16} />
            </Button>
          }
        />
      </>
    );
    // Its label goes with Arrange and ⋯.
    if (single) {
      end = icon("text", "textTool", t("live.canvas.bar.editText"), { onClick: () => onAction({ kind: "editText" }) });
    }
  } else if (type === "arrow") {
    const routes = shapes.map((s) => s.route ?? "straight");
    tools = (
      <>
        {ROUTE_CHOICES.map((r) =>
          icon(r.route, r.icon, t(`live.canvas.routes.${r.route}`), {
            "aria-pressed": routes.every((x) => x === r.route),
            onClick: () => onAction({ kind: "route", route: r.route }),
          }),
        )}
        <Divider />
        {icon("dashed", "dashed", t("live.canvas.bar.dashed"), {
          "aria-pressed": shapes.every((s) => s.dashed),
          onClick: () => onAction({ kind: "dashed", dashed: !shapes.every((s) => s.dashed) }),
        })}
        <HeadsMenu shapes={shapes} onAction={onAction} />
        <StrokePicker shapes={shapes} border={false} onAction={onAction} />
        {single &&
          icon("label", "textTool", t("live.canvas.bar.label"), { onClick: () => onAction({ kind: "label" }) })}
      </>
    );
  } else if (type === "note") {
    tools = <NoteColors shapes={shapes} onAction={onAction} />;
  } else if (type === "text") {
    const style = first.style ?? {};
    const font = style.font ?? "onest";
    tools = (
      <>
        <FontPicker
          choices={fonts}
          value={font}
          onChange={(ref) => onAction({ kind: "font", font: ref })}
          onBring={() => onAction({ kind: "bringFont" })}
        />
        <TextStyleMenu
          look={{
            weight: style.weight ?? 400,
            tracking: style.tracking ?? 0,
            lineHeight: style.lineHeight ?? null,
            caps: style.caps === true,
            highlight: null,
          }}
          weights={fontWeights(font, TYPE_WEIGHTS)}
          highlight={false}
          onChange={(patch) => onAction({ kind: "type", patch })}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              className="cnv-bar__pick"
              aria-label={t("live.type.text")}
              title={t("live.type.text")}
            >
              <TypeGlyph />
              <Icon name="chevronDown" size={16} />
            </Button>
          }
        />
        <Divider />
        <div className="cnv-bar__sizes" role="radiogroup" aria-label={t("live.canvas.bar.size")}>
          {TEXT_SIZES.map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: a size button in a radio group
            <button
              key={s.key}
              type="button"
              role="radio"
              className="cnv-bar__size"
              aria-checked={shapes.every((sh) => (sh.style?.size ?? 24) === s.size)}
              aria-label={t(`live.canvas.sizes.${s.key}`)}
              title={t(`live.canvas.sizes.${s.key}`)}
              onClick={() => onAction({ kind: "size", size: s.size })}
            >
              {t(`live.canvas.sizes.short.${s.key}`)}
            </button>
          ))}
        </div>
      </>
    );
  } else if (type === "draw") {
    tools = <StrokeInks shapes={shapes} onAction={onAction} />;
  } else if (type === "frame" && single) {
    tools = (
      <Button size="sm" variant="ghost" icon="edit" onClick={() => onAction({ kind: "rename" })}>
        {t("live.canvas.bar.rename")}
      </Button>
    );
  } else if (!type && shapes.every((s) => s.type === "shape" || s.type === "arrow" || s.type === "draw")) {
    // A mix of shapes, lines and strokes shares a line color.
    tools = <StrokePicker shapes={shapes} border={false} onAction={onAction} />;
  }
  return (
    <div
      className="cnv-bar ac-glass"
      role="toolbar"
      aria-label={t("live.canvas.bar.title")}
      onKeyDown={rovingKeys}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {tools}
      {tools && <Divider />}
      {end}
      <ArrangeMenu onAction={onAction} />
      <MoreMenu shapes={shapes} onAction={onAction} />
    </div>
  );
}

/** The crop's own bar: Apply (Enter) and Cancel (Esc). */
export function CropBar({ onApply, onCancel }: { onApply(): void; onCancel(): void }) {
  const { t } = useTranslation();
  return (
    <div
      className="cnv-bar ac-glass"
      role="toolbar"
      aria-label={t("live.canvas.crop.label")}
      onKeyDown={rovingKeys}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button size="sm" variant="ghost" icon="close" title={`${t("live.canvas.crop.cancel")} (Esc)`} onClick={onCancel}>
        {t("live.canvas.crop.cancel")}
      </Button>
      <Button size="sm" variant="primary" icon="check" title={`${t("live.canvas.crop.apply")} (↵)`} onClick={onApply}>
        {t("live.canvas.crop.apply")}
      </Button>
    </div>
  );
}
