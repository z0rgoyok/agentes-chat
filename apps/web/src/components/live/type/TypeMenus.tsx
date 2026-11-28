import type { Dash, Gradient, Shadow } from "@agenteschat/live";
import { Menu, MenuCheckboxItem, MenuRadioGroup, MenuSeparator, MenuSub } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./type.css";

/**
 * The text style menu ("Aa") and a shape's effects menu (ADR 0220 §8), the same in slides, canvases and documents:
 * weight, letter spacing, line height, capitals and highlight; shadow, border and gradient. Each choice is a
 * preset, written as the file stores it, so what people pick is what agents and exports read.
 */

/** Weights people pick from (each font offers the ones it draws), with their names' keys. */
const WEIGHT_WORDS = { 300: "w300", 400: "w400", 500: "w500", 600: "w600", 700: "w700", 800: "w800" } as const;
export const TYPE_WEIGHTS = [300, 400, 500, 600, 700, 800] as const;

/** Letter spacing presets, in thousandths of the size. */
export const TRACKINGS = [
  { key: "tight", value: -20 },
  { key: "normal", value: 0 },
  { key: "open", value: 60 },
  { key: "wide", value: 140 },
] as const;

/** Line heights, as multiples of the size. */
export const LINE_HEIGHTS = [1, 1.2, 1.4, 1.6, 2] as const;

/** Highlight colors, light enough to read dark text on. */
export const HIGHLIGHTS = [
  { key: "yellow", color: "#fff176" },
  { key: "green", color: "#b9f6ca" },
  { key: "blue", color: "#bbdefb" },
  { key: "pink", color: "#f8bbd0" },
  { key: "orange", color: "#ffe0b2" },
] as const;

/** What the text style menu shows and changes. */
export interface TypeLook {
  weight: number;
  /** Thousandths of the size. */
  tracking: number;
  /** As a multiple of the size; null where it is none of the presets' (or the look's own). */
  lineHeight: number | null;
  caps: boolean;
  /** Null: none. */
  highlight: string | null;
}

export type TypePatch = Partial<Pick<TypeLook, "weight" | "tracking" | "caps">> & {
  lineHeight?: number;
  highlight?: string | null;
};

const NONE = "none";

/** The text style menu's button face: a sample of letters, as the language writes them ("Aa"). */
export function TypeGlyph() {
  const { t } = useTranslation();
  return <span className="lf-aa">{t("live.type.glyph")}</span>;
}

export function TextStyleMenu({
  look,
  weights,
  lines = true,
  highlight = true,
  onChange,
  trigger,
  onClosed,
}: {
  look: TypeLook;
  /** The weights the font draws. */
  weights: readonly number[];
  /** Whether it offers line height (a document's blocks keep their own). */
  lines?: boolean;
  /** Whether it offers a highlight. */
  highlight?: boolean;
  onChange: (patch: TypePatch) => void;
  trigger: ReactNode;
  onClosed?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const tracking = TRACKINGS.find((p) => p.value === look.tracking);
  return (
    <Menu label={t("live.type.text")} trigger={trigger} onClosed={onClosed}>
      <MenuRadioGroup
        label={t("live.type.weight")}
        value={String(look.weight)}
        onValueChange={(v) => onChange({ weight: Number(v) })}
        options={weights.map((w) => ({
          value: String(w),
          label: (
            <span style={{ fontWeight: w }}>
              {w in WEIGHT_WORDS ? t(`live.type.weights.${WEIGHT_WORDS[w as keyof typeof WEIGHT_WORDS]}`) : w}
            </span>
          ),
        }))}
      />
      <MenuSeparator />
      <MenuSub label={t("live.type.tracking")}>
        <MenuRadioGroup
          label={t("live.type.tracking")}
          value={tracking ? String(tracking.value) : ""}
          onValueChange={(v) => onChange({ tracking: Number(v) })}
          options={TRACKINGS.map((p) => ({ value: String(p.value), label: t(`live.type.trackings.${p.key}`) }))}
        />
      </MenuSub>
      {lines && (
        <MenuSub label={t("live.type.lineHeight")}>
          <MenuRadioGroup
            label={t("live.type.lineHeight")}
            value={look.lineHeight === null ? "" : String(look.lineHeight)}
            onValueChange={(v) => onChange({ lineHeight: Number(v) })}
            options={LINE_HEIGHTS.map((h) => ({ value: String(h), label: number.format(h) }))}
          />
        </MenuSub>
      )}
      <MenuCheckboxItem checked={look.caps} onCheckedChange={(caps) => onChange({ caps })}>
        {t("live.type.caps")}
      </MenuCheckboxItem>
      {highlight && (
        <>
          <MenuSeparator />
          <MenuSub label={t("live.type.highlight")}>
            <MenuRadioGroup
              label={t("live.type.highlight")}
              value={look.highlight ?? NONE}
              onValueChange={(v) => onChange({ highlight: v === NONE ? null : v })}
              options={[
                { value: NONE, label: t("live.type.highlights.none"), leading: <span className="lf-swatch" /> },
                ...HIGHLIGHTS.map((h) => ({
                  value: h.color,
                  label: t(`live.type.highlights.${h.key}`),
                  leading: <span className="lf-swatch" style={{ background: h.color }} />,
                })),
              ]}
            />
          </MenuSub>
        </>
      )}
    </Menu>
  );
}

/** Shadows as presets, in the units of the file's kind (a slide is 1920 wide; a canvas is drawn at its own size). */
export const SHADOWS: Record<"slides" | "canvas", Record<"soft" | "strong", Shadow>> = {
  slides: {
    soft: { x: 0, y: 8, blur: 24, color: "#0e1a2b29" },
    strong: { x: 0, y: 18, blur: 48, color: "#0e1a2b4d" },
  },
  canvas: {
    soft: { x: 0, y: 4, blur: 12, color: "#0e1a2b29" },
    strong: { x: 0, y: 10, blur: 28, color: "#0e1a2b4d" },
  },
};

/** Gradients, top-left to bottom-right. */
export const GRADIENTS = [
  { key: "ocean", from: "#0063d1", to: "#7cc4ff" },
  { key: "graphite", from: "#151514", to: "#5c5c58" },
  { key: "sunset", from: "#ff6a3d", to: "#ffc15e" },
  { key: "violet", from: "#5b3cc4", to: "#e05fd0" },
] as const;

const GRADIENT_ANGLE = 135;

/** What the effects menu shows of a shape. */
export interface EffectsLook {
  shadow?: Shadow;
  gradient?: Gradient;
  dash?: Dash;
}

export interface EffectsPatch {
  shadow?: Shadow | null;
  gradient?: Gradient | null;
  dash?: Dash;
}

const sameShadow = (a: Shadow | undefined, b: Shadow) =>
  !!a && a.x === b.x && a.y === b.y && a.blur === b.blur && a.color.toLowerCase() === b.color.toLowerCase();

export function EffectsMenu({
  look,
  scale,
  border = true,
  onChange,
  trigger,
  onClosed,
}: {
  look: EffectsLook;
  scale: "slides" | "canvas";
  /** Whether its border may be dashed (a shape with no border has none to dash). */
  border?: boolean;
  onChange: (patch: EffectsPatch) => void;
  trigger: ReactNode;
  onClosed?: () => void;
}) {
  const { t } = useTranslation();
  const presets = SHADOWS[scale];
  const shadow = !look.shadow
    ? NONE
    : ((["soft", "strong"] as const).find((k) => sameShadow(look.shadow, presets[k])) ?? "");
  const gradient = !look.gradient
    ? NONE
    : (GRADIENTS.find(
        (g) =>
          g.from.toLowerCase() === look.gradient?.from.toLowerCase() &&
          g.to.toLowerCase() === look.gradient?.to.toLowerCase(),
      )?.key ?? "");
  return (
    <Menu label={t("live.type.effects")} trigger={trigger} onClosed={onClosed}>
      <MenuRadioGroup
        label={t("live.type.shadow")}
        value={shadow}
        onValueChange={(v) => onChange({ shadow: v === "soft" || v === "strong" ? presets[v] : null })}
        options={([NONE, "soft", "strong"] as const).map((k) => ({ value: k, label: t(`live.type.shadows.${k}`) }))}
      />
      {border && (
        <>
          <MenuSeparator />
          <MenuRadioGroup
            label={t("live.type.border")}
            value={look.dash ?? "solid"}
            onValueChange={(v) => onChange({ dash: v as Dash })}
            options={(["solid", "dashed", "dotted"] as const).map((k) => ({
              value: k,
              label: t(`live.type.dashes.${k}`),
            }))}
          />
        </>
      )}
      <MenuSeparator />
      <MenuSub label={t("live.type.gradient")}>
        <MenuRadioGroup
          label={t("live.type.gradient")}
          value={gradient}
          onValueChange={(v) => {
            const g = GRADIENTS.find((x) => x.key === v);
            onChange({ gradient: g ? { from: g.from, to: g.to, angle: GRADIENT_ANGLE } : null });
          }}
          options={[
            { value: NONE, label: t("live.type.gradients.none"), leading: <span className="lf-swatch" /> },
            ...GRADIENTS.map((g) => ({
              value: g.key,
              label: t(`live.type.gradients.${g.key}`),
              leading: (
                <span
                  className="lf-swatch"
                  style={{ background: `linear-gradient(${GRADIENT_ANGLE}deg, ${g.from}, ${g.to})` }}
                />
              ),
            })),
          ]}
        />
      </MenuSub>
    </Menu>
  );
}
