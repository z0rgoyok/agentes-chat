import { baseKeymap, chainCommands, exitCode } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import type { Command, Plugin } from "prosemirror-state";
import {
  docLineBreak,
  escapeEdge,
  fenceToCode,
  goToCell,
  leaveCodeOnEmptyLines,
  liftDocParagraph,
  paragraphAfterNode,
  setDocStyle,
  shiftDocLevel,
  splitDocParagraph,
  toggleDocList,
  toggleDocMark,
} from "./commands";

/**
 * The document's keys (ADR 0200), before ProseMirror's own: marks (⌘B ⌘I ⌘U, ⌘⇧X strikethrough, ⌘E code), styles
 * (⌘⌥0 text, ⌘⌥1–3 headings), lists (⌘⇧8 bullets, ⌘⇧7 numbers), ⌘K link, Enter that keeps a list going and leaves
 * code after two empty lines, Shift-Enter a line break, Tab and Shift-Tab between a table's cells or a list's levels,
 * and the arrows out past a table or a picture at either end.
 */

export interface DocKeyOptions {
  undo: Command;
  redo: Command;
  /** ⌘K: the address (the toolbar's link form). */
  onLink: () => void;
}

/** Two spaces in code (Tab never leaves a code block by surprise). */
const indentCode: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.type.spec.code) return false;
  dispatch?.(state.tr.insertText("  ").scrollIntoView());
  return true;
};

const always =
  (command: Command): Command =>
  (state, dispatch, view) =>
    command(state, dispatch, view) || true;

export function docKeymap(options: DocKeyOptions): Plugin[] {
  const keys: Record<string, Command> = {
    "Mod-b": toggleDocMark("bold"),
    "Mod-i": toggleDocMark("italic"),
    "Mod-u": toggleDocMark("underline"),
    "Mod-Shift-x": toggleDocMark("strike"),
    "Mod-e": toggleDocMark("code"),
    "Mod-Alt-0": setDocStyle("text"),
    "Mod-Alt-1": setDocStyle("h1"),
    "Mod-Alt-2": setDocStyle("h2"),
    "Mod-Alt-3": setDocStyle("h3"),
    "Mod-Shift-7": toggleDocList("ordered"),
    "Mod-Shift-8": toggleDocList("bullet"),
    Enter: chainCommands(paragraphAfterNode, fenceToCode, leaveCodeOnEmptyLines, splitDocParagraph),
    "Shift-Enter": docLineBreak,
    "Mod-Enter": chainCommands(exitCode, docLineBreak),
    Backspace: liftDocParagraph,
    Tab: chainCommands(goToCell(1), indentCode, always(shiftDocLevel(1))),
    "Shift-Tab": chainCommands(goToCell(-1), always(shiftDocLevel(-1))),
    ArrowDown: escapeEdge(1),
    ArrowRight: escapeEdge(1),
    ArrowUp: escapeEdge(-1),
    ArrowLeft: escapeEdge(-1),
    "Mod-z": options.undo,
    "Mod-Shift-z": options.redo,
    "Mod-y": options.redo,
    "Mod-k": () => {
      options.onLink();
      return true;
    },
  };
  return [keymap(keys), keymap(baseKeymap)];
}
