import { readPeerState } from "@agenteschat/live/awareness";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * Other people's carets and selections inside a text box (ADR 0196 §5), drawn in their color with their name, and
 * this person's own caret sent to them. It is y-prosemirror's cursor plugin with three differences that matter here:
 * the caret travels in the presence field `cursorPm` (the field `cursor` is the pointer over a slide or a canvas),
 * names and colors come from the people and agents of the workspace rather than from what a client claims, and the
 * presence of others is never written to.
 */

export interface CaretLook {
  name: string;
  color: string;
}

export const richCursorsKey = new PluginKey<DecorationSet>("richCursors");

interface SyncState {
  doc: Y.Doc;
  type: Y.XmlFragment;
  binding: { mapping: Map<Y.AbstractType<unknown>, unknown> } | null;
  snapshot: unknown;
  prevSnapshot: unknown;
  isChangeOrigin?: boolean;
}

type Mapping = Parameters<typeof relativePositionToAbsolutePosition>[3];

function syncState(state: EditorState): SyncState | null {
  return (ySyncPluginKey.getState(state) as SyncState | undefined) ?? null;
}

/** The caret element: a thin bar in the person's color and their name above it (shown on hover, rich.css). */
function caretElement(look: CaretLook): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "rt-caret";
  caret.style.setProperty("--peer", look.color);
  const name = document.createElement("span");
  name.className = "rt-caret__name";
  name.textContent = look.name;
  caret.append("⁠", name, "⁠");
  return caret;
}

function decorations(
  state: EditorState,
  awareness: Awareness,
  look: (clientId: number, user: { kind: string; id: string }) => CaretLook | null,
): DecorationSet {
  const ystate = syncState(state);
  if (!ystate?.binding || ystate.snapshot != null || ystate.prevSnapshot != null || ystate.binding.mapping.size === 0) {
    return DecorationSet.empty;
  }
  const found: Decoration[] = [];
  const max = Math.max(state.doc.content.size - 1, 0);
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const peer = readPeerState(raw);
    const cursor = peer?.cursorPm as { anchor?: unknown; head?: unknown } | null | undefined;
    if (!peer || !cursor?.anchor || !cursor.head) return;
    const seen = look(clientId, peer.user);
    if (!seen) return;
    const mapping = ystate.binding?.mapping as Mapping;
    let anchor: number | null;
    let head: number | null;
    try {
      anchor = relativePositionToAbsolutePosition(
        ystate.doc,
        ystate.type,
        Y.createRelativePositionFromJSON(cursor.anchor),
        mapping,
      );
      head = relativePositionToAbsolutePosition(
        ystate.doc,
        ystate.type,
        Y.createRelativePositionFromJSON(cursor.head),
        mapping,
      );
    } catch {
      return;
    }
    // A caret in another text box of the same file reads as null here.
    if (anchor === null || head === null) return;
    anchor = Math.min(anchor, max);
    head = Math.min(head, max);
    found.push(Decoration.widget(head, () => caretElement(seen), { key: `${clientId}:${seen.color}`, side: 10 }));
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    if (from < to) {
      found.push(
        Decoration.inline(
          from,
          to,
          { class: "rt-peer-sel", style: `--peer: ${seen.color}` },
          { inclusiveEnd: true, inclusiveStart: false },
        ),
      );
    }
  });
  return DecorationSet.create(state.doc, found);
}

export interface RichCursorsOptions {
  awareness: Awareness;
  /** A peer's name and color (null: don't show them, a person who hides their presence). */
  look: (clientId: number, user: { kind: string; id: string }) => CaretLook | null;
  /** Send this person's caret (false in a box they can only read). */
  broadcast: boolean;
}

export function richCursors({ awareness, look, broadcast }: RichCursorsOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: richCursorsKey,
    state: {
      init: (_, state) => decorations(state, awareness, look),
      apply(tr, previous, _old, state) {
        const ystate = syncState(state);
        if (ystate?.isChangeOrigin || tr.getMeta(richCursorsKey)) return decorations(state, awareness, look);
        return previous.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => richCursorsKey.getState(state),
    },
    view(view: EditorView) {
      let alive = true;
      let queued = false;
      const redraw = () => {
        // Presence comes in bursts: once a frame is enough.
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          // ProseMirror's own `docView` is there while the view is mounted.
          if (alive && (view as unknown as { docView?: unknown }).docView) {
            view.dispatch(view.state.tr.setMeta(richCursorsKey, true));
          }
        });
      };
      const send = () => {
        if (!broadcast) return;
        const ystate = syncState(view.state);
        if (!ystate?.binding) return;
        const mapping = ystate.binding.mapping as Mapping;
        const current = (awareness.getLocalState() ?? {}) as { cursorPm?: { anchor?: unknown } | null };
        if (view.hasFocus()) {
          const { anchor, head } = view.state.selection;
          const a = absolutePositionToRelativePosition(anchor, ystate.type, mapping);
          const h = absolutePositionToRelativePosition(head, ystate.type, mapping);
          const was = current.cursorPm;
          const same =
            was?.anchor &&
            (was as { head?: unknown }).head &&
            Y.compareRelativePositions(Y.createRelativePositionFromJSON(was.anchor), a) &&
            Y.compareRelativePositions(Y.createRelativePositionFromJSON((was as { head: unknown }).head), h);
          if (!same) {
            awareness.setLocalStateField("cursorPm", {
              anchor: Y.relativePositionToJSON(a),
              head: Y.relativePositionToJSON(h),
            });
          }
        } else if (current.cursorPm?.anchor && ownsCaret(ystate, current.cursorPm.anchor)) {
          awareness.setLocalStateField("cursorPm", null);
        }
      };
      awareness.on("change", redraw);
      view.dom.addEventListener("focusin", send);
      view.dom.addEventListener("focusout", send);
      return {
        update: send,
        destroy() {
          alive = false;
          awareness.off("change", redraw);
          view.dom.removeEventListener("focusin", send);
          view.dom.removeEventListener("focusout", send);
          const current = (awareness.getLocalState() ?? {}) as { cursorPm?: { anchor?: unknown } | null };
          const ystate = syncState(view.state);
          if (broadcast && ystate && current.cursorPm?.anchor && ownsCaret(ystate, current.cursorPm.anchor)) {
            awareness.setLocalStateField("cursorPm", null);
          }
        },
      };
    },
  });
}

/** The caret this person sends is in this box (another box may have taken over already). */
function ownsCaret(ystate: SyncState, anchor: unknown): boolean {
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor), ystate.doc);
    if (!at) return false;
    for (let type: Y.AbstractType<unknown> | null = at.type; type; ) {
      if (type === ystate.type) return true;
      const parent: unknown = type._item?.parent;
      type = parent instanceof Y.AbstractType ? parent : null;
    }
  } catch {
    return false;
  }
  return false;
}
