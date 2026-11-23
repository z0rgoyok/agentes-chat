import {
  type ArtifactDetail,
  isLiveFileKind,
  type LiveRoom,
  nextFrame,
  useArtifact,
  useLiveDocVersion,
  useLivePeers,
  useLiveSelector,
} from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import {
  addSheet,
  type ClipCell,
  clearRange,
  copyRange,
  deleteCols,
  deleteRows,
  deleteSheet,
  duplicateSheet,
  indexOf,
  insertCols,
  insertRows,
  nextSheetName,
  parseA1Range,
  pasteCells,
  type RangeIds,
  type SheetLocale,
  sheetLocale,
  sheetName,
  sortRange,
} from "@agenteschat/live/spreadsheet";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Keyboard, StyleSheet, type TextInputInstance, View } from "react-native";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type * as Y from "yjs";
import { Filters, type HeaderMenuItem, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { showActionSheet } from "../../shared/PickerSheet";
import { copyText, errorHaptic, successHaptic } from "../../shared/parts";
import { liveClosed, liveRoute } from "../logic";
import { setFollowing, useFollowing } from "../shared/follow";
import { LiveBar, LiveUnavailable } from "../shared/LiveBar";
import { usePeerLook } from "../shared/peers";
import { type LiveDoc, useLiveDoc } from "../shared/useLiveDoc";
import { HereIsland } from "../slides/Island";
import { useAskAgent, useRevealHere, useTalkFocus } from "../talk/hooks";
import { FileTalkLine } from "../talk/TalkLine";
import { type Caret, CellBar, type CellEditing } from "./CellBar";
import { boxLabel, cellLabel, commitCell, formulaKeys, insertReference, takesReference } from "./edit";
import type { GridBox } from "./grid-view";
import { type GridSheetTab, liveGridLayout, liveGridSource, liveSheetTabs, selectionStats } from "./model";
import { GridBones, type GridPeer, type GridSelection, SheetGrid } from "./SheetGrid";

/**
 * A live spreadsheet on the phone (ADR 0196), pushed with its bar (`LiveBar`): the grid with its letters and numbers,
 * the sheets as chips over the cell bar, and the cell bar riding the keyboard while a cell is typed into, in the
 * person's language. Everyone else's selection shows in their color with their face; following someone (from the
 * faces' list) moves the view to wherever they select, until the person moves it themselves.
 */
export function SpreadsheetScreen({ id, focusId = null }: { id: string; focusId?: string | null }) {
  const { i18n } = useTranslation();
  const live = useLiveDoc(id, { kind: "spreadsheet" });
  const query = useArtifact(live.orgId, id);
  const detail = query.data;
  useTalkFocus(detail, focusId);
  const title = detail?.title ?? "";
  const closed = liveClosed(live);
  const locale = useMemo(() => sheetLocale(i18n.language || "en"), [i18n.language]);

  // A link that named the wrong screen (or a file that isn't a spreadsheet) gives way to the right one.
  const docKind = live.room && live.loaded ? live.room.kind : null;
  const kind = detail?.kind ?? docKind;
  useEffect(() => {
    if (!kind || kind === "spreadsheet") return;
    if (isLiveFileKind(kind)) router.replace(liveRoute(kind, id));
    else router.replace({ pathname: "/file/[id]", params: { id } });
  }, [kind, id]);

  if (closed)
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={undefined} />
        <LiveUnavailable reason={closed} />
      </>
    );
  if (!live.room || !live.loaded || docKind !== "spreadsheet")
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={detail} />
        <GridBones />
      </>
    );
  return <LiveSheet live={live} room={live.room} fileId={id} title={title} detail={detail} locale={locale} />;
}

const sameTabs = (a: GridSheetTab[], b: GridSheetTab[]) =>
  a.length === b.length && a.every((tab, i) => tab.id === b[i]?.id && tab.name === b[i]?.name);

/** Goes up whenever a sheet's shape changes (rows, columns, sizes, merges, frozen panes, sheets): not for its cells. */
function useSheetShape(doc: Y.Doc): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const sheets = doc.getMap("sheets");
    const order = doc.getArray("sheetOrder");
    const bump = () => setN((v) => v + 1);
    const deep = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      // A cell's value or look leaves the shape as it is.
      if (events.some((e) => e.path[1] !== "cells")) bump();
    };
    sheets.observeDeep(deep);
    order.observe(bump);
    return () => {
      sheets.unobserveDeep(deep);
      order.unobserve(bump);
    };
  }, [doc]);
  return n;
}

/** What was copied last in this app (its cells keep their formulas, which move as copies do when pasted here). */
let copied: { tsv: string; cells: ClipCell[][]; source: { sheet: string; r1: number; c1: number } } | null = null;

const firstCell = (frozenRows: number, frozenCols: number): GridSelection => ({
  row: frozenRows,
  col: frozenCols,
  box: { r1: frozenRows, c1: frozenCols, r2: frozenRows, c2: frozenCols },
});

function LiveSheet({
  live,
  room,
  fileId,
  title,
  detail,
  locale,
}: {
  live: LiveDoc;
  room: LiveRoom;
  fileId: string;
  title: string;
  detail: ArtifactDetail | undefined;
  locale: SheetLocale;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const doc = room.doc;
  const readOnly = live.mode !== "edit";

  // Values in the person's language (TEXT, VALUE, "1,5" typed), TODAY and NOW kept current.
  const engine = useMemo(() => room.engine(), [room]);
  useEffect(() => {
    engine.setLocale(locale);
  }, [engine, locale]);
  useEffect(() => {
    const timer = setInterval(() => engine.tick(), 60_000);
    return () => clearInterval(timer);
  }, [engine]);

  const tabs = useLiveSelector(room, liveSheetTabs, sameTabs) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const sheetId = tabs.some((tab) => tab.id === picked) ? picked : (tabs[0]?.id ?? null);
  const shape = useSheetShape(doc);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shape is read again when it changed (`shape`).
  const layout = useMemo(() => (sheetId ? liveGridLayout(doc, sheetId) : null), [doc, sheetId, shape]);
  const version = useLiveDocVersion(room, nextFrame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cells are read again after every change (`version`).
  const source = useMemo(
    () => (layout && sheetId ? liveGridSource(doc, engine, sheetId, layout, locale) : null),
    [doc, engine, sheetId, layout, locale, version],
  );

  // ── The selection ──────────────────────────────────────────────────────────────────────────────────────────────
  const [selection, setSelection] = useState<GridSelection>(() => firstCell(0, 0));
  const [reveal, setReveal] = useState<{ box: GridBox; n: number } | null>(null);
  const revealBox = useCallback((box: GridBox) => setReveal((r) => ({ box, n: (r?.n ?? 0) + 1 })), []);
  // Another sheet starts at its first cell; a sheet that lost rows or columns keeps the selection on it.
  const shownSheet = useRef(sheetId);
  useEffect(() => {
    if (!layout) return;
    if (shownSheet.current !== sheetId) {
      shownSheet.current = sheetId;
      setSelection(firstCell(layout.frozenRows, layout.frozenCols));
      return;
    }
    setSelection((sel) => {
      const lastRow = Math.max(0, layout.rows - 1);
      const lastCol = Math.max(0, layout.cols - 1);
      if (sel.row <= lastRow && sel.col <= lastCol && sel.box.r2 <= lastRow && sel.box.c2 <= lastCol) return sel;
      const row = Math.min(sel.row, lastRow);
      const col = Math.min(sel.col, lastCol);
      return {
        row,
        col,
        box: {
          r1: Math.min(sel.box.r1, lastRow),
          c1: Math.min(sel.box.c1, lastCol),
          r2: Math.min(sel.box.r2, lastRow),
          c2: Math.min(sel.box.c2, lastCol),
        },
      };
    });
  }, [layout, sheetId]);

  // ── Typing into a cell ─────────────────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<CellEditing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const caret = useRef<Caret>({ start: 0, end: 0 });
  const inserted = useRef<{ start: number; end: number } | null>(null);
  const input = useRef<TextInputInstance>(null);
  const inputOf = useCallback((row: number, col: number) => source?.input(row, col) ?? "", [source]);

  const startEditing = useCallback(
    (row = selection.row, col = selection.col) => {
      if (readOnly) return;
      const text = inputOf(row, col);
      caret.current = { start: text.length, end: text.length };
      inserted.current = null;
      setProblem(null);
      setEditing({ text, place: caret.current });
      revealBox({ r1: row, c1: col, r2: row, c2: col });
    },
    [readOnly, inputOf, selection.row, selection.col, revealBox],
  );
  /** Writes the cell being typed into; false (and the bar says why) when it couldn't. */
  const write = useCallback((): boolean => {
    if (!editing || !sheetId) return true;
    if (editing.text === inputOf(selection.row, selection.col)) return true;
    const result = commitCell(doc, { sheet: sheetId, row: selection.row, col: selection.col }, editing.text, locale);
    if (result.ok) {
      setProblem(null);
      return true;
    }
    errorHaptic();
    setProblem(t(`mobile.live.sheet.problem.${result.problem.key}`, result.problem.params ?? {}));
    return false;
  }, [editing, sheetId, inputOf, selection.row, selection.col, doc, locale, t]);
  const enter = () => {
    if (!write() || !layout) return;
    // On to the cell under it, still typing, as Enter does in a spreadsheet.
    const row = Math.min(selection.row + 1, layout.rows - 1);
    const col = selection.col;
    setSelection({ row, col, box: { r1: row, c1: col, r2: row, c2: col } });
    const text = row === selection.row ? (editing?.text ?? "") : inputOf(row, col);
    caret.current = { start: text.length, end: text.length };
    inserted.current = null;
    setEditing({ text, place: caret.current });
    revealBox({ r1: row, c1: col, r2: row, c2: col });
  };
  const done = () => {
    if (!write()) return;
    setEditing(null);
    Keyboard.dismiss();
  };
  const cancel = () => {
    setEditing(null);
    setProblem(null);
    Keyboard.dismiss();
  };
  // The file turned read-only under the person: what they typed waits in the field no more.
  useEffect(() => {
    if (readOnly) setEditing(null);
  }, [readOnly]);

  const onTapCell = (row: number, col: number, again: boolean): boolean => {
    if (editing) {
      const at = caret.current.start;
      if (editing.text.startsWith("=") && (takesReference(editing.text, at, locale) || inserted.current?.end === at)) {
        // A formula being typed takes the tapped cell's address where the caret is.
        const next = insertReference(editing.text, at, cellLabel(row, col), inserted.current);
        inserted.current = next.inserted;
        caret.current = { start: next.caret, end: next.caret };
        setEditing({ text: next.text, place: caret.current });
        return true;
      }
      if (!write()) return true;
      setEditing(null);
      Keyboard.dismiss();
      return false;
    }
    if (again && !readOnly) {
      startEditing(row, col);
      return true;
    }
    return false;
  };

  // ── Presence ───────────────────────────────────────────────────────────────────────────────────────────────────
  const typing = editing !== null;
  useEffect(() => {
    if (!sheetId || !layout) return;
    const r1 = layout.rowIds[selection.box.r1];
    const c1 = layout.colIds[selection.box.c1];
    const r2 = layout.rowIds[selection.box.r2];
    const c2 = layout.colIds[selection.box.c2];
    room.setLocal({
      mode: typing ? "editing" : "viewing",
      at: { sheet: sheetId },
      sel:
        r1 && c1 && r2 && c2
          ? { sheet: { sheet: sheetId, r1, c1, r2, c2, ...(typing ? { editing: true } : {}) } }
          : undefined,
    });
  }, [room, sheetId, layout, selection.box, typing]);

  const peers = useLivePeers(room);
  const look = usePeerLook();
  const indexes = useMemo(
    () => (layout ? { rows: indexOf(layout.rowIds), cols: indexOf(layout.colIds) } : null),
    [layout],
  );
  const rings = useMemo<GridPeer[]>(() => {
    if (!indexes || !sheetId) return [];
    return peers.flatMap((p) => {
      const s = p.state.sel?.sheet;
      if (p.self || !s || s.sheet !== sheetId) return [];
      const r1 = indexes.rows.get(s.r1);
      const r2 = indexes.rows.get(s.r2);
      const c1 = indexes.cols.get(s.c1);
      const c2 = indexes.cols.get(s.c2);
      if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return [];
      return [
        {
          key: String(p.clientId),
          box: { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) },
          tint: look(p.user).tint,
          who: { type: p.user.kind === "agent" ? "agent" : "person", id: p.user.id },
          editing: p.state.mode === "editing",
        } satisfies GridPeer,
      ];
    });
  }, [peers, indexes, sheetId, look]);

  // ── Following someone ──────────────────────────────────────────────────────────────────────────────────────────
  const followId = useFollowing(fileId);
  const followed = followId === null ? null : (peers.find((p) => p.clientId === followId && !p.self) ?? null);
  useEffect(() => {
    room.setLocal({ following: followId ?? undefined });
  }, [room, followId]);
  // They left the file: following ends.
  const gone = followId !== null && followed === null && live.status === "live";
  useEffect(() => {
    if (gone) setFollowing(fileId, null);
  }, [gone, fileId]);
  const theirSel = followed?.state.sel?.sheet;
  const theirSheet = theirSel?.sheet ?? followed?.state.at?.sheet;
  const theirKey = theirSel ? `${theirSel.sheet}:${theirSel.r1}:${theirSel.c1}:${theirSel.r2}:${theirSel.c2}` : "";
  useEffect(() => {
    if (theirSheet && theirSheet !== sheetId && tabs.some((tab) => tab.id === theirSheet)) setPicked(theirSheet);
  }, [theirSheet, sheetId, tabs]);
  const theirRing = rings.find((r) => r.key === String(followId));
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per move of theirs (`theirKey`).
  useEffect(() => {
    if (theirRing) revealBox(theirRing.box);
  }, [theirKey, theirRing?.box.r1, theirRing?.box.c1]);
  const stopFollowing = useCallback(() => {
    if (followId !== null) setFollowing(fileId, null);
  }, [followId, fileId]);

  // ── The file's conversation (ADR 0199) ─────────────────────────────────────────────────────────────────────────
  const asking = useAskAgent(detail);
  // A message's line about some cells: their sheet, the cells chosen and in view.
  useRevealHere(fileId, Boolean(layout), (sel) => {
    const range = sel.range ? parseA1Range(sel.range) : null;
    if (!range) return;
    stopFollowing();
    if (sel.sheet && sel.sheet !== sheetId && tabs.some((tab) => tab.id === sel.sheet)) setPicked(sel.sheet);
    const rows = Math.max(1, layout?.rows ?? 1);
    const cols = Math.max(1, layout?.cols ?? 1);
    const box = {
      r1: Math.min(range.r1, rows - 1),
      c1: Math.min(range.c1, cols - 1),
      r2: Math.min(range.r2, rows - 1),
      c2: Math.min(range.c2, cols - 1),
    };
    setSelection({ row: box.r1, col: box.c1, box });
    revealBox(box);
  });

  // ── Menus ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const rangeOf = (box: GridBox): RangeIds | null => (sheetId ? { sheet: sheetId, ...box } : null);
  const attempt = (run: () => void) => {
    try {
      run();
    } catch {
      errorHaptic();
      toast({ title: t("mobile.live.sheet.cantDo"), icon: "x" });
    }
  };
  const copy = () => {
    const range = rangeOf(selection.box);
    if (!range) return;
    const clip = copyRange(doc, range, engine, locale);
    copied = { tsv: clip.tsv, cells: clip.cells, source: { sheet: range.sheet, r1: range.r1, c1: range.c1 } };
    void copyText(clip.tsv).then((ok) => {
      if (ok) successHaptic();
      toast(ok ? { title: t("mobile.live.sheet.copied"), icon: "copy" } : { title: t("mobile.app.failed"), icon: "x" });
    });
  };
  const paste = async () => {
    if (!sheetId) return;
    const text = await Clipboard.getStringAsync().catch(() => "");
    if (!text) return;
    // What this app copied keeps its formulas; anything else is read as typed.
    const clip = copied && copied.tsv === text ? copied : { tsv: text };
    attempt(() => {
      const written = pasteCells(doc, { sheet: sheetId, row: selection.row, col: selection.col }, clip, locale, LOCAL);
      setSelection({ row: written.r1, col: written.c1, box: written });
    });
  };
  const sort = (desc: boolean) => {
    if (!sheetId || !layout) return;
    const single = selection.box.r1 === selection.box.r2 && selection.box.c1 === selection.box.c2;
    // One cell: the whole sheet's rows by its column, the frozen rows (a header) staying on top.
    const range: RangeIds = single
      ? { sheet: sheetId, r1: layout.frozenRows, c1: 0, r2: layout.rows - 1, c2: layout.cols - 1 }
      : { sheet: sheetId, ...selection.box };
    attempt(() => sortRange(doc, range, selection.col, desc, engine, LOCAL));
  };
  const hold = (row: number, col: number) => {
    if (!sheetId) return;
    const box =
      selection.box.r1 <= row && row <= selection.box.r2 && selection.box.c1 <= col && col <= selection.box.c2
        ? selection.box
        : { r1: row, c1: col, r2: row, c2: col };
    const rows = box.r2 - box.r1 + 1;
    const cols = box.c2 - box.c1 + 1;
    const label = layout ? boxLabel(box, layout) : cellLabel(row, col);
    showActionSheet(label, [
      { label: t("mobile.live.sheet.menu.copy"), icon: "copy", onPress: copy },
      // "Ask Atlas" (ADR 0199): the conversation opens with these cells over its composer.
      ...(asking.label
        ? [
            {
              label: asking.label,
              icon: "sparkle" as const,
              onPress: () => asking.ask({ label: `${sheetName(doc, sheetId)}!${label}`, sheet: sheetId, range: label }),
            },
          ]
        : []),
      ...(readOnly
        ? []
        : [
            { label: t("mobile.live.sheet.menu.paste"), icon: "paste" as const, onPress: () => void paste() },
            {
              label: t("mobile.live.sheet.menu.clear"),
              icon: "x" as const,
              onPress: () => attempt(() => clearRange(doc, { sheet: sheetId, ...box }, "contents", LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.rowsAbove", { count: rows }),
              icon: "up" as const,
              onPress: () => attempt(() => insertRows(doc, sheetId, box.r1, rows, LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.rowsBelow", { count: rows }),
              icon: "down" as const,
              onPress: () => attempt(() => insertRows(doc, sheetId, box.r2 + 1, rows, LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.colsLeft", { count: cols }),
              icon: "left" as const,
              onPress: () => attempt(() => insertCols(doc, sheetId, box.c1, cols, LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.colsRight", { count: cols }),
              icon: "right" as const,
              onPress: () => attempt(() => insertCols(doc, sheetId, box.c2 + 1, cols, LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.sortUp"),
              icon: "up" as const,
              onPress: () => sort(false),
            },
            {
              label: t("mobile.live.sheet.menu.sortDown"),
              icon: "down" as const,
              onPress: () => sort(true),
            },
            {
              label: t("mobile.live.sheet.menu.deleteRows", { count: rows }),
              icon: "trash" as const,
              destructive: true,
              onPress: () => attempt(() => deleteRows(doc, sheetId, box.r1, rows, LOCAL)),
            },
            {
              label: t("mobile.live.sheet.menu.deleteCols", { count: cols }),
              icon: "trash" as const,
              destructive: true,
              onPress: () => attempt(() => deleteCols(doc, sheetId, box.c1, cols, LOCAL)),
            },
          ]),
    ]);
  };

  const sheetMenu: HeaderMenuItem[] =
    readOnly || !sheetId
      ? []
      : [
          {
            icon: "plus",
            sf: "plus.square.on.square",
            label: t("mobile.live.sheet.newSheet"),
            onPress: () =>
              attempt(() => {
                const added = addSheet(doc, nextSheetName(doc, t("mobile.live.sheet.sheetWord")), LOCAL);
                setPicked(added);
              }),
          },
          {
            icon: "copy",
            sf: "doc.on.doc",
            label: t("mobile.live.sheet.duplicateSheet"),
            onPress: () =>
              attempt(() => {
                const name = t("mobile.live.sheet.copyOf", { name: sheetName(doc, sheetId) });
                setPicked(duplicateSheet(doc, sheetId, name, LOCAL));
              }),
          },
          ...(tabs.length > 1
            ? [
                {
                  icon: "trash" as const,
                  sf: "trash" as const,
                  label: t("mobile.live.sheet.deleteSheet"),
                  destructive: true,
                  onPress: () =>
                    Alert.alert(
                      t("mobile.live.sheet.deleteSheetTitle", { name: sheetName(doc, sheetId) }),
                      t("mobile.live.sheet.deleteSheetText"),
                      [
                        { text: t("mobile.common.cancel"), style: "cancel" },
                        {
                          text: t("mobile.live.sheet.deleteSheet"),
                          style: "destructive",
                          onPress: () => attempt(() => deleteSheet(doc, sheetId, LOCAL)),
                        },
                      ],
                    ),
                },
              ]
            : []),
        ];

  // ── The bars ───────────────────────────────────────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!source) return null;
    const s = selectionStats(source, selection.box);
    if (!s) return null;
    const n = new Intl.NumberFormat(locale.tag, { maximumFractionDigits: 2 });
    if (s.numbers === 0) return t("mobile.live.sheet.countOnly", { count: n.format(s.count) });
    return t("mobile.live.sheet.stats", {
      sum: n.format(s.sum),
      average: n.format(s.average ?? 0),
      count: n.format(s.count),
    });
  }, [source, selection.box, locale.tag, t]);
  const keyboard = useReanimatedKeyboardAnimation();
  const homeRoom = useAnimatedStyle(() => ({ height: insets.bottom * (1 - keyboard.progress.get()) }));
  const label = layout ? boxLabel(selection.box, layout) : "";

  if (!source || !layout || !sheetId)
    return (
      <>
        <LiveBar live={live} fileId={fileId} title={title} detail={detail} />
        <GridBones />
      </>
    );
  return (
    <>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={sheetMenu} />
      <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.fill}>
        <View style={styles.fill}>
          <SheetGrid
            source={source}
            selection={selection}
            onSelect={setSelection}
            onTapCell={onTapCell}
            onHold={hold}
            peers={rings}
            reveal={reveal}
            onMoved={stopFollowing}
            editing={typing}
          />
          {followed ? (
            // The live files' island (it fades in and out), under the sheet's column letters.
            <HereIsland
              who={followed.user}
              words={t("mobile.live.here.followingName", { name: look(followed.user).name })}
              action={t("mobile.live.here.stop")}
              onAction={stopFollowing}
              top={32}
            />
          ) : null}
        </View>
        {tabs.length > 1 && !typing ? (
          <View style={[styles.tabs, { backgroundColor: c.bg }]}>
            <Filters
              items={tabs.map((tab) => ({ key: tab.id, label: tab.name }))}
              value={sheetId}
              onChange={(key) => {
                stopFollowing();
                setPicked(key);
              }}
            />
          </View>
        ) : null}
        <CellBar
          label={label}
          value={inputOf(selection.row, selection.col)}
          stats={stats}
          readOnly={readOnly}
          editing={editing}
          problem={problem}
          keys={formulaKeys(locale)}
          input={input}
          caret={caret}
          onEdit={() => startEditing()}
          onChange={(next) => {
            if (!next.place) inserted.current = null;
            setEditing(next);
            if (problem) setProblem(null);
          }}
          onEnter={enter}
          onDone={done}
          onCancel={cancel}
        />
        {typing ? <Animated.View style={[homeRoom, { backgroundColor: c.bg }]} /> : <FileTalkLine file={detail} />}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { paddingTop: 8 },
});
