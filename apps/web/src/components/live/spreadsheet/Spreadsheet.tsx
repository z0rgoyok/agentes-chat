import { nextFrame, useLiveDocVersion, useLivePeers } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import {
  addSheet,
  type BorderPreset,
  borderRange,
  type CellStyle,
  changeDecimals,
  clearRange,
  colIds,
  copyRange,
  deleteCols,
  deleteRows,
  deleteSheet,
  duplicateSheet,
  ensureSize,
  errorKey,
  type FormulaProblem,
  fillRange,
  formatRange,
  functionHelp,
  functionNames,
  insertCols,
  insertRows,
  inspectFormula,
  mergeRange,
  moveRange,
  moveSheet,
  type NumberFormatPreset,
  nextSheetName,
  numberFormatCode,
  parseA1Range,
  pasteCells,
  type RangeIds,
  renameSheet,
  rowIds,
  SheetError,
  setColWidth,
  setFrozen,
  setInput,
  setRowHeight,
  setSheetTab,
  sheetByName,
  sheetIds,
  sheetLocale,
  sheetName,
  sheetSize,
  sheetTabColor,
  sortRange,
  uniqueSheetName,
  unmergeRange,
} from "@agenteschat/live/spreadsheet";
import { Button, Dialog, DialogFooter, isApple, modKey, useDarkTheme } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import type { LiveEditorProps } from "../editor";
import { lastCopied, readClipboard, rememberCopy, writeClipboard } from "./clipboard";
import { CELL_PAD_X, type RangeMark } from "./draw";
import { FormulaBar } from "./FormulaBar";
import { FormulaAssist, FormulaInput } from "./FormulaInput";
import {
  canPoint,
  type FnOption,
  fnKey,
  matchFunctions,
  placeFunction,
  placeRef,
  refColor,
  signatureParts,
} from "./formula-ui";
import { Grid, type GridArea, type GridHandle } from "./Grid";
import {
  anchorOf,
  type CellPos,
  cellCount,
  clampIndex,
  collapsed,
  cycleWithin,
  type GridRange,
  IDLE_TEXT,
  inRange,
  jumpFrom,
  normalize,
  rangeA1,
  rangesMeet,
  type SheetSelection,
  selectionLabel,
  selectionRange,
  statsOf,
  stepFrom,
} from "./model";
import { SheetCursors, useSheetPeers } from "./presence";
import { SheetTabs } from "./SheetTabs";
import { DocSource } from "./source";
import { SelectionStatus } from "./status";
import { type QuickFunction, SheetToolbar } from "./Toolbar";
import "./sheet.css";

/**
 * The spreadsheet editor (ADR 0196): the toolbar, the formula bar, the grid and the sheet tabs, over a live document
 * everyone in the file edits at once. Every change goes through `@agenteschat/live`'s edits with the `LOCAL` origin
 * (what the person's undo takes back), values come from the room's engine computing in the person's language, and
 * the person's selection and typing go out as their presence while everyone else's comes in and is drawn.
 */

/** A selection pinned to row and column ids, so it follows its cells when rows or columns come and go. */
interface Pinned {
  sel: SheetSelection;
  ids: (string | undefined)[];
}

/** A cell being typed in. */
interface Edit {
  sheet: string;
  rowId: string;
  colId: string;
  r: number;
  c: number;
  text: string;
  /** What it held (nothing is written when it didn't change). */
  original: string;
  caret: number;
  where: "cell" | "bar";
  /** Started by typing: arrows point at cells in a formula, else they finish the cell. */
  pointing: boolean;
  /** The reference being pointed at, and where it sits in the text. */
  point: { start: number; end: number; anchor: CellPos; corner: CellPos } | null;
  problem: string | null;
}

/** How long after a change the person still shows as editing. */
const EDITED_MS = 4000;
const MORE_ROWS = 100;

export function Spreadsheet(props: LiveEditorProps) {
  const { room, search, onSearch, following, onStopFollowing, onSelection } = props;
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const reduced = usePrefersReducedMotion();
  const doc = room.doc;
  const state = useSyncExternalStore(room.subscribe, room.getState, room.getState);
  const version = useLiveDocVersion(room, nextFrame);
  const locale = useMemo(() => sheetLocale(props.locale), [props.locale]);
  const editable = !props.readOnly && state.mode === "edit";
  // A room closed under the editor (the page going away) has no engine left: the loading state draws instead.
  const engine = useMemo(() => (room.destroyed ? null : room.engine()), [room]);

  const grid = useRef<GridHandle>(null);
  const cellInput = useRef<HTMLTextAreaElement>(null);
  const barInput = useRef<HTMLTextAreaElement>(null);
  const barBox = useRef<HTMLDivElement>(null);
  const cellBox = useRef<HTMLDivElement>(null);

  // ── Sheets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const sheets = useMemo(
    () =>
      version >= 0 ? sheetIds(doc).map((id) => ({ id, name: sheetName(doc, id), tab: sheetTabColor(doc, id) })) : [],
    [doc, version],
  );
  const [picked, setPicked] = useState<string | undefined>(search.sheet);
  useEffect(() => {
    if (search.sheet) setPicked(search.sheet);
  }, [search.sheet]);
  const sheet = picked && sheets.some((s) => s.id === picked) ? picked : sheets[0]?.id;
  const current = sheets.find((s) => s.id === sheet);

  const source = useMemo(() => {
    if (!sheet || !engine) return null;
    // The engine computes text in the person's language (`=VALOR("1,5")`), before anything is read.
    engine.setLocale(locale);
    return new DocSource(doc, engine, sheet, locale, version);
  }, [doc, engine, sheet, locale, version]);
  const size = source ? { rows: source.rows.count, cols: source.cols.count } : { rows: 0, cols: 0 };

  // ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────
  const [pins, setPins] = useState<Record<string, Pinned>>({});
  const pinned = sheet ? pins[sheet] : undefined;
  const sel: SheetSelection = useMemo(() => {
    if (!pinned || !source) return collapsed({ r: 0, c: 0 });
    const at = (rowId: string | undefined, colId: string | undefined, fallback: CellPos): CellPos => {
      const r = rowId ? source.rowIndex(rowId) : -1;
      const c = colId ? source.colIndex(colId) : -1;
      return {
        r: r >= 0 ? r : clampIndex(fallback.r, source.rows.count),
        c: c >= 0 ? c : clampIndex(fallback.c, source.cols.count),
      };
    };
    const [ar, ac, nr, nc, cr, cc] = pinned.ids;
    const out: SheetSelection = {
      active: at(ar, ac, pinned.sel.active),
      anchor: at(nr, nc, pinned.sel.anchor),
      corner: at(cr, cc, pinned.sel.corner),
    };
    if (pinned.sel.whole) out.whole = pinned.sel.whole;
    return out;
  }, [pinned, source]);
  const range: GridRange = useMemo(
    () =>
      source
        ? selectionRange(sel, { rows: source.rows.count, cols: source.cols.count }, source.merges)
        : { r1: 0, c1: 0, r2: 0, c2: 0 },
    [sel, source],
  );

  /** Selects on the sheet shown, or on `opts.sheet` (the name box going to another sheet). */
  const setSel = (next: SheetSelection, opts: { reveal?: boolean | GridRange; sheet?: string } = {}) => {
    const on = opts.sheet ?? sheet;
    if (!on || !source) return;
    const rowsOf = on === source.sheet ? source.rowIds : rowIds(doc, on);
    const colsOf = on === source.sheet ? source.colIds : colIds(doc, on);
    const ids = (p: CellPos) => [rowsOf[p.r], colsOf[p.c]];
    setPins((all) => ({
      ...all,
      [on]: { sel: next, ids: [...ids(next.active), ...ids(next.anchor), ...ids(next.corner)] },
    }));
    if (opts.reveal !== false) {
      const show =
        typeof opts.reveal === "object"
          ? opts.reveal
          : { r1: next.corner.r, c1: next.corner.c, r2: next.corner.r, c2: next.corner.c };
      requestAnimationFrame(() => grid.current?.reveal(show));
    }
  };

  // ── Typing ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const [edit, setEdit] = useState<Edit | null>(null);
  const [assistOff, setAssistOff] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** The caret the inputs should take after a change made here (a reference or a function put in). */
  const caretTo = useRef<number | null>(null);
  const editingAt: CellPos | null = edit && edit.sheet === sheet ? editPos(edit, source) : null;
  const lastEdit = useRef(0);
  const [, setEditedTick] = useState(0);
  const markEdited = () => {
    lastEdit.current = Date.now();
    setEditedTick((n) => n + 1);
  };

  const inspection = useMemo(() => {
    if (!edit?.text.startsWith("=") || !sheet) return null;
    try {
      return inspectFormula(edit.text, edit.caret, { doc, sheetId: edit.sheet, locale });
    } catch {
      return null;
    }
  }, [edit, doc, sheet, locale]);
  const dark = useDarkTheme();
  const refSpans = (inspection?.refs ?? []).map((ref) => ({
    start: ref.start,
    end: ref.end,
    color: refColor(ref.color, dark),
  }));
  const fnOptions = useMemo<FnOption[]>(() => functionNames(locale), [locale]);
  const suggestions = inspection?.word && !assistOff ? matchFunctions(inspection.word.text, fnOptions) : [];
  const help = inspection?.fn ? functionHelp(inspection.fn.name, locale) : null;
  const signature =
    help && inspection?.fn ? signatureParts(help, inspection.fn.arg, locale, (key) => String(t(key as never))) : null;

  // ── Presence ────────────────────────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const others = useSheetPeers(peers, sheet, source, reduced);
  const agentsHere = peers.some((p) => !p.self && p.user.kind === "agent" && p.state.sel?.sheet?.sheet === sheet);
  const [copyMark, setCopyMark] = useState<{ sheet: string; range: GridRange } | null>(null);
  const marks: RangeMark[] = useMemo(() => {
    const list = [...others.marks];
    if (inspection) {
      for (const ref of inspection.refs) {
        if (ref.sheet !== sheet) continue;
        list.push({
          range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 },
          color: refColor(ref.color, dark),
          wash: 0.08,
          width: 2,
        });
      }
    }
    if (copyMark && copyMark.sheet === sheet && !edit) {
      list.push({ range: copyMark.range, color: "var(--ink)", dashed: true });
    }
    return list;
  }, [others.marks, inspection, sheet, dark, copyMark, edit]);

  // This person's own presence: where they are, what they selected, typing or not.
  const selIds =
    source && sheet
      ? [source.rowIds[range.r1], source.colIds[range.c1], source.rowIds[range.r2], source.colIds[range.c2]]
      : [];
  const selKey = selIds.join(",");
  const typing = edit !== null;
  const recentlyEdited = Date.now() - lastEdit.current < EDITED_MS;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selKey` stands for the ids it is made of
  useEffect(() => {
    if (!sheet) return;
    const [r1, c1, r2, c2] = selIds;
    room.setLocal({
      at: { sheet },
      sel:
        r1 && c1 && r2 && c2 ? { sheet: { sheet, r1, c1, r2, c2, ...(typing ? { editing: true } : {}) } } : undefined,
      mode: editable && (typing || recentlyEdited) ? "editing" : "viewing",
    });
    if (!typing && recentlyEdited) {
      const id = setTimeout(() => setEditedTick((n) => n + 1), EDITED_MS);
      return () => clearTimeout(id);
    }
  }, [room, sheet, selKey, typing, recentlyEdited, editable]);
  // Leaving the editor takes the selection away from the others' screens.
  useEffect(() => () => room.setLocal({ sel: undefined, at: undefined }), [room]);

  // "Ask an agent" and the page's header know what is selected.
  const label = current && source ? selectionLabel(current.name, range, size) : null;
  const rangeText = source ? rangeA1(range, size) : "";
  useEffect(() => {
    if (!label || !sheet) {
      onSelection(null);
      return;
    }
    onSelection({ label, sheet, range: rangeText });
  }, [label, sheet, rangeText, onSelection]);

  // Following someone: their sheet, and their range in view.
  const followSel = following?.state.sel?.sheet;
  const followSheet = followSel?.sheet ?? following?.state.at?.sheet;
  const followKey = followSel
    ? `${followSel.sheet}|${followSel.r1}|${followSel.c1}|${followSel.r2}|${followSel.c2}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `followKey` stands for the followed selection
  useEffect(() => {
    if (!following || !followSheet || !sheets.some((s) => s.id === followSheet)) return;
    if (followSheet !== sheet) {
      setPicked(followSheet);
      onSearch({ sheet: followSheet });
      return;
    }
    if (!followSel || !source) return;
    const r1 = source.rowIndex(followSel.r1);
    const c1 = source.colIndex(followSel.c1);
    const r2 = source.rowIndex(followSel.r2);
    const c2 = source.colIndex(followSel.c2);
    if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) return;
    grid.current?.reveal(normalize({ r: r1, c: c1 }, { r: r2, c: c2 }));
  }, [following?.clientId, followSheet, followKey, sheet, source !== null]);
  const ownMove = () => {
    if (following) onStopFollowing();
  };

  // ── Undo ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [undoState, setUndoState] = useState({ undo: 0, redo: 0 });
  useEffect(() => {
    const undo = room.undo;
    const update = () => setUndoState({ undo: undo.undoStack.length, redo: undo.redoStack.length });
    update();
    undo.on("stack-item-added", update);
    undo.on("stack-item-popped", update);
    undo.on("stack-cleared", update);
    return () => {
      undo.off("stack-item-added", update);
      undo.off("stack-item-popped", update);
      undo.off("stack-cleared", update);
    };
  }, [room]);
  const undo = () => {
    if (!editable) return;
    room.undo.undo();
    markEdited();
  };
  const redo = () => {
    if (!editable) return;
    room.undo.redo();
    markEdited();
  };

  // ── Edits ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const failText = (err: unknown) => {
    if (err instanceof SheetError) {
      const key = `live.sheet.failed.${err.reason}`;
      if (i18n.exists(key)) return String(t(key as never));
    }
    return t("live.sheet.failed.other");
  };
  const problemText = (problem: FormulaProblem) => {
    const key = `live.sheet.problem.${problem.code}`;
    return i18n.exists(key) ? String(t(key as never)) : t("live.sheet.problem.unexpected");
  };
  /** Runs an edit; what the document refuses is said in a toast. */
  const run = (fn: () => void): boolean => {
    if (!editable) return false;
    try {
      fn();
      // Each edit is its own step back, however fast the next one comes.
      room.undo.stopCapturing();
      markEdited();
      return true;
    } catch (err) {
      toast.show(failText(err), "error");
      return false;
    }
  };
  const ids = (r: GridRange): RangeIds => ({ sheet: sheet as string, ...r });

  const focusGrid = () => cellInput.current?.focus({ preventScroll: true });

  const startEdit = (where: "cell" | "bar", pointing: boolean, text?: string) => {
    if (!editable || !sheet || !source) return;
    const at = anchorOf(sel.active, source.merges);
    const rowId = source.rowIds[at.r];
    const colId = source.colIds[at.c];
    if (!rowId || !colId) return;
    const original = source.input(at.r, at.c);
    const value = text ?? original;
    setEdit({
      sheet,
      rowId,
      colId,
      r: at.r,
      c: at.c,
      text: value,
      original,
      caret: value.length,
      where,
      pointing,
      point: null,
      problem: null,
    });
    setAssistOff(false);
    setHighlight(0);
    setCopyMark(null);
    caretTo.current = value.length;
    ownMove();
    grid.current?.reveal({ r1: at.r, c1: at.c, r2: at.r, c2: at.c });
  };

  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;

  const cancelEdit = () => {
    setEdit(null);
    focusGrid();
  };

  /** Writes what was typed. False keeps the editor open (a formula that can't be read, says why). */
  const commit = (): boolean => {
    const e = edit;
    if (!e) return true;
    if (e.text !== e.original && editable) {
      const at = editPos(e, source) ?? { r: e.r, c: e.c };
      let result: ReturnType<typeof setInput>;
      try {
        result = setInput(doc, { sheet: e.sheet, row: at.r, col: at.c }, e.text, locale, LOCAL);
      } catch (err) {
        toast.show(failText(err), "error");
        return false;
      }
      if (!result.ok) {
        setEdit({ ...e, problem: problemText(result.error) });
        return false;
      }
      room.undo.stopCapturing();
      markEdited();
    }
    setEdit(null);
    return true;
  };

  /** After Enter or Tab: the next cell, inside the selection when it has several. */
  const moveAfter = (by: "row" | "col", back: boolean) => {
    if (!source) return;
    if (cellCount(range) > 1 && !sel.whole) {
      setSel({ ...sel, active: cycleWithin(range, sel.active, by, back) }, { reveal: false });
      return;
    }
    const next =
      by === "row"
        ? stepFrom(sel.active, back ? -1 : 1, 0, size, source.merges)
        : stepFrom(sel.active, 0, back ? -1 : 1, size, source.merges);
    setSel(collapsed(anchorOf(next, source.merges)));
  };

  // ── Selection by keys ───────────────────────────────────────────────────────────────────────────────────────────
  const move = (dr: number, dc: number, opts: { extend: boolean; jump: boolean }) => {
    if (!source) return;
    ownMove();
    const from = opts.extend ? sel.corner : sel.active;
    const filled = (r: number, c: number) => source.filled(r, c);
    const to = opts.jump ? jumpFrom(from, dr, dc, size, filled) : stepFrom(from, dr, dc, size, source.merges);
    if (opts.extend) setSel({ ...sel, corner: to, whole: sel.whole === "all" ? undefined : sel.whole });
    else setSel(collapsed(anchorOf(to, source.merges)));
  };

  const selectAll = () => {
    if (!source) return;
    setSel(
      { active: sel.active, anchor: { r: 0, c: 0 }, corner: { r: size.rows - 1, c: size.cols - 1 }, whole: "all" },
      { reveal: false },
    );
  };

  const onNavKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!source) return;
    const apple = isApple();
    const mod = apple ? e.metaKey : e.ctrlKey;
    const key = e.key;
    const letter = key.length === 1 ? key.toLowerCase() : "";
    if (mod && !e.altKey && letter) {
      if (letter === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (letter === "y" && !apple) {
        e.preventDefault();
        redo();
      } else if (letter === "a") {
        e.preventDefault();
        selectAll();
      } else if (letter === "b" || letter === "i" || letter === "u") {
        e.preventDefault();
        const style = activeStyle;
        const k = letter as "b" | "i" | "u";
        format({ [k]: style?.[k] ? undefined : 1 } as Partial<CellStyle>);
      } else if (letter === "d") {
        e.preventDefault();
        fillDown();
      } else if (letter === "v" && e.shiftKey) {
        // ⇧⌘V: the paste that follows takes values only.
        valuesOnlyNext.current = true;
      }
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[key];
    if (arrow) {
      e.preventDefault();
      tabStart.current = null;
      move(arrow[0], arrow[1], { extend: e.shiftKey, jump: mod });
      return;
    }
    switch (key) {
      case "Tab": {
        e.preventDefault();
        if (tabStart.current === null) tabStart.current = sel.active.c;
        moveAfter("col", e.shiftKey);
        return;
      }
      case "Enter": {
        e.preventDefault();
        if (e.shiftKey) {
          moveAfter("row", true);
          return;
        }
        if (editable) startEdit("cell", false);
        else moveAfter("row", false);
        return;
      }
      case "F2":
        e.preventDefault();
        startEdit("cell", false);
        return;
      case "Home": {
        e.preventDefault();
        const to = mod ? { r: 0, c: 0 } : { r: (e.shiftKey ? sel.corner : sel.active).r, c: 0 };
        if (e.shiftKey) setSel({ ...sel, corner: to });
        else setSel(collapsed(anchorOf(to, source.merges)));
        return;
      }
      case "End": {
        e.preventDefault();
        const used = source.used();
        const from = e.shiftKey ? sel.corner : sel.active;
        const to = mod
          ? (used ?? { r: 0, c: 0 })
          : jumpFrom({ r: from.r, c: 0 }, 0, 1, size, (r, c) => source.filled(r, c)).c >= from.c
            ? { r: from.r, c: lastFilledInRow(source, from.r) }
            : from;
        if (e.shiftKey) setSel({ ...sel, corner: to });
        else setSel(collapsed(anchorOf(to, source.merges)));
        return;
      }
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const rows = (grid.current?.pageRows() ?? 20) * (key === "PageUp" ? -1 : 1);
        move(rows, 0, { extend: e.shiftKey, jump: false });
        return;
      }
      case "Delete":
      case "Backspace":
        e.preventDefault();
        run(() => clearRange(doc, ids(range), "contents", LOCAL));
        return;
      case "Escape":
        setCopyMark(null);
        return;
      case " ":
        if (e.shiftKey && !mod) {
          e.preventDefault();
          setSel(
            { ...sel, anchor: { r: sel.active.r, c: 0 }, corner: { r: sel.active.r, c: size.cols - 1 }, whole: "rows" },
            { reveal: false },
          );
        } else if (e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          setSel(
            { ...sel, anchor: { r: 0, c: sel.active.c }, corner: { r: size.rows - 1, c: sel.active.c }, whole: "cols" },
            { reveal: false },
          );
        }
        return;
    }
  };
  const tabStart = useRef<number | null>(null);
  const valuesOnlyNext = useRef(false);

  /** Keys while typing in the cell or in the bar. */
  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!edit) return;
    const apple = isApple();
    const mod = apple ? e.metaKey : e.ctrlKey;
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && !mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const option = suggestions[Math.min(highlight, suggestions.length - 1)];
        if (option) pickFunction(option);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAssistOff(true);
        return;
      }
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        cancelEdit();
        return;
      case "Enter": {
        if (e.altKey || (e.ctrlKey && apple)) {
          // A line break inside the cell.
          e.preventDefault();
          const el = e.currentTarget;
          const start = el.selectionStart ?? edit.text.length;
          const end = el.selectionEnd ?? start;
          const text = `${edit.text.slice(0, start)}\n${edit.text.slice(end)}`;
          caretTo.current = start + 1;
          setEdit({ ...edit, text, caret: start + 1, point: null, problem: null });
          return;
        }
        e.preventDefault();
        if (mod) {
          commitIntoSelection();
          return;
        }
        if (!commit()) return;
        focusGrid();
        if (tabStart.current !== null && !e.shiftKey && cellCount(range) === 1 && source) {
          const to = { r: clampIndex(sel.active.r + 1, size.rows), c: tabStart.current };
          tabStart.current = null;
          setSel(collapsed(anchorOf(to, source.merges)));
          return;
        }
        moveAfter("row", e.shiftKey);
        return;
      }
      case "Tab":
        e.preventDefault();
        if (!commit()) return;
        focusGrid();
        if (tabStart.current === null) tabStart.current = sel.active.c;
        moveAfter("col", e.shiftKey);
        return;
      case "F2":
        e.preventDefault();
        setEdit({ ...edit, pointing: !edit.pointing, point: null });
        return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[e.key];
    if (!arrow || mod || e.altKey || edit.where !== "cell" || !edit.pointing) return;
    e.preventDefault();
    if (edit.point || canPoint(edit.text, edit.caret, locale)) {
      if (!source) return;
      const from = edit.point ? edit.point.corner : { r: edit.r, c: edit.c };
      const to = stepFrom(from, arrow[0], arrow[1], size, source.merges);
      const anchor = e.shiftKey && edit.point ? edit.point.anchor : to;
      pointAt(anchor, to);
      grid.current?.reveal({ r1: to.r, c1: to.c, r2: to.r, c2: to.c });
      return;
    }
    if (!commit()) return;
    focusGrid();
    move(arrow[0], arrow[1], { extend: false, jump: false });
  };

  /** Puts a reference to the cells from `anchor` to `corner` at the cursor (or over the one being pointed). */
  const pointAt = (anchor: CellPos, corner: CellPos) => {
    if (!edit) return;
    const ref = rangeA1(normalize(anchor, corner));
    const placed = placeRef(edit.text, edit.caret, ref, edit.point);
    caretTo.current = placed.caret;
    setEdit({
      ...edit,
      text: placed.text,
      caret: placed.caret,
      point: { start: placed.span.start, end: placed.span.end, anchor, corner },
      problem: null,
    });
  };

  const pickFunction = (option: FnOption) => {
    const word = inspection?.word;
    if (!edit || !word) return;
    const placed = placeFunction(edit.text, word, option.name);
    caretTo.current = placed.caret;
    setEdit({ ...edit, text: placed.text, caret: placed.caret, point: null, problem: null });
    setHighlight(0);
  };

  // The inputs take the caret a change made here asked for; the idle field keeps its placeholder selected.
  useLayoutEffect(() => {
    const idle = cellInput.current;
    if (!edit && idle && document.activeElement === idle) {
      if (idle.selectionStart !== 0 || idle.selectionEnd !== idle.value.length) idle.select();
    }
    const to = caretTo.current;
    if (to === null || !edit) return;
    caretTo.current = null;
    const el = edit.where === "bar" ? barInput.current : cellInput.current;
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    el.setSelectionRange(to, to);
  });

  const onText = (where: "cell" | "bar", typed: string, typedCaret: number) => {
    let text = typed;
    let caret = typedCaret;
    if (!edit) {
      if (!editable) return;
      if (where === "cell") {
        // What was typed over the idle field's placeholder.
        const cut = text.indexOf(IDLE_TEXT);
        if (cut >= 0) {
          text = text.replaceAll(IDLE_TEXT, "");
          if (caret > cut) caret--;
        }
        if (text === "") return;
      }
      // Typing on a selected cell starts over with what was typed (the bar starts from what the cell holds).
      startEdit(where, where === "cell", text);
      if (where === "cell") {
        caretTo.current = null;
      }
      setEdit((e) => (e ? { ...e, text, caret } : e));
      return;
    }
    setEdit({ ...edit, text, caret, where, point: null, problem: null });
    setAssistOff(false);
    setHighlight(0);
  };

  const onCaret = (caret: number) => {
    if (edit && caret !== edit.caret)
      setEdit({ ...edit, caret, point: edit.point && caret === edit.point.end ? edit.point : null });
  };

  // ── Writing many cells ──────────────────────────────────────────────────────────────────────────────────────────
  const format = (patch: Partial<CellStyle>) => run(() => formatRange(doc, ids(range), patch, LOCAL));

  /** ⌘Enter: what was typed goes into every selected cell (formulas move as copies do). */
  const commitIntoSelection = () => {
    if (!edit || !source || !sheet || !engine) return;
    const at = sel.active;
    if (!commit()) return;
    focusGrid();
    if (cellCount(range) <= 1) return;
    run(() => {
      const copied = copyRange(doc, ids({ r1: at.r, c1: at.c, r2: at.r, c2: at.c }), engine, locale);
      pasteCells(
        doc,
        { sheet, row: range.r1, col: range.c1 },
        { cells: copied.cells, source: { sheet, r1: at.r, c1: at.c } },
        locale,
        LOCAL,
        { into: ids(range) },
      );
    });
  };

  /** ⌘D: the selection's top row copied down over it (one row: the row above copied into it). */
  const fillDown = () => {
    if (!sheet || !engine) return;
    const top = range.r1 === range.r2 ? range.r1 - 1 : range.r1;
    if (top < 0) return;
    run(() => {
      const from = { r1: top, c1: range.c1, r2: top, c2: range.c2 };
      const copied = copyRange(doc, ids(from), engine, locale);
      const into = { r1: top + 1, c1: range.c1, r2: range.r2, c2: range.c2 };
      pasteCells(
        doc,
        { sheet, row: into.r1, col: into.c1 },
        { cells: copied.cells, source: { sheet, r1: top, c1: range.c1 } },
        locale,
        LOCAL,
        { into: ids(into) },
      );
    });
  };

  // ── Clipboard ───────────────────────────────────────────────────────────────────────────────────────────────────
  const copyOut = (e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    if (edit || !sheet || !source || !engine) return;
    e.preventDefault();
    try {
      const copied = copyRange(doc, ids(range), engine, locale);
      writeClipboard(
        e.clipboardData,
        {
          file: room.fileId,
          sheet,
          r1: range.r1,
          c1: range.c1,
          rows: range.r2 - range.r1 + 1,
          cols: range.c2 - range.c1 + 1,
          cells: copied.cells,
          tsv: copied.tsv,
          cut: cut && editable,
        },
        copied.html,
      );
      setCopyMark({ sheet, range });
    } catch (err) {
      toast.show(failText(err), "error");
    }
  };

  const pasteIn = (pasted: ReturnType<typeof readClipboard>, valuesOnly: boolean) => {
    if (!pasted || !sheet || !source) return;
    const copied = pasted.copied;
    // Cells copied in another file: their formulas travel as A1 and are read here (their sheet's ids mean nothing).
    const clip =
      copied && copied.file !== room.fileId ? { ...pasted, clip: { cells: copied.cells, tsv: copied.tsv } } : pasted;
    if (copied?.cut && copied.file === room.fileId && !valuesOnly && sheets.some((s) => s.id === copied.sheet)) {
      run(() => {
        const from: RangeIds = {
          sheet: copied.sheet,
          r1: copied.r1,
          c1: copied.c1,
          r2: copied.r1 + copied.rows - 1,
          c2: copied.c1 + copied.cols - 1,
        };
        const landed = moveRange(doc, from, { sheet, row: range.r1, col: range.c1 }, LOCAL);
        setSel({
          active: { r: landed.r1, c: landed.c1 },
          anchor: { r: landed.r1, c: landed.c1 },
          corner: { r: landed.r2, c: landed.c2 },
        });
      });
      rememberCopy(null);
      setCopyMark(null);
      return;
    }
    run(() => {
      const landed = pasteCells(doc, { sheet, row: range.r1, col: range.c1 }, clip.clip, locale, LOCAL, {
        valuesOnly,
        into: ids(range),
      });
      setSel(
        {
          active: { r: landed.r1, c: landed.c1 },
          anchor: { r: landed.r1, c: landed.c1 },
          corner: { r: landed.r2, c: landed.c2 },
        },
        { reveal: false },
      );
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (edit) return;
    e.preventDefault();
    if (!editable) return;
    const valuesOnly = valuesOnlyNext.current;
    valuesOnlyNext.current = false;
    pasteIn(readClipboard(e.clipboardData), valuesOnly);
  };

  /** The menu's Paste: the async clipboard, where the browser allows it; else the keys to use. */
  const pasteFromMenu = async (valuesOnly: boolean) => {
    const keys = `${modKey()}${isApple() ? "" : "+"}V`;
    try {
      const items = await navigator.clipboard.read();
      const data = new Map<string, string>();
      for (const item of items) {
        for (const type of item.types) {
          if (type === "text/plain" || type === "text/html") data.set(type, await (await item.getType(type)).text());
        }
      }
      const fake = { getData: (type: string) => data.get(type) ?? "" } as unknown as DataTransfer;
      pasteIn(readClipboard(fake), valuesOnly);
    } catch {
      const copy = lastCopied();
      if (copy && copy.file === room.fileId) {
        pasteIn(
          { clip: { cells: copy.cells, source: { sheet: copy.sheet, r1: copy.r1, c1: copy.c1 } }, copied: copy },
          valuesOnly,
        );
        return;
      }
      toast.show(t("live.sheet.pasteKeys", { keys }));
    }
  };

  const copyFromMenu = async (cut: boolean) => {
    if (!sheet || !engine) return;
    try {
      const copied = copyRange(doc, ids(range), engine, locale);
      rememberCopy({
        file: room.fileId,
        sheet,
        r1: range.r1,
        c1: range.c1,
        rows: range.r2 - range.r1 + 1,
        cols: range.c2 - range.c1 + 1,
        cells: copied.cells,
        tsv: copied.tsv,
        cut: cut && editable,
      });
      setCopyMark({ sheet, range });
      const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (Item && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new Item({
            "text/plain": new Blob([copied.tsv], { type: "text/plain" }),
            "text/html": new Blob([copied.html], { type: "text/html" }),
          }),
        ]);
      } else await navigator.clipboard?.writeText(copied.tsv);
    } catch {
      // The copy stays here for pasting in this file.
    }
  };

  // The Mac app's Edit menu sends undo and redo to the focused field; the grid's field holds no text of its own.
  useEffect(() => {
    const el = cellInput.current;
    if (!el) return;
    const onBefore = (e: InputEvent) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      if (editRef.current) return;
      e.preventDefault();
      if (e.inputType === "historyUndo") undoRef.current();
      else redoRef.current();
    };
    el.addEventListener("beforeinput", onBefore);
    return () => el.removeEventListener("beforeinput", onBefore);
  }, []);
  const editRef = useRef(edit);
  editRef.current = edit;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  // ── Pointer ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * A press and the drag after it: where it started and the selection the press made, so each cell the pointer
   * moves over extends that one (never a selection a render behind).
   */
  const dragging = useRef<{ area: GridArea; pointing: boolean; from: CellPos; base: SheetSelection } | null>(null);
  const onPress = (at: CellPos, area: GridArea, how: { shift: boolean; meta: boolean }) => {
    if (!source) return;
    ownMove();
    tabStart.current = null;
    if (
      edit &&
      area === "cell" &&
      edit.text.startsWith("=") &&
      (edit.point || canPoint(edit.text, edit.caret, locale))
    ) {
      dragging.current = { area, pointing: true, from: at, base: sel };
      pointAt(at, at);
      return;
    }
    if (edit && !commit()) return;
    focusGrid();
    const last = { r: size.rows - 1, c: size.cols - 1 };
    let next: SheetSelection;
    if (area === "corner") {
      next = { active: sel.active, anchor: { r: 0, c: 0 }, corner: last, whole: "all" };
    } else if (area === "col") {
      next = how.shift
        ? { ...sel, corner: { r: last.r, c: at.c }, whole: "cols" }
        : { active: { r: 0, c: at.c }, anchor: { r: 0, c: at.c }, corner: { r: last.r, c: at.c }, whole: "cols" };
    } else if (area === "row") {
      next = how.shift
        ? { ...sel, corner: { r: at.r, c: last.c }, whole: "rows" }
        : { active: { r: at.r, c: 0 }, anchor: { r: at.r, c: 0 }, corner: { r: at.r, c: last.c }, whole: "rows" };
    } else {
      next = how.shift ? { ...sel, corner: at, whole: undefined } : collapsed(anchorOf(at, source.merges));
    }
    dragging.current = { area, pointing: false, from: at, base: next };
    setSel(next, { reveal: false });
  };

  const onDrag = (at: CellPos, area: GridArea) => {
    const d = dragging.current;
    if (!d || !source) return;
    if (d.pointing) {
      if (edit?.point) pointAt(d.from, at);
      return;
    }
    if (d.area === "corner") return;
    if (d.area === "col") {
      setSel({ ...d.base, corner: { r: size.rows - 1, c: at.c }, whole: "cols" }, { reveal: false });
    } else if (d.area === "row") {
      setSel({ ...d.base, corner: { r: at.r, c: size.cols - 1 }, whole: "rows" }, { reveal: false });
    } else if (area === "cell") {
      setSel({ ...d.base, corner: at, whole: undefined }, { reveal: false });
    }
  };

  const onRelease = () => {
    dragging.current = null;
  };

  const onFill = (to: GridRange) => {
    if (!sheet) return;
    run(() => fillRange(doc, ids(range), ids(to), engine, LOCAL));
    setSel({ active: sel.active, anchor: { r: to.r1, c: to.c1 }, corner: { r: to.r2, c: to.c2 } }, { reveal: false });
  };

  /** The rows or columns a resize applies to: all those selected whole, when the one dragged is among them. */
  const resized = (axis: "row" | "col", index: number): number[] => {
    const whole =
      axis === "col" ? sel.whole === "cols" || sel.whole === "all" : sel.whole === "rows" || sel.whole === "all";
    const lo = axis === "col" ? range.c1 : range.r1;
    const hi = axis === "col" ? range.c2 : range.r2;
    if (!whole || index < lo || index > hi) return [index];
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  };

  const onResize = (axis: "row" | "col", index: number, px: number) => {
    if (!sheet) return;
    const which = resized(axis, index);
    run(() =>
      axis === "col" ? setColWidth(doc, sheet, which, px, LOCAL) : setRowHeight(doc, sheet, which, px, LOCAL),
    );
  };

  /** Double click on a header's edge: as wide as the longest text, or as tall as wrapped text needs. */
  const onAutoFit = (axis: "row" | "col", index: number) => {
    if (!sheet || !source) return;
    const which = resized(axis, index);
    run(() => {
      for (const i of which) {
        if (axis === "col") {
          let widest = 0;
          for (let r = 0; r < source.rows.count; r++) {
            const cell = source.cell(r, i);
            if (!cell?.text || source.merges.at(r, i)) continue;
            widest = Math.max(widest, grid.current?.textWidth(cell.text, cell) ?? 0);
          }
          const px = widest > 0 ? Math.min(600, Math.max(40, Math.ceil(widest + 2 * CELL_PAD_X + 2))) : 100;
          setColWidth(doc, sheet, i, px, LOCAL);
        } else {
          let lines = 1;
          for (let c = 0; c < source.cols.count; c++) {
            const cell = source.cell(i, c);
            if (!cell?.text || !cell.style?.w) continue;
            const width = Math.max(8, source.cols.size(c) - 2 * CELL_PAD_X);
            const textWidth = grid.current?.textWidth(cell.text, cell) ?? 0;
            lines = Math.max(lines, cell.text.split("\n").length, Math.ceil(textWidth / width));
          }
          setRowHeight(doc, sheet, i, lines <= 1 ? 24 : Math.min(1000, lines * 17 + 8), LOCAL);
        }
      }
    });
  };

  // ── Menus ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const rowCount = range.r2 - range.r1 + 1;
  const colCount = range.c2 - range.c1 + 1;
  const sortBy = (desc: boolean) => {
    if (!sheet || !source || !engine) return;
    const target = cellCount(range) > 1 ? range : regionAround(source, sel.active);
    const header = hasHeader(source, target, sel.active.c);
    run(() => sortRange(doc, ids(target), sel.active.c, desc, engine, LOCAL, { header }));
  };

  const menuEntries = (area: GridArea): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    const item = (
      id: string,
      label: string,
      runIt: () => void,
      extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {},
    ) => entries.push({ kind: "item", id, label, run: runIt, ...extra });
    if (editable) item("cut", t("live.sheet.menu.cut"), () => void copyFromMenu(true));
    item("copy", t("live.sheet.menu.copy"), () => void copyFromMenu(false));
    const askItem = () => {
      const ask = props.onAsk;
      if (!ask) return;
      entries.push({ kind: "separator" });
      item("ask", t("live.sheet.menu.ask"), () => ask());
    };
    if (!editable) {
      askItem();
      return entries;
    }
    item("paste", t("live.sheet.menu.paste"), () => void pasteFromMenu(false));
    item("pasteValues", t("live.sheet.menu.pasteValues"), () => void pasteFromMenu(true));
    entries.push({ kind: "separator" });
    if (area !== "col") {
      item("rowsAbove", t("live.sheet.menu.insertRowsAbove", { count: rowCount }), () =>
        run(() => insertRows(doc, sheet as string, range.r1, rowCount, LOCAL)),
      );
      item("rowsBelow", t("live.sheet.menu.insertRowsBelow", { count: rowCount }), () =>
        run(() => insertRows(doc, sheet as string, range.r2 + 1, rowCount, LOCAL)),
      );
    }
    if (area !== "row") {
      item("colsLeft", t("live.sheet.menu.insertColsLeft", { count: colCount }), () =>
        run(() => insertCols(doc, sheet as string, range.c1, colCount, LOCAL)),
      );
      item("colsRight", t("live.sheet.menu.insertColsRight", { count: colCount }), () =>
        run(() => insertCols(doc, sheet as string, range.c2 + 1, colCount, LOCAL)),
      );
    }
    entries.push({ kind: "separator" });
    if (area !== "col") {
      item(
        "deleteRows",
        t("live.sheet.menu.deleteRows", { count: rowCount }),
        () => {
          if (run(() => deleteRows(doc, sheet as string, range.r1, rowCount, LOCAL)))
            setSel(collapsed({ r: range.r1, c: sel.active.c }));
        },
        { danger: true, disabled: rowCount >= size.rows },
      );
    }
    if (area !== "row") {
      item(
        "deleteCols",
        t("live.sheet.menu.deleteCols", { count: colCount }),
        () => {
          if (run(() => deleteCols(doc, sheet as string, range.c1, colCount, LOCAL)))
            setSel(collapsed({ r: sel.active.r, c: range.c1 }));
        },
        { danger: true, disabled: colCount >= size.cols },
      );
    }
    entries.push({ kind: "separator" });
    item("clear", t("live.sheet.menu.clear"), () => run(() => clearRange(doc, ids(range), "contents", LOCAL)));
    item("sortAsc", t("live.sheet.sortAsc"), () => sortBy(false));
    item("sortDesc", t("live.sheet.sortDesc"), () => sortBy(true));
    if (area === "col") item("fitWidth", t("live.sheet.menu.fitWidth"), () => onAutoFit("col", sel.active.c));
    if (area === "row") item("fitHeight", t("live.sheet.menu.fitHeight"), () => onAutoFit("row", sel.active.r));
    askItem();
    return entries;
  };

  const onMenu = (x: number, y: number, at: CellPos, area: GridArea) => {
    if (!source) return;
    if (edit && !commit()) return;
    // A right click outside the selection selects what it landed on first.
    const inside =
      area === "corner" ||
      (area === "cell" && inRange(range, at.r, at.c)) ||
      (area === "col" && at.c >= range.c1 && at.c <= range.c2 && (sel.whole === "cols" || sel.whole === "all")) ||
      (area === "row" && at.r >= range.r1 && at.r <= range.r2 && (sel.whole === "rows" || sel.whole === "all"));
    if (!inside) onPress(at, area, { shift: false, meta: false });
    focusGrid();
    requestAnimationFrame(() => openContextMenu(x, y, menuEntries(area)));
  };

  // ── Toolbar ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const activeCell = source?.cell(sel.active.r, sel.active.c) ?? null;
  const activeStyle = activeCell?.style;
  const activeValue = source ? source.value(sel.active.r, sel.active.c) : null;
  const merged = source ? source.merges.list.some((m) => rangesMeet(m, range)) : false;
  const frozen = source?.frozen ?? { rows: 0, cols: 0 };

  const onNumberFormat = (preset: NumberFormatPreset) =>
    format({ nf: preset === "general" ? undefined : numberFormatCode(preset, locale) });
  const onDecimals = (delta: 1 | -1) => {
    const next = changeDecimals(activeStyle?.nf, delta, activeValue);
    if (next !== activeStyle?.nf) format({ nf: next });
  };
  const onBorders = (preset: BorderPreset) =>
    run(() => borderRange(doc, ids(range), preset, preset === "none" ? null : { w: 1 }, LOCAL));
  const onMerge = () => {
    if (merged) run(() => unmergeRange(doc, ids(range), LOCAL));
    else if (cellCount(range) > 1) {
      if (run(() => mergeRange(doc, ids(range), LOCAL)))
        setSel(collapsed({ r: range.r1, c: range.c1 }), { reveal: false });
    }
  };
  const onFreeze = (rows: number, cols: number) => {
    if (sheet) run(() => setFrozen(doc, sheet, rows, cols, LOCAL));
  };
  const functionName = (canonical: QuickFunction) => functionHelp(canonical, locale)?.name ?? canonical;
  /** Σ: on one cell, the function over the numbers right above it (or to its left) to check and Enter; on a range, under each of its columns. */
  const onFunction = (canonical: QuickFunction) => {
    if (!source || !sheet) return;
    const name = functionName(canonical);
    if (cellCount(range) === 1) {
      const block = numbersNextTo(source, sel.active);
      const text = block ? `=${name}(${rangeA1(block)})` : `=${name}()`;
      startEdit("cell", true, text);
      if (!block) caretTo.current = text.length - 1;
      return;
    }
    run(() => {
      const row = range.r2 + 1;
      ensureSize(doc, sheet, Math.max(size.rows, row + 1), size.cols, LOCAL);
      for (let c = range.c1; c <= range.c2; c++) {
        setInput(
          doc,
          { sheet, row, col: c },
          `=${name}(${rangeA1({ r1: range.r1, c1: c, r2: range.r2, c2: c })})`,
          locale,
          LOCAL,
        );
      }
    });
  };

  // ── Name box ────────────────────────────────────────────────────────────────────────────────────────────────────
  const onJump = (text: string): boolean => {
    if (!source) return false;
    const parsed = parseA1Range(text.trim());
    if (!parsed) return false;
    let target = sheet;
    if (parsed.sheet) {
      const found = sheetByName(doc, parsed.sheet);
      if (!found) return false;
      target = found;
    }
    if (!target) return false;
    selectRange(target, parsed);
    return true;
  };
  /** Chooses a range on a sheet (switching to it) and brings it into view. */
  const selectRange = (target: string, parsed: NonNullable<ReturnType<typeof parseA1Range>>) => {
    const there = target === sheet ? size : sheetSize(doc, target);
    const r1 = Math.min(parsed.r1, there.rows - 1);
    const c1 = Math.min(parsed.c1, there.cols - 1);
    const r2 = Math.min(parsed.r2, there.rows - 1);
    const c2 = Math.min(parsed.c2, there.cols - 1);
    if (target !== sheet) switchSheet(target);
    const next: SheetSelection = { active: { r: r1, c: c1 }, anchor: { r: r1, c: c1 }, corner: { r: r2, c: c2 } };
    if (parsed.whole === "rows") next.whole = "rows";
    if (parsed.whole === "cols") next.whole = "cols";
    setSel(next, { reveal: { r1, c1, r2, c2 }, sheet: target });
  };
  // A message's line about a range here (ADR 0199): its sheet, the range chosen and in view, once per click.
  const revealPart = props.reveal;
  const revealed = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per click (its key), as soon as a sheet can show it
  useEffect(() => {
    if (!revealPart || revealed.current === revealPart.key || !source) return;
    const { sheet: id, range: text } = revealPart.selection;
    const parsed = text ? parseA1Range(text) : null;
    const target = id && sheets.some((s) => s.id === id) ? id : sheet;
    if (!parsed || !target) return;
    revealed.current = revealPart.key;
    if (edit && !commit()) return;
    selectRange(target, parsed);
  }, [revealPart?.key, source !== null]);

  // ── Sheets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const switchSheet = (id: string) => {
    if (id === sheet) return;
    if (edit && !commit()) return;
    setPicked(id);
    onSearch({ sheet: id });
  };
  const [deleting, setDeleting] = useState<string | null>(null);
  const addOne = () => {
    if (!sheet) return;
    const at = sheets.findIndex((s) => s.id === sheet) + 1;
    let made = "";
    if (
      run(() => {
        made = addSheet(doc, nextSheetName(doc, t("live.sheet.tabs.base")), LOCAL, { at });
      })
    )
      switchSheet(made);
  };
  const renameOne = (id: string, name: string): boolean => run(() => renameSheet(doc, id, name, LOCAL));
  const duplicateOne = (id: string) => {
    let made = "";
    const name = uniqueSheetName(doc, t("live.sheet.tabs.copyName", { name: sheetName(doc, id) }).slice(0, 31));
    if (
      run(() => {
        made = duplicateSheet(doc, id, name, LOCAL);
      })
    )
      switchSheet(made);
  };
  const deleteOne = (id: string) => {
    const at = sheets.findIndex((s) => s.id === id);
    if (!run(() => deleteSheet(doc, id, LOCAL))) return;
    setDeleting(null);
    if (id === sheet) {
      const next = sheets.filter((s) => s.id !== id)[Math.max(0, at - 1)];
      if (next) {
        setPicked(next.id);
        onSearch({ sheet: next.id });
      }
    }
  };

  // ── Status line ─────────────────────────────────────────────────────────────────────────────────────────────────
  const stats = useMemo(() => (source && cellCount(range) > 1 ? statsOf(source.values(range)) : null), [source, range]);
  const status = stats && stats.count > 0 ? <SelectionStatus stats={stats} locale={locale} /> : null;

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const editorWidth = edit && editingAt ? editWidth(edit.text, grid.current, activeCell) : undefined;
  const barValue = edit ? edit.text : source ? source.input(sel.active.r, sel.active.c) : "";
  const cellText = edit?.where === "cell" || edit?.where === "bar" ? (edit?.text ?? "") : "";
  const assistAnchor = edit ? (edit.where === "bar" ? barBox.current : cellBox.current) : null;
  const cellFont = activeCell?.style;
  // What the cell holds goes with its name, so a screen reader says both as the selection moves.
  const cellName = rangeA1({ r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c });
  const cellAria = activeCell?.text
    ? t("live.sheet.cellWith", { cell: cellName, value: activeCell.text })
    : t("live.sheet.cellLabel", { cell: cellName });

  if (!state.loaded || !source || !current) {
    return (
      <div className="sheet sheet--loading" role="status" aria-busy="true" aria-label={t("live.sheet.loading")}>
        <div className="sheet-skeleton" />
      </div>
    );
  }

  const editor = (
    <div ref={cellBox} className="sheet-grid__editor" data-editing={edit ? "true" : "false"}>
      <FormulaInput
        ref={cellInput}
        boxClassName="sheet-editor"
        className="sheet-editor__input"
        boxStyle={{
          fontWeight: cellFont?.b ? 600 : undefined,
          fontStyle: cellFont?.i ? "italic" : undefined,
          fontSize: cellFont?.fs ? `${Math.round(cellFont.fs * 13) / 10}px` : undefined,
        }}
        aria-label={cellAria}
        aria-describedby={edit?.problem ? "sheet-problem" : undefined}
        aria-invalid={edit?.problem ? true : undefined}
        value={edit ? cellText : IDLE_TEXT}
        spans={edit ? refSpans : []}
        readOnly={!editable}
        inputMode={edit ? undefined : "none"}
        onText={(text, caret) => onText("cell", text, caret)}
        onCaret={onCaret}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (edit) onEditKey(e);
          else onNavKey(e);
        }}
        onFocus={(e) => {
          if (edit?.where === "bar") setEdit({ ...edit, where: "cell" });
          else if (!edit) e.currentTarget.select();
        }}
        onCopy={(e) => copyOut(e, false)}
        onCut={(e) => copyOut(e, true)}
        onPaste={onPaste}
      />
    </div>
  );

  return (
    <div className="sheet" data-readonly={editable ? undefined : "true"}>
      {editable ? (
        <SheetToolbar
          locale={locale}
          style={activeStyle}
          value={activeValue}
          merged={merged}
          frozen={frozen}
          active={sel.active}
          canUndo={undoState.undo > 0}
          canRedo={undoState.redo > 0}
          functionName={functionName}
          onUndo={undo}
          onRedo={redo}
          onFormat={format}
          onNumberFormat={onNumberFormat}
          onDecimals={onDecimals}
          onBorders={onBorders}
          onMerge={onMerge}
          onFreeze={onFreeze}
          onSort={sortBy}
          onFunction={onFunction}
          onDone={focusGrid}
        />
      ) : (
        <div className="sheet-quiet">{t("live.sheet.readOnly")}</div>
      )}
      <FormulaBar
        address={rangeText}
        onJump={onJump}
        onLeave={focusGrid}
        value={barValue}
        spans={edit ? refSpans : []}
        editable={editable}
        inputRef={barInput}
        boxRef={barBox}
        onFocusInput={() => {
          if (!edit) startEdit("bar", false);
          else if (edit.where !== "bar") setEdit({ ...edit, where: "bar", pointing: false });
        }}
        onText={(text, caret) => onText("bar", text, caret)}
        onCaret={onCaret}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          onEditKey(e);
        }}
      />
      <Grid
        ref={grid}
        source={source}
        selection={{ range, active: anchorOf(sel.active, source.merges), ...(sel.whole ? { whole: sel.whole } : {}) }}
        marks={marks}
        tags={others.tags}
        editing={editingAt}
        readOnly={!editable}
        editorWidth={editorWidth}
        editor={editor}
        errorTip={(cell) => (cell.error ? String(t(errorKey(cell.error.code, cell.error.circular) as never)) : "")}
        moreRows={
          editable ? (
            <Button
              size="sm"
              icon="plus"
              onClick={() => run(() => ensureSize(doc, sheet as string, size.rows + MORE_ROWS, size.cols, LOCAL))}
            >
              {t("live.sheet.moreRows", { count: MORE_ROWS })}
            </Button>
          ) : undefined
        }
        onPress={onPress}
        onDrag={onDrag}
        onRelease={onRelease}
        onDoubleClick={(at) => {
          if (!editable) return;
          setSel(collapsed(anchorOf(at, source.merges)), { reveal: false });
          requestAnimationFrame(() => startEditRef.current("cell", false));
        }}
        onFill={onFill}
        onResize={onResize}
        onAutoFit={onAutoFit}
        onMenu={onMenu}
        onUserScroll={ownMove}
        cursors={
          agentsHere
            ? (view) => <SheetCursors peers={peers} sheet={current.id} source={source} view={view} />
            : undefined
        }
      />
      <SheetTabs
        sheets={sheets}
        current={current.id}
        editable={editable}
        status={status}
        onSelect={switchSheet}
        onAdd={addOne}
        onRename={renameOne}
        onDuplicate={duplicateOne}
        onDelete={(id) => setDeleting(id)}
        onColor={(id, color) => run(() => setSheetTab(doc, id, color, LOCAL))}
        onMove={(id, to) => run(() => moveSheet(doc, id, to, LOCAL))}
      />
      <FormulaAssist
        anchor={assistAnchor}
        options={suggestions}
        highlight={Math.min(highlight, Math.max(0, suggestions.length - 1))}
        describe={(option) => {
          const key = fnKey(option.canonical);
          return i18n.exists(key) ? String(t(key as never)) : null;
        }}
        onPick={pickFunction}
        signature={signature}
        problem={edit?.problem ?? null}
        label={t("live.sheet.suggestions")}
      />
      {edit?.problem && (
        <span id="sheet-problem" className="sheet-visually-hidden">
          {edit.problem}
        </span>
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("live.sheet.tabs.deleteTitle", { name: deleting ? sheetName(doc, deleting) : "" })}
        description={t("live.sheet.tabs.deleteBody")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={() => deleting && deleteOne(deleting)}>
            {t("live.sheet.tabs.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the cell being typed in is now (its row or column may have moved). */
function editPos(edit: Edit, source: DocSource | null): CellPos | null {
  if (!source || source.sheet !== edit.sheet) return null;
  const r = source.rowIndex(edit.rowId);
  const c = source.colIndex(edit.colId);
  return r < 0 || c < 0 ? null : { r, c };
}

/** The editor grows to the right with what is typed. */
function editWidth(text: string, grid: GridHandle | null, cell: ReturnType<DocSource["cell"]>): number | undefined {
  if (!grid) return undefined;
  const longest = text.split("\n").reduce((w, line) => Math.max(w, grid.textWidth(line, cell)), 0);
  return Math.ceil(longest + 2 * CELL_PAD_X + 12);
}

function lastFilledInRow(source: DocSource, r: number): number {
  for (let c = source.cols.count - 1; c >= 0; c--) if (source.filled(r, c)) return c;
  return 0;
}

/** The block of filled cells around a cell (sorting with one cell selected sorts its table). */
export function regionAround(source: Pick<DocSource, "filled" | "rows" | "cols">, at: CellPos): GridRange {
  const out = { r1: at.r, c1: at.c, r2: at.r, c2: at.c };
  const rowHas = (r: number, c1: number, c2: number) => {
    for (let c = c1; c <= c2; c++) if (source.filled(r, c)) return true;
    return false;
  };
  const colHas = (c: number, r1: number, r2: number) => {
    for (let r = r1; r <= r2; r++) if (source.filled(r, c)) return true;
    return false;
  };
  for (let grew = true, guard = 0; grew && guard < 2000; guard++) {
    grew = false;
    if (out.r1 > 0 && rowHas(out.r1 - 1, Math.max(0, out.c1 - 1), Math.min(source.cols.count - 1, out.c2 + 1))) {
      out.r1--;
      grew = true;
    }
    if (
      out.r2 < source.rows.count - 1 &&
      rowHas(out.r2 + 1, Math.max(0, out.c1 - 1), Math.min(source.cols.count - 1, out.c2 + 1))
    ) {
      out.r2++;
      grew = true;
    }
    if (out.c1 > 0 && colHas(out.c1 - 1, out.r1, out.r2)) {
      out.c1--;
      grew = true;
    }
    if (out.c2 < source.cols.count - 1 && colHas(out.c2 + 1, out.r1, out.r2)) {
      out.c2++;
      grew = true;
    }
  }
  return out;
}

/** A first row of words over values in the sort column reads as a header, which stays on top. */
export function hasHeader(source: Pick<DocSource, "cell">, range: GridRange, byCol: number): boolean {
  if (range.r2 - range.r1 < 1) return false;
  for (let c = range.c1; c <= range.c2; c++) {
    const top = source.cell(range.r1, c);
    if (top && top.kind !== "text" && top.kind !== "empty") return false;
  }
  const first = source.cell(range.r1, byCol);
  const next = source.cell(range.r1 + 1, byCol);
  return !!first && first.kind === "text" && !!next && next.kind !== "text";
}

/** The numbers right above a cell (else to its left), for Σ. */
export function numbersNextTo(source: Pick<DocSource, "cell">, at: CellPos): GridRange | null {
  const isNumber = (r: number, c: number) => source.cell(r, c)?.kind === "number";
  if (at.r > 0 && isNumber(at.r - 1, at.c)) {
    let r = at.r - 1;
    while (r > 0 && isNumber(r - 1, at.c)) r--;
    return { r1: r, c1: at.c, r2: at.r - 1, c2: at.c };
  }
  if (at.c > 0 && isNumber(at.r, at.c - 1)) {
    let c = at.c - 1;
    while (c > 0 && isNumber(at.r, c - 1)) c--;
    return { r1: at.r, c1: c, r2: at.r, c2: at.c - 1 };
  }
  return null;
}
