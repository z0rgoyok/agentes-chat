import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

export interface CodeEditorHandle {
  /** What the editor holds, with the file's own line endings. */
  text(): string;
  /** A new text to start from (the file as saved, or as it is on the computer now): nothing unsaved after it. */
  reset(text: string): void;
  focus(): void;
}

/** The editor in the app's own type and colors (the tokens, so both themes); its tokens are colored in `code.css`. */
const look = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "transparent", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { padding: "8px 0 40vh", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", minWidth: "40px", opacity: "0.6" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--code-editor-line)" },
  ".cm-activeLineGutter": { opacity: "1" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--code-editor-sel)",
  },
  ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--sunken)", borderColor: "var(--line)", color: "var(--muted)" },
});

/**
 * A file of a code session's worktree in an editor (ADR 0215): line numbers, the language its name says (loaded when
 * the file opens), undo, search, Tab indents. ⌘S (Ctrl+S) asks to save; `onDirty` says whether it differs from the
 * text it started from. A file with Windows line endings keeps them.
 */
export default function CodeEditor({
  path,
  initial,
  readOnly,
  onDirty,
  onSave,
  handle,
  label,
}: {
  path: string;
  initial: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  handle: Ref<CodeEditorHandle>;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const base = useRef<Text | null>(null);
  const locked = useRef(new Compartment());
  const latest = useRef({ onDirty, onSave });
  latest.current = { onDirty, onSave };
  // The first text and the path make the editor; a later text comes through `reset`.
  const first = useRef(initial);

  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const state = (text: string) =>
      EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            indentWithTab,
          ]),
          syntaxHighlighting(classHighlighter),
          look,
          language.of([]),
          locked.current.of([]),
          ...(text.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n")] : []),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && base.current) latest.current.onDirty(!u.state.doc.eq(base.current));
          }),
        ],
      });
    const made = new EditorView({ state: state(first.current), parent: host.current });
    base.current = made.state.doc;
    view.current = made;
    let gone = false;
    const known = LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf("/") + 1));
    void known?.load().then(
      (support) => {
        if (!gone) made.dispatch({ effects: language.reconfigure(support) });
      },
      () => {},
    );
    return () => {
      gone = true;
      view.current = null;
      made.destroy();
    };
  }, [path, label]);

  useEffect(() => {
    view.current?.dispatch({
      effects: locked.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    });
  }, [readOnly]);

  useImperativeHandle(
    handle,
    () => ({
      text: () => view.current?.state.sliceDoc() ?? "",
      reset: (text) => {
        const v = view.current;
        if (!v) return;
        // The same text (a save's answer): the cursor and the history stay.
        if (v.state.sliceDoc() !== text)
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: v.state.toText(text) } });
        base.current = v.state.doc;
        latest.current.onDirty(false);
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div ref={host} className="code-editor" />;
}
