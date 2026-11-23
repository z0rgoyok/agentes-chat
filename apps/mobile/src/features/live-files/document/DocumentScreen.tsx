import {
  type ArtifactDetail,
  isLiveFileKind,
  type LiveRoom,
  nextFrame,
  useArtifact,
  useLiveDocVersion,
  useLivePeers,
} from "@agenteschat/client";
import { LOCAL, readableOn } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import {
  blockIndex,
  type DocBlock,
  type DocRun,
  deleteBlocks,
  documentBody,
  documentSource,
  insertBlocks,
  readBlock,
  readDocument,
  replaceBlocks,
} from "@agenteschat/live/document";
import { Image } from "expo-image";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Text as RNText,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextStyle,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated from "react-native-reanimated";
import type * as Y from "yjs";
import {
  type HeaderMenuItem,
  Icon,
  type IconName,
  PressScale,
  SCREEN_X,
  Text,
  type TextVariant,
  usePulse,
  useSystemText,
  useTheme,
  useToast,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Face } from "../../shared/Face";
import { useDirectory } from "../../shared/hooks";
import { pickOne, showActionSheet } from "../../shared/PickerSheet";
import { errorHaptic, MONO } from "../../shared/parts";
import { liveClosed, liveRoute } from "../logic";
import { LiveBar, LiveUnavailable } from "../shared/LiveBar";
import { usePeerLook } from "../shared/peers";
import { type LiveDoc, useLiveDoc } from "../shared/useLiveDoc";
import { useFilePictures } from "../slides/pictures";
import { useAskAgent, useRevealHere, useTalkFocus } from "../talk/hooks";
import { FileTalkLine } from "../talk/TalkLine";
import {
  askSelection,
  BLOCK_STYLES,
  type BlockStyle,
  blockStyle,
  editable,
  listNumbers,
  restyled,
  toggledList,
  toggledQuote,
} from "./logic";
import {
  appendRuns,
  applyDiff,
  deleteRange,
  editableElement,
  formatRange,
  hasMark,
  type Marks,
  mapCaret,
  marksAt,
  plainOf,
  rangeHas,
  runsOf,
  runsSlice,
  type TextDiff,
  textDiff,
  withMark,
} from "./text";

/**
 * A document on the phone (ADR 0200), pushed with the file's bar (`LiveBar`): the page as the Wiki reads it, its title
 * and where it came from ("Ada imported Plan.docx") over its headings, paragraphs, lists, quotes, code, tables and
 * pictures, with whoever else is in it shown at the block they are on (an agent with its face). A tap on a block edits
 * it in place, its words with their marks, each change written into the file as the smallest edit of that block's
 * text (`text.ts`), so two people typing in one block both keep their words; over the keyboard, the format
 * bar (style, bold, italic, lists, quote, link) ends with the file's agent ("Ask Atlas", the block quoted in its
 * conversation, ADR 0199). Pictures and tables are edited on a computer. Under the page, the file's conversation.
 * `focusId`: a message of the conversation to open at.
 */
export function DocumentScreen({ id, focusId = null }: { id: string; focusId?: string | null }) {
  const live = useLiveDoc(id, { kind: "document" });
  const query = useArtifact(live.orgId, id);
  const detail = query.data;
  const title = detail?.title ?? "";
  const closed = liveClosed(live);
  useTalkFocus(detail, focusId);

  // A link that named the wrong screen (or a file that isn't a document) gives way to the right one.
  const docKind = live.room && live.loaded ? live.room.kind : null;
  const kind = detail?.kind ?? docKind;
  useEffect(() => {
    if (!kind || kind === "document") return;
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
  if (!live.room || !live.loaded || docKind !== "document")
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={detail} />
        <DocumentBones />
      </>
    );
  return <LiveDocument live={live} room={live.room} fileId={id} title={title} detail={detail} />;
}

/** The block being edited: its id, and where the caret goes once (a block just opened, split or restyled). */
interface Editing {
  id: string;
  place?: Caret;
}

type Caret = { start: number; end: number };

/** An address a link may have (the rich text's own rule: https, http or mailto). */
const LINKABLE = /^(https?:\/\/|mailto:)\S+$/i;

function LiveDocument({
  live,
  room,
  fileId,
  title,
  detail,
}: {
  live: LiveDoc;
  room: LiveRoom;
  fileId: string;
  title: string;
  detail: ArtifactDetail | undefined;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const toast = useToast();
  const doc = room.doc;
  const readOnly = live.mode !== "edit";
  const version = useLiveDocVersion(room, nextFrame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after every change (`version`).
  const blocks = useMemo(() => readDocument(doc), [doc, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after every change (`version`).
  const source = useMemo(() => documentSource(doc), [doc, version]);
  const numbers = useMemo(() => listNumbers(blocks), [blocks]);

  // ── Editing a block, character by character ────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<Editing | null>(null);
  const caret = useRef<Caret>({ start: 0, end: 0 });
  const input = useRef<TextInputInstance>(null);
  const latest = useRef<Editing | null>(null);
  latest.current = editing;
  // The marks the format bar turned on with nothing chosen: what the next words typed there take.
  const [pending, setPending] = useState<Marks | null>(null);
  const pendingAt = useRef(-1);
  // The marks where the caret is (the format bar lights bold and italic).
  const [here, setHere] = useState<Marks>({});
  // Adding a link: its words, and the address being typed (the block's field gives way to it meanwhile).
  const [link, setLink] = useState<{ start: number; end: number; url: string } | null>(null);
  const linking = useRef(false);
  const attempt = useCallback(
    (run: () => void) => {
      try {
        run();
        return true;
      } catch {
        errorHaptic();
        toast({ title: t("live.canvas.errors.other"), icon: "x" });
        return false;
      }
    },
    [toast, t],
  );
  /** The words of block `id` as stored now (null: gone, or not a block the phone edits). */
  const elementOf = useCallback(
    (id: string): Y.XmlElement | null => {
      try {
        return editableElement(documentBody(doc).get(blockIndex(doc, id)) as Y.XmlElement);
      } catch {
        return null;
      }
    },
    [doc],
  );
  const elementNow = () => (latest.current ? elementOf(latest.current.id) : null);
  const edit = (block: DocBlock, at: "end" | number = "end") => {
    if (readOnly || !block.id) return;
    const element = elementOf(block.id);
    if (!element) {
      toast({ title: t("mobile.live.doc.notHere"), icon: "info" });
      return;
    }
    const length = plainOf(element).length;
    const pos = at === "end" ? length : Math.min(at, length);
    caret.current = { start: pos, end: pos };
    setPending(null);
    setEditing({ id: block.id, place: caret.current });
  };
  // The field let go (the keyboard down, a tap on the page); another block taken meanwhile, or a link's address being
  // typed, stays.
  const leave = (id: string) => {
    if (linking.current || latest.current?.id !== id) return;
    setEditing(null);
    setPending(null);
  };
  // Gone under the person (someone deleted it): nothing to edit.
  const editedGone = editing !== null && !blocks.some((b) => b.id === editing.id);
  useEffect(() => {
    if (editedGone) setEditing(null);
  }, [editedGone]);
  // The file turned read-only under the person: the field goes.
  useEffect(() => {
    if (readOnly) setEditing(null);
  }, [readOnly]);

  // Presence: the block being edited, for everyone else's screens (ADR 0200).
  const editingId = editing?.id ?? null;
  useEffect(() => {
    room.setLocal({
      mode: editingId ? "editing" : "viewing",
      sel: editingId ? { document: [editingId] } : undefined,
    });
  }, [room, editingId]);
  useEffect(
    () => () => {
      if (!room.destroyed) room.setLocal({ sel: undefined, mode: "viewing" });
    },
    [room],
  );

  /** What the next words typed take: the format bar's marks, else the character before the caret's. */
  const marksFor = (element: Y.XmlElement, at: number) => pending ?? marksAt(element, at);
  /** The caret moved: the format bar's marks for the next words go once it is somewhere else. */
  const moved = (sel: Caret) => {
    caret.current = sel;
    const element = elementNow();
    if (pending && (sel.start < pendingAt.current || sel.start > pendingAt.current + 1)) setPending(null);
    if (!element) return;
    const marks = sel.end > sel.start ? marksAt(element, sel.start + 1) : (pending ?? marksAt(element, sel.start));
    setHere((now) => (JSON.stringify(now) === JSON.stringify(marks) ? now : marks));
  };
  const typed = (diff: TextDiff) => {
    const element = elementNow();
    if (!element) return;
    const marks = marksFor(element, diff.at);
    attempt(() => doc.transact(() => applyDiff(element, diff, marks), LOCAL));
    if (pending) setPending(null);
  };

  /** Return: the words after the caret go to a new block under this one (a list goes on; an empty item ends it). */
  const split = () => {
    const now = latest.current;
    const element = elementNow();
    const block = now ? readBlock(doc, now.id) : null;
    if (!now || !element || !block) return;
    const length = plainOf(element).length;
    const { start, end } = caret.current;
    if (block.type === "paragraph" && block.list && length === 0) {
      write(now.id, toggledList(block, block.list), { start: 0, end: 0 });
      return;
    }
    const tail = runsSlice(runsOf(element), end, length);
    // A list item's next one is an item too (a new id, the file gives it); after a heading or a quote, a paragraph.
    let next: DocBlock = { type: "paragraph", runs: tail };
    if (block.type === "paragraph") {
      const { id: _id, runs: _runs, ...item } = block;
      next = { ...item, runs: tail };
    }
    let made: string | undefined;
    const ok = attempt(() =>
      doc.transact(() => {
        deleteRange(element, start, length);
        made = insertBlocks(doc, [next], { after: now.id }, LOCAL)[0];
      }, LOCAL),
    );
    if (ok && made) {
      caret.current = { start: 0, end: 0 };
      setEditing({ id: made, place: caret.current });
    }
  };
  /**
   * Delete at a block's start: a list item becomes a paragraph; an empty block goes; anything else joins the block
   * above, its words (and their marks) at that block's end, the caret where they meet.
   */
  const backspace = () => {
    const now = latest.current;
    const element = elementNow();
    const block = now ? readBlock(doc, now.id) : null;
    if (!now || !element || !block || caret.current.start !== 0 || caret.current.end !== 0) return;
    if (block.type === "paragraph" && block.list) {
      write(now.id, toggledList(block, block.list), { start: 0, end: 0 });
      return;
    }
    const at = blocks.findIndex((b) => b.id === now.id);
    const above = at > 0 ? blocks[at - 1] : undefined;
    const target = above?.id ? elementOf(above.id) : null;
    if (!above?.id || !target || target.nodeName === "code_block") return;
    const meet = plainOf(target).length;
    const runs = runsOf(element);
    const aboveId = above.id;
    const ok = attempt(() =>
      doc.transact(() => {
        if (runs.length > 0) appendRuns(target, runs);
        deleteBlocks(doc, now.id, undefined, LOCAL);
      }, LOCAL),
    );
    if (ok) {
      caret.current = { start: meet, end: meet };
      setEditing({ id: aboveId, place: caret.current });
    }
  };

  // ── The format bar ─────────────────────────────────────────────────────────────────────────────────────────────
  /** The block changed whole (its style, its list), and edited again: a sheet may have taken the keyboard meanwhile. */
  const write = (id: string, block: DocBlock, place: Caret = caret.current) => {
    if (!attempt(() => replaceBlocks(doc, id, undefined, [block], LOCAL))) return;
    caret.current = place;
    setEditing({ id, place });
  };
  const change = (how: (block: DocBlock) => DocBlock) => {
    const id = latest.current?.id;
    const block = id ? readBlock(doc, id) : null;
    if (id && block) write(id, how(block));
  };
  /** Bold or italic: on the words chosen (off when they all have it already), else for the next words typed. */
  const toggleMark = (mark: "bold" | "italic") => {
    const element = elementNow();
    if (!element) return;
    const { start, end } = caret.current;
    if (end > start) {
      const on = !rangeHas(element, start, end, mark);
      attempt(() => doc.transact(() => formatRange(element, start, end, { [mark]: on ? {} : null }), LOCAL));
      setHere((now) => withMark(now, mark, on));
      return;
    }
    const base = pending ?? marksAt(element, start);
    const next = withMark(base, mark, !hasMark(base, mark));
    pendingAt.current = start;
    setPending(next);
    setHere(next);
  };
  /** Link: on the words chosen, its address typed over the keyboard; on a link already, it comes off. */
  const startLink = () => {
    const element = elementNow();
    const { start, end } = caret.current;
    if (!element || end <= start) {
      toast({ title: t("mobile.live.doc.linkChoose"), icon: "info" });
      return;
    }
    if (rangeHas(element, start, end, "link")) {
      attempt(() => doc.transact(() => formatRange(element, start, end, { link: null }), LOCAL));
      return;
    }
    linking.current = true;
    setLink({ start, end, url: "" });
  };
  const endLink = (apply: boolean) => {
    const element = elementNow();
    const now = link;
    linking.current = false;
    setLink(null);
    if (apply && element && now) {
      const url = now.url.trim();
      if (!LINKABLE.test(url)) toast({ title: t("mobile.live.doc.linkBad"), icon: "x" });
      else attempt(() => doc.transact(() => formatRange(element, now.start, now.end, { link: { href: url } }), LOCAL));
    }
    // Back to the words, where they were.
    const id = latest.current?.id;
    if (id && now) {
      caret.current = { start: now.end, end: now.end };
      setEditing({ id, place: caret.current });
      requestAnimationFrame(() => input.current?.focus());
    }
  };
  const chooseStyle = async () => {
    const id = latest.current?.id;
    const block = id ? readBlock(doc, id) : null;
    if (!id || !block) return;
    const place = caret.current;
    const picked = (await pickOne({
      title: t("mobile.live.doc.style"),
      value: blockStyle(block),
      options: BLOCK_STYLES.map((style) => ({ key: style, label: t(`mobile.live.doc.styles.${style}`) })),
    })) as BlockStyle | null;
    if (picked && picked !== blockStyle(block)) write(id, restyled(block, picked), place);
    else {
      caret.current = place;
      setEditing({ id, place });
    }
  };
  const asking = useAskAgent(detail);
  const askHere = () => {
    const now = latest.current;
    const element = elementNow();
    const block = now ? readBlock(doc, now.id) : null;
    if (!now || !element || !block) return;
    const { start, end } = caret.current;
    const chosen = end > start ? plainOf(element).slice(start, end) : undefined;
    setEditing(null);
    asking.ask(askSelection(block, chosen));
  };

  // ── A block's menu ─────────────────────────────────────────────────────────────────────────────────────────────
  const hold = (block: DocBlock) => {
    const actions: { label: string; icon: IconName; destructive?: boolean; onPress: () => void }[] = [];
    const label = asking.label;
    if (label) actions.push({ label, icon: "sparkle", onPress: () => asking.ask(askSelection(block)) });
    if (!readOnly && editable(block))
      actions.push({ label: t("live.canvas.actions.editText"), icon: "pen", onPress: () => edit(block) });
    if (!readOnly && block.id && blocks.length > 1)
      actions.push({
        label: t("live.canvas.actions.delete"),
        icon: "trash",
        destructive: true,
        onPress: () => attempt(() => deleteBlocks(doc, block.id as string, undefined, LOCAL)),
      });
    if (actions.length > 0) showActionSheet(t("live.kinds.document"), actions);
  };
  const addParagraph = () => {
    const last = blocks.at(-1);
    if (last?.type === "paragraph" && !last.list && last.runs.length === 0) {
      edit(last);
      return;
    }
    let made: string | undefined;
    if (attempt(() => (made = insertBlocks(doc, [{ type: "paragraph", runs: [] }], {}, LOCAL)[0])) && made) {
      caret.current = { start: 0, end: 0 };
      setEditing({ id: made, place: caret.current });
    }
  };

  // ── Everyone else, and the part a message's line names ─────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const others = useMemo(() => {
    const out = new Map<string, Peer[]>();
    for (const p of peers) {
      if (p.self) continue;
      for (const id of p.state.sel?.document ?? []) out.set(id, [...(out.get(id) ?? []), p]);
    }
    return out;
  }, [peers]);
  const scroll = useRef<ScrollViewInstance>(null);
  const tops = useRef(new Map<string, number>());
  const [lit, setLit] = useState<string | null>(null);
  useRevealHere(fileId, blocks.length > 0, (sel) => {
    const id = sel.block;
    const y = id ? tops.current.get(id) : undefined;
    if (!id || y === undefined) return;
    scroll.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    setLit(id);
  });
  useEffect(() => {
    if (!lit) return;
    const id = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(id);
  }, [lit]);

  const menu: HeaderMenuItem[] = asking.label
    ? [{ icon: "sparkle", sf: "sparkles", label: asking.label, onPress: () => asking.ask(null) }]
    : [];
  const dir = useDirectory();
  const maker = detail ? dir.nameOf(detail.createdBy) : "";
  const empty = blocks.length === 1 && blocks[0]?.type === "paragraph" && blocks[0].runs.length === 0;
  const editedElement = editing ? elementOf(editing.id) : null;
  return (
    <>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={menu} />
      <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.fill}>
        <ScrollView
          ref={scroll}
          style={[styles.fill, { backgroundColor: c.bg }]}
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Text variant="display2" style={styles.title}>
            {title}
          </Text>
          {detail ? (
            <View style={styles.by}>
              <Face who={detail.createdBy} size={18} live={false} />
              <Text variant="footnote" tone="faint" style={styles.byWords}>
                {source ? (
                  <Trans
                    i18nKey="mobile.live.talk.imported"
                    values={{ name: maker, file: source.name }}
                    components={[<Text key="b" variant="footnote" tone="ink2" style={styles.bold} />]}
                  />
                ) : (
                  <Trans
                    i18nKey="live.shell.meta.made"
                    values={{ name: maker }}
                    components={[<Text key="b" variant="footnote" tone="ink2" style={styles.bold} />]}
                  />
                )}
              </Text>
            </View>
          ) : null}
          {blocks.map((block, i) => {
            const id = block.id ?? `at-${i}`;
            const isEditing = editing !== null && editing.id === block.id && editedElement !== null;
            return (
              <View
                key={id}
                onLayout={(e) => {
                  if (block.id) tops.current.set(block.id, e.nativeEvent.layout.y);
                }}
                style={[styles.block, lit === block.id && { backgroundColor: c.plate }]}
              >
                <BlockFlags peers={block.id ? others.get(block.id) : undefined} />
                {isEditing && editing && editedElement ? (
                  <BlockField
                    block={block}
                    element={editedElement}
                    number={block.id ? numbers.get(block.id) : undefined}
                    place={editing.place}
                    caret={caret}
                    input={input}
                    onTyped={typed}
                    onSelection={(sel) => {
                      moved(sel);
                      if (editing.place) setEditing({ id: editing.id });
                    }}
                    onSplit={split}
                    onBackspace={backspace}
                    onBlur={() => leave(editing.id)}
                  />
                ) : (
                  <PressScale
                    haptic={false}
                    to={0.99}
                    onPress={() => edit(block)}
                    onLongPress={() => hold(block)}
                    delayLongPress={400}
                    accessibilityRole={readOnly ? "text" : "button"}
                    accessibilityHint={readOnly || !editable(block) ? undefined : t("mobile.live.doc.editHint")}
                  >
                    <BlockView
                      block={block}
                      fileId={fileId}
                      orgId={room.orgId}
                      number={block.id ? numbers.get(block.id) : undefined}
                      placeholder={empty && !readOnly ? t("mobile.live.doc.placeholder") : undefined}
                    />
                  </PressScale>
                )}
              </View>
            );
          })}
          {readOnly ? null : (
            <PressScale
              haptic={false}
              onPress={addParagraph}
              accessibilityRole="button"
              style={styles.add}
              contentStyle={styles.addIn}
            >
              <Icon name="plus" size={16} color={c.faint} />
              <Text variant="subhead" tone="faint">
                {t("mobile.live.doc.add")}
              </Text>
            </PressScale>
          )}
        </ScrollView>
        {link ? (
          <LinkBar
            url={link.url}
            onUrl={(url) => setLink((now) => (now ? { ...now, url } : now))}
            onDone={() => endLink(true)}
            onCancel={() => endLink(false)}
          />
        ) : editing ? (
          <FormatBar
            agent={asking.agent?.id ?? null}
            askLabel={asking.label}
            bold={hasMark(here, "bold")}
            italic={hasMark(here, "italic")}
            onStyle={() => void chooseStyle()}
            onBold={() => toggleMark("bold")}
            onItalic={() => toggleMark("italic")}
            onBullets={() => change((b) => toggledList(b, "bullet"))}
            onNumbers={() => change((b) => toggledList(b, "ordered"))}
            onQuote={() => change(toggledQuote)}
            onLink={startLink}
            onAsk={askHere}
          />
        ) : null}
      </KeyboardAvoidingView>
      {editing ? null : <FileTalkLine file={detail} />}
    </>
  );
}

/** A block's text look, by its style: a heading in its size, code in mono, the rest as the page's body. */
function variantOf(block: DocBlock): { variant: TextVariant; weight?: "bold" | "semibold" } {
  if (block.type === "heading")
    return block.level === 1
      ? { variant: "title2", weight: "bold" }
      : block.level === 2
        ? { variant: "title", weight: "semibold" }
        : { variant: "callout", weight: "semibold" };
  return { variant: "body" };
}

/** A run's marks as a text style. */
function runStyle(run: DocRun, link: string, code: string): TextStyle {
  const line = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
  return {
    ...(run.bold ? { fontWeight: weights.bold } : {}),
    ...(run.italic ? { fontStyle: "italic" } : {}),
    ...(line ? { textDecorationLine: line as TextStyle["textDecorationLine"] } : {}),
    ...(run.code ? { fontFamily: MONO, backgroundColor: code } : {}),
    ...(run.color ? { color: run.color } : {}),
    ...(run.link ? { color: link, textDecorationLine: "underline" } : {}),
  };
}

/** A paragraph's words with their marks. */
function Runs({ runs }: { runs: readonly DocRun[] }) {
  const { colors: c } = useTheme();
  return (
    <>
      {runs.map((run, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids of their own; their place is their key
        <RNText key={i} style={runStyle(run, c.agent, c.plate)}>
          {run.text}
        </RNText>
      ))}
    </>
  );
}

/** A block of the page as the Wiki shows it. */
const BlockView = memo(function BlockView({
  block,
  fileId,
  orgId,
  number,
  placeholder,
}: {
  block: DocBlock;
  fileId: string;
  orgId: string;
  number: number | undefined;
  placeholder?: string | undefined;
}) {
  const { colors: c } = useTheme();
  switch (block.type) {
    case "paragraph":
    case "heading": {
      const { variant, weight } = variantOf(block);
      const words =
        block.runs.length === 0 && placeholder ? (
          <Text variant={variant} tone="faint">
            {placeholder}
          </Text>
        ) : (
          <Text variant={variant} style={[weight && { fontWeight: weights[weight] }, alignOf(block.align)]}>
            {block.runs.length === 0 ? " " : <Runs runs={block.runs} />}
          </Text>
        );
      if (block.type === "paragraph" && block.list) {
        return (
          <View style={[styles.item, { paddingLeft: (block.level ?? 0) * LIST_INDENT }]}>
            <Text variant="body" tone="muted" style={styles.marker}>
              {block.list === "ordered" ? `${number ?? 1}.` : "•"}
            </Text>
            <View style={styles.fill}>{words}</View>
          </View>
        );
      }
      return words;
    }
    case "blockquote":
      return (
        <View style={[styles.quote, { borderLeftColor: c.line2 }]}>
          {block.blocks.map((inner, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a quote's inner blocks have no ids
            <BlockView key={i} block={inner} fileId={fileId} orgId={orgId} number={undefined} />
          ))}
        </View>
      );
    case "code_block":
      return (
        <ScrollView
          horizontal
          style={[styles.code, { backgroundColor: c.plate }]}
          contentContainerStyle={styles.codeIn}
        >
          <RNText style={[styles.mono, { color: c.ink }]}>{block.text || " "}</RNText>
        </ScrollView>
      );
    case "horizontal_rule":
      return <View style={[styles.rule, { backgroundColor: c.line2 }]} />;
    case "image":
      return <DocPicture block={block} fileId={fileId} orgId={orgId} />;
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.table, { borderColor: c.line2 }]}>
            {block.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a table's rows have no ids
              <View key={r} style={[styles.row, r > 0 && [styles.rowLine, { borderTopColor: c.line2 }]]}>
                {row.map((cell, k) => (
                  <View
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells have no ids
                    key={k}
                    style={[styles.cell, k > 0 && [styles.cellLine, { borderLeftColor: c.line2 }]]}
                  >
                    {cell.blocks.map((p, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a cell's paragraphs have no ids
                      <Text key={j} variant="subhead" style={block.header && r === 0 ? styles.bold : undefined}>
                        <Runs runs={p.runs} />
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
});

const alignOf = (align: "left" | "center" | "right" | undefined): TextStyle | undefined =>
  align && align !== "left" ? { textAlign: align } : undefined;

/** A picture of the file at its share of the page's width, its own proportions once it loads. */
function DocPicture({
  block,
  fileId,
  orgId,
}: {
  block: Extract<DocBlock, { type: "image" }>;
  fileId: string;
  orgId: string;
}) {
  const { colors: c } = useTheme();
  const picture = useFilePictures(orgId, fileId);
  const { width } = useWindowDimensions();
  const [ratio, setRatio] = useState(4 / 3);
  const w = (width - SCREEN_X * 2) * Math.max(0.1, Math.min(1, block.width ?? 1));
  return (
    <Image
      source={picture(block.asset)}
      recyclingKey={block.asset}
      contentFit="contain"
      accessibilityLabel={block.alt}
      onLoad={(e) => {
        if (e.source.width > 0 && e.source.height > 0) setRatio(e.source.width / e.source.height);
      }}
      style={[styles.picture, { width: w, aspectRatio: ratio, backgroundColor: c.plate }]}
    />
  );
}

/**
 * The block being edited: a field in its look showing the block's words with their marks, each change applied to the
 * file as the smallest edit (`onTyped`). Someone else's typing in the same block comes in under the caret, which stays
 * on the person's own words. Return makes the next block; Delete at its start joins the block above.
 */
function BlockField({
  block,
  element,
  number,
  place,
  caret,
  input,
  onTyped,
  onSelection,
  onSplit,
  onBackspace,
  onBlur,
}: {
  block: DocBlock;
  element: Y.XmlElement;
  number: number | undefined;
  /** Where the caret goes, once. */
  place: Caret | undefined;
  caret: RefObject<Caret>;
  input: RefObject<TextInputInstance | null>;
  onTyped: (diff: TextDiff) => void;
  onSelection: (sel: Caret) => void;
  onSplit: () => void;
  onBackspace: () => void;
  onBlur: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { variant, weight } = variantOf(block);
  const look = useSystemText(
    variant === "title2" ? "title2" : variant === "title" ? "headline" : variant === "callout" ? "callout" : "body",
    weight ? weights[weight] : undefined,
  );
  const code = block.type === "code_block";
  const listed = block.type === "paragraph" ? block.list : undefined;
  // The block's words as stored now (the screen draws again with every change to the file).
  const runs = runsOf(element);
  const plain = runs.map((r) => r.text).join("");
  // What the field holds: changed by the person's typing at once, by anyone else's when it arrives.
  const shown = useRef(plain);
  const [moved, setMoved] = useState<Caret | null>(null);
  useLayoutEffect(() => {
    if (plain === shown.current) return;
    const diff = textDiff(shown.current, plain);
    shown.current = plain;
    if (!diff) return;
    // Someone else's change: the caret stays on the person's words.
    const now = caret.current;
    setMoved({ start: mapCaret(now.start, diff), end: mapCaret(now.end, diff) });
  }, [plain, caret]);
  const selection = moved ?? place;
  const field = (
    <TextInput
      ref={input}
      autoFocus
      multiline
      onChangeText={(next) => {
        const diff = textDiff(shown.current, next);
        if (!diff) return;
        onTyped(diff);
        shown.current = plainOf(element);
      }}
      {...(selection ? { selection } : {})}
      onSelectionChange={(e) => {
        if (moved) setMoved(null);
        onSelection(e.nativeEvent.selection);
      }}
      // Return makes the next block; code keeps its lines.
      submitBehavior={code ? "newline" : "submit"}
      onSubmitEditing={code ? undefined : onSplit}
      onKeyPress={(e) => {
        if (e.nativeEvent.key === "Backspace") onBackspace();
      }}
      onBlur={onBlur}
      placeholder={t("mobile.live.doc.placeholder")}
      placeholderTextColor={c.faint}
      scrollEnabled={false}
      style={[
        look,
        styles.field,
        { color: c.ink },
        code && [styles.mono, styles.codeIn, { backgroundColor: c.plate, borderRadius: 8 }],
        block.type === "blockquote" && [styles.quote, { borderLeftColor: c.line2 }],
      ]}
    >
      {runs.map((run, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs have no ids of their own; their place is their key
        <RNText key={i} style={runStyle(run, c.agent, c.plate)}>
          {run.text}
        </RNText>
      ))}
    </TextInput>
  );
  if (!listed) return field;
  return (
    <View style={[styles.item, { paddingLeft: ((block.type === "paragraph" && block.level) || 0) * LIST_INDENT }]}>
      <Text variant="body" tone="muted" style={styles.marker}>
        {listed === "ordered" ? `${number ?? 1}.` : "•"}
      </Text>
      <View style={styles.fill}>{field}</View>
    </View>
  );
}

/** Who else is at a block: a person's name on their color, an agent's face and name (ADR 0200). */
function BlockFlags({ peers }: { peers: Peer[] | undefined }) {
  const { colors: c } = useTheme();
  const look = usePeerLook();
  if (!peers || peers.length === 0) return null;
  return (
    <View style={styles.flags} pointerEvents="none">
      {peers.slice(0, 3).map((p) => {
        const who = look(p.user);
        const agent = p.user.kind === "agent";
        return (
          <View
            key={p.clientId}
            style={[
              styles.flag,
              agent
                ? { backgroundColor: c.raised, borderColor: c.line2, borderWidth: StyleSheet.hairlineWidth }
                : { backgroundColor: who.tint },
            ]}
          >
            {agent ? <Face who={{ type: "agent", id: p.user.id }} size={14} live={false} /> : null}
            {/* White on a dark tint, ink on a light one (dark mode's pastels), as a pointer's name tag. */}
            <Text
              variant="caption"
              style={[styles.flagName, { color: agent ? c.ink : readableOn(who.tint, ["#ffffff", "#111111"]) }]}
              numberOfLines={1}
            >
              {who.name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** The bar over the keyboard while a block is edited: style, marks, lists, quote, link, and the file's agent. */
function FormatBar({
  agent,
  askLabel,
  bold,
  italic,
  onStyle,
  onBold,
  onItalic,
  onBullets,
  onNumbers,
  onQuote,
  onLink,
  onAsk,
}: {
  agent: string | null;
  askLabel: string | null;
  /** Bold and italic where the caret is (or for the next words): their buttons lit. */
  bold: boolean;
  italic: boolean;
  onStyle: () => void;
  onBold: () => void;
  onItalic: () => void;
  onBullets: () => void;
  onNumbers: () => void;
  onQuote: () => void;
  onLink: () => void;
  onAsk: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View
      style={[styles.formatBar, { backgroundColor: c.grouped, borderTopColor: c.line2 }]}
      accessibilityRole="toolbar"
    >
      <FormatButton icon="heading" label={t("mobile.live.doc.style")} onPress={onStyle} />
      <FormatButton icon="bold" label={t("mobile.live.doc.bold")} on={bold} onPress={onBold} />
      <FormatButton icon="italic" label={t("mobile.live.doc.italic")} on={italic} onPress={onItalic} />
      <FormatButton icon="bulletList" label={t("mobile.live.doc.bullets")} onPress={onBullets} />
      <FormatButton icon="numberedList" label={t("mobile.live.doc.numbers")} onPress={onNumbers} />
      <FormatButton icon="quote" label={t("mobile.live.doc.quote")} onPress={onQuote} />
      <FormatButton icon="link" label={t("mobile.live.doc.link")} onPress={onLink} />
      {agent && askLabel ? (
        <PressScale
          haptic={false}
          onPress={onAsk}
          accessibilityRole="button"
          accessibilityLabel={askLabel}
          style={[styles.formatButton, { backgroundColor: c.plate }]}
          contentStyle={styles.formatButtonIn}
        >
          <Face who={{ type: "agent", id: agent }} size={22} live={false} />
        </PressScale>
      ) : null}
    </View>
  );
}

function FormatButton({
  icon,
  label,
  on = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  on?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <PressScale
      haptic={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={[styles.formatButton, on && { backgroundColor: c.plate }]}
      contentStyle={styles.formatButtonIn}
    >
      <Icon name={icon} size={20} color={c.ink} />
    </PressScale>
  );
}

/** A link's address over the keyboard, for the words chosen: Done puts it on them, × leaves them as they were. */
function LinkBar({
  url,
  onUrl,
  onDone,
  onCancel,
}: {
  url: string;
  onUrl: (url: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const field = useSystemText("body");
  return (
    <View style={[styles.formatBar, styles.linkBar, { backgroundColor: c.grouped, borderTopColor: c.line2 }]}>
      <Icon name="link" size={18} color={c.muted} />
      <TextInput
        autoFocus
        value={url}
        onChangeText={onUrl}
        onSubmitEditing={onDone}
        placeholder={t("mobile.live.doc.linkPlaceholder")}
        placeholderTextColor={c.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        accessibilityLabel={t("mobile.live.doc.link")}
        style={[field, styles.linkField, { color: c.ink }]}
      />
      <PressScale
        haptic={false}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.common.cancel")}
        style={styles.formatButton}
        contentStyle={styles.formatButtonIn}
      >
        <Icon name="x" size={18} color={c.muted} />
      </PressScale>
      <PressScale
        haptic={false}
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.live.doc.linkApply")}
        style={styles.formatButton}
        contentStyle={styles.formatButtonIn}
      >
        <Icon name="check" size={20} color={c.ink} />
      </PressScale>
    </View>
  );
}

/** The page's shape while the document opens: a title and a few lines, quiet. */
function DocumentBones() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View
      style={[styles.fill, styles.page, { backgroundColor: c.bg }, pulse]}
      accessible
      accessibilityLabel={t("mobile.common.loading")}
      accessibilityState={{ busy: true }}
    >
      <View style={[styles.boneTitle, { backgroundColor: c.plate }]} />
      {[0.92, 0.84, 0.88, 0.6].map((w) => (
        <View key={w} style={[styles.boneLine, { width: `${w * 100}%`, backgroundColor: c.plate }]} />
      ))}
    </Animated.View>
  );
}

/** A list's indent per level, and its marker's column. */
const LIST_INDENT = 20;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingHorizontal: SCREEN_X + 4, paddingTop: 12, paddingBottom: 32 },
  title: { marginBottom: 6 },
  // The face on the first line of the words beside it (an imported file's name can wrap them).
  by: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 16 },
  byWords: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  block: { marginVertical: 4, borderRadius: 6 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  marker: { minWidth: 18, textAlign: "right" },
  quote: { borderLeftWidth: 3, paddingLeft: 12 },
  code: { borderRadius: 8 },
  codeIn: { padding: 12 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  picture: { borderRadius: 8 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  row: { flexDirection: "row" },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { width: 140, paddingHorizontal: 8, paddingVertical: 6 },
  cellLine: { borderLeftWidth: StyleSheet.hairlineWidth },
  field: { padding: 0, margin: 0, textAlignVertical: "top" },
  flags: { position: "absolute", right: 0, top: -14, zIndex: 1, flexDirection: "row", gap: 4 },
  flag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 20,
    maxWidth: 140,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderBottomLeftRadius: 3,
  },
  flagName: { fontWeight: "600" },
  add: { alignSelf: "flex-start", marginTop: 12 },
  addIn: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  formatBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    height: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  linkBar: { gap: 4, justifyContent: "flex-start" },
  linkField: { flex: 1, paddingVertical: 8 },
  formatButton: { width: 44, height: 44, borderRadius: Math.round(44 * 0.3) },
  formatButtonIn: { alignItems: "center", justifyContent: "center" },
  boneTitle: { height: 28, width: "70%", borderRadius: 6, marginBottom: 20 },
  boneLine: { height: 12, borderRadius: 4, marginBottom: 12 },
});
