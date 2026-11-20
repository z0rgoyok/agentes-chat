import { LOCAL } from "@agenteschat/live";
import type { PeerUser } from "@agenteschat/live/awareness";
import { cx } from "@agenteschat/ui";
import type { Node as PMNode } from "prosemirror-model";
import { type Command, EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { type CSSProperties, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { redoCommand, undoCommand, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { NO_FORMAT, type RichFormat, richFormat, richInputRules, richKeymap, sameFormat } from "./commands";
import { type CaretLook, richCursors } from "./cursors";
import { listNumbers, richSchema } from "./schema";
import { redoWith, richUndo, undoWith } from "./undo";
import "./rich.css";

/**
 * A rich text box people and agents edit together (ADR 0196 §2, §5): ProseMirror bound to the box's `Y.XmlFragment`
 * through y-prosemirror. Every change typed here is the person's own (their undo takes it back, as it takes back
 * moving the box, and never what someone else typed), other people's carets show in their color with their name, and
 * this person's caret goes to them in the presence field `cursorPm`. Slides and the canvas mount one while a box is
 * being edited and draw `RichView` the rest of the time.
 */

export interface RichTextHandle {
  /** Runs a command of `./commands` on the text (the toolbar's buttons); false when it didn't apply. */
  run(command: Command): boolean;
  focus(): void;
  format(): RichFormat;
  /** ProseMirror's view, while mounted. */
  view(): EditorView | null;
}

export interface RichTextProps {
  fragment: Y.XmlFragment;
  /** The box's name for screen readers ("Título", "Texto"). */
  label: string;
  readOnly?: boolean;
  /** The file's presence: others' carets in, this person's caret out. */
  awareness?: Awareness | null;
  /** A peer's name and color, or null to leave them out. */
  look?: (clientId: number, user: PeerUser) => CaretLook | null;
  /** The file's undo (`room.undo`); without one the box keeps an undo of its own. */
  undoManager?: Y.UndoManager | null;
  /** Shown while the box is empty. */
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  /** Where the caret goes as the box opens: under a point of the page (the double click), at the end, or all. */
  focusAt?: { x: number; y: number } | "end" | "all" | null;
  /** What is on where the caret is, each time it changes (the toolbar's pressed buttons). */
  onFormat?: (format: RichFormat) => void;
  /** ⌘K. */
  onLink?: () => void;
  /** Esc. */
  onEscape?: () => void;
  ref?: Ref<RichTextHandle>;
}

/** Each open box's view by its editable element (see `richViewOf`). */
const views = new WeakMap<Element, EditorView>();

/**
 * The editor of a rich text box from its element (the `.rt-editor`, or anything inside it): for a toolbar that only
 * has the page to go by, and for tests that type as ProseMirror does. Null when the box isn't open.
 */
export function richViewOf(el: Element | null): EditorView | null {
  const editor = el?.closest(".rt-editor");
  return editor ? (views.get(editor) ?? null) : null;
}

const placeholderKey = new PluginKey("richPlaceholder");

/** The box's hint while it is one empty paragraph. */
function placeholderPlugin(text: () => string | undefined): Plugin {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const words = text();
        const doc = state.doc;
        const first = doc.firstChild;
        if (!words || doc.childCount !== 1 || !first || first.content.size > 0) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, first.nodeSize, { class: "rt-empty", "data-placeholder": words }),
        ]);
      },
    },
  });
}

const numbersKey = new PluginKey("richNumbers");

/** Numbered items show their number (`data-n`, drawn by rich.css), counted per list and level. */
const numbersPlugin = new Plugin({
  key: numbersKey,
  props: {
    decorations(state) {
      const paragraphs: { node: PMNode; pos: number }[] = [];
      state.doc.forEach((node, pos) => {
        paragraphs.push({ node, pos });
      });
      const numbers = listNumbers(paragraphs.map((p) => p.node.attrs));
      const found: Decoration[] = [];
      paragraphs.forEach(({ node, pos }, i) => {
        const n = numbers[i];
        if (n !== null && n !== undefined)
          found.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": String(n) }));
      });
      return found.length ? DecorationSet.create(state.doc, found) : null;
    },
  },
});

export function RichText({
  fragment,
  label,
  readOnly = false,
  awareness,
  undoManager,
  placeholder,
  className,
  style,
  focusAt,
  ref,
  ...rest
}: RichTextProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const format = useRef<RichFormat>(NO_FORMAT);
  // What changes between renders is read through here, so the editor isn't made again for a new callback.
  const latest = useRef({ placeholder, label, readOnly, ...rest });
  useLayoutEffect(() => {
    latest.current = { placeholder, label, readOnly, ...rest };
  });
  // Read once, as the box opens.
  const focusFirst = useRef(focusAt);

  useImperativeHandle(
    ref,
    () => ({
      run(command) {
        const v = view.current;
        if (!v) return false;
        const done = command(v.state, v.dispatch, v);
        v.focus();
        return done;
      },
      focus() {
        view.current?.focus();
      },
      format: () => format.current,
      view: () => view.current,
    }),
    [],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // What the person types reaches the document as y-prosemirror's own transactions (origin `ySyncPluginKey`), each
    // inside its lock, so its observer never draws the person's own keys back (that would break an accent being
    // composed). The file's undo takes them back with everything else the person did (ADR 0196 §6): it tracks that
    // origin beside `LOCAL`. Only this person's typing has it; others' arrive with the connection's origin.
    if (undoManager && !undoManager.trackedOrigins.has(ySyncPluginKey)) undoManager.trackedOrigins.add(ySyncPluginKey);
    const undo = undoManager ? undoWith(undoManager) : undoCommand;
    const redo = undoManager ? redoWith(undoManager) : redoCommand;
    const plugins: Plugin[] = [
      ySyncPlugin(fragment),
      ...(awareness
        ? [
            richCursors({
              awareness,
              look: (clientId, user) =>
                latest.current.look?.(clientId, { kind: user.kind === "agent" ? "agent" : "person", id: user.id }) ??
                null,
              broadcast: !readOnly,
            }),
          ]
        : []),
      undoManager ? richUndo(undoManager) : yUndoPlugin({ trackedOrigins: [LOCAL] }),
      ...richKeymap({
        undo,
        redo,
        onLink: () => latest.current.onLink?.(),
        onEscape: () => latest.current.onEscape?.(),
      }),
      richInputRules(),
      placeholderPlugin(() => latest.current.placeholder),
      numbersPlugin,
    ];
    const tell = (state: EditorState) => {
      const next = richFormat(state);
      if (sameFormat(next, format.current)) return;
      format.current = next;
      latest.current.onFormat?.(next);
    };
    const editor: EditorView = new EditorView(el, {
      state: EditorState.create({ schema: richSchema, plugins }),
      editable: () => !latest.current.readOnly,
      attributes: () => ({
        class: "rt rt-editor",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": latest.current.label,
        ...(latest.current.readOnly ? { "aria-readonly": "true" } : {}),
      }),
      // `this` is the view: a plugin may dispatch while the view is still being made, before `editor` is set.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        if (!latest.current.readOnly) tell(this.state);
      },
      handleDOMEvents: {
        // The desktop app's Edit menu sends undo and redo this way.
        beforeinput(v, event) {
          const input = event as InputEvent;
          if (input.inputType === "historyUndo" || input.inputType === "historyRedo") {
            event.preventDefault();
            (input.inputType === "historyUndo" ? undo : redo)(v.state, v.dispatch, v);
            return true;
          }
          return false;
        },
      },
    });
    view.current = editor;
    views.set(editor.dom, editor);
    const first = focusFirst.current;
    if (first && !readOnly) {
      let selection: Selection | null = null;
      if (first === "end") selection = Selection.atEnd(editor.state.doc);
      else if (first === "all") selection = TextSelection.create(editor.state.doc, 0, editor.state.doc.content.size);
      else {
        try {
          const at = editor.posAtCoords({ left: first.x, top: first.y });
          if (at) selection = TextSelection.create(editor.state.doc, at.pos);
        } catch {
          // No layout (a test's page): the end, then.
        }
        selection ??= Selection.atEnd(editor.state.doc);
      }
      if (selection) editor.dispatch(editor.state.tr.setSelection(selection));
      editor.focus();
      tell(editor.state);
    }
    return () => {
      views.delete(editor.dom);
      editor.destroy();
      if (view.current === editor) view.current = null;
    };
  }, [fragment, awareness, undoManager, readOnly]);

  return <div ref={host} className={cx("rt-host", className)} style={style} />;
}
