import type { Peer } from "@agenteschat/live/awareness";
import { type Box, type Guide, type Point, rectsIntersect, type ShapeView } from "@agenteschat/live/canvas";
import { type CSSProperties, type KeyboardEvent, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PeerCursors } from "../PeerCursor";
import { type PeerLook, PeerTag, usePeerLooks } from "../peers";
import { boxToScreen, type Camera, type Size, toScreen } from "./camera";
import { arrowLine, boundsOf, CORNERS, HANDLES, type Handle, routePoints } from "./edit-math";

/**
 * What the canvas draws over its shapes in screen pixels (ADR 0196 §5), so it keeps one size at any zoom: frames'
 * names, the hovered shape's outline, this person's selection with its handles (ink), what a drag is drawing (a
 * marquee, a new box, an arrow), the snapping guides, everyone else's selections in their color with their name, and
 * their pointers. Presses on handles and names reach the plane, which reads `data-handle` and `data-frame-label`.
 */

export interface Draft {
  marquee?: Box;
  box?: Box;
  line?: { from: Point; to: Point };
  guides?: Guide[];
}

export interface OverlayProps {
  cam: Camera;
  stage: Size;
  shapes: readonly ShapeView[];
  byId: ReadonlyMap<string, ShapeView>;
  selected: readonly string[];
  hover: string | null;
  draft: Draft | null;
  peers: Peer[];
  readOnly: boolean;
  /** A frame being renamed, an arrow's label being typed. */
  naming: { id: string; kind: "frame" | "label" } | null;
  onName(id: string, kind: "frame" | "label", value: string | null): void;
  /** Hides the handles while something moves (they'd lag behind the shapes). */
  busy: boolean;
}

/** A frame's name sits this far above its top edge. */
const LABEL_LIFT = 22;

export const Overlay = memo(function Overlay(props: OverlayProps) {
  const { cam, stage, shapes, byId, selected, hover, draft, peers, readOnly, naming, busy } = props;
  const view: Box = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: stage.w / cam.z, h: stage.h / cam.z };
  const onScreen = (s: ShapeView) =>
    rectsIntersect({ x: s.x, y: s.y - LABEL_LIFT / cam.z, w: s.w, h: s.h + LABEL_LIFT / cam.z }, view, 40 / cam.z);
  // A hidden frame (the layers' eye) has no name on the plane either.
  const frames = shapes.filter((s) => s.type === "frame" && !s.hidden && onScreen(s));
  const chosen = selected.map((id) => byId.get(id)).filter((s): s is ShapeView => !!s);
  const single = chosen.length === 1 ? chosen[0] : null;
  const toScreenPoint = (p: Point) => toScreen(cam, p);
  return (
    <div className="cnv-over" aria-hidden={naming ? undefined : true}>
      {frames.map((f) => (
        <FrameLabel
          key={f.id}
          frame={f}
          cam={cam}
          selected={selected.includes(f.id)}
          naming={naming?.kind === "frame" && naming.id === f.id}
          readOnly={readOnly}
          onName={(value) => props.onName(f.id, "frame", value)}
        />
      ))}
      {hover && !selected.includes(hover) && byId.get(hover) && (
        <ShapeOutline shape={byId.get(hover) as ShapeView} byId={byId} cam={cam} className="cnv-over__hover" />
      )}
      {chosen.map((s) => (
        <ShapeOutline key={s.id} shape={s} byId={byId} cam={cam} className="cnv-over__sel" />
      ))}
      {!busy && !readOnly && single && single.type !== "arrow" && !single.locked && (
        <Handles shape={single} cam={cam} rotate={single.type !== "frame"} />
      )}
      {!busy && !readOnly && single?.type === "arrow" && <ArrowHandles arrow={single} byId={byId} cam={cam} />}
      {!busy && chosen.length > 1 && (
        <GroupBox ids={selected} byId={byId} cam={cam} handles={!readOnly && chosen.every((s) => !s.locked)} />
      )}
      <PeerSelections peers={peers} byId={byId} cam={cam} />
      {draft?.marquee && <div className="cnv-over__marquee" style={rect(boxToScreen(cam, draft.marquee))} />}
      {draft?.box && <div className="cnv-over__draft" style={rect(boxToScreen(cam, draft.box))} />}
      {draft?.line && <DraftLine from={toScreenPoint(draft.line.from)} to={toScreenPoint(draft.line.to)} />}
      {draft?.guides?.map((g) => (
        <GuideLine key={`${g.axis}:${g.at}`} guide={g} cam={cam} />
      ))}
      {naming?.kind === "label" && byId.get(naming.id) && (
        <LabelEditor
          arrow={byId.get(naming.id) as ShapeView}
          byId={byId}
          cam={cam}
          onDone={(value) => props.onName(naming.id, "label", value)}
        />
      )}
      <PeerCursors peers={peers} space="canvas" toScreen={toScreenPoint} />
    </div>
  );
});

const rect = (b: Box): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });

/** A shape's outline on screen, turned with it (an arrow's: along its line). */
function ShapeOutline({
  shape,
  byId,
  cam,
  className,
  style,
}: {
  shape: ShapeView;
  byId: ReadonlyMap<string, ShapeView>;
  cam: Camera;
  className: string;
  style?: CSSProperties;
}) {
  if (shape.type === "arrow") {
    const line = arrowLine(shape, byId);
    if (!line) return null;
    const a = toScreen(cam, { x: line.x1, y: line.y1 });
    const b = toScreen(cam, { x: line.x2, y: line.y2 });
    if (!shape.route || shape.route === "straight") {
      return <DraftLine from={a} to={b} className={`${className} cnv-over__line`} style={style} />;
    }
    // A curve or an elbow: its outline follows its route.
    const points = routePoints(line, shape.route)
      .map((p) => toScreen(cam, p))
      .map((p) => `${p.x},${p.y}`)
      .join(" ");
    return (
      <svg className={`${className} cnv-over__route`} style={style} aria-hidden="true">
        <polyline points={points} />
      </svg>
    );
  }
  const b = boxToScreen(cam, shape);
  return (
    <div
      className={className}
      data-frame={shape.type === "frame" || undefined}
      style={{ ...rect(b), ...(shape.rot ? { transform: `rotate(${shape.rot}deg)` } : {}), ...style }}
    />
  );
}

/** The eight handles and the rotation knob of one chosen shape, turned with it. */
function Handles({ shape, cam, rotate }: { shape: ShapeView; cam: Camera; rotate: boolean }) {
  const b = boxToScreen(cam, shape);
  // A small shape on screen keeps only its corners, so the handles never cover it.
  const small = b.w < 40 || b.h < 40;
  const shown = small ? CORNERS : HANDLES;
  return (
    <div
      className="cnv-over__frame"
      style={{ ...rect(b), ...(shape.rot ? { transform: `rotate(${shape.rot}deg)` } : {}) }}
    >
      {shown.map((h) => (
        <span key={h} className="cnv-over__handle" data-handle={h} data-pos={h} />
      ))}
      {rotate && <span className="cnv-over__rotate" data-handle="rotate" />}
    </div>
  );
}

function ArrowHandles({ arrow, byId, cam }: { arrow: ShapeView; byId: ReadonlyMap<string, ShapeView>; cam: Camera }) {
  const line = arrowLine(arrow, byId);
  if (!line) return null;
  const a = toScreen(cam, { x: line.x1, y: line.y1 });
  const b = toScreen(cam, { x: line.x2, y: line.y2 });
  return (
    <>
      <span className="cnv-over__end" data-handle="from" style={{ left: a.x, top: a.y }} />
      <span className="cnv-over__end" data-handle="to" style={{ left: b.x, top: b.y }} />
    </>
  );
}

/** The box around several chosen shapes, with corners that resize them together. */
function GroupBox({
  ids,
  byId,
  cam,
  handles,
}: {
  ids: readonly string[];
  byId: ReadonlyMap<string, ShapeView>;
  cam: Camera;
  handles: boolean;
}) {
  const bounds = boundsOf(ids, byId);
  if (!bounds) return null;
  return (
    <div className="cnv-over__group" style={rect(boxToScreen(cam, bounds))}>
      {handles &&
        CORNERS.map((h: Handle) => <span key={h} className="cnv-over__handle" data-handle={h} data-pos={h} />)}
    </div>
  );
}

function DraftLine({
  from,
  to,
  className = "cnv-over__arrow",
  style,
}: {
  from: Point;
  to: Point;
  className?: string;
  style?: CSSProperties;
}) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return (
    <div
      className={className}
      style={{ left: from.x, top: from.y, width: len, transform: `rotate(${angle}deg)`, ...style }}
    />
  );
}

function GuideLine({ guide, cam }: { guide: Guide; cam: Camera }) {
  if (guide.axis === "x") {
    const a = toScreen(cam, { x: guide.at, y: guide.from });
    const b = toScreen(cam, { x: guide.at, y: guide.to });
    return <div className="cnv-over__guide" data-axis="x" style={{ left: a.x, top: a.y, height: b.y - a.y }} />;
  }
  const a = toScreen(cam, { x: guide.from, y: guide.at });
  const b = toScreen(cam, { x: guide.to, y: guide.at });
  return <div className="cnv-over__guide" data-axis="y" style={{ left: a.x, top: a.y, width: b.x - a.x }} />;
}

/** A frame's name above its corner: a press chooses the frame, a double press (or Rename) edits it. */
function FrameLabel({
  frame,
  cam,
  selected,
  naming,
  readOnly,
  onName,
}: {
  frame: ShapeView;
  cam: Camera;
  selected: boolean;
  naming: boolean;
  readOnly: boolean;
  onName(value: string | null): void;
}) {
  const { t } = useTranslation();
  const p = toScreen(cam, { x: frame.x, y: frame.y });
  const width = Math.max(48, frame.w * cam.z);
  const name = frame.name?.trim() || t("live.canvas.kinds.frame");
  const style: CSSProperties = { left: p.x, top: p.y - LABEL_LIFT, maxWidth: width };
  if (naming && !readOnly) {
    return (
      <InlineInput
        className="cnv-over__name-input"
        style={{ ...style, width: Math.min(320, Math.max(160, width)) }}
        value={frame.name ?? ""}
        label={t("live.canvas.renameFrame")}
        onDone={onName}
      />
    );
  }
  return (
    <span className="cnv-over__name" data-frame-label={frame.id} data-selected={selected || undefined} style={style}>
      {name}
    </span>
  );
}

/** The words on an arrow, typed where they show (the middle of its line). */
function LabelEditor({
  arrow,
  byId,
  cam,
  onDone,
}: {
  arrow: ShapeView;
  byId: ReadonlyMap<string, ShapeView>;
  cam: Camera;
  onDone(value: string | null): void;
}) {
  const { t } = useTranslation();
  const line = arrowLine(arrow, byId);
  if (!line) return null;
  const mid = toScreen(cam, { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 });
  return (
    <InlineInput
      className="cnv-over__label-input"
      style={{ left: mid.x, top: mid.y }}
      value={arrow.label ?? ""}
      label={t("live.canvas.arrowLabel")}
      onDone={onDone}
    />
  );
}

/** A one-line field that takes Enter (keep), Esc (leave as it was) and leaving it (keep). */
function InlineInput({
  value,
  label,
  className,
  style,
  onDone,
}: {
  value: string;
  label: string;
  className: string;
  style: CSSProperties;
  onDone(value: string | null): void;
}) {
  const [text, setText] = useState(value);
  const ended = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const end = (next: string | null) => {
    if (ended.current) return;
    ended.current = true;
    onDone(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") end(text);
    else if (e.key === "Escape") end(null);
  };
  return (
    <input
      ref={input}
      className={`ac-input ${className}`}
      style={style}
      aria-label={label}
      value={text}
      maxLength={200}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => end(text)}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** Everyone else's chosen shapes: an outline in their color, their name on the corner of the first. */
function PeerSelections({
  peers,
  byId,
  cam,
}: {
  peers: Peer[];
  byId: ReadonlyMap<string, ShapeView>;
  cam: Camera;
}): ReactNode {
  const looks = usePeerLooks();
  return peers
    .filter((p) => !p.self && p.state.sel?.canvas?.length)
    .map((p) => {
      const look = looks(p.user);
      const ids = (p.state.sel?.canvas ?? []).filter((id) => byId.has(id));
      if (!ids.length) return null;
      const bounds = boundsOf(ids, byId);
      const style = { "--peer": look.color } as CSSProperties;
      return (
        <div key={p.clientId} className="cnv-over__peer" style={style}>
          {ids.slice(0, 50).map((id) => (
            <ShapeOutline key={id} shape={byId.get(id) as ShapeView} byId={byId} cam={cam} className="cnv-over__psel" />
          ))}
          {bounds && <PeerTagAt look={look} at={toScreen(cam, { x: bounds.x + bounds.w, y: bounds.y })} />}
        </div>
      );
    });
}

function PeerTagAt({ look, at }: { look: PeerLook; at: Point }) {
  return (
    <span className="cnv-over__ptag-at" style={{ left: at.x, top: at.y }}>
      <PeerTag look={look} />
    </span>
  );
}
