import { type PeerUser, readPeerState } from "@agenteschat/live/awareness";
import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * Who else is writing in the document (ADR 0196 §5, ADR 0200): a person's caret in their color with their name on a
 * flag, their selection tinted; an agent's caret with its face and name (the `lf-cur__who` tag of its pointer
 * elsewhere) at the end of the blocks it works on, those blocks lit in its color while it writes. People's carets
 * travel in the presence field `cursorPm` (y-prosemirror's relative positions, as in rich text); agents say the blocks
 * (`sel.document`) and what they do (`activity`). Names and colors come from the workspace (`look`), never from what a
 * client claims, and the presence of others is never written to.
 */

export interface DocCaretLook {
  name: string;
  color: string;
  /** Words on `color`. */
  onColor: string;
}

export const docPresenceKey = new PluginKey<DecorationSet>("docPresence");

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

/** A person's caret: a bar in their color, their name on a flag over it. */
function personCaret(look: DocCaretLook, clientId: number): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "lf-doc-caret";
  caret.dataset.client = String(clientId);
  caret.style.setProperty("--peer", look.color);
  caret.style.setProperty("--peer-on", look.onColor);
  const name = document.createElement("span");
  name.className = "lf-doc-caret__tag";
  name.textContent = look.name;
  caret.append("⁠", name, "⁠");
  return caret;
}

export interface DocPresenceOptions {
  awareness: Awareness;
  /** A peer's name and colors (null: don't show them, a person who hides their presence). */
  look: (user: PeerUser) => DocCaretLook | null;
  /**
   * The element an agent's caret is drawn in, by its presence id: the editor fills it with the agent's face and name
   * (a React portal), and keeps it across redraws.
   */
  agentCaret: (clientId: number) => HTMLElement;
  /** Send this person's caret (false where they can only read). */
  broadcast: boolean;
}

/** The top-level blocks by id, with where each starts. */
function blocksById(doc: PMNode): Map<string, { node: PMNode; pos: number }> {
  const map = new Map<string, { node: PMNode; pos: number }>();
  doc.forEach((node, pos) => {
    const id = node.attrs.id;
    if (typeof id === "string") map.set(id, { node, pos });
  });
  return map;
}

function decorations(state: EditorState, options: DocPresenceOptions): DecorationSet {
  const ystate = syncState(state);
  if (!ystate?.binding || ystate.snapshot != null || ystate.prevSnapshot != null || ystate.binding.mapping.size === 0) {
    return DecorationSet.empty;
  }
  const { awareness, look } = options;
  const found: Decoration[] = [];
  const max = Math.max(state.doc.content.size - 1, 0);
  let blocks: Map<string, { node: PMNode; pos: number }> | null = null;
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const peer = readPeerState(raw);
    if (!peer) return;
    const seen = look(peer.user);
    if (!seen) return;
    const agent = peer.user.kind === "agent";
    const style = `--peer: ${seen.color}; --peer-on: ${seen.onColor}`;
    const cursor = peer.cursorPm as { anchor?: unknown; head?: unknown } | null | undefined;
    if (cursor?.anchor && cursor.head) {
      let anchor: number | null;
      let head: number | null;
      try {
        const mapping = ystate.binding?.mapping as Mapping;
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
      if (anchor === null || head === null) return;
      anchor = Math.min(anchor, max);
      head = Math.min(head, max);
      found.push(
        Decoration.widget(head, () => (agent ? options.agentCaret(clientId) : personCaret(seen, clientId)), {
          key: `${clientId}:${seen.color}:${seen.name}`,
          side: 10,
        }),
      );
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      if (from < to) {
        found.push(
          Decoration.inline(
            from,
            to,
            { class: "lf-doc-peer-sel", style },
            { inclusiveEnd: true, inclusiveStart: false },
          ),
        );
      }
      return;
    }
    // An agent at work says which blocks: they light up while it writes, its caret at the end of the last one.
    const ids = agent ? peer.sel?.document : undefined;
    if (!ids?.length) return;
    blocks ??= blocksById(state.doc);
    const at = ids.map((id) => blocks?.get(id)).filter((b): b is { node: PMNode; pos: number } => !!b);
    const last = at[at.length - 1];
    if (!last) return;
    if (peer.mode === "editing") {
      for (const b of at) {
        found.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "lf-doc-agent-block", style }));
      }
    }
    const end = last.node.isTextblock ? last.pos + last.node.nodeSize - 1 : last.pos + last.node.nodeSize;
    found.push(
      Decoration.widget(end, () => options.agentCaret(clientId), {
        key: `agent:${clientId}`,
        side: last.node.isTextblock ? 10 : 1,
      }),
    );
  });
  return DecorationSet.create(state.doc, found);
}

/** The caret this person sends is in this document (it may be in another file's text since). */
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

export function docPresence(options: DocPresenceOptions): Plugin<DecorationSet> {
  const { awareness, broadcast } = options;
  return new Plugin<DecorationSet>({
    key: docPresenceKey,
    state: {
      init: (_, state) => decorations(state, options),
      apply(tr, previous, _old, state) {
        const ystate = syncState(state);
        if (ystate?.isChangeOrigin || tr.getMeta(docPresenceKey)) return decorations(state, options);
        return previous.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => docPresenceKey.getState(state),
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
          if (alive && (view as unknown as { docView?: unknown }).docView) {
            view.dispatch(view.state.tr.setMeta(docPresenceKey, true));
          }
        });
      };
      const send = () => {
        if (!broadcast) return;
        const ystate = syncState(view.state);
        if (!ystate?.binding) return;
        const mapping = ystate.binding.mapping as Mapping;
        const current = (awareness.getLocalState() ?? {}) as { cursorPm?: { anchor?: unknown; head?: unknown } | null };
        if (view.hasFocus()) {
          const { anchor, head } = view.state.selection;
          const a = absolutePositionToRelativePosition(anchor, ystate.type, mapping);
          const h = absolutePositionToRelativePosition(head, ystate.type, mapping);
          const was = current.cursorPm;
          const same =
            was?.anchor &&
            was.head &&
            Y.compareRelativePositions(Y.createRelativePositionFromJSON(was.anchor), a) &&
            Y.compareRelativePositions(Y.createRelativePositionFromJSON(was.head), h);
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
