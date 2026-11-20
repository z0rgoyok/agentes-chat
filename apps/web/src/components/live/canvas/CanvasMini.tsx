import { useApi } from "@agenteschat/client";
import type { CanvasPreview, CanvasPreviewShape, NoteColor } from "@agenteschat/live/canvas";
import { NOTE_COLORS, routeArrow, strokePath } from "@agenteschat/live/canvas";
import { useDarkTheme } from "@agenteschat/ui";
import { useOrgIfAny } from "@/components/org-context";
import { isInk, SOFT } from "./palette";
import "./canvas.css";

/**
 * A canvas drawn small, for its cards (the Drive, a message, Ask an agent's context) from the preview the server
 * keeps (ADR 0196 §7: the bounds and up to 40 of the biggest shapes): frames, notes in their color, pictures (when
 * the card says which file they belong to, the part a crop shows), text as lines, shapes in their form, arrows and
 * lines along their route, pen strokes. Decoration: the card's words name it.
 */
export function CanvasMini({ preview, fileId }: { preview: CanvasPreview; fileId?: string }) {
  const api = useApi();
  const org = useOrgIfAny();
  const dark = useDarkTheme();
  const bounds = preview.bounds;
  if (!bounds || !preview.shapes.length) {
    return <div className="cnv-mini cnv-mini--empty" data-bg={preview.bg} aria-hidden="true" />;
  }
  const pad = Math.max(bounds.w, bounds.h) * 0.06 + 8;
  const box = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad };
  const url = (asset: string) => (org && fileId ? api.live.assetUrl(org.org.id, fileId, asset) : null);
  // Frames first, then the rest as the preview lists them (the biggest first): what is inside frames shows on them.
  const shapes = [...preview.shapes].sort((a, b) => Number(b.type === "frame") - Number(a.type === "frame"));
  return (
    <div className="cnv-mini" data-bg={preview.bg} aria-hidden="true">
      <svg
        className="cnv-mini__svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
      >
        {shapes.map((s) => (
          <MiniShape key={s.id} shape={s} dark={dark} url={s.asset ? url(s.asset) : null} unit={box.w / 240} />
        ))}
      </svg>
    </div>
  );
}

function noteFill(color: string | undefined, dark: boolean): string {
  const name = (NOTE_COLORS as readonly string[]).includes(color ?? "") ? (color as NoteColor) : "yellow";
  return dark ? SOFT[name].dark : SOFT[name].light;
}

/** A star's corners on a 100 × 100 square. */
const STAR = [50, 3, 62, 36, 97, 37, 69, 58, 79, 93, 50, 72, 21, 93, 31, 58, 3, 37, 38, 36];

/** A form's corners in world units (`null`: a rectangle or an ellipse, drawn as themselves). */
function formPoints(s: CanvasPreviewShape): string | null {
  const at = (fx: number, fy: number) => `${s.x + fx * s.w},${s.y + fy * s.h}`;
  switch (s.kind) {
    case "diamond":
      return [at(0.5, 0), at(1, 0.5), at(0.5, 1), at(0, 0.5)].join(" ");
    case "triangle":
      return [at(0.5, 0), at(1, 1), at(0, 1)].join(" ");
    case "star": {
      const out: string[] = [];
      for (let i = 0; i < STAR.length; i += 2) out.push(at((STAR[i] ?? 0) / 100, (STAR[i + 1] ?? 0) / 100));
      return out.join(" ");
    }
    default:
      return null;
  }
}

/** A line's own color, unless it's the ink on the dark theme (drawn by the theme's ink then). */
const lineColor = (stroke: string | undefined, dark: boolean) =>
  stroke && stroke !== "none" && !(dark && isInk(stroke)) ? { stroke } : undefined;

function MiniShape({
  shape: s,
  dark,
  url,
  unit,
}: {
  shape: CanvasPreviewShape;
  dark: boolean;
  url: string | null;
  /** About a pixel of the card, in world units. */
  unit: number;
}) {
  const turn = s.rot ? `rotate(${s.rot} ${s.x + s.w / 2} ${s.y + s.h / 2})` : undefined;
  switch (s.type) {
    case "frame":
      return (
        <rect
          className="cnv-mini__frame"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={Math.min(12, s.w / 8)}
          vectorEffect="non-scaling-stroke"
        />
      );
    case "note":
      return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} fill={noteFill(s.color, dark)} transform={turn} />;
    case "image":
      if (url && s.crop) {
        // The picture stretched over a unit square, of which the crop's part fills the box.
        return (
          <svg
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            viewBox={`${s.crop.x} ${s.crop.y} ${s.crop.w} ${s.crop.h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <image href={url} x={0} y={0} width={1} height={1} preserveAspectRatio="none" />
          </svg>
        );
      }
      return url ? (
        <image
          href={url}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          preserveAspectRatio="xMidYMid slice"
          transform={turn}
        />
      ) : (
        <rect className="cnv-mini__picture" x={s.x} y={s.y} width={s.w} height={s.h} rx={8} transform={turn} />
      );
    case "pending":
      return <rect className="cnv-mini__pending" x={s.x} y={s.y} width={s.w} height={s.h} rx={8} />;
    case "text": {
      // Words as lines: as many as the box holds, at least one.
      const line = Math.max(unit * 3, Math.min(24, s.h / 2));
      const rows = Math.max(1, Math.min(4, Math.floor(s.h / (line * 1.6))));
      return (
        <g transform={turn}>
          {Array.from({ length: rows }, (_, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one box, fixed
              key={i}
              className="cnv-mini__words"
              x={s.x}
              y={s.y + i * line * 1.6}
              width={i === rows - 1 && rows > 1 ? s.w * 0.6 : s.w}
              height={line}
              rx={line / 2}
            />
          ))}
        </g>
      );
    }
    case "arrow":
      return s.line ? (
        <path
          className="cnv-mini__arrow"
          d={routeArrow(s.line, s.route ?? "straight").d}
          style={lineColor(s.stroke, dark)}
          vectorEffect="non-scaling-stroke"
        />
      ) : null;
    case "draw":
      return s.points?.length ? (
        <path
          className="cnv-mini__draw"
          data-tool={s.tool ?? "pen"}
          d={strokePath(s.points)}
          transform={`${turn ? `${turn} ` : ""}translate(${s.x} ${s.y})`}
          style={lineColor(s.stroke, dark)}
          vectorEffect="non-scaling-stroke"
        />
      ) : null;
    case "shape": {
      const look = {
        ...(s.color ? { fill: dark ? undefined : s.color === "none" ? "none" : s.color } : {}),
        ...lineColor(s.stroke, dark),
      };
      const points = formPoints(s);
      if (points) {
        return (
          <polygon
            className="cnv-mini__shape"
            points={points}
            style={look}
            transform={turn}
            vectorEffect="non-scaling-stroke"
          />
        );
      }
      return s.kind === "ellipse" ? (
        <ellipse
          className="cnv-mini__shape"
          cx={s.x + s.w / 2}
          cy={s.y + s.h / 2}
          rx={s.w / 2}
          ry={s.h / 2}
          style={look}
          transform={turn}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <rect
          className="cnv-mini__shape"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={4}
          style={look}
          transform={turn}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    default:
      return (
        <rect
          className="cnv-mini__card"
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={10}
          transform={turn}
          vectorEffect="non-scaling-stroke"
        />
      );
  }
}
