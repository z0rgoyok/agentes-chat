import { compareStack } from "@agenteschat/live";
import type { ShapeView } from "@agenteschat/live/canvas";
import { Button, cx, Icon, type IconName } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, type MouseEvent, memo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { isLine, KIND_ICONS } from "./tools";

/**
 * Layers ("Camadas", ADR 0196 §2): every shape of the canvas in a list, inside the frame it sits in, the top of the
 * stack first (frames before what is loose, as they hold it), each with its kind's icon, its name, the face of who
 * made it and an eye that hides it from the plane or brings it back. A press chooses it, a hidden one too (the plane
 * can't, as nothing of it is drawn to press).
 */

export interface LayerRow {
  shape: ShapeView;
  /** How many frames it sits in. */
  depth: number;
}

/** Frames first (they hold the rest), then by stack, top first. */
const byLayer = (a: ShapeView, b: ShapeView) =>
  Number(b.type === "frame") - Number(a.type === "frame") || compareStack(b, a);

/** The canvas's shapes as the layers list shows them: each frame followed by what is in it, one step in. */
export function layerRows(shapes: readonly ShapeView[]): LayerRow[] {
  const ids = new Set(shapes.map((s) => s.id));
  const children = new Map<string | null, ShapeView[]>();
  for (const s of shapes) {
    const parent = s.parent && ids.has(s.parent) && s.parent !== s.id ? s.parent : null;
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }
  const out: LayerRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of [...(children.get(parent) ?? [])].sort(byLayer)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ shape: s, depth });
      if (s.type === "frame") walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  // A frame inside its own child (a broken loop) leaves those out of the walk: they still show, at the top.
  for (const s of shapes) if (!seen.has(s.id)) out.push({ shape: s, depth: 0 });
  return out;
}

/** The first words of a shape's text, cut to fit a row. */
function wordsOf(shape: ShapeView): string {
  const text = (shape.text ?? [])
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return firstWords(text);
}

function firstWords(text: string | undefined, most = 48): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > most ? `${clean.slice(0, most - 1).trimEnd()}…` : clean;
}

/** A shape's name in the list: a frame's name, the first words of its text, else what kind of thing it is. */
export function layerName(t: TFunction, shape: ShapeView): string {
  switch (shape.type) {
    case "frame":
      return shape.name?.trim() || t("live.canvas.kinds.frame");
    case "note":
      return wordsOf(shape) || t("live.canvas.kinds.note");
    case "text":
      return wordsOf(shape) || t("live.canvas.kinds.text");
    case "shape":
      return wordsOf(shape) || t(`live.canvas.shapeKinds.${shape.kind ?? "rect"}` as "live.canvas.shapeKinds.rect");
    case "image":
      return firstWords(shape.alt) || firstWords(shape.gen?.prompt) || t("live.canvas.kinds.image");
    case "pending":
      return firstWords(shape.prompt) || t("live.canvas.kinds.image");
    case "arrow":
      return firstWords(shape.label) || (isLine(shape) ? t("live.canvas.kinds.line") : t("live.canvas.kinds.arrow"));
    case "draw":
      return shape.tool === "marker" ? t("live.canvas.pen.marker") : t("live.canvas.kinds.draw");
    case "html":
      return t("live.canvas.kinds.html");
    case "file":
      return t("live.canvas.kinds.file");
  }
}

/** Each kind's icon in the list (the dock's own). */
export function layerIcon(shape: ShapeView): IconName {
  switch (shape.type) {
    case "frame":
      return "frame";
    case "image":
    case "pending":
      return "image";
    case "note":
      return "sticky";
    case "text":
      return "textTool";
    case "shape":
      return KIND_ICONS[shape.kind ?? "rect"];
    case "arrow":
      return isLine(shape) ? "line" : "arrowTool";
    case "draw":
      return shape.tool === "marker" ? "marker" : "pen";
    case "html":
      return "page";
    case "file":
      return "file";
  }
}

export const LayersPanel = memo(function LayersPanel({
  shapes,
  selected,
  readOnly,
  onPick,
  onHide,
  onClose,
}: {
  shapes: readonly ShapeView[];
  selected: readonly string[];
  readOnly: boolean;
  /** A row was pressed (`add`: with Shift or ⌘, it joins the selection). */
  onPick(id: string, add: boolean): void;
  onHide(id: string, hidden: boolean): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const rows = layerRows(shapes);
  const chosen = new Set(selected);
  return (
    <aside className="cnv-layers ac-glass" aria-label={t("live.canvas.layers.title")}>
      <header className="cnv-layers__head">
        <h2 className="cnv-layers__title">{t("live.canvas.layers.title")}</h2>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("live.canvas.layers.close")}
          title={t("live.canvas.layers.close")}
          onClick={onClose}
        />
      </header>
      {rows.length === 0 ? (
        <p className="cnv-layers__empty small muted">{t("live.canvas.layers.empty")}</p>
      ) : (
        <ul className="cnv-layers__list">
          {rows.map(({ shape, depth }) => (
            <LayerItem
              key={shape.id}
              shape={shape}
              depth={depth}
              on={chosen.has(shape.id)}
              readOnly={readOnly}
              onPick={onPick}
              onHide={onHide}
            />
          ))}
        </ul>
      )}
    </aside>
  );
});

function LayerItem({
  shape,
  depth,
  on,
  readOnly,
  onPick,
  onHide,
}: {
  shape: ShapeView;
  depth: number;
  on: boolean;
  readOnly: boolean;
  onPick(id: string, add: boolean): void;
  onHide(id: string, hidden: boolean): void;
}) {
  const { t } = useTranslation();
  const name = layerName(t, shape);
  const hidden = !!shape.hidden;
  const eye = hidden ? t("live.canvas.layers.show", { name }) : t("live.canvas.layers.hide", { name });
  return (
    <li
      className={cx("cnv-layer", on && "is-on")}
      data-hidden={hidden || undefined}
      style={{ "--depth": depth } as CSSProperties}
    >
      <button
        type="button"
        className="cnv-layer__pick"
        aria-pressed={on}
        onClick={(e: MouseEvent) => onPick(shape.id, e.shiftKey || e.metaKey || e.ctrlKey)}
      >
        <Icon name={layerIcon(shape)} size={16} />
        <span className="cnv-layer__name">{name}</span>
      </button>
      {shape.by && <LayerWho user={shape.by} />}
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={hidden ? "eyeOff" : "eye"}
          className="cnv-layer__eye"
          aria-label={eye}
          title={eye}
          aria-pressed={hidden}
          onClick={() => onHide(shape.id, !hidden)}
        />
      )}
    </li>
  );
}

/** The face of who made a shape (a picture being made: who asked for it). */
function LayerWho({ user }: { user: NonNullable<ShapeView["by"]> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name =
    user.kind === "agent"
      ? (dir.anyAgent(user.id)?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(user.id)?.name ?? t("channel.unknownPerson"));
  return (
    <span className="cnv-layer__who" title={name}>
      {user.kind === "agent" ? (
        <AgentAvatar agentId={user.id} name={name} size="xs" />
      ) : (
        <PersonAvatar id={user.id} name={name} size="xs" />
      )}
    </span>
  );
}
