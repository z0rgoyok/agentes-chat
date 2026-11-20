import { type Command, type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { getRelativeSelection, ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";

/**
 * Undo inside a text box with the file's own undo (ADR 0196): what is typed joins the same history as moving a box or
 * adding a slide, so ⌘Z takes back the last thing this person did wherever it was, and never anything someone else
 * or an agent did. It does what y-prosemirror's `yUndoPlugin` does for the caret (each step remembers where the caret
 * was, and undoing puts it back there), on an `UndoManager` the box doesn't own: the stock plugin destroys its manager
 * when the box closes, which would end the file's history.
 */

type Binding = Parameters<typeof getRelativeSelection>[0];

interface UndoState {
  prevSel: ReturnType<typeof getRelativeSelection> | null;
}

const richUndoKey = new PluginKey<UndoState>("richUndo");

function bindingOf(state: EditorState): Binding | null {
  return (ySyncPluginKey.getState(state) as { binding?: Binding } | undefined)?.binding ?? null;
}

export function richUndo(undoManager: Y.UndoManager): Plugin<UndoState> {
  return new Plugin<UndoState>({
    key: richUndoKey,
    state: {
      init: () => ({ prevSel: null }),
      apply: (_tr, value, oldState) => {
        const binding = bindingOf(oldState);
        if (!binding) return value;
        try {
          return { prevSel: getRelativeSelection(binding, oldState) };
        } catch {
          return value;
        }
      },
    },
    view(view) {
      const added = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
        const binding = bindingOf(view.state);
        // Only steps this box made: its caret is the one to bring back.
        if (binding && view.hasFocus()) stackItem.meta.set(binding, richUndoKey.getState(view.state)?.prevSel ?? null);
      };
      const popped = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
        const binding = bindingOf(view.state);
        if (!binding) return;
        const saved = stackItem.meta.get(binding);
        if (saved) binding.beforeTransactionSelection = saved as Binding["beforeTransactionSelection"];
      };
      undoManager.on("stack-item-added", added);
      undoManager.on("stack-item-popped", popped);
      return {
        destroy() {
          undoManager.off("stack-item-added", added);
          undoManager.off("stack-item-popped", popped);
        },
      };
    },
  });
}

export const undoWith =
  (undoManager: Y.UndoManager): Command =>
  (_state, dispatch) => {
    if (!undoManager.canUndo()) return false;
    if (dispatch) undoManager.undo();
    return true;
  };

export const redoWith =
  (undoManager: Y.UndoManager): Command =>
  (_state, dispatch) => {
    if (!undoManager.canRedo()) return false;
    if (dispatch) undoManager.redo();
    return true;
  };
