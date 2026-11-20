import type { ArrowHeads, ArrowRoute, CanvasShapeKind, DrawTool, ShapeView } from "@agenteschat/live/canvas";
import type { IconName } from "@agenteschat/ui";
import type { TFunction } from "i18next";

/**
 * The canvas's tools (ADR 0196 §2) as data: what the dock holds, each one's key, the forms and the arrows' routes its
 * menus offer, the pen's colors and sizes, and the shortcuts list ("?") built from the same table, so a key shown on
 * a button, in the list and the one the plane listens to never part ways. No React here: the file's page reads the
 * list without loading the canvas.
 */

export type Tool = "select" | "hand" | "frame" | "shape" | "line" | "arrow" | "draw" | "text" | "note" | "comment";

/** A key as the plane reads it (`key` in lower case) and as people see it ("⇧T"). */
export interface ToolKey {
  key: string;
  shift?: boolean;
}

export const keyLabel = (k: ToolKey) => `${k.shift ? "⇧" : ""}${k.key.toUpperCase()}`;

/** What the Shapes menu offers: the five forms and the line, each with its key. */
export const SHAPE_CHOICES: readonly { kind: CanvasShapeKind | "line"; icon: IconName; key: ToolKey }[] = [
  { kind: "rect", icon: "rectangle", key: { key: "r" } },
  { kind: "ellipse", icon: "ellipse", key: { key: "o" } },
  { kind: "diamond", icon: "diamond", key: { key: "d" } },
  { kind: "triangle", icon: "triangle", key: { key: "t", shift: true } },
  { kind: "star", icon: "star", key: { key: "s", shift: true } },
  { kind: "line", icon: "line", key: { key: "l" } },
];

export const KIND_ICONS: Record<CanvasShapeKind, IconName> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
  triangle: "triangle",
  star: "star",
};

/** How an arrow runs, as the Arrow menu and the arrow's bar offer it. */
export const ROUTE_CHOICES: readonly { route: ArrowRoute; icon: IconName }[] = [
  { route: "straight", icon: "arrowTool" },
  { route: "curve", icon: "curve" },
  { route: "elbow", icon: "elbow" },
];

/** The single-letter keys of the dock's tools (the desktop app keeps the ⌘ ones). */
export const TOOL_KEYS: Readonly<Record<Exclude<Tool, "shape" | "line">, ToolKey>> = {
  select: { key: "v" },
  hand: { key: "h" },
  frame: { key: "f" },
  arrow: { key: "a" },
  draw: { key: "p" },
  text: { key: "t" },
  note: { key: "n" },
  comment: { key: "c" },
};

export const IMAGE_KEY: ToolKey = { key: "i" };
/** "Pedir ao Atlas": the file's conversation, with what is selected. */
export const ASK_KEY: ToolKey = { key: "g" };

/** An arrow's heads in one word: the four ways the bar offers. */
export type HeadsChoice = "none" | "end" | "start" | "both";

export const HEADS_CHOICES: readonly { heads: HeadsChoice; icon: IconName }[] = [
  { heads: "end", icon: "arrowTool" },
  { heads: "both", icon: "arrowBoth" },
  { heads: "start", icon: "arrowStart" },
  { heads: "none", icon: "line" },
];

/** The heads an arrow has (left out: none at its start, one at its end). */
export function headsOf(shape: Pick<ShapeView, "heads">): HeadsChoice {
  const start = shape.heads?.start ?? "none";
  const end = shape.heads?.end ?? "arrow";
  if (start === "arrow") return end === "arrow" ? "both" : "start";
  return end === "arrow" ? "end" : "none";
}

/** The `heads` to store for a choice (null: the default, one at the end). */
export function headsFor(choice: HeadsChoice): ArrowHeads | null {
  switch (choice) {
    case "end":
      return null;
    case "both":
      return { start: "arrow", end: "arrow" };
    case "start":
      return { start: "arrow", end: "none" };
    case "none":
      return { start: "none", end: "none" };
  }
}

/** A line is an arrow with no heads (the Shapes menu's Line). */
export const isLine = (shape: Pick<ShapeView, "type" | "heads">) => shape.type === "arrow" && headsOf(shape) === "none";

/** The colors people draw and outline with: the pen bar's five, in its order. */
export const INKS = [
  { key: "red", color: "#e5484d" },
  { key: "ink", color: "#151514" },
  { key: "blue", color: "#0063d1" },
  { key: "green", color: "#2f9e44" },
  { key: "orange", color: "#f2a33a" },
] as const;

export type PenSize = "s" | "m" | "l";

export const PEN_SIZES: readonly PenSize[] = ["s", "m", "l"];

/** Each size's width in world units: the pen's lines, the highlighter's wide bands. */
export const PEN_WIDTHS: Record<DrawTool, Record<PenSize, number>> = {
  pen: { s: 2, m: 4, l: 8 },
  marker: { s: 8, m: 16, l: 24 },
};

/** The size a stroke's width is nearest to, for its tool. */
export function penSizeOf(tool: DrawTool, width: number | undefined): PenSize {
  const widths = PEN_WIDTHS[tool];
  const w = width ?? widths.m;
  return PEN_SIZES.reduce<PenSize>((best, s) => (Math.abs(widths[s] - w) < Math.abs(widths[best] - w) ? s : best), "m");
}

/** The pen as the person last set it: pen or highlighter, a color, a size. */
export interface PenStyle {
  tool: DrawTool;
  color: string;
  size: PenSize;
}

export const DEFAULT_PEN: PenStyle = { tool: "pen", color: INKS[0].color, size: "m" };

/** The widths a border or a line takes from its bar. */
export const STROKE_WIDTHS = [1, 2, 4, 8, 12] as const;
/** A rectangle's corners, from square to well rounded. */
export const CORNER_RADII = [0, 8, 16, 32, 64] as const;

/**
 * The canvas's keys for the shortcuts list ("?"): every tool, then the view and duplicating. `mod` is ⌘ or Ctrl.
 */
export function canvasShortcuts(t: TFunction, mod: string): [string, string[]][] {
  const k = (key: ToolKey) => (key.shift ? ["⇧", key.key.toUpperCase()] : [key.key.toUpperCase()]);
  return [
    [t("live.canvas.tools.select"), k(TOOL_KEYS.select)],
    [t("live.canvas.tools.hand"), k(TOOL_KEYS.hand)],
    [t("live.canvas.tools.frame"), k(TOOL_KEYS.frame)],
    ...SHAPE_CHOICES.map(
      (c) => [t(`live.canvas.shapeKinds.${c.kind}` as "live.canvas.shapeKinds.rect"), k(c.key)] as [string, string[]],
    ),
    [t("live.canvas.tools.arrow"), k(TOOL_KEYS.arrow)],
    [t("live.canvas.tools.pen"), k(TOOL_KEYS.draw)],
    [t("live.canvas.tools.text"), k(TOOL_KEYS.text)],
    [t("live.canvas.tools.note"), k(TOOL_KEYS.note)],
    [t("live.canvas.tools.image"), k(IMAGE_KEY)],
    [t("live.canvas.tools.comment"), k(TOOL_KEYS.comment)],
    [t("live.canvas.tools.ask"), k(ASK_KEY)],
    [t("live.shell.shortcuts.zoom"), ["=", "-"]],
    [t("live.shell.shortcuts.fit"), ["⇧", "1"]],
    [t("live.canvas.zoom.selection"), ["⇧", "2"]],
    [t("live.shell.shortcuts.duplicate"), [mod, "D"]],
  ];
}
