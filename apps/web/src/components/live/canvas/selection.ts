import type { ShapeType, ShapeView } from "@agenteschat/live/canvas";
import type { TFunction } from "i18next";
import type { LiveSelection } from "../editor";

/**
 * What a person has chosen on a canvas, in words for Ask an agent's context line and the agent (ADR 0196 §6):
 * "2 imagens", "1 nota", "3 itens" for a mix (a picture on its way counts as a picture), with the shapes' ids.
 */

/** Kinds as the words count them. */
const COUNTED: Record<ShapeType, string> = {
  image: "image",
  pending: "image",
  note: "note",
  text: "text",
  frame: "frame",
  shape: "shape",
  arrow: "arrow",
  draw: "draw",
  html: "html",
  file: "file",
};

export function selectionOf(t: TFunction, shapes: readonly ShapeView[]): LiveSelection | null {
  if (!shapes.length) return null;
  const kinds = new Set(shapes.map((s) => COUNTED[s.type]));
  const count = shapes.length;
  const [only] = kinds;
  const label =
    kinds.size === 1 && only
      ? String(t(`live.canvas.count.${only}` as "live.canvas.count.image", { count }))
      : String(t("live.canvas.count.items", { count }));
  return { label, shapes: shapes.map((s) => s.id) };
}
