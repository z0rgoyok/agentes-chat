import type { ImageFailure } from "@agenteschat/client";
import { useArtifact } from "@agenteschat/client";
import { type Gradient, shadowCss } from "@agenteschat/live";
import {
  arrowHeadPoints,
  type CanvasTextStyle,
  type Point,
  routeArrow,
  type ShapeView,
  strokePath,
} from "@agenteschat/live/canvas";
import { Button, Icon, PixelSpinner, Tip } from "@agenteschat/ui";
import { type CSSProperties, memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { HtmlFrame } from "@/components/artifacts/HtmlFrame";
import { useOrg } from "@/components/org-context";
import { colorOf, ImageSky } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { fontFamilyCss, fontsOfRich, useLiveFonts } from "../fonts";
import { useCanvasEnv } from "./context";
import { fillStyle, strokeStyle } from "./palette";
import { CanvasRich } from "./text";

/**
 * The shapes of a canvas as the plane draws them (ADR 0196 §2, ADR 0197), each in world units inside the plane's
 * moving layer: pictures (the part a crop shows), notes, text, frames, shapes with their label and border, pen
 * strokes, a Drive file's card, an agent's page (a picture of it until someone presses Interact), and the placeholder
 * of a picture being made. Arrows and lines are drawn apart (`ArrowShape`), from their ends. Hidden shapes (the layers'
 * eye) aren't drawn.
 */

export interface ShapeBodyProps {
  shape: ShapeView;
  /** Its text box is open for typing. */
  editing: boolean;
  /** A page that takes the pointer now. */
  interacting: boolean;
  /** A picture that just replaced its placeholder: it fades in. */
  fresh: boolean;
}

/** A shape's text look as CSS (ADR 0220 §3): font, size, weight, color, alignment, spacing, capitals, padding. */
export function canvasTextCss(style: CanvasTextStyle | undefined): CSSProperties {
  if (!style) return {};
  return {
    ...(style.font ? { fontFamily: fontFamilyCss(style.font) } : {}),
    ...(style.size ? { fontSize: style.size } : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.weight ? { fontWeight: style.weight } : {}),
    ...(style.align ? { textAlign: style.align } : {}),
    ...(style.lineHeight ? { lineHeight: style.lineHeight } : {}),
    ...(style.tracking ? { letterSpacing: `${style.tracking / 1000}em` } : {}),
    ...(style.caps ? { textTransform: "uppercase" } : {}),
    ...(style.padding !== undefined ? { padding: style.padding } : {}),
  };
}

const VALIGN = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

/** A gradient's ends in the box's own units, from its CSS angle. */
function gradientEnds(g: Gradient) {
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.sin(a) / 2;
  const dy = -Math.cos(a) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}

function dashCss(dash: string | undefined, width: number): CSSProperties {
  if (dash === "dashed") return { strokeDasharray: `${width * 3} ${width * 2}` };
  if (dash === "dotted") return { strokeDasharray: `0 ${width * 2}`, strokeLinecap: "round" };
  return {};
}

/** The box a shape takes in the world, turned around its center. */
function boxStyle(s: ShapeView): CSSProperties {
  return {
    left: s.x,
    top: s.y,
    width: s.w,
    height: s.h,
    ...(s.rot ? { transform: `rotate(${s.rot}deg)` } : {}),
  };
}

export const ShapeBody = memo(function ShapeBody({ shape, editing, interacting, fresh }: ShapeBodyProps) {
  useLiveFonts([shape.style?.font, ...fontsOfRich(shape.text)]);
  if (shape.hidden) return null;
  return (
    <div
      className="cnv-shape"
      data-shape={shape.id}
      data-type={shape.type}
      data-locked={shape.locked || undefined}
      data-editing={editing || undefined}
      style={boxStyle(shape)}
    >
      <ShapeInside shape={shape} editing={editing} interacting={interacting} fresh={fresh} />
    </div>
  );
});

function ShapeInside({ shape, editing, interacting, fresh }: ShapeBodyProps) {
  switch (shape.type) {
    case "image":
      return <ImageShape shape={shape} fresh={fresh} />;
    case "note":
      return (
        <div className="cnv-note" data-color={shape.color ?? "yellow"}>
          <CanvasRich shape={shape} editing={editing} className="cnv-note__text" style={canvasTextCss(shape.style)} />
        </div>
      );
    case "text":
      return <CanvasRich shape={shape} editing={editing} className="cnv-text" style={canvasTextCss(shape.style)} />;
    case "frame":
      return <div className="cnv-frame" style={shape.fill ? fillStyle(shape.fill) : undefined} />;
    case "shape":
      return <GeometricShape shape={shape} editing={editing} />;
    case "draw":
      return <DrawShape shape={shape} />;
    case "html":
      return <PageShape shape={shape} interacting={interacting} />;
    case "file":
      return <FileShape shape={shape} />;
    case "pending":
      return <PendingShape shape={shape} />;
    default:
      return null;
  }
}

function ImageShape({ shape, fresh }: { shape: ShapeView; fresh: boolean }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (!shape.asset) return <div className="cnv-img cnv-img--missing" />;
  const alt = shape.alt ?? shape.gen?.prompt ?? t("live.canvas.kinds.image");
  const crop = shape.crop;
  // A crop shows that part of the picture filling the box: the picture scaled up and moved so the part sits in it.
  const cropped: CSSProperties | undefined = crop
    ? {
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`,
      }
    : undefined;
  return (
    <div
      className="cnv-img"
      data-state={state}
      data-crop={crop ? true : undefined}
      style={{
        ...(shape.radius ? { borderRadius: shape.radius, overflow: "hidden" } : {}),
        ...(shape.shadow ? { filter: `drop-shadow(${shadowCss(shape.shadow)})` } : {}),
      }}
    >
      {state === "failed" ? (
        <span className="cnv-img__failed small muted ac-iconline">
          <Icon name="image" size={16} />
          {t("live.canvas.imageFailed")}
        </span>
      ) : (
        <img
          src={env.assetUrl(shape.asset)}
          alt={alt}
          draggable={false}
          decoding="async"
          data-fresh={fresh || undefined}
          style={cropped}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      )}
    </div>
  );
}

/** A star's corners on a 100 × 100 square (stretched to the box). */
const STAR = [
  [50, 3],
  [62, 36],
  [97, 37],
  [69, 58],
  [79, 93],
  [50, 72],
  [21, 93],
  [31, 58],
  [3, 37],
  [38, 36],
] as const;

/** A rectangle's corners when it names none, in world units. */
const RECT_RADIUS = 8;

/** A form's outline in its box (world units, `w` × `h`), a unit in from the edge so its border isn't cut. */
function geoOutline(kind: string, w: number, h: number, radius: number | undefined, style?: CSSProperties) {
  switch (kind) {
    case "ellipse":
      return <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - 1)} ry={Math.max(0, h / 2 - 1)} style={style} />;
    case "diamond":
      return <polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} style={style} />;
    case "triangle":
      return <polygon points={`${w / 2},1 ${w - 1},${h - 1} 1,${h - 1}`} style={style} />;
    case "star":
      return <polygon points={STAR.map(([x, y]) => `${(x / 100) * w},${(y / 100) * h}`).join(" ")} style={style} />;
    default: {
      const r = Math.max(0, Math.min(radius ?? RECT_RADIUS, w / 2 - 1, h / 2 - 1));
      return <rect x={1} y={1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={r} style={style} />;
    }
  }
}

/** A rectangle, an ellipse, a diamond, a triangle or a star, with its border and its label in the middle. */
function GeometricShape({ shape, editing }: { shape: ShapeView; editing: boolean }) {
  const kind = shape.kind ?? "rect";
  const fill = shape.fill && shape.fill !== "none" ? fillStyle(shape.fill) : undefined;
  const stroke = strokeStyle(shape.stroke, shape.strokeWidth);
  const w = Math.max(1, shape.w);
  const h = Math.max(1, shape.h);
  const gradient = shape.gradient ? { id: `cnv-g-${shape.id}`, ...gradientEnds(shape.gradient) } : null;
  const outline: CSSProperties = {
    ...(gradient ? { fill: `url(#${gradient.id})` } : {}),
    ...dashCss(shape.dash, shape.strokeWidth ?? 2),
  };
  const valign = shape.style?.valign;
  return (
    <div
      className="cnv-geo"
      data-kind={kind}
      data-fill={shape.fill ? (shape.fill === "none" ? "none" : "custom") : undefined}
      data-stroke={shape.stroke ? (shape.stroke === "none" ? "none" : "custom") : undefined}
      data-stroke-width={shape.strokeWidth ? true : undefined}
      style={{
        ...fill,
        ...stroke,
        ...(valign ? { alignItems: VALIGN[valign] } : {}),
        ...(shape.style?.padding !== undefined ? { padding: shape.style.padding } : {}),
      }}
    >
      <svg
        className="cnv-geo__svg"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={shape.shadow ? { filter: `drop-shadow(${shadowCss(shape.shadow)})` } : undefined}
      >
        {gradient && shape.gradient && (
          <defs>
            <linearGradient id={gradient.id} x1={gradient.x1} y1={gradient.y1} x2={gradient.x2} y2={gradient.y2}>
              <stop offset="0" stopColor={shape.gradient.from} />
              <stop offset="1" stopColor={shape.gradient.to} />
            </linearGradient>
          </defs>
        )}
        {geoOutline(kind, w, h, shape.radius, outline)}
      </svg>
      <CanvasRich
        shape={shape}
        editing={editing}
        className="cnv-geo__text"
        style={{ ...canvasTextCss(shape.style), padding: undefined, ...(valign ? { width: "100%" } : {}) }}
      />
    </div>
  );
}

/** A pen stroke (its points from its box's corner), the marker's wide and see-through. */
function DrawShape({ shape }: { shape: ShapeView }) {
  if (!shape.points?.length) return null;
  return (
    <svg
      className="cnv-draw"
      data-tool={shape.tool ?? "pen"}
      width={Math.max(1, shape.w)}
      height={Math.max(1, shape.h)}
      style={strokeStyle(shape.stroke, shape.strokeWidth)}
      aria-hidden="true"
    >
      <path d={strokePath(shape.points)} />
    </svg>
  );
}

/** An agent's page: a still picture of it until Interact, then the page itself (isolated, ADR 0019). */
function PageShape({ shape, interacting }: { shape: ShapeView; interacting: boolean }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const query = useArtifact(env.orgId, shape.artifact ?? null);
  const a = query.data;
  const html = a?.content.kind === "html" ? a.content.html : null;
  return (
    <div className="cnv-page" data-live={interacting || undefined}>
      {html !== null ? (
        <HtmlFrame html={html} title={a?.title ?? t("live.canvas.kinds.html")} thumbnail={!interacting} />
      ) : (
        <span className="cnv-page__status small muted">
          {query.isError ? t("live.canvas.fileMissing") : t("live.canvas.loadingFile")}
        </span>
      )}
      {html !== null && !interacting && (
        <span className="cnv-page__foot">
          <span className="cnv-page__title">{a?.title}</span>
          <Button size="sm" icon="pointer" onClick={() => env.interact(shape.id)}>
            {t("live.canvas.interact")}
          </Button>
        </span>
      )}
    </div>
  );
}

/** Any Drive file, as the conversation's card for it (opened in the viewer on a double click). */
function FileShape({ shape }: { shape: ShapeView }) {
  if (!shape.artifact) return null;
  return (
    <div className="cnv-file">
      <ArtifactCard artifact={{ id: shape.artifact }} />
    </div>
  );
}

/** Each reason pictures fail for, as its words' key (never `too_many`: i18next reads `_many` as a plural form). */
const FAILURES: Record<ImageFailure, "noKey" | "budget" | "limit" | "blocked" | "provider" | "tooMany"> = {
  no_key: "noKey",
  budget: "budget",
  limit: "limit",
  blocked: "blocked",
  provider: "provider",
  too_many: "tooMany",
};

/** Why pictures failed, in words (an unknown code: the general ones). */
export function failureKey(error: string | undefined) {
  const known = error && Object.hasOwn(FAILURES, error) ? FAILURES[error as ImageFailure] : null;
  return known ? (`live.images.failed.${known}` as const) : ("live.images.failed.other" as const);
}

/**
 * A picture on its way (ADR 0197): the sky forming in the requester's tone (an agent's own, the sky's for a person),
 * who asked and the prompt; failed, why, with Try again for who may edit.
 */
function PendingShape({ shape }: { shape: ShapeView }) {
  const { t } = useTranslation();
  const env = useCanvasEnv();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const by = shape.by;
  const agent = by?.kind === "agent" ? dir.anyAgent(by.id) : undefined;
  const name = by
    ? by.kind === "agent"
      ? (agent?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(by.id)?.name ?? t("channel.unknownPerson"))
    : "";
  const failed = shape.status === "failed";
  const tone = agent ? colorOf(agent) : "sky";
  return (
    <div className="cnv-pending" data-status={shape.status} role="status">
      {!failed && <ImageSky color={tone} />}
      <div className="cnv-pending__body">
        {failed ? (
          <>
            <span className="cnv-pending__why ac-iconline">
              <Icon name="alert" size={16} />
              {t(failureKey(shape.error))}
            </span>
            {!env.readOnly && shape.request && (
              <Button size="sm" icon="refresh" onClick={() => shape.request && env.retry(shape.request)}>
                {t("live.images.retry")}
              </Button>
            )}
          </>
        ) : (
          <span className="cnv-pending__state ac-iconline">
            <PixelSpinner size={16} color={tone} />
            {shape.status === "running" ? t("live.images.making") : t("live.images.queued")}
          </span>
        )}
        {shape.prompt && (
          <Tip tip={shape.prompt} look="ac-msg__tip">
            <span className="cnv-pending__prompt">{shape.prompt}</span>
          </Tip>
        )}
        {by && (
          <span className="cnv-pending__who ac-iconline">
            {by.kind === "agent" ? (
              <AgentAvatar agentId={by.id} name={name} size="xs" state={failed ? "idle" : "thinking"} />
            ) : (
              <PersonAvatar id={by.id} name={name} size="xs" />
            )}
            <span>{t("live.images.askedBy", { name })}</span>
          </span>
        )}
      </div>
    </div>
  );
}

export interface ArrowLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Room around an arrow's line inside its own drawing (its head and its stroke). */
const ARROW_PAD = 24;

/** How an arrow looks past its line: its route, its heads (a line has none), its color and width. */
export type ArrowLook = Pick<ShapeView, "route" | "heads" | "stroke" | "strokeWidth">;

const headPoints = (tip: Point, dir: Point, size: number) =>
  arrowHeadPoints(tip, dir, size)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");

/**
 * An arrow from its line (worked out by the plane from its ends: bound ends follow their shapes), drawn in its own
 * small SVG so it stacks among the shapes by its stacking key: straight, curved or in right angles, with a head at
 * either end or none (a line); its label on a plate in the middle of its path.
 */
export const ArrowShape = memo(function ArrowShape({
  id,
  line,
  dashed,
  label,
  editingLabel,
  look,
}: {
  id: string;
  line: ArrowLine;
  dashed: boolean;
  label: string | undefined;
  editingLabel: boolean;
  look?: ArrowLook;
}) {
  const x = Math.min(line.x1, line.x2) - ARROW_PAD;
  const y = Math.min(line.y1, line.y2) - ARROW_PAD;
  const w = Math.abs(line.x2 - line.x1) + 2 * ARROW_PAD;
  const h = Math.abs(line.y2 - line.y1) + 2 * ARROW_PAD;
  const local = { x1: line.x1 - x, y1: line.y1 - y, x2: line.x2 - x, y2: line.y2 - y };
  const len = Math.hypot(local.x2 - local.x1, local.y2 - local.y1);
  const width = look?.strokeWidth ?? 2;
  const head = 12 + width;
  const atStart = look?.heads?.start === "arrow" && len > 1;
  const atEnd = (look?.heads?.end ?? "arrow") === "arrow" && len > 1;
  // The line stops at a head's base, so a thick stroke doesn't poke through its tip.
  const routed = routeArrow(local, look?.route ?? "straight", {
    start: atStart ? head * 0.8 : 0,
    end: atEnd ? head * 0.8 : 0,
  });
  const backwards = { x: -routed.startDir.x, y: -routed.startDir.y };
  return (
    <div
      className="cnv-arrow"
      data-shape={id}
      data-type="arrow"
      data-stroke={look?.stroke && look.stroke !== "none" ? "custom" : undefined}
      style={{ left: x, top: y, width: w, height: h, ...strokeStyle(look?.stroke, look?.strokeWidth) }}
    >
      <svg className="cnv-arrow__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <path d={routed.d} strokeDasharray={dashed ? "8 7" : undefined} className="cnv-arrow__line" />
        {atEnd && <polygon className="cnv-arrow__head" points={headPoints(routed.end, routed.endDir, head)} />}
        {atStart && <polygon className="cnv-arrow__head" points={headPoints(routed.start, backwards, head)} />}
      </svg>
      {label && !editingLabel && (
        <span className="cnv-arrow__label" style={{ left: routed.mid.x, top: routed.mid.y }}>
          {label}
        </span>
      )}
    </div>
  );
});
