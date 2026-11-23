import {
  type ClipCell,
  errorKey,
  parseA1Range,
  sheetLocale,
  toHtml,
  toTsv,
  type WorkbookData,
} from "@agenteschat/live/spreadsheet";
import { cx, isApple } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { openContextMenu } from "@/lib/context-menu";
import { FormulaBar } from "./FormulaBar";
import { FormulaInput } from "./FormulaInput";
import { Grid, type GridArea, type GridHandle } from "./Grid";
import {
  anchorOf,
  type CellPos,
  cellCount,
  collapsed,
  type GridRange,
  IDLE_TEXT,
  jumpFrom,
  rangeA1,
  type SheetSelection,
  selectionRange,
  statsOf,
  stepFrom,
} from "./model";
import { SheetTabs } from "./SheetTabs";
import { WorkbookSource } from "./source";
import { SelectionStatus } from "./status";
import "./sheet.css";

/**
 * An uploaded workbook drawn read-only (ADR 0198): the same grid, formula bar and sheet tabs as a live spreadsheet,
 * over what the server read from the file (values as the file saved them, in the reader's language and formats).
 * Cells can be selected, walked with the keys and copied; nothing can be changed. `notice` takes the toolbar's place
 * ("Arquivo do Excel · Editar como planilha"); without it the line says the file is read-only.
 */
export interface WorkbookViewProps {
  workbook: WorkbookData;
  /** The reader's language (the app's by default): numbers, dates and errors are shown in it. */
  locale?: string;
  /** The line over the grid (what the file is, and making an editable copy). */
  notice?: ReactNode;
  className?: string;
}

/** A copy reaches at most this many cells (a whole sheet selected copies as far as its used cells). */
const COPY_MAX_CELLS = 200_000;

export function WorkbookView({ workbook, locale: tag, notice, className }: WorkbookViewProps) {
  const { t, i18n } = useTranslation();
  const locale = useMemo(() => sheetLocale(tag ?? i18n.language), [tag, i18n.language]);
  const sheets = workbook.sheets;
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, sheets.length - 1));
  const data = sheets[current];
  const source = useMemo(
    () => (data ? new WorkbookSource(data, String(current), locale) : null),
    [data, current, locale],
  );
  const size = source ? { rows: source.rows.count, cols: source.cols.count } : { rows: 0, cols: 0 };

  const [selections, setSelections] = useState<Record<number, SheetSelection>>({});
  const sel = selections[current] ?? collapsed({ r: 0, c: 0 });
  const range: GridRange = useMemo(
    () =>
      source
        ? selectionRange(sel, { rows: source.rows.count, cols: source.cols.count }, source.merges)
        : { r1: 0, c1: 0, r2: 0, c2: 0 },
    [sel, source],
  );
  const grid = useRef<GridHandle>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const bar = useRef<HTMLTextAreaElement>(null);
  const dragArea = useRef<GridArea | null>(null);

  const setSel = (next: SheetSelection, reveal = true) => {
    setSelections((all) => ({ ...all, [current]: next }));
    if (reveal) {
      const at = next.corner;
      requestAnimationFrame(() => grid.current?.reveal({ r1: at.r, c1: at.c, r2: at.r, c2: at.c }));
    }
  };

  // The grid's field keeps its placeholder selected, so copy reaches it (the Mac app's Edit menu too).
  useLayoutEffect(() => {
    const el = field.current;
    if (el && document.activeElement === el && (el.selectionStart !== 0 || el.selectionEnd !== el.value.length)) {
      el.select();
    }
  });

  if (!source || !data) {
    return (
      <div className={cx("sheet", "sheet--readonly", className)} data-readonly="true">
        <div className="sheet-quiet">
          {notice ?? <span className="sheet-quiet__words">{t("live.sheet.empty")}</span>}
        </div>
      </div>
    );
  }

  const move = (dr: number, dc: number, extend: boolean, jump: boolean) => {
    const from = extend ? sel.corner : sel.active;
    const to = jump
      ? jumpFrom(from, dr, dc, size, (r, c) => source.filled(r, c))
      : stepFrom(from, dr, dc, size, source.merges);
    if (extend) setSel({ ...sel, corner: to, whole: sel.whole === "all" ? undefined : sel.whole });
    else setSel(collapsed(anchorOf(to, source.merges)));
  };

  const selectAll = () =>
    setSel(
      { active: sel.active, anchor: { r: 0, c: 0 }, corner: { r: size.rows - 1, c: size.cols - 1 }, whole: "all" },
      false,
    );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = isApple() ? e.metaKey : e.ctrlKey;
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      move(arrow[0], arrow[1], e.shiftKey, mod);
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (mod) return;
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1, false, false);
        return;
      case "Enter":
        e.preventDefault();
        move(e.shiftKey ? -1 : 1, 0, false, false);
        return;
      case "Home":
        e.preventDefault();
        setSel(collapsed({ r: e.ctrlKey ? 0 : sel.active.r, c: 0 }));
        return;
      case "End": {
        e.preventDefault();
        const used = source.used();
        if (used) setSel(collapsed(anchorOf(used, source.merges)));
        return;
      }
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const rows = grid.current?.pageRows() ?? 20;
        move(e.key === "PageUp" ? -rows : rows, 0, e.shiftKey, false);
        return;
      }
    }
    // Nothing typed lands: the file can't change.
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") e.preventDefault();
  };

  /** The selection as tab-separated text and a table, for Excel, Google Sheets and documents. */
  const copied = (): { tsv: string; html: string } => {
    const used = source.used();
    const r2 = Math.min(range.r2, used?.r ?? range.r1);
    const c2 = Math.min(range.c2, used?.c ?? range.c1);
    const rows: ClipCell[][] = [];
    if ((r2 - range.r1 + 1) * (c2 - range.c1 + 1) <= COPY_MAX_CELLS) {
      for (let r = range.r1; r <= r2; r++) {
        const row: ClipCell[] = [];
        for (let c = range.c1; c <= c2; c++) {
          const cell = source.cell(r, c);
          const value = source.value(r, c);
          const clip: ClipCell = { display: cell?.text ?? "" };
          if (value !== null && typeof value !== "object") clip.v = value;
          if (cell?.style) clip.s = cell.style;
          if (cell?.error) clip.e = cell.error.code;
          row.push(clip);
        }
        rows.push(row);
      }
    }
    return { tsv: toTsv(rows.map((row) => row.map((c) => c.display ?? ""))), html: toHtml(rows) };
  };

  const onCopy = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const { tsv, html } = copied();
    e.clipboardData.setData("text/plain", tsv);
    e.clipboardData.setData("text/html", html);
  };

  const copyFromMenu = async () => {
    const { tsv, html } = copied();
    try {
      const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (Item && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new Item({
            "text/plain": new Blob([tsv], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else await navigator.clipboard?.writeText(tsv);
    } catch {
      // The keys still copy (⌘C).
    }
  };

  const press = (at: CellPos, area: GridArea, shift: boolean) => {
    field.current?.focus({ preventScroll: true });
    dragArea.current = area;
    const last = { r: size.rows - 1, c: size.cols - 1 };
    if (area === "corner") selectAll();
    else if (area === "col") {
      if (shift) setSel({ ...sel, corner: { r: last.r, c: at.c }, whole: "cols" }, false);
      else
        setSel(
          { active: { r: 0, c: at.c }, anchor: { r: 0, c: at.c }, corner: { r: last.r, c: at.c }, whole: "cols" },
          false,
        );
    } else if (area === "row") {
      if (shift) setSel({ ...sel, corner: { r: at.r, c: last.c }, whole: "rows" }, false);
      else
        setSel(
          { active: { r: at.r, c: 0 }, anchor: { r: at.r, c: 0 }, corner: { r: at.r, c: last.c }, whole: "rows" },
          false,
        );
    } else if (shift) setSel({ ...sel, corner: at, whole: undefined }, false);
    else setSel(collapsed(anchorOf(at, source.merges)), false);
  };
  const drag = (at: CellPos, area: GridArea) => {
    const from = dragArea.current;
    if (!from) return;
    if (from === "col") setSel({ ...sel, corner: { r: size.rows - 1, c: at.c }, whole: "cols" }, false);
    else if (from === "row") setSel({ ...sel, corner: { r: at.r, c: size.cols - 1 }, whole: "rows" }, false);
    else if (area === "cell") setSel({ ...sel, corner: at, whole: undefined }, false);
  };

  const onJump = (text: string): boolean => {
    const parsed = parseA1Range(text.trim());
    if (!parsed) return false;
    let target = current;
    if (parsed.sheet) {
      const found = sheets.findIndex((s) => s.name.toLowerCase() === parsed.sheet?.toLowerCase());
      if (found < 0) return false;
      target = found;
    }
    const at = (r: number, c: number) => ({ r: Math.min(r, size.rows - 1), c: Math.min(c, size.cols - 1) });
    const next: SheetSelection = {
      active: at(parsed.r1, parsed.c1),
      anchor: at(parsed.r1, parsed.c1),
      corner: at(parsed.r2, parsed.c2),
    };
    setIndex(target);
    setSelections((all) => ({ ...all, [target]: next }));
    requestAnimationFrame(() =>
      grid.current?.reveal({ r1: next.anchor.r, c1: next.anchor.c, r2: next.corner.r, c2: next.corner.c }),
    );
    return true;
  };

  const stats = cellCount(range) > 1 ? statsOf(source.values(range)) : null;
  const active = anchorOf(sel.active, source.merges);
  const cellName = rangeA1({ r1: active.r, c1: active.c, r2: active.r, c2: active.c });
  const shown = source.cell(active.r, active.c)?.text;
  const cellAria = shown
    ? t("live.sheet.cellWith", { cell: cellName, value: shown })
    : t("live.sheet.cellLabel", { cell: cellName });
  const focusGrid = () => field.current?.focus({ preventScroll: true });

  return (
    <div className={cx("sheet", "sheet--readonly", className)} data-readonly="true">
      <div className="sheet-quiet">
        {notice ?? <span className="sheet-quiet__words">{t("live.sheet.readOnly")}</span>}
      </div>
      <FormulaBar
        address={rangeA1(range, size)}
        onJump={onJump}
        onLeave={focusGrid}
        value={source.input(active.r, active.c)}
        spans={[]}
        editable={false}
        inputRef={bar}
        onFocusInput={() => {}}
        onText={() => {}}
        onCaret={() => {}}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            focusGrid();
          }
        }}
      />
      <Grid
        ref={grid}
        source={source}
        selection={{ range, active, ...(sel.whole ? { whole: sel.whole } : {}) }}
        marks={[]}
        tags={[]}
        editing={null}
        readOnly
        editor={
          <div className="sheet-grid__editor" data-editing="false">
            <FormulaInput
              ref={field}
              boxClassName="sheet-editor"
              className="sheet-editor__input"
              aria-label={cellAria}
              value={IDLE_TEXT}
              spans={[]}
              readOnly
              inputMode="none"
              onText={() => {}}
              onKeyDown={onKey}
              onFocus={(e) => e.currentTarget.select()}
              onCopy={onCopy}
              onCut={onCopy}
            />
          </div>
        }
        errorTip={(cell) => (cell.error ? String(t(errorKey(cell.error.code, cell.error.circular) as never)) : "")}
        onPress={(at, area, how) => press(at, area, how.shift)}
        onDrag={drag}
        onRelease={() => {
          dragArea.current = null;
        }}
        onDoubleClick={() => {}}
        onFill={() => {}}
        onResize={() => {}}
        onAutoFit={() => {}}
        onMenu={(x, y, at, area) => {
          if (!(area === "cell" && at.r >= range.r1 && at.r <= range.r2 && at.c >= range.c1 && at.c <= range.c2)) {
            press(at, area, false);
          }
          focusGrid();
          requestAnimationFrame(() =>
            openContextMenu(x, y, [
              { kind: "item", id: "copy", label: t("live.sheet.menu.copy"), run: () => void copyFromMenu() },
            ]),
          );
        }}
        onUserScroll={() => {}}
      />
      <SheetTabs
        sheets={sheets.map((s, i) => ({ id: String(i), name: s.name, tab: s.tab }))}
        current={String(current)}
        editable={false}
        status={stats && stats.count > 0 ? <SelectionStatus stats={stats} locale={locale} /> : null}
        onSelect={(id) => setIndex(Number(id))}
        onAdd={() => {}}
        onRename={() => false}
        onDuplicate={() => {}}
        onDelete={() => {}}
        onColor={() => {}}
        onMove={() => {}}
      />
    </div>
  );
}
