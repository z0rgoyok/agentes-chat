import type { Artifact, LiveSelection } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type PeerUser, readPeerState } from "@agenteschat/live/awareness";
import { DOC_BODY } from "@agenteschat/live/document";
import { Button } from "@agenteschat/ui";
import { deleteSelection } from "prosemirror-commands";
import { type Command, EditorState, NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ySyncPlugin, ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useToast } from "@/lib/toast";
import type { LiveEditorProps } from "../editor";
import { LiveMeta } from "../LiveHeader";
import { PeerFace, usePeerLooks } from "../peers";
import { redoWith, richUndo, undoWith } from "../rich/undo";
import { DrivePicker } from "../slides/DrivePicker";
import { useFileAgentHere } from "../talk";
import {
  addDocColumn,
  addDocRow,
  type DocFormat,
  type DocStyle,
  deleteDocColumn,
  deleteDocRow,
  deleteDocTable,
  docFormat,
  insertDocImage,
  insertDocTable,
  NO_DOC_FORMAT,
  sameDocFormat,
  setDocLink,
  setDocStyle,
  setImageWidth,
  tableHasHeader,
  toggleDocHeaderRow,
  toggleDocList,
  toggleDocMark,
} from "./commands";
import { DocTitle } from "./DocTitle";
import { ImageView } from "./image";
import { docInputRules, pastedText } from "./input";
import { docKeymap } from "./keys";
import { blockIds, emptyHint, findBlock, findText, listNumbering, revealKey, revealLight } from "./plugins";
import { type DocCaretLook, docPresence } from "./presence";
import { docSchema, N } from "./schema";
import { DocToolbar, type TableAction } from "./Toolbar";
import "@/pages/wiki.css";
import "./document.css";

/**
 * A document (ADR 0200) on its page: the Wiki's page (its title, who made it and who sees it, its text in the Wiki's
 * type at the Wiki's reading width) that everyone edits at once. ProseMirror bound to the document's body through
 * y-prosemirror: what is typed is the person's own change (their undo takes it back, never what someone else or an
 * agent wrote), other people's carets show with their names, an agent's with its face where it writes, every
 * top-level block keeps an id of its own (`blockIds`), and pictures are the file's own (uploaded, or copied from the
 * Drive). What the person selects goes over the file's conversation's composer (`onSelection`: the words, at most 200
 * characters, and their block); "Ask Atlas" floats over a selection; a message's line about the document lights
 * up the words or the block it names (`reveal`).
 */

/** Pictures a document takes (what the server stores as the file's pictures). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The most words a quote carries (`liveRef.selection.text`). */
const QUOTE_CHARS = 200;
/** How long a part a message pointed at stays lit. */
const REVEAL_MS = 2400;

const keep = (e: { preventDefault(): void }) => e.preventDefault();
const noop = () => {};
/** The caret to the text's start (Enter in the title). */
const toStart: Command = (state, dispatch) => {
  dispatch?.(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView());
  return true;
};

/** A file's name without its extension ("Praia.png" → "Praia"), as a picture's description. */
const altOf = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 500) || null;

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/** The selection as the conversation's quote, or null for a caret alone (the whole file). */
export function selectionOf(
  state: EditorState,
  words: { text: string; image: string; table: string },
): LiveSelection | null {
  const sel = state.selection;
  const $from = state.doc.resolve(sel.from);
  const top = $from.depth >= 1 ? $from.node(1) : sel instanceof NodeSelection ? sel.node : state.doc.firstChild;
  const id = typeof top?.attrs.id === "string" ? top.attrs.id : undefined;
  const block = id ? { block: id } : {};
  if (sel instanceof NodeSelection) {
    if (sel.node.type === N.image) return { label: words.image, ...block };
    if (sel.node.type === N.table) return { label: words.table, ...block };
    return null;
  }
  if (sel.empty) return null;
  const text = state.doc.textBetween(sel.from, sel.to, " ", " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const quote = text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text;
  return { label: words.text, text: quote, ...block };
}

const selectionKeyOf = (s: LiveSelection | null) => (s ? `${s.label}|${s.block ?? ""}|${s.text ?? ""}` : "");

/** What the editor's state is made with (the plugins' inputs). */
export interface DocStateOptions {
  undo: Command;
  redo: Command;
  readOnly: boolean;
  /** The element an agent's caret is drawn in. */
  agentCaret: (clientId: number) => HTMLElement;
  /** ⌘K. */
  openLink: () => void;
  look: (user: PeerUser) => DocCaretLook | null;
  /** The empty document's hint. */
  hint: () => string | undefined;
}

/**
 * The editor's state over a document's body: synced with the document, others' carets, the file's undo, the keys and
 * typed shortcuts, block ids, numbered items, the hint, the light on a part shown.
 */
export function docState(
  fragment: Y.XmlFragment,
  room: Pick<LiveEditorProps["room"], "awareness" | "undo">,
  options: DocStateOptions,
): EditorState {
  return EditorState.create({
    schema: docSchema,
    plugins: [
      ySyncPlugin(fragment),
      docPresence({
        awareness: room.awareness,
        look: options.look,
        agentCaret: options.agentCaret,
        broadcast: !options.readOnly,
      }),
      richUndo(room.undo),
      ...docKeymap({ undo: options.undo, redo: options.redo, onLink: options.openLink }),
      docInputRules(),
      blockIds(),
      listNumbering(),
      emptyHint(options.hint),
      revealLight(),
    ],
  });
}

/** Each open document's view by its editable element (see `docViewOf`). */
const views = new WeakMap<Element, EditorView>();

/**
 * The editor of a document from its element (the `.lf-doc__body`, or anything inside it): for tests that type as
 * ProseMirror does, and anything that only has the page to go by. Null when no document is open there.
 */
export function docViewOf(el: Element | null): EditorView | null {
  const body = el?.closest(".lf-doc__body");
  return body ? (views.get(body) ?? null) : null;
}

/** An agent with a caret in the document now (its presence id, who, whether it writes). */
interface AgentCaret {
  clientId: number;
  user: PeerUser;
  working: boolean;
}

export function DocumentEditor(props: LiveEditorProps) {
  const { room, orgId, artifact, readOnly, following, onStopFollowing, onAsk, reveal } = props;
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const looks = usePeerLooks();
  const fileAgent = useFileAgentHere();
  const fragment = useMemo(() => room.doc.getXmlFragment(DOC_BODY), [room]);
  const host = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<DocFormat>(NO_DOC_FORMAT);
  const [header, setHeader] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [linkOpen, setLinkOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [agents, setAgents] = useState<AgentCaret[]>([]);
  const agentHosts = useRef(new Map<number, HTMLElement>());
  const fileId = artifact.id;
  const canAsk = Boolean(onAsk && fileAgent);

  /** The element an agent's caret is drawn in (kept per agent, so redraws reuse it). */
  const agentCaret = useCallback((clientId: number) => {
    let el = agentHosts.current.get(clientId);
    if (!el) {
      el = document.createElement("span");
      el.className = "lf-doc-caret lf-doc-caret--agent";
      el.dataset.client = String(clientId);
      el.contentEditable = "false";
      agentHosts.current.set(clientId, el);
    }
    return el;
  }, []);

  // What changes between renders is read through here, so the editor isn't made again for a new callback.
  const latest = useRef({
    t,
    looks,
    readOnly,
    onSelection: props.onSelection,
    canAsk,
    selectionKey: "",
    openLink: () => setLinkOpen(true),
  });
  useLayoutEffect(() => {
    latest.current.t = t;
    latest.current.looks = looks;
    latest.current.readOnly = readOnly;
    latest.current.onSelection = props.onSelection;
    latest.current.canAsk = canAsk;
  });

  /** After every change: the toolbar's state, the selection for the conversation, "Ask Atlas" over it. */
  const tell = useCallback((view: EditorView) => {
    const state = view.state;
    const next = docFormat(state);
    setFormat((was) => (sameDocFormat(was, next) ? was : next));
    setHeader(next.table && tableHasHeader(state));
    const words = latest.current.t;
    const selection = selectionOf(state, {
      text: words("live.doc.selection.text"),
      image: words("live.doc.selection.image"),
      table: words("live.doc.selection.table"),
    });
    const key = selectionKeyOf(selection);
    if (key !== latest.current.selectionKey) {
      latest.current.selectionKey = key;
      latest.current.onSelection(selection);
    }
    let at: { x: number; y: number } | null = null;
    if (latest.current.canAsk && next.ranged && view.hasFocus() && page.current) {
      try {
        const box = page.current.getBoundingClientRect();
        const start = view.coordsAtPos(state.selection.from);
        at = { x: Math.max(0, start.left - box.left), y: Math.max(0, start.top - box.top) };
      } catch {
        // No layout (a page being drawn): at the page's corner.
        at = { x: 0, y: 0 };
      }
    }
    setBubble((was) => (was && at && was.x === at.x && was.y === at.y ? was : at));
  }, []);

  const assetUrl = useCallback((asset: string) => api.live.assetUrl(orgId, fileId, asset), [api, orgId, fileId]);

  /** Runs a command on the text and gives the caret back to it. */
  const run = useCallback((command: Command) => {
    const view = viewRef.current;
    if (!view) return false;
    const done = command(view.state, view.dispatch, view);
    view.focus();
    return done;
  }, []);

  // ── Pictures ───────────────────────────────────────────────────────────────────────────────────────────────────

  const upload = useCallback(
    async (files: File[]) => {
      if (readOnly) return;
      const pictures = files.filter((f) => IMAGE_TYPES.has(f.type));
      if (!pictures.length) {
        toast.show(t("live.doc.image.onlyImages"), "error");
        return;
      }
      const fitting = pictures.filter((f) => f.size <= MAX_IMAGE_BYTES);
      if (fitting.length < pictures.length) toast.show(t("live.doc.image.tooBig"), "error");
      setUploading((n) => n + fitting.length);
      for (const file of fitting) {
        try {
          const asset = await api.live.uploadAsset(orgId, fileId, file);
          run(insertDocImage(asset.id, altOf(file.name)));
        } catch (error) {
          toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
        } finally {
          setUploading((n) => n - 1);
        }
      }
    },
    [readOnly, api, orgId, fileId, run, toast, t, i18n.language],
  );
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const fromDrive = async (picked: Artifact) => {
    setDriveOpen(false);
    setUploading((n) => n + 1);
    try {
      const asset = await api.live.copyAsset(orgId, fileId, { artifactId: picked.id });
      run(insertDocImage(asset.id, altOf(picked.title)));
    } catch (error) {
      toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
    } finally {
      setUploading((n) => n - 1);
    }
  };

  // ── The editor ─────────────────────────────────────────────────────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once per document and mode; the rest is read live
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const undoManager = room.undo;
    // What the person types reaches the document as y-prosemirror's own transactions (origin `ySyncPluginKey`): the
    // file's undo takes them back with everything else they did, and never what came from others (ADR 0196 §6).
    if (!undoManager.trackedOrigins.has(ySyncPluginKey)) undoManager.trackedOrigins.add(ySyncPluginKey);
    const undo = undoWith(undoManager);
    const redo = redoWith(undoManager);
    const missing = t("live.doc.image.missing");
    const view: EditorView = new EditorView(el, {
      state: docState(fragment, room, {
        undo,
        redo,
        readOnly,
        agentCaret,
        openLink: () => latest.current.openLink(),
        look: (user) => {
          const look = latest.current.looks(user);
          return { name: look.name, color: look.color, onColor: look.onColor };
        },
        hint: () => latest.current.t("live.doc.placeholder"),
      }),
      editable: () => !latest.current.readOnly,
      nodeViews: { image: (node) => new ImageView(node, assetUrl, missing) },
      clipboardTextParser: (text, $context, plain) => pastedText(text, $context, plain),
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length || latest.current.readOnly) return false;
        void uploadRef.current(files);
        return true;
      },
      handleDrop: (v, event, _slice, moved) => {
        const files = moved ? [] : imageFiles(event.dataTransfer);
        if (!files.length || latest.current.readOnly) return false;
        event.preventDefault();
        // The pictures go where they were dropped.
        const at = v.posAtCoords({ left: event.clientX, top: event.clientY });
        if (at) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(at.pos))));
        void uploadRef.current(files);
        return true;
      },
      attributes: () => ({
        class: "md lf-doc__body",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": latest.current.t("live.doc.body"),
        ...(latest.current.readOnly ? { "aria-readonly": "true" } : {}),
      }),
      // `this` is the view: a plugin may dispatch while the view is still being made.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        tell(this);
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
        focus(v) {
          if (!latest.current.readOnly) room.setLocal({ mode: "editing" });
          tell(v);
          return false;
        },
        blur(v) {
          room.setLocal({ mode: "viewing" });
          // After the blur settles (a press on "Ask Atlas" keeps the focus here).
          requestAnimationFrame(() => tell(v));
          return false;
        },
      },
    });
    viewRef.current = view;
    views.set(view.dom, view);
    tell(view);
    return () => {
      views.delete(view.dom);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
      if (!room.destroyed) room.setLocal({ mode: "viewing" });
    };
  }, [fragment, room, readOnly]);

  // Undo and redo follow the file's history (this person's own steps).
  useEffect(() => {
    const undo = room.undo;
    const sync = () => setHistory({ undo: undo.canUndo(), redo: undo.canRedo() });
    sync();
    undo.on("stack-item-added", sync);
    undo.on("stack-item-popped", sync);
    undo.on("stack-cleared", sync);
    return () => {
      undo.off("stack-item-added", sync);
      undo.off("stack-item-popped", sync);
      undo.off("stack-cleared", sync);
    };
  }, [room]);

  // The agents with a caret here: their faces go in the carets the editor draws.
  useEffect(() => {
    const awareness = room.awareness;
    const read = () => {
      const next: AgentCaret[] = [];
      awareness.getStates().forEach((raw, clientId) => {
        if (clientId === awareness.clientID) return;
        const peer = readPeerState(raw);
        if (peer?.user.kind !== "agent") return;
        if (!peer.cursorPm && !peer.sel?.document?.length) return;
        next.push({ clientId, user: peer.user, working: peer.mode === "editing" });
        // Its caret's element exists before the editor draws it, so its face is in it from the first frame.
        agentCaret(clientId);
      });
      for (const id of [...agentHosts.current.keys()]) {
        if (!next.some((a) => a.clientId === id)) agentHosts.current.delete(id);
      }
      setAgents((was) =>
        was.length === next.length &&
        was.every((a, i) => {
          const b = next[i];
          return b && a.clientId === b.clientId && a.user.id === b.user.id && a.working === b.working;
        })
          ? was
          : next,
      );
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [room, agentCaret]);

  // Following someone: their caret stays in view; scrolling by hand stops following.
  const followed = following?.clientId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caret moves with every change of their presence
  useEffect(() => {
    if (followed === undefined) return;
    const caret = host.current?.querySelector(`[data-client="${followed}"]`);
    caret?.scrollIntoView?.({ block: "nearest" });
  }, [followed, following?.state]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || followed === undefined) return;
    const stop = () => onStopFollowing();
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, [followed, onStopFollowing]);

  // A message's line about this document: its words (else its block) selected, brought into view, lit a moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per click (its key)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const part = reveal.selection;
    const state = view.state;
    const block = part.block ? findBlock(state, part.block) : null;
    let range: { from: number; to: number; block: boolean } | null = null;
    if (part.text) {
      // In its block, else anywhere (the block may have been split since); a quote cut at 200 characters ends in "…".
      const words = part.text.replace(/…$/, "");
      let hit = block ? findText(block.node, block.pos, words) : null;
      for (let i = 0, pos = 0; !hit && i < state.doc.childCount; i++) {
        const node = state.doc.child(i);
        hit = findText(node, pos, words);
        pos += node.nodeSize;
      }
      if (hit) range = { ...hit, block: false };
    }
    if (!range && block) range = { from: block.pos, to: block.pos + block.node.nodeSize, block: true };
    if (!range) return;
    const tr = state.tr.setMeta(revealKey, range);
    if (!range.block) tr.setSelection(TextSelection.create(state.doc, range.from, range.to));
    else if (block && !block.node.isTextblock) tr.setSelection(NodeSelection.create(state.doc, block.pos));
    else tr.setSelection(TextSelection.create(state.doc, range.from + 1, range.to - 1));
    view.dispatch(tr.scrollIntoView());
    try {
      const dom = range.block ? view.nodeDOM(range.from) : view.domAtPos(range.from).node;
      const el = dom instanceof HTMLElement ? dom : (dom?.parentElement ?? null);
      el?.scrollIntoView?.({ block: "center" });
    } catch {
      // No layout: ProseMirror's own scroll did what it could.
    }
    const id = setTimeout(() => {
      if (viewRef.current === view) view.dispatch(view.state.tr.setMeta(revealKey, null));
    }, REVEAL_MS);
    return () => clearTimeout(id);
  }, [reveal?.key]);

  // ── The toolbar's actions ──────────────────────────────────────────────────────────────────────────────────────

  const focusText = () => viewRef.current?.focus();
  const table = (action: TableAction) => {
    const commands: Record<TableAction, Command> = {
      rowAbove: addDocRow(-1),
      rowBelow: addDocRow(1),
      columnLeft: addDocColumn(-1),
      columnRight: addDocColumn(1),
      deleteRow: deleteDocRow,
      deleteColumn: deleteDocColumn,
      header: toggleDocHeaderRow,
      deleteTable: deleteDocTable,
    };
    run(commands[action]);
  };

  return (
    <div className="lf-doc" data-readonly={readOnly || undefined}>
      {!readOnly && (
        <DocToolbar
          format={format}
          canUndo={history.undo}
          canRedo={history.redo}
          uploading={uploading}
          header={header}
          onUndo={() => {
            room.undo.undo();
            focusText();
          }}
          onRedo={() => {
            room.undo.redo();
            focusText();
          }}
          onStyle={(style: DocStyle) => run(setDocStyle(style))}
          onMark={(mark) => run(toggleDocMark(mark))}
          onList={(kind) => run(toggleDocList(kind))}
          onLink={(href) => run(setDocLink(href))}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          onUpload={() => fileInput.current?.click()}
          onDrive={() => setDriveOpen(true)}
          onImageWidth={(width) => run(setImageWidth(width))}
          onRemoveImage={() => run(deleteSelection)}
          onInsertTable={() => run(insertDocTable())}
          onTable={table}
          onDone={focusText}
        />
      )}
      <div ref={scroller} className="lf-doc__scroll">
        <article ref={page} className="wiki-doc__main lf-doc__page">
          <DocTitle
            key={artifact.id}
            orgId={orgId}
            fileId={artifact.id}
            value={artifact.title}
            canRename={!readOnly}
            onEnter={() => run(toStart)}
          />
          <LiveMeta artifact={artifact} onVersions={props.onVersions ?? noop} />
          <div className="wiki-page__body wiki-prose lf-doc__prose">
            <div ref={host} className="lf-doc__host" />
          </div>
          {bubble && fileAgent && onAsk && (
            <div className="lf-doc__ask ac-glass" style={{ left: bubble.x, top: bubble.y } as CSSProperties}>
              <Button size="sm" variant="ghost" className="lf-doc__ask-btn" onMouseDown={keep} onClick={() => onAsk()}>
                <AgentAvatar agentId={fileAgent.id} name={fileAgent.name} size="xs" />
                <span className="ac-btn__label">{t("live.conversation.ask", agentGrammar(fileAgent.name))}</span>
              </Button>
            </div>
          )}
        </article>
      </div>
      {agents.map((agent) => {
        const el = agentCaret(agent.clientId);
        return createPortal(<AgentCaretTag agent={agent} host={el} />, el, String(agent.clientId));
      })}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      <DrivePicker
        orgId={orgId}
        open={driveOpen}
        onClose={() => setDriveOpen(false)}
        onPick={(a) => void fromDrive(a)}
      />
    </div>
  );
}

/** An agent's caret: its color on the bar, its face (writing while it works) and name on the tag. */
function AgentCaretTag({ agent, host }: { agent: AgentCaret; host: HTMLElement }) {
  const looks = usePeerLooks();
  const look = looks(agent.user);
  useLayoutEffect(() => {
    host.style.setProperty("--peer", look.color);
    host.style.setProperty("--peer-on", look.onColor);
  }, [host, look.color, look.onColor]);
  return (
    <span className="lf-cur__who lf-doc-caret__who">
      <PeerFace user={agent.user} name={look.name} size="xs" working={agent.working} />
      <b>{look.name}</b>
    </span>
  );
}
