import {
  type Gradient,
  type Shadow,
  SLIDE_H,
  SLIDE_W,
  type SlideTheme,
  shadowCss,
  shapeFill,
  textLook,
  themeOf,
} from "@agenteschat/live";
import type { DeckFonts, ElementView, SlideChart, SlideTable, SlideView, ThemeId } from "@agenteschat/live/slides";
import { cx, Icon } from "@agenteschat/ui";
import { type CSSProperties, createContext, memo, type ReactNode, useContext } from "react";
import { useTranslation } from "react-i18next";
import { ChartAccent, ChartView } from "@/components/ChartBlock";
import { fontFamilyCss, fontsOfRich, useLiveFonts } from "../fonts";
import { RichView } from "../rich";
import "./slides.css";

/**
 * A slide as it looks (ADR 0196 §2), drawn in slide units (the deck's 1920×1080) and scaled by whoever shows it: the
 * stage while editing, the rail's thumbnails, presenting, the Drive's covers and uploaded decks (`DeckView`). Every
 * size is the theme's or the element's own in those units, so a slide looks the same at any scale and in the export.
 */

/** Where a slide is drawn, which decides what an empty part shows: hints while editing, nothing elsewhere. */
export type SlideMode = "edit" | "thumb" | "show";

/** A picture's address by its id (an asset of the live file, or a picture inside an uploaded deck). */
export type SlideImageUrl = (id: string) => string | null;

/** The pictures of the file being drawn: the editor gives the live file's asset addresses. */
export const SlideImages = createContext<SlideImageUrl | null>(null);

/** The deck's own fonts over its theme's (ADR 0220 §3): the editor, presenting and covers give them. */
export const SlideFonts = createContext<DeckFonts | undefined>(undefined);

const FONT_STACKS: Record<string, string> = {
  "Funnel Display": '"Funnel Display", "Source Sans 3 Variable", "Source Sans 3", system-ui, sans-serif',
  "Source Sans 3": '"Source Sans 3 Variable", "Source Sans 3", system-ui, sans-serif',
};

export function fontStack(family: string): string {
  return FONT_STACKS[family] ?? FONT_STACKS["Source Sans 3"] ?? family;
}

/** The theme's colors as the slide's own CSS variables (charts and tables read them). */
export function themeVars(theme: SlideTheme, fonts?: DeckFonts): CSSProperties {
  const c = theme.colors;
  const body = (fonts?.body && fontFamilyCss(fonts.body)) || fontStack(theme.fonts.body);
  const heading = (fonts?.heading && fontFamilyCss(fonts.heading)) || fontStack(theme.fonts.heading);
  return {
    "--sl-bg": c.bg,
    "--sl-text": c.text,
    "--sl-muted": c.muted,
    "--sl-accent": c.accent,
    "--sl-accent2": c.accent2,
    "--sl-surface": c.surface,
    "--sl-line": c.line,
    "--sl-body-font": body,
    "--sl-heading-font": heading,
    color: c.text,
    fontFamily: body,
  } as CSSProperties;
}

/** An element's place on the slide: its box (a line's from both ends), turned around its middle. */
export function elementPlace(el: Pick<ElementView, "type" | "x" | "y" | "w" | "h" | "rot">): CSSProperties {
  const line = el.type === "line";
  const x = line ? Math.min(el.x, el.x + el.w) : el.x;
  const y = line ? Math.min(el.y, el.y + el.h) : el.y;
  return {
    left: x,
    top: y,
    width: Math.abs(el.w),
    height: Math.abs(el.h),
    ...(el.rot ? { transform: `rotate(${el.rot}deg)` } : {}),
  };
}

const HEADLINE = new Set(["title", "number", "quote"]);

/** The words an empty text box shows while editing. */
export function usePlaceholder(el: Pick<ElementView, "type" | "role">): string {
  const { t } = useTranslation();
  if (el.type !== "text") return "";
  return el.role && HEADLINE.has(el.role) ? t("live.slides.placeholder.title") : t("live.slides.placeholder.text");
}

export interface ElementBodyProps {
  el: ElementView;
  theme: SlideTheme;
  mode: SlideMode;
  /** In place of the drawn text: the editor while this box is being typed in. */
  text?: ReactNode;
  /** In place of the drawn table: its cells being edited. */
  table?: ReactNode;
}

/** What an element shows inside its box. */
export function ElementBody({ el, theme, mode, text, table }: ElementBodyProps) {
  switch (el.type) {
    case "text":
      return <TextBody el={el} theme={theme} mode={mode} text={text} />;
    case "shape":
      return <ShapeBody el={el} theme={theme} mode={mode} text={text} />;
    case "image":
      return <ImageBody el={el} theme={theme} mode={mode} />;
    case "chart":
      return el.chart ? <ChartBody chart={el.chart} theme={theme} /> : null;
    case "table":
      return table ?? (el.table ? <TableBody table={el.table} theme={theme} el={el} /> : null);
    case "line":
      return <LineBody el={el} theme={theme} mode={mode} />;
  }
}

/** The look of an element's text as CSS: the theme's for its role under its own style (and the deck's fonts). */
export function textStyle(
  theme: SlideTheme,
  el: Pick<ElementView, "type" | "role" | "style">,
  fonts?: DeckFonts,
): CSSProperties {
  const look = textLook(theme, el, fonts);
  return {
    fontFamily: fontFamilyCss(look.fontRef, look.category) ?? fontStack(look.fontFamily),
    fontSize: look.size,
    fontWeight: look.weight,
    color: look.color,
    lineHeight: look.lineHeight,
    textAlign: look.align,
    justifyContent: look.valign === "middle" ? "center" : look.valign === "bottom" ? "flex-end" : "flex-start",
    ...(look.tracking
      ? { letterSpacing: `${look.tracking / 1000}em` }
      : look.font === "heading"
        ? { letterSpacing: "-0.01em" }
        : {}),
    ...(look.caps ? { textTransform: "uppercase" } : {}),
    ...(look.padding ? { padding: look.padding } : {}),
    ...(el.style?.opacity !== undefined && el.type === "text" ? { opacity: el.style.opacity } : {}),
  };
}

/** The fonts an element's text draws with, loaded while it shows. */
function useElementFonts(theme: SlideTheme, el: ElementView): DeckFonts | undefined {
  const fonts = useContext(SlideFonts);
  const look = textLook(theme, el, fonts);
  useLiveFonts([look.fontRef, ...fontsOfRich(el.text)]);
  return fonts;
}

/** A gradient's ends in the box's own units (0..1), from its CSS angle (0: to the top, 90: to the right). */
function gradientEnds(g: Gradient) {
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.sin(a) / 2;
  const dy = -Math.cos(a) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}

/** A dash pattern for a stroke of `width`. */
export function dashArray(
  dash: string | undefined,
  width: number,
): { strokeDasharray?: string; strokeLinecap?: "round" } {
  if (dash === "dashed") return { strokeDasharray: `${width * 3} ${width * 2}` };
  if (dash === "dotted") return { strokeDasharray: `0 ${width * 2}`, strokeLinecap: "round" };
  return {};
}

/** A drop shadow as a CSS filter (it follows the shape's own outline). */
export function shadowFilter(shadow: Shadow | undefined): CSSProperties {
  return shadow ? { filter: `drop-shadow(${shadowCss(shadow)})` } : {};
}

function TextBody({
  el,
  theme,
  mode,
  text,
}: {
  el: ElementView;
  theme: SlideTheme;
  mode: SlideMode;
  text?: ReactNode;
}) {
  const placeholder = usePlaceholder(el);
  const fonts = useElementFonts(theme, el);
  return (
    <div
      className="sl-text"
      style={{ ...textStyle(theme, el, fonts), "--rt-placeholder": theme.colors.muted } as CSSProperties}
    >
      {text ?? <RichView doc={el.text ?? []} placeholder={mode === "edit" ? placeholder : undefined} />}
    </div>
  );
}

/** A shape's outline in its box (w×h), inset by half its stroke so the stroke stays inside. */
export function shapePath(kind: string, w: number, h: number, inset: number, radius = 0): ReactNode {
  const x0 = inset;
  const y0 = inset;
  const x1 = Math.max(x0, w - inset);
  const y1 = Math.max(y0, h - inset);
  const mx = w / 2;
  const my = h / 2;
  switch (kind) {
    case "ellipse":
      return <ellipse cx={mx} cy={my} rx={Math.max(0, mx - inset)} ry={Math.max(0, my - inset)} />;
    case "triangle":
      return <polygon points={`${mx},${y0} ${x1},${y1} ${x0},${y1}`} />;
    case "diamond":
      return <polygon points={`${mx},${y0} ${x1},${my} ${mx},${y1} ${x0},${my}`} />;
    case "arrow": {
      const head = Math.min((x1 - x0) * 0.45, (y1 - y0) * 0.9);
      const neck = x1 - head;
      const t = y0 + (y1 - y0) * 0.28;
      const b = y1 - (y1 - y0) * 0.28;
      return (
        <polygon points={`${x0},${t} ${neck},${t} ${neck},${y0} ${x1},${my} ${neck},${y1} ${neck},${b} ${x0},${b}`} />
      );
    }
    default:
      return (
        <rect
          x={x0}
          y={y0}
          width={Math.max(0, x1 - x0)}
          height={Math.max(0, y1 - y0)}
          rx={Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)}
        />
      );
  }
}

function ShapeBody({
  el,
  theme,
  mode,
  text,
}: {
  el: ElementView;
  theme: SlideTheme;
  mode: SlideMode;
  text?: ReactNode;
}) {
  const style = el.style ?? {};
  const fonts = useElementFonts(theme, el);
  const fill = shapeFill(theme, style);
  const stroke = style.stroke && style.stroke !== "none" ? style.stroke : null;
  const width = stroke ? (style.strokeWidth ?? 4) : 0;
  const w = Math.max(1, el.w);
  const h = Math.max(1, el.h);
  const hasText = !!text || (el.text ?? []).some((p) => p.runs.some((r) => r.text));
  const gradient = style.gradient ? { id: `sl-g-${el.id}`, ...gradientEnds(style.gradient) } : null;
  return (
    <>
      <svg
        className="sl-shape"
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        aria-hidden="true"
        style={{ overflow: "visible", ...shadowFilter(style.shadow) }}
      >
        {gradient && style.gradient && (
          <defs>
            <linearGradient id={gradient.id} x1={gradient.x1} y1={gradient.y1} x2={gradient.x2} y2={gradient.y2}>
              <stop offset="0" stopColor={style.gradient.from} />
              <stop offset="1" stopColor={style.gradient.to} />
            </linearGradient>
          </defs>
        )}
        <g
          fill={gradient ? `url(#${gradient.id})` : fill === "none" ? "none" : fill}
          stroke={stroke ?? "none"}
          strokeWidth={width}
          strokeLinejoin="round"
          opacity={style.opacity ?? 1}
          {...dashArray(style.dash, width)}
        >
          {shapePath(style.shape ?? "rect", w, h, width / 2, style.radius ?? 0)}
        </g>
      </svg>
      {(hasText || mode === "edit") && (
        <div className="sl-text sl-text--shape" style={textStyle(theme, el, fonts)}>
          {text ?? <RichView doc={el.text ?? []} />}
        </div>
      )}
    </>
  );
}

function ImageBody({ el, theme, mode }: { el: ElementView; theme: SlideTheme; mode: SlideMode }) {
  const { t } = useTranslation();
  const url = useContext(SlideImages);
  const src = el.asset ? url?.(el.asset) : null;
  const radius = el.style?.radius;
  if (src) {
    return (
      <img
        className="sl-image"
        src={src}
        alt={el.alt ?? ""}
        draggable={false}
        style={{
          objectFit: el.fit ?? "cover",
          ...(radius ? { borderRadius: radius } : {}),
          ...(el.style?.opacity !== undefined ? { opacity: el.style.opacity } : {}),
          ...shadowFilter(el.style?.shadow),
        }}
      />
    );
  }
  // An empty image slot of the layout: a quiet frame while editing, nothing when shown.
  if (mode === "show" && !el.asset) return null;
  return (
    <div
      className="sl-image sl-image--empty"
      style={{ background: theme.colors.surface, color: theme.colors.muted }}
      data-missing={el.asset ? "true" : undefined}
    >
      {mode === "edit" && (
        <span className="sl-image__hint">
          <Icon name="image" size={20} />
          {el.asset ? t("live.slides.image.missing") : t("live.slides.image.empty")}
        </span>
      )}
    </div>
  );
}

/** Charts are drawn by the chat's own chart at this many slide units per page pixel, so their words read on a slide. */
const CHART_ZOOM = 2.4;

function ChartBody({ chart, theme }: { chart: SlideChart; theme: SlideTheme }) {
  const vars = {
    "--ink": theme.colors.text,
    "--ink2": theme.colors.text,
    "--muted": theme.colors.muted,
    "--faint": theme.colors.muted,
    "--plate": theme.colors.surface,
    "--line": theme.colors.line,
    "--line-strong": theme.colors.line,
    "--ok": theme.colors.accent2,
  } as CSSProperties;
  return (
    <div className="sl-chart" style={vars}>
      {(chart.title || chart.subtitle) && (
        <div className="sl-chart__head">
          {chart.title && (
            <div className="sl-chart__title" style={{ fontFamily: fontStack(theme.fonts.heading) }}>
              {chart.title}
            </div>
          )}
          {chart.subtitle && <div className="sl-chart__subtitle">{chart.subtitle}</div>}
        </div>
      )}
      <div className="sl-chart__plot">
        <div className="sl-chart__zoom" style={{ "--chart-zoom": CHART_ZOOM } as CSSProperties}>
          <ChartAccent.Provider value={theme.colors.accent as `#${string}`}>
            <ChartView spec={chart} big />
          </ChartAccent.Provider>
        </div>
      </div>
    </div>
  );
}

/** A table's words in slide units: a bit smaller than body text, so a few rows fit. */
export function tableFontSize(theme: SlideTheme, el: Pick<ElementView, "style" | "table">): number {
  if (el.style?.size) return el.style.size;
  const rows = el.table?.rows.length ?? 1;
  return Math.round(Math.max(18, Math.min(theme.sizes.body * 0.8, 36 - Math.max(0, rows - 6) * 1.5)));
}

function TableBody({ table, theme, el }: { table: SlideTable; theme: SlideTheme; el: ElementView }) {
  return (
    <table className="sl-table" style={{ fontSize: tableFontSize(theme, el) }}>
      <tbody>
        {table.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table, in order
          <tr key={r} className={cx(table.header && r === 0 && "sl-table__head")}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one row, in order
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LineBody({ el, theme, mode }: { el: ElementView; theme: SlideTheme; mode: SlideMode }) {
  const style = el.style ?? {};
  const width = style.strokeWidth ?? 6;
  const color = style.stroke && style.stroke !== "none" ? style.stroke : theme.colors.text;
  const w = Math.abs(el.w);
  const h = Math.abs(el.h);
  const x1 = el.w < 0 ? w : 0;
  const y1 = el.h < 0 ? h : 0;
  const x2 = el.w < 0 ? 0 : w;
  const y2 = el.h < 0 ? 0 : h;
  const arrow = style.lineEnd === "arrow";
  const head = Math.max(width * 3, 18);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  // The line stops where the head starts, so its square end never shows past the point.
  const ex = arrow ? x2 - ux * head * 0.8 : x2;
  const ey = arrow ? y2 - uy * head * 0.8 : y2;
  const px = -uy * head * 0.55;
  const py = ux * head * 0.55;
  return (
    <svg className="sl-line" width={Math.max(w, 1)} height={Math.max(h, 1)} aria-hidden="true">
      <g stroke={color} fill={color} opacity={style.opacity ?? 1}>
        <line
          x1={x1}
          y1={y1}
          x2={ex}
          y2={ey}
          strokeWidth={width}
          strokeLinecap="round"
          {...dashArray(style.dash, width)}
        />
        {/* While editing, a wide clear stroke along the line takes the pointer: a thin line is hard to hit. */}
        {mode === "edit" && (
          <line
            className="sl-line__hit"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeWidth={Math.max(width * 3, 36)}
            stroke="transparent"
          />
        )}
        {arrow && (
          <polygon
            points={`${x2},${y2} ${x2 - ux * head + px},${y2 - uy * head + py} ${x2 - ux * head - px},${y2 - uy * head - py}`}
            stroke="none"
          />
        )}
      </g>
    </svg>
  );
}

/** A slide's background: its own color or picture, else the theme's. */
export function slideBackground(
  slide: Pick<SlideView, "bg">,
  theme: SlideTheme,
  url: SlideImageUrl | null,
): CSSProperties {
  const bg = slide.bg;
  if (typeof bg === "string") return { background: bg };
  if (bg && typeof bg === "object") {
    const src = url?.(bg.asset);
    if (src) return { background: `${theme.colors.bg} center / cover no-repeat url("${src.replace(/"/g, "%22")}")` };
  }
  return { background: theme.colors.bg };
}

/**
 * A whole slide in slide units, unscaled: background and elements bottom to top. `children` go over the elements
 * (the stage's handles live elsewhere, in page pixels).
 */
export const SlideBody = memo(function SlideBody({
  slide,
  theme,
  mode,
  w = SLIDE_W,
  h = SLIDE_H,
  hide,
  slot,
  editing,
  children,
}: {
  slide: SlideView;
  theme: SlideTheme;
  mode: SlideMode;
  w?: number;
  h?: number;
  /** Elements drawn by someone else at this moment (the one being typed in, the ones being dragged). */
  hide?: ReadonlySet<string>;
  /**
   * The stage's own body for an element, in place of the drawn one: its text or table being edited, or a text a peer
   * types in (their caret shows). `undefined` draws it as usual.
   */
  slot?: (el: ElementView) => ReactNode | undefined;
  /** The element being typed in (it takes the pointer for its text). */
  editing?: string | null;
  children?: ReactNode;
}) {
  const url = useContext(SlideImages);
  const fonts = useContext(SlideFonts);
  useLiveFonts([fonts?.heading, fonts?.body]);
  return (
    <div
      className="sl-body"
      data-mode={mode}
      style={{ width: w, height: h, ...themeVars(theme, fonts), ...slideBackground(slide, theme, url) }}
    >
      {slide.elements.map((el) => {
        if (hide?.has(el.id)) return null;
        const own = slot?.(el);
        return (
          <div
            key={el.id}
            className={cx("sl-el", editing === el.id && "is-editing")}
            data-type={el.type}
            data-el={mode === "edit" ? el.id : undefined}
            style={elementPlace(el)}
          >
            <ElementBody
              el={el}
              theme={theme}
              mode={mode}
              {...(own !== undefined && (el.type === "text" || el.type === "shape") ? { text: own } : {})}
              {...(own !== undefined && el.type === "table" ? { table: own } : {})}
            />
          </div>
        );
      })}
      {children}
    </div>
  );
});

/** Draws `children` (slide units, `w`×`h`) at `scale`, in a box of the scaled size. */
export function Scaled({
  scale,
  w = SLIDE_W,
  h = SLIDE_H,
  className,
  children,
}: {
  scale: number;
  w?: number;
  h?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx("sl-scaled", className)}
      style={{ width: w * scale, height: h * scale, "--slide-scale": scale } as CSSProperties}
    >
      <div className="sl-scaled__inner" style={{ width: w, height: h, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

/** A theme by id or as itself. */
export const themeFrom = (theme: ThemeId | SlideTheme): SlideTheme =>
  typeof theme === "string" ? themeOf(theme) : theme;
