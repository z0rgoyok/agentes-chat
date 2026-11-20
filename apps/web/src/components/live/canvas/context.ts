import type { LiveRoom } from "@agenteschat/client";
import { createContext, useContext } from "react";

/**
 * What every shape of an open canvas reads (ADR 0196): the room, where its pictures are, whether it can change, and
 * what a shape's own buttons do. Stable for the canvas's life, so a shape redraws only when it changes itself.
 */
export interface CanvasEnv {
  room: LiveRoom;
  orgId: string;
  fileId: string;
  readOnly: boolean;
  /** A picture of this canvas, by its asset id. */
  assetUrl(assetId: string): string;
  /** "Try again" on a placeholder whose pictures failed (ADR 0197). */
  retry(requestId: string): void;
  /** "Interact" on a page: it takes the pointer and the keys until a press outside it. */
  interact(shapeId: string): void;
  /** The text box of a note, a text or a shape is done being typed in. */
  doneEditing(shapeId: string, box?: { h: number }): void;
  /** Esc in a text box: stop typing, keep the shape chosen. */
  stopEditing(shapeId: string): void;
  /** Where the caret goes as a text box opens: under the double click that opened it, else at the end. */
  caretFor(shapeId: string): { x: number; y: number } | "end";
  /** A Drive file's card or page opened in the viewer. */
  openFile(fileId: string): void;
}

export const CanvasContext = createContext<CanvasEnv | null>(null);

export function useCanvasEnv(): CanvasEnv {
  const env = useContext(CanvasContext);
  if (!env) throw new Error("A canvas shape is drawn outside its canvas");
  return env;
}
