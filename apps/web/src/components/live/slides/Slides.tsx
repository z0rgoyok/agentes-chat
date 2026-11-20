import { type Artifact, type LiveAsset, useApi, useLivePeers } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { LOCAL, type Point } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import type { RichAlign, RichList } from "@agenteschat/live/rich";
import {
  type ElementPatch,
  type ElementView,
  elementTextFragment,
  type NewElement,
  type ShapeKind,
  type SlideChart,
  type SlideLayout,
  type SlideTable,
  type SlideView,
  type ThemeId,
  textLook,
  themeOf,
} from "@agenteschat/live/slides";
import { Button, EmptyState, useMatchMedia } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { type MenuEntry, openContextMenu, tidy } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import type { LiveEditorProps } from "../editor";
import { PeerFace, type PeerLook, peerWorking, usePeerLooks } from "../peers";
import {
  colorWholeText,
  markWholeText,
  NO_FORMAT,
  type RichFormat,
  type RichMarkKey,
  type RichTextHandle,
  setRichAlign,
  setRichColor,
  setRichLink,
  setWholeParagraphs,
  shiftRichLevel,
  shiftWholeLevels,
  toggleRichList,
  toggleRichMark,
  wholeFormat,
} from "../rich";
import {
  type AlignHow,
  alignPatches,
  bindUndo,
  changeLayout,
  changeTheme,
  copyElements,
  copySlide,
  type EditRefusal,
  edit,
  hideSlide,
  imageBox,
  insertElement,
  isRefusal,
  newSlide,
  patchElements,
  placeSlide,
  removeElements,
  removeSlides,
  restack,
} from "./actions";
import { ChartDialog } from "./ChartDialog";
import { CLIP_TYPE, clipOf, readClip, type SlidesClip, shifted } from "./clipboard";
import { DrivePicker } from "./DrivePicker";
import { useDeck } from "./deck";
import { Notes } from "./Notes";
import { Present } from "./Present";
import { Rail } from "./Rail";
import { SlideImages } from "./render";
import { type EditTarget, NUDGE, Stage } from "./Stage";
import { type ShapeTools, SlideToolbar, type TableOp, type TextTools } from "./Toolbar";
import "./slides.css";

/**
 * The presentation editor of a live file (ADR 0196 §2, §5, §6), the page's editor for `slides`: the toolbar, the rail
 * of slides on the left, the current slide on its stage and its speaker notes under it, presenting, and everyone in
 * the file (their faces on the slides they are on, what they chose, their pointers and carets, "Ada está apresentando
 * · Seguir"). Every change is an edit of `@agenteschat/live` with the `LOCAL` origin, so the person's undo takes back
 * their own changes and never an agent's or another person's. Pictures are the file's own (uploaded, or copied from
 * the Drive) and drawn from their addresses.
 */

/** Pictures a presentation takes, and how large (the server's limit). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** A paste or a duplicate lands this far from what it copied (slide units). */
const COPY_STEP = 24;

/** After this layout, a new slide takes the next one people usually want. */
function nextLayout(current: SlideLayout | undefined): SlideLayout {
  if (!current || current === "title" || current === "section" || current === "blank") return "title-body";
  return current;
}

/** The empty text an element starts with: no text yet, or only empty paragraphs. */
function isEmptyText(el: ElementView | undefined): boolean {
  return !el?.text?.some((p) => p.runs.some((r) => r.text.trim()));
}

/** A picture's size as the browser reads it (for one copied in without its size known). */
function naturalSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (typeof URL.createObjectURL !== "function") return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

export function Slides(props: LiveEditorProps) {
  const { room, orgId, readOnly, locale, search, onSearch, following, onStopFollowing, onSelection } = props;
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const deck = useDeck(room);
  const peers = useLivePeers(room);
  const looks = usePeerLooks();
  const theme = themeOf(deck.theme);
  const compact = useMatchMedia("(max-width: 760px)");
  const root = useRef<HTMLDivElement>(null);
  const rich = useRef<RichTextHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = room.fileId;
  // Each command here is a step of the file's undo of its own.
  bindUndo(room.doc, room.undo);

  // ── The current slide ──────────────────────────────────────────────────────────────────────────────────────────

  const ids = deck.slides.map((s) => s.id);
  const [picked, setPicked] = useState<string | null>(() => search.slide ?? null);
  const lastIndex = useRef(0);
  let currentId: string | null = picked && ids.includes(picked) ? picked : null;
  // The slide shown was deleted (by anyone): the one now in its place.
  if (!currentId && ids.length) currentId = ids[Math.min(lastIndex.current, ids.length - 1)] ?? null;
  const currentIndex = currentId ? ids.indexOf(currentId) : -1;
  const slide: SlideView | null = currentIndex >= 0 ? (deck.slides[currentIndex] ?? null) : null;
  useLayoutEffect(() => {
    if (currentIndex >= 0) lastIndex.current = currentIndex;
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [tableEdit, setTableEdit] = useState<string | null>(null);
  const [caret, setCaret] = useState<RichFormat>(NO_FORMAT);
  const [linkOpen, setLinkOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);
  const [chartDialog, setChartDialog] = useState<{ el: ElementView | null } | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [watchId, setWatchId] = useState<number | null>(null);
  /** Text boxes just made with "Texto": left empty, they go when their text closes. */
  const fresh = useRef(new Set<string>());
  /** Where the next picture goes: in place of a picture (replace) or into an empty picture slot. */
  const pictureFor = useRef<string | null>(null);
  /** This tab's copy, for a paste the browser's clipboard can't give back (the context menu). */
  const memoryClip = useRef<SlidesClip | null>(null);
  const pasteCount = useRef(0);

  // The page's address says which slide (a link, back and forward).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new address moves the slide
  useEffect(() => {
    if (search.slide && search.slide !== picked) setPicked(search.slide);
  }, [search.slide]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address follows the slide shown
  useEffect(() => {
    if (currentId && currentId !== search.slide) onSearch({ slide: currentId });
  }, [currentId]);
  // A message's line about a slide (ADR 0199): that slide, shown (the address follows).
  const revealSlide = props.reveal?.selection.slide;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per click (its key)
  useEffect(() => {
    if (revealSlide && ids.includes(revealSlide)) setPicked(revealSlide);
  }, [props.reveal?.key]);

  const byId = useMemo(() => new Map((slide?.elements ?? []).map((el) => [el.id, el])), [slide]);
  const chosen = selected.map((id) => byId.get(id)).filter((el): el is ElementView => !!el);

  // What was chosen and is gone (deleted, undone, another slide): out of the choice.
  useEffect(() => {
    const kept = selected.filter((id) => byId.has(id));
    if (kept.length !== selected.length) setSelected(kept);
    if (editing && !byId.has(editing.id)) setEditing(null);
    if (tableEdit && !byId.has(tableEdit)) setTableEdit(null);
  }, [byId, selected, editing, tableEdit]);

  // A text closed: back to the toolbar's whole-box look; an empty new box goes.
  const wasEditing = useRef<string | null>(null);
  useEffect(() => {
    const before = wasEditing.current;
    wasEditing.current = editing?.id ?? null;
    if (!editing) {
      setCaret(NO_FORMAT);
      setLinkOpen(false);
    }
    if (before && before !== editing?.id && fresh.current.has(before)) {
      fresh.current.delete(before);
      const el = byId.get(before);
      if (el && slide && isEmptyText(el)) {
        removeElements(room.doc, slide.id, [before]);
        setSelected((s) => s.filter((id) => id !== before));
      }
    }
  }, [editing, byId, slide, room]);

  const refuse = useCallback(
    (code: EditRefusal | null) => {
      if (!code) return false;
      const words: Record<EditRefusal, string> = {
        too_many: t("live.slides.errors.tooMany"),
        too_large: t("live.slides.errors.tooLarge"),
        not_found: t("live.slides.errors.notFound"),
        invalid: t("live.slides.errors.invalid"),
        unknown: t("live.slides.errors.invalid"),
      };
      toast.show(words[code], "error");
      return true;
    },
    [t, toast],
  );
  /** A result that is an id, or a refusal said once. */
  const made = useCallback(
    (result: string | EditRefusal): string | null => {
      if (isRefusal(result)) {
        refuse(result);
        return null;
      }
      return result;
    },
    [refuse],
  );

  const stageEl = () => root.current?.querySelector<HTMLElement>(".sl-stage") ?? null;
  const focusStage = () => requestAnimationFrame(() => stageEl()?.focus({ preventScroll: true }));

  const go = useCallback(
    (id: string, opts: { user?: boolean } = {}) => {
      setPicked(id);
      setSelected([]);
      setEditing(null);
      setTableEdit(null);
      if (opts.user && following) onStopFollowing();
    },
    [following, onStopFollowing],
  );

  // ── Presence ───────────────────────────────────────────────────────────────────────────────────────────────────

  const presenting = Boolean(search.present);
  const selectedKey = selected.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the choice by its ids
  useEffect(() => {
    room.setLocal({
      mode: !readOnly && (selected.length > 0 || editing || tableEdit) ? "editing" : "viewing",
      at: currentId ? { slide: currentId } : undefined,
      sel: selected.length ? { slide: selected.slice(0, 200) } : undefined,
    });
  }, [room, readOnly, selectedKey, editing, tableEdit, currentId]);
  useEffect(
    () => () => {
      if (!room.destroyed) {
        room.setLocal({ at: undefined, sel: undefined, presenting: undefined, cursor: undefined, mode: "viewing" });
      }
    },
    [room],
  );

  // The selection for "Ask an agent" and the header: "Slide 3".
  useEffect(() => {
    onSelection(
      currentId && currentIndex >= 0
        ? { label: t("live.slides.selection.slide", { n: currentIndex + 1 }), slide: currentId }
        : null,
    );
  }, [onSelection, currentId, currentIndex, t]);

  /** Who else is on each slide (the rail's faces). */
  const peersBySlide = useMemo(() => {
    const map = new Map<string, Peer[]>();
    for (const p of peers) {
      if (p.self) continue;
      const at = p.state.presenting?.slide ?? p.state.at?.slide;
      if (at) map.set(at, [...(map.get(at) ?? []), p]);
    }
    return map;
  }, [peers]);

  // ── Following ──────────────────────────────────────────────────────────────────────────────────────────────────

  const followed = following ? (peers.find((p) => p.clientId === following.clientId && !p.self) ?? null) : null;
  const followSlide = followed?.state.presenting?.slide ?? followed?.state.at?.slide;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the followed peer's slide moves this one
  useEffect(() => {
    if (followSlide && followSlide !== currentId && ids.includes(followSlide)) go(followSlide);
  }, [followSlide]);

  /** Someone else presenting (the first one), to follow from the bar over the editor. */
  const presenter = peers.find((p) => !p.self && p.state.presenting) ?? null;
  const watching =
    (followed?.state.presenting ? followed : null) ??
    (watchId !== null ? (peers.find((p) => p.clientId === watchId && p.state.presenting) ?? null) : null);
  useEffect(() => {
    if (watchId !== null && !peers.some((p) => p.clientId === watchId && p.state.presenting)) setWatchId(null);
  }, [peers, watchId]);

  /** Fills the screen from inside a press (the browser allows it only there): the page, as when presenting. */
  const fillScreen = () => {
    const page = root.current?.closest<HTMLElement>(".lf-page") ?? document.documentElement;
    try {
      if (!document.fullscreenElement) page.requestFullscreen?.().catch(() => {});
    } catch {
      // Refused (a frame, an old browser): the presentation fills the window instead.
    }
  };
  const leaveScreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    } catch {
      // Already left.
    }
  };

  const presentFrom = (id: string) => {
    fillScreen();
    go(id, { user: true });
    onSearch({ present: true, slide: id });
  };
  const watch = (peer: Peer) => {
    fillScreen();
    setWatchId(peer.clientId);
  };
  const stopWatching = () => {
    if (followed?.state.presenting) onStopFollowing();
    setWatchId(null);
    leaveScreen();
  };

  // While this person presents, their slide is in their presence, with when they started.
  const ownPresenting = presenting && !watching;
  const presentSince = useRef<number | null>(null);
  useEffect(() => {
    if (!ownPresenting || !currentId) return;
    presentSince.current ??= Date.now();
    room.setLocal({ presenting: { slide: currentId, since: presentSince.current } });
  }, [room, ownPresenting, currentId]);
  useEffect(() => {
    if (ownPresenting) return;
    presentSince.current = null;
    if (!room.destroyed) room.setLocal({ presenting: undefined });
  }, [room, ownPresenting]);

  // ── Undo ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const [history, setHistory] = useState({ undo: false, redo: false });
  useEffect(() => {
    const update = () => setHistory({ undo: room.undo.canUndo(), redo: room.undo.canRedo() });
    update();
    room.undo.on("stack-item-added", update);
    room.undo.on("stack-item-popped", update);
    room.undo.on("stack-cleared", update);
    return () => {
      room.undo.off("stack-item-added", update);
      room.undo.off("stack-item-popped", update);
      room.undo.off("stack-cleared", update);
    };
  }, [room]);
  const undo = useCallback(() => {
    setEditing(null);
    room.undo.undo();
  }, [room]);
  const redo = useCallback(() => {
    setEditing(null);
    room.undo.redo();
  }, [room]);

  // The desktop app's Edit menu sends undo and redo as input events (a text or the notes take their own).
  useEffect(() => {
    const el = root.current;
    if (!el || readOnly) return;
    const onInput = (e: Event) => {
      const input = e as InputEvent;
      if (input.inputType !== "historyUndo" && input.inputType !== "historyRedo") return;
      if (e.target instanceof Element && e.target.closest(".rt-editor, textarea, input")) return;
      e.preventDefault();
      if (input.inputType === "historyUndo") undo();
      else redo();
    };
    el.addEventListener("beforeinput", onInput);
    return () => el.removeEventListener("beforeinput", onInput);
  }, [readOnly, undo, redo]);

  // ── Slides ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const addSlideAfter = (afterId: string | null, layout?: SlideLayout) => {
    const index = afterId ? ids.indexOf(afterId) + 1 : ids.length;
    const after = afterId ? deck.slides.find((s) => s.id === afterId) : undefined;
    const id = made(newSlide(room.doc, layout ?? nextLayout(after?.layout), index));
    if (id) {
      go(id, { user: true });
      focusStage();
    }
  };
  const duplicateSlideOf = (id: string) => {
    const copy = made(copySlide(room.doc, id));
    if (copy) go(copy, { user: true });
  };
  const deleteSlide = (id: string) => {
    if (refuse(removeSlides(room.doc, [id]))) return;
    toast.show(t("live.slides.rail.deleted"), "info");
  };

  // ── Elements ───────────────────────────────────────────────────────────────────────────────────────────────────

  const addElement = (el: NewElement, opts: { edit?: boolean; table?: boolean } = {}): string | null => {
    if (!slide) return null;
    const id = made(insertElement(room.doc, slide.id, el));
    if (!id) return null;
    setSelected([id]);
    if (opts.edit) {
      fresh.current.add(id);
      setEditing({ id, at: "end" });
    } else if (opts.table) setTableEdit(id);
    else focusStage();
    return id;
  };

  const deleteChosen = () => {
    if (!slide || !selected.length) return;
    setEditing(null);
    setTableEdit(null);
    if (!refuse(removeElements(room.doc, slide.id, selected))) setSelected([]);
    focusStage();
  };

  const duplicateChosen = () => {
    if (!slide || !chosen.length) return;
    const result = copyElements(room.doc, slide.id, chosen, COPY_STEP);
    if (Array.isArray(result)) setSelected(result);
    else refuse(result);
  };

  const patchChosen = (patch: (el: ElementView) => ElementPatch | null) => {
    if (!slide) return;
    const patches = chosen.flatMap((el) => {
      const p = patch(el);
      return p ? [{ id: el.id, patch: p }] : [];
    });
    if (patches.length) refuse(patchElements(room.doc, slide.id, patches));
  };

  const nudge = (dx: number, dy: number) =>
    patchChosen((el) => ({ x: Math.round((el.x + dx) * 10) / 10, y: Math.round((el.y + dy) * 10) / 10 }));

  // ── Text ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const editingEl = editing ? byId.get(editing.id) : undefined;
  const texts = editingEl ? [editingEl] : chosen.filter((el) => el.type === "text" || el.type === "shape");
  const textTools: TextTools | null =
    texts.length && texts.length === (editingEl ? 1 : chosen.length) && !tableEdit
      ? {
          format: editingEl ? caret : wholeFormat(texts[0]?.text ?? []),
          size: textLook(theme, texts[0] as ElementView).size,
          editing: !!editingEl,
        }
      : null;

  /** Runs a text command: on the words in the open text, else on every chosen box whole. */
  const onText = (inText: () => void, whole: (fragments: { el: ElementView; fragment: Y.XmlFragment }[]) => void) => {
    if (editingEl && rich.current) {
      // A command on the words is a step of its own, apart from the typing around it.
      room.undo.stopCapturing();
      inText();
      room.undo.stopCapturing();
      return;
    }
    if (!slide) return;
    const fragments = texts.flatMap((el) => {
      const fragment = elementTextFragment(room.doc, slide.id, el.id);
      return fragment ? [{ el, fragment }] : [];
    });
    if (!fragments.length) return;
    refuse(edit(room.doc, () => whole(fragments)));
  };

  const mark = (key: RichMarkKey) => {
    const on = !(textTools?.format[key] ?? false);
    onText(
      () => rich.current?.run(toggleRichMark(key)),
      (fs) => {
        for (const { fragment } of fs) markWholeText(fragment, key, on, LOCAL);
      },
    );
  };
  const color = (value: string | null) =>
    onText(
      () => rich.current?.run(setRichColor(value)),
      (fs) => {
        for (const { fragment } of fs) colorWholeText(fragment, value, LOCAL);
      },
    );
  const align = (value: RichAlign) =>
    onText(
      () => rich.current?.run(setRichAlign(value)),
      (fs) => {
        for (const { fragment } of fs) setWholeParagraphs(fragment, { align: value }, LOCAL);
      },
    );
  const list = (kind: RichList) => {
    const off = textTools?.format.list === kind;
    onText(
      () => rich.current?.run(toggleRichList(kind)),
      (fs) => {
        for (const { fragment } of fs) setWholeParagraphs(fragment, { list: off ? null : kind }, LOCAL);
      },
    );
  };
  const level = (delta: 1 | -1) =>
    onText(
      () => rich.current?.run(shiftRichLevel(delta)),
      (fs) => {
        for (const { fragment } of fs) shiftWholeLevels(fragment, delta, LOCAL);
      },
    );
  const size = (value: number) => {
    if (!slide) return;
    refuse(
      patchElements(
        room.doc,
        slide.id,
        texts.map((el) => ({ id: el.id, patch: { style: { size: value } } })),
      ),
    );
    if (editingEl) rich.current?.focus();
  };
  const link = (href: string | null) => {
    if (!rich.current) return;
    if (!rich.current.run(setRichLink(href)) && href) toast.show(t("live.slides.link.invalid"), "error");
  };

  // ── Shapes, lines, tables, charts ─────────────────────────────────────────────────────────────────────────────

  const allOf = (type: ElementView["type"]) => chosen.length > 0 && chosen.every((el) => el.type === type);
  const shapeTools: ShapeTools | null = allOf("shape")
    ? {
        line: false,
        fill: chosen[0]?.style?.fill && chosen[0].style.fill !== "none" ? chosen[0].style.fill : null,
        stroke: chosen[0]?.style?.stroke && chosen[0].style.stroke !== "none" ? chosen[0].style.stroke : null,
        arrow: false,
      }
    : allOf("line")
      ? {
          line: true,
          fill: null,
          stroke: chosen[0]?.style?.stroke ?? null,
          arrow: chosen[0]?.style?.lineEnd === "arrow",
        }
      : null;
  const tableEl = chosen.length === 1 && chosen[0]?.type === "table" ? chosen[0] : null;
  const chartEl = chosen.length === 1 && chosen[0]?.type === "chart" ? chosen[0] : null;

  const tableOp = (op: TableOp) => {
    const table = tableEl?.table;
    if (!tableEl || !table || !slide) return;
    const rows = table.rows.map((r) => [...r]);
    const cols = rows[0]?.length ?? 0;
    let next: SlideTable = { rows, header: table.header };
    if (op === "rowAbove" || op === "rowBelow")
      next.rows.splice(op === "rowAbove" ? 0 : rows.length, 0, Array(cols).fill(""));
    else if (op === "colLeft" || op === "colRight") {
      next.rows = rows.map((r) => (op === "colLeft" ? ["", ...r] : [...r, ""]));
    } else if (op === "deleteRow") {
      if (rows.length <= 1) return;
      next.rows = rows.slice(0, -1);
    } else if (op === "deleteCol") {
      if (cols <= 1) return;
      next.rows = rows.map((r) => r.slice(0, -1));
    } else next = { rows, header: !table.header };
    // The box grows or shrinks with its rows, so its words keep their size.
    const per = tableEl.h / Math.max(1, rows.length);
    const h = Math.max(80, Math.round(per * next.rows.length));
    refuse(patchElements(room.doc, slide.id, [{ id: tableEl.id, patch: { table: next, h } }]));
  };

  const saveChart = (chart: SlideChart) => {
    const current = chartDialog?.el;
    setChartDialog(null);
    if (current && slide) refuse(patchElements(room.doc, slide.id, [{ id: current.id, patch: { chart } }]));
    else addElement({ type: "chart", chart });
  };

  const addShape = (kind: ShapeKind | "line") =>
    addElement(kind === "line" ? { type: "line" } : { type: "shape", style: { shape: kind } });

  // ── Pictures ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** A picture now the file's, onto the slide: into the slot or picture it was for, else as large as fits. */
  const placePicture = (asset: LiveAsset, name: string, at?: Point) => {
    if (!slide) return;
    const target = pictureFor.current ? byId.get(pictureFor.current) : undefined;
    pictureFor.current = null;
    if (target?.type === "image") {
      refuse(patchElements(room.doc, slide.id, [{ id: target.id, patch: { asset: asset.id } }]));
      setSelected([target.id]);
      return;
    }
    const box = imageBox(asset.width, asset.height, deck);
    if (at) {
      box.x = Math.round(Math.min(deck.w - box.w, Math.max(0, at.x - box.w / 2)));
      box.y = Math.round(Math.min(deck.h - box.h, Math.max(0, at.y - box.h / 2)));
    }
    addElement({
      type: "image",
      box,
      asset: asset.id,
      fit: "contain",
      alt: name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200),
    });
  };

  const upload = async (files: File[], at?: Point) => {
    if (readOnly) return;
    const pictures = files.filter((f) => IMAGE_TYPES.has(f.type));
    if (!pictures.length) {
      toast.show(t("live.slides.image.onlyImages"), "error");
      return;
    }
    const fitting = pictures.filter((f) => f.size <= MAX_IMAGE_BYTES);
    if (fitting.length < pictures.length) toast.show(t("live.slides.image.tooBig"), "error");
    setUploading((n) => n + fitting.length);
    for (const file of fitting) {
      try {
        const asset = await api.live.uploadAsset(orgId, fileId, file);
        const size = asset.width && asset.height ? null : await naturalSize(file);
        placePicture(
          size ? { ...asset, width: asset.width ?? size.w, height: asset.height ?? size.h } : asset,
          file.name,
          at,
        );
      } catch (error) {
        toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const fromDrive = async (artifact: Artifact) => {
    setDriveOpen(false);
    setUploading((n) => n + 1);
    try {
      const asset = await api.live.copyAsset(orgId, fileId, { artifactId: artifact.id });
      placePicture(asset, artifact.title);
    } catch (error) {
      toast.show(errorText(t, error, i18n.language, { maxMb: 25 }), "error");
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const pickPicture = (forId: string | null = null) => {
    pictureFor.current = forId;
    fileInput.current?.click();
  };

  // ── Clipboard ──────────────────────────────────────────────────────────────────────────────────────────────────

  const copyChosen = (data?: DataTransfer | null) => {
    if (!chosen.length) return false;
    const clip = clipOf(fileId, chosen);
    memoryClip.current = readClip(clip.json);
    pasteCount.current = 0;
    if (data) {
      data.setData(CLIP_TYPE, clip.json);
      if (clip.text) data.setData("text/plain", clip.text);
    } else if (clip.text) {
      void navigator.clipboard?.writeText?.(clip.text).catch(() => {});
    }
    return true;
  };

  const pasteClip = async (clip: SlidesClip) => {
    if (!slide || readOnly) return;
    let elements = clip.elements;
    // Pictures of another file are copied into this one first (the server checks the person reads it).
    if (clip.fileId !== fileId) {
      const copies = new Map<string, string>();
      for (const el of elements) {
        if (!el.asset || copies.has(el.asset)) continue;
        try {
          const asset = await api.live.copyAsset(orgId, fileId, { fileId: clip.fileId, assetId: el.asset });
          copies.set(el.asset, asset.id);
        } catch {
          copies.set(el.asset, "");
        }
      }
      elements = elements.flatMap((el) => {
        if (!el.asset) return [el];
        const asset = copies.get(el.asset);
        return asset ? [{ ...el, asset }] : [];
      });
    }
    pasteCount.current += 1;
    const sameSlide =
      clip.fileId === fileId &&
      elements.some((el) => el.box && slide.elements.some((e) => e.x === el.box?.x && e.y === el.box?.y));
    const placed = shifted(elements, sameSlide ? COPY_STEP * pasteCount.current : 0);
    const madeIds: string[] = [];
    const refused = edit(room.doc, () => {
      for (const el of placed) {
        const id = insertElement(room.doc, slide.id, el);
        if (!isRefusal(id)) madeIds.push(id);
      }
    });
    if (!refuse(refused) && madeIds.length) setSelected(madeIds);
  };

  // In a text, a table's cell or a field, the clipboard is the words' (ProseMirror and the field handle it).
  const inWords = (target: EventTarget) => target instanceof Element && !!target.closest(".rt-editor, input, textarea");
  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (inWords(e.target)) return;
    if (copyChosen(e.clipboardData)) e.preventDefault();
  };
  const onCut = (e: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || inWords(e.target)) return;
    if (copyChosen(e.clipboardData)) {
      e.preventDefault();
      deleteChosen();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || !slide || inWords(e.target)) return;
    const data = e.clipboardData;
    const clip = readClip(data.getData(CLIP_TYPE));
    if (clip) {
      e.preventDefault();
      void pasteClip(clip);
      return;
    }
    const files = [...data.files].filter((f) => IMAGE_TYPES.has(f.type));
    if (files.length) {
      e.preventDefault();
      void upload(files);
      return;
    }
    const text = data.getData("text/plain").trim();
    if (text) {
      e.preventDefault();
      addElement({ type: "text", text: text.slice(0, 20_000) });
      return;
    }
    if (memoryClip.current) {
      e.preventDefault();
      void pasteClip(memoryClip.current);
    }
  };
  const pasteFromMenu = async () => {
    if (memoryClip.current) return void (await pasteClip(memoryClip.current));
    try {
      const text = (await navigator.clipboard?.readText?.())?.trim();
      if (text) addElement({ type: "text", text: text.slice(0, 20_000) });
    } catch {
      toast.show(t("live.slides.clipboard.blocked"), "info");
    }
  };

  // ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const onStageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const target = e.target as Element;
    if (target.closest(".rt-editor, input, textarea")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && (key === "z" || key === "y")) {
      e.preventDefault();
      if (readOnly) return;
      if (key === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const next = deck.slides[currentIndex + (e.key === "PageDown" ? 1 : -1)];
      if (next) go(next.id, { user: true });
      return;
    }
    if (e.key === "Escape") {
      if (tableEdit) setTableEdit(null);
      else if (selected.length) setSelected([]);
      else return;
      e.preventDefault();
      return;
    }
    if (readOnly) return;
    if (mod && key === "a") {
      e.preventDefault();
      setSelected(slide?.elements.map((el) => el.id) ?? []);
      return;
    }
    if (!chosen.length) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteChosen();
    } else if (e.key.startsWith("Arrow") && !mod) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE * 10 : NUDGE;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      nudge(dx, dy);
    } else if (mod && key === "d") {
      e.preventDefault();
      duplicateChosen();
    } else if (mod && (key === "b" || key === "i" || key === "u") && textTools) {
      e.preventDefault();
      mark(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
    } else if (e.key === "Enter" && chosen.length === 1) {
      const el = chosen[0];
      if (el?.type === "text" || el?.type === "shape") {
        e.preventDefault();
        setEditing({ id: el.id, at: "end" });
      } else if (el?.type === "table") {
        e.preventDefault();
        setTableEdit(el.id);
      }
    }
  };

  // ── Menus ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const onStageMenu = (e: MouseEvent<HTMLDivElement>, id: string | null) => {
    e.preventDefault();
    const el = id ? byId.get(id) : undefined;
    const entries: MenuEntry[] = [];
    const item = (
      key: string,
      label: string,
      run: () => void,
      extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {},
    ) => entries.push({ kind: "item", id: key, label, run, ...extra });
    if (el) {
      if (!readOnly) item("cut", t("live.slides.menu.cut"), () => copyChosen() && deleteChosen(), { icon: "copy" });
      item("copy", t("live.slides.menu.copy"), () => copyChosen(), { icon: "copy" });
      if (!readOnly) {
        item("paste", t("live.slides.menu.paste"), () => void pasteFromMenu(), { icon: "document" });
        item("duplicate", t("live.slides.menu.duplicate"), duplicateChosen, { icon: "copy" });
        entries.push({ kind: "separator" });
        if (el.type === "text" || el.type === "shape") {
          item("edit", t("live.slides.menu.editText"), () => setEditing({ id: el.id, at: "end" }), { icon: "edit" });
        }
        if (el.type === "table")
          item("cells", t("live.slides.menu.editTable"), () => setTableEdit(el.id), { icon: "table" });
        if (el.type === "chart")
          item("chart", t("live.slides.chart.editData"), () => setChartDialog({ el }), { icon: "chart" });
        if (el.type === "image") {
          item("replace", t("live.slides.image.replace"), () => pickPicture(el.id), { icon: "image" });
          if (el.asset) {
            item(
              "fit",
              el.fit === "cover" ? t("live.slides.image.contain") : t("live.slides.image.cover"),
              () => patchChosen(() => ({ fit: el.fit === "cover" ? "contain" : "cover" })),
              { icon: "expand" },
            );
          }
        }
        entries.push({ kind: "separator" });
        item(
          "front",
          t("live.slides.arrange.front"),
          () => slide && refuse(restack(room.doc, slide.id, selected, "front")),
          {
            icon: "bringFront",
          },
        );
        item(
          "back",
          t("live.slides.arrange.back"),
          () => slide && refuse(restack(room.doc, slide.id, selected, "back")),
          {
            icon: "sendBack",
          },
        );
        entries.push({ kind: "separator" });
        item("delete", t("live.slides.menu.delete"), deleteChosen, { icon: "trash", danger: true });
      }
    } else if (!readOnly) {
      item("paste", t("live.slides.menu.paste"), () => void pasteFromMenu(), { icon: "document" });
      item("selectAll", t("live.slides.menu.selectAll"), () => setSelected(slide?.elements.map((x) => x.id) ?? []));
      entries.push({ kind: "separator" });
      item("newSlide", t("live.slides.rail.newAfter"), () => addSlideAfter(currentId), { icon: "plus" });
    }
    if (entries.length) openContextMenu(e.clientX, e.clientY, tidy(entries), e.target);
  };

  const onDone = () => {
    if (editing) rich.current?.focus();
    else focusStage();
  };

  // ── Drawing ────────────────────────────────────────────────────────────────────────────────────────────────────

  const imageUrl = useCallback((id: string) => api.live.assetUrl(orgId, fileId, id), [api, orgId, fileId]);
  const presenterLook: PeerLook | null = presenter ? looks(presenter.user) : null;
  const watchingLook = watching ? looks(watching.user) : null;

  return (
    <SlideImages.Provider value={imageUrl}>
      <div ref={root} className="sl-editor" data-readonly={readOnly ? "true" : undefined}>
        {!readOnly && (
          <SlideToolbar
            theme={theme}
            layout={slide?.layout ?? null}
            canUndo={history.undo}
            canRedo={history.redo}
            selected={chosen.length}
            text={textTools}
            shape={shapeTools}
            table={tableEl?.table ? { header: tableEl.table.header } : null}
            chart={!!chartEl}
            onUndo={undo}
            onRedo={redo}
            onNewSlide={(layout) => addSlideAfter(currentId, layout)}
            onLayout={(layout) => currentId && refuse(changeLayout(room.doc, currentId, layout))}
            onTheme={(id: ThemeId) => refuse(changeTheme(room.doc, id))}
            onText={() => addElement({ type: "text", text: "" }, { edit: true })}
            onUpload={() =>
              pickPicture(chosen.length === 1 && chosen[0]?.type === "image" && !chosen[0].asset ? chosen[0].id : null)
            }
            onDrive={() => {
              pictureFor.current =
                chosen.length === 1 && chosen[0]?.type === "image" && !chosen[0].asset ? chosen[0].id : null;
              setDriveOpen(true);
            }}
            onShape={addShape}
            onChart={() => setChartDialog({ el: null })}
            onEditChart={() => chartEl && setChartDialog({ el: chartEl })}
            onTable={(rows, cols) =>
              addElement(
                {
                  type: "table",
                  table: { rows: Array.from({ length: rows }, () => Array(cols).fill("")), header: true },
                },
                { table: true },
              )
            }
            onTableOp={tableOp}
            onMark={mark}
            onColor={color}
            onAlign={align}
            onList={list}
            onLevel={level}
            onSize={size}
            onLink={link}
            linkOpen={linkOpen}
            onLinkOpenChange={setLinkOpen}
            onFill={(value) => patchChosen(() => ({ style: { fill: value ?? "none" } }))}
            onStroke={(value) =>
              patchChosen((el) =>
                el.type === "line"
                  ? { style: { stroke: value } }
                  : { style: value ? { stroke: value, strokeWidth: el.style?.strokeWidth ?? 4 } : { stroke: null } },
              )
            }
            onArrow={() =>
              patchChosen((el) => ({ style: { lineEnd: el.style?.lineEnd === "arrow" ? "none" : "arrow" } }))
            }
            onArrange={(how) => slide && refuse(restack(room.doc, slide.id, selected, how))}
            onAlignElements={(how: AlignHow) =>
              slide && refuse(patchElements(room.doc, slide.id, alignPatches(chosen, how, deck)))
            }
            onDelete={deleteChosen}
            onDone={onDone}
          />
        )}
        {presenter && presenterLook && !watching && !ownPresenting && (
          <div className="sl-presenting" role="status">
            <PeerFace
              user={presenter.user}
              name={presenterLook.name}
              color={presenterLook.color}
              size="xs"
              working={peerWorking(presenter)}
            />
            <span className="sl-presenting__words">
              {t("live.slides.presenting.who", { name: presenterLook.name })}
            </span>
            <Button variant="link" onClick={() => watch(presenter)}>
              {t("live.slides.presenting.follow")}
            </Button>
          </div>
        )}
        <div className="sl-main" data-compact={compact ? "true" : undefined}>
          <Rail
            deck={deck}
            theme={theme}
            current={currentId}
            readOnly={readOnly}
            peersBySlide={peersBySlide}
            looks={looks}
            onPick={(id) => go(id, { user: true })}
            onMove={(id, to) => refuse(placeSlide(room.doc, id, to))}
            onNewAfter={(id) => addSlideAfter(id)}
            onDuplicate={duplicateSlideOf}
            onHide={(id, hidden) => refuse(hideSlide(room.doc, id, hidden))}
            onDelete={deleteSlide}
            onPresentFrom={presentFrom}
          />
          <div className="sl-center">
            {slide ? (
              <Stage
                room={room}
                deck={deck}
                slide={slide}
                theme={theme}
                readOnly={readOnly}
                selected={selected}
                onSelect={(next) => {
                  setSelected(next);
                  if (next.length && following) onStopFollowing();
                }}
                editing={readOnly ? null : editing}
                onEdit={(target) => {
                  setEditing(target);
                  if (target) setSelected([target.id]);
                  else focusStage();
                }}
                tableEdit={readOnly ? null : tableEdit}
                onTableEdit={(id) => {
                  setTableEdit(id);
                  if (!id) focusStage();
                }}
                peers={peers}
                looks={looks}
                rich={rich}
                onFormat={setCaret}
                onLinkKey={() => setLinkOpen(true)}
                onOpen={(el) => {
                  if (el.type === "chart") setChartDialog({ el });
                  else if (el.type === "image") pickPicture(el.id);
                }}
                onKeyDown={onStageKey}
                onCopy={onCopy}
                onCut={onCut}
                onPaste={onPaste}
                onContextMenu={onStageMenu}
                onDropFiles={(files, at) => void upload(files, at)}
                label={t("live.slides.stage.label", { n: currentIndex + 1, total: deck.slides.length })}
              />
            ) : (
              <div className="sl-empty">
                <EmptyState
                  size="panel"
                  icon="slides"
                  title={t("live.slides.empty.title")}
                  actions={
                    !readOnly && (
                      <Button variant="primary" icon="plus" onClick={() => addSlideAfter(null, "title")}>
                        {t("live.slides.empty.add")}
                      </Button>
                    )
                  }
                >
                  {readOnly ? undefined : t("live.slides.empty.body")}
                </EmptyState>
              </div>
            )}
            {uploading > 0 && (
              <p className="sl-uploading" role="status">
                {t("live.slides.image.uploading", { count: uploading })}
              </p>
            )}
            {slide && (
              <Notes
                key={slide.id}
                room={room}
                slideId={slide.id}
                readOnly={readOnly}
                open={notesOpen}
                onOpenChange={setNotesOpen}
              />
            )}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void upload(files);
          }}
        />
        {chartDialog && (
          <ChartDialog
            open
            chart={chartDialog.el?.chart ?? null}
            locale={locale}
            onClose={() => setChartDialog(null)}
            onSave={saveChart}
          />
        )}
        <DrivePicker
          orgId={orgId}
          open={driveOpen}
          onClose={() => setDriveOpen(false)}
          onPick={(a) => void fromDrive(a)}
        />
        {watching?.state.presenting && watchingLook ? (
          <Present
            deck={deck}
            slideId={watching.state.presenting.slide}
            following={{ name: watchingLook.name }}
            onExit={stopWatching}
          />
        ) : (
          presenting &&
          currentId && (
            <Present
              deck={deck}
              slideId={currentId}
              onSlide={(id) => setPicked(id)}
              onExit={() => {
                leaveScreen();
                onSearch({ present: undefined });
                focusStage();
              }}
            />
          )
        )}
      </div>
    </SlideImages.Provider>
  );
}
