import { everyoneWord, isEveryoneWord } from "@agenteschat/client/lib/everyone";
import { linkPill } from "@agenteschat/client/lib/link-pills";
import { parseFileLink, parseMessageLink } from "@agenteschat/client/lib/message-links";
import { linkSite, type TableCellRead, tableColumnKinds } from "@agenteschat/client/lib/table";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Pressable,
  Text as RNText,
  ScrollView,
  type StyleProp,
  StyleSheet,
  type TextStyle,
  useWindowDimensions,
  View,
} from "react-native";
import { ScrollView as GestureScrollView } from "react-native-gesture-handler";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { serverUrl } from "@/lib/server";
import { Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import { variantStyle } from "@/ui/Text";
import { openPage } from "../ai/parts";
import { ownLinkHref } from "../links/app-links";
import { useColors } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { SiteIcon } from "../shared/SiteIcon";
import { ChannelRefText } from "./ChannelRefText";
import { FileRefText } from "./FileRefText";
import { IdRefText } from "./IdRefText";
import { keepColumns, keptColumns } from "./kept-sizes";
import { LinkPillText } from "./LinkPillText";
import {
  type Block,
  CHAT_TEXT_MAX_SCALE,
  chatCellOf,
  chatCodeOf,
  fitTableColumns,
  type Inline,
  mentionTint,
  tableColumnWidths,
  tableKey,
  tableResolvesLate,
} from "./logic";
import { useKeptWidth, useLayoutKey, useRowLook } from "./look";
import { MessageRefText } from "./MessageRefText";
import { useRowDirectory, useRowMyHandle } from "./row-data";

/**
 * Inline marks of a message (bold, italic, `code`, links, a message's or a file's link as its pill, an internal id as
 * what it names, @mentions, #channels), inside a Text. `channelRefs`: the
 * message's `meta.channelRefs` (a renamed channel still links).
 */
export function Spans({
  inline,
  channelRefs,
  everyone = false,
  ink,
}: {
  inline: Inline[];
  channelRefs?: Record<string, string>;
  /** The message mentions everyone (`meta.mentionsEveryone`): its word shows in the reader's language. */
  everyone?: boolean;
  /** Over a solid bubble: a mention's color and plate in place of its own. */
  ink?: string | undefined;
}) {
  const c = useColors();
  // In a conversation, the size of code in its card (`chatCodeOf`), so inline and fenced code agree at every step.
  const sized = useRowLook().text;
  const codeSize = sized ? { fontSize: chatCodeOf(sized).fontSize } : undefined;
  return (
    <>
      {inline.map((s, i) => {
        const key = `${i}-${s.kind}`;
        switch (s.kind) {
          case "bold":
            return (
              <RNText key={key} style={styles.bold}>
                {s.text}
              </RNText>
            );
          case "italic":
            return (
              <RNText key={key} style={styles.italic}>
                {s.text}
              </RNText>
            );
          case "code":
            return (
              // On the plate, a thin space of room at each side: a text inside a text takes no padding.
              <RNText key={key} style={[styles.inlineCode, codeSize, { backgroundColor: c.plate, color: c.ink2 }]}>
                {`\u2009${s.text}\u2009`}
              </RNText>
            );
          case "link": {
            // A message or a file here: its pill, opening it in the app.
            const message = parseMessageLink(s.href, [serverUrl()]);
            if (message) return <MessageRefText key={key} link={message} />;
            const file = parseFileLink(s.href, [serverUrl()]);
            if (file) return <FileRefText key={key} link={file} />;
            // An address as written, whatever way: the words of a link written with its own stay.
            const pill = s.text === s.href ? linkPill(s.href) : null;
            if (pill) return <LinkPillText key={key} href={s.href} pill={pill} />;
            // A page of this server opens its screen here; any other site the in-app browser. A press on a link wins
            // over the row's long press.
            const own = ownLinkHref(s.href, serverUrl());
            return (
              <RNText
                key={key}
                accessibilityRole="link"
                onPress={() => (own ? router.push(own as never) : openPage(s.href))}
                style={[styles.link, { textDecorationColor: c.faint }]}
              >
                {s.text}
              </RNText>
            );
          }
          case "channel":
            return <ChannelRefText key={key} name={s.name} text={s.text} refs={channelRefs} />;
          case "id": {
            const shown = (
              <RNText
                key={key}
                style={s.code ? [styles.inlineCode, { backgroundColor: c.plate, color: c.ink2 }] : undefined}
              >
                {s.text}
              </RNText>
            );
            return <IdRefText key={key} id={s.id} shown={shown} />;
          }
          case "mention":
            return <MentionText key={key} text={s.text} everyone={everyone} ink={ink} />;
          default:
            return <RNText key={key}>{s.text}</RNText>;
        }
      })}
    </>
  );
}

/**
 * An @mention in a text: the agent's chip in its tone, mine and everyone's in amber, a person's in ink; a handle nobody
 * here has stays as written. A piece of its own, so only a text with a mention reads the directory, the reader's handle
 * and the language: every paragraph, list item and table cell of a conversation is a `Spans`, and each paid for them.
 * In a conversation the directory and the handle are the ones its rows share (`row-data.tsx`).
 */
function MentionText({ text, everyone, ink }: { text: string; everyone: boolean; ink: string | undefined }) {
  const c = useColors();
  const myHandle = useRowMyHandle();
  const { i18n } = useTranslation();
  const { agentById, memberByHandle } = useRowDirectory();
  const { scheme } = useTheme();
  const handle = text.slice(1);
  const all = everyone && isEveryoneWord(handle);
  const tint = mentionTint(handle, [...agentById.values()], scheme);
  if (!all && !tint && !memberByHandle.has(handle.toLowerCase())) return <RNText>{text}</RNText>;
  return (
    <RNText
      style={[
        styles.bold,
        ink
          ? { color: ink, backgroundColor: "rgba(0,0,0,0.16)" }
          : all || handle.toLowerCase() === myHandle
            ? { color: c.amber, backgroundColor: `${c.amber}2e` }
            : (tint ?? { color: c.ink }),
      ]}
    >
      {all ? `@${everyoneWord(i18n.language)}` : text}
    </RNText>
  );
}

type TableBlock = Extract<Block, { kind: "table" }>;

/** The table's sideways scroller, its offset read on the UI thread: the standing column and the fade follow it there. */
const TableScroller = Animated.createAnimatedComponent(GestureScrollView);

/** How wide the fade is at the side that hides columns, and how far a scroll takes it from whole to nothing. */
const TABLE_FADE = 28;

/** A cell as its column's kind reads it (`tableColumnKinds`): its words, and whether it is only a link. */
const cellRead = (cell: Inline[]): TableCellRead => {
  const said = cell.filter((s) => s.text.trim());
  return { text: cell.map((s) => s.text).join(""), link: said.length === 1 && said[0]?.kind === "link" };
};

/** A cell's words as a spreadsheet takes them (`tableTsv`). */
export const cellText = (cell: Inline[]) => cell.map((s) => s.text).join("");

/**
 * A cell that is only a link to a site, in a column of links: where it goes, the name it shows (the site's, or the
 * link's own words when it has them) and the host its icon comes from. Null for anything else (a message's or a file's
 * link here keeps its pill).
 */
function siteCellOf(cell: Inline[]): { href: string; label: string; host: string } | null {
  const said = cell.filter((s) => s.text.trim());
  const only = said.length === 1 ? said[0] : undefined;
  if (only?.kind !== "link") return null;
  if (parseMessageLink(only.href, [serverUrl()]) || parseFileLink(only.href, [serverUrl()])) return null;
  const site = linkSite(only.href);
  if (!site) return null;
  return { href: only.href, label: only.text === only.href ? site : only.text, host: new URL(only.href).host };
}

/**
 * A table (the web's table card's table): no band behind the header, rows split by hairlines, numbers on the right
 * in tabular figures. Each column is first as wide as its widest cell as drawn (measured on an unseen copy that never
 * wraps, since a guess by letters came out narrow and broke words), then fitted to the box (`fitTableColumns`): the
 * columns of longer text wrap and the links cut at their end so the whole table fits before it scrolls; a count
 * ("#") stays narrow. Only a table that still can't fit scrolls sideways inside its box: its first column stands
 * still (the one after a count too), with a hairline at its edge once the rest has moved under it; a scroll comes to
 * rest at the start of a column, and the side that hides columns fades out. All of it follows the scroll on the UI
 * thread. `surface`: the color under the table (the standing column's and the fade's), the chat's background unless
 * said. `bare`: no box of its own (a `TableCard`'s frame holds it). `full`: the whole screen's (`/table`), the header
 * staying on top as the rows scroll up under it, `bottom` points of room under the last row.
 */
export function Table({
  header,
  rows,
  align,
  surface,
  bare = false,
  full = false,
  bottom = 0,
}: Pick<TableBlock, "header" | "rows" | "align"> & {
  surface?: string;
  bare?: boolean;
  full?: boolean;
  bottom?: number;
}) {
  const c = useColors();
  const { fontScale } = useWindowDimensions();
  // Each column's width as drawn, kept across the list's unmounts (`kept-sizes.ts`): a table coming back lays out at
  // its widths from its first frame. At the letters' guess its cells wrapped otherwise (another height) until they
  // were measured again, and every row under it moved. Measured anew when what they depend on changes (the cells,
  // the width, the text size). Meanwhile the new cells draw at the widths measured last (`before`), never at the guess:
  // a live block's table follows its slider step by step, and every step jumped to the guess and back.
  const content = useMemo(() => tableKey(header, rows), [header, rows]);
  const columnsKey = `table:${content}:${useLayoutKey()}`;
  const [measured, setMeasured] = useState(() => ({
    key: columnsKey,
    columns: { ...keptColumns(columnsKey) },
    before: {} as Record<number, number>,
  }));
  if (measured.key !== columnsKey)
    setMeasured({
      key: columnsKey,
      columns: { ...keptColumns(columnsKey) },
      before: { ...measured.before, ...measured.columns },
    });
  const drawn: Record<number, number> = measured.columns;
  useEffect(() => {
    if (Object.keys(drawn).length > 0) keepColumns(columnsKey, drawn);
  }, [columnsKey, drawn]);
  // The unseen copy only until every column has its width: a table coming back has them all, and drew each of its
  // cells twice on every mount for nothing. Kept while a cell's pill or name loads after it mounts (wider then): its
  // column measures again and widens, where measured once at the icon the title wrapped in it.
  const unmeasured = header.some((_, col) => drawn[col] === undefined);
  const late = useMemo(() => tableResolvesLate(header, rows), [header, rows]);
  const kinds = useMemo(
    () =>
      tableColumnKinds(
        rows.map((r) => r.map(cellRead)),
        header.length,
      ),
    [header.length, rows],
  );
  // The box's width, kept as the columns are: a table coming back fits it from its first frame.
  const [frame, onFrame] = useKeptWidth(`table-frame:${content}`);
  // Full screen: the room under the bar, which the header and the rows' own scroller share.
  const [tall, setTall] = useState(0);
  const widths = tableColumnWidths(header, rows, { ...measured.before, ...drawn }, fontScale);
  const fitted = fitTableColumns(widths, kinds, frame, fontScale);
  // The content's width said outright (not left to layout), so the box always knows how far it scrolls.
  const total = fitted.widths.reduce((sum, w) => sum + w, 0);
  const scrolls = fitted.scrolls && frame > 0;
  // The columns standing still while the rest pass under them: the first, and the one after a count ("#").
  const standing = scrolls ? (kinds[0] === "index" && header.length > 2 ? 2 : 1) : 0;
  const snaps = useMemo(() => {
    if (!scrolls) return undefined;
    const end = total - frame;
    const stand = fitted.widths.slice(0, standing).reduce((sum, w) => sum + w, 0);
    const starts: number[] = [];
    let at = 0;
    for (const w of fitted.widths) {
      starts.push(at);
      at += w;
    }
    // A scroll rests where a column starts right after the standing ones, or at the table's end.
    const rests = starts
      .slice(standing + 1)
      .map((start) => start - stand)
      .filter((o) => o > 0 && o < end);
    return [0, ...rests, end];
  }, [scrolls, total, frame, fitted.widths, standing]);
  const fill = surface ?? c.bg;
  const edge = c.line2 ?? c.line;
  const x = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      x.value = e.contentOffset.x;
    },
  });
  // Pinned where the box starts whatever the scroll (a bounce at the start never pulls it right), with its edge's
  // hairline once something has gone under it.
  const stand = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(0, x.value) }],
    borderRightColor: x.value > 1 ? edge : "transparent",
  }));
  const fade = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, (total - frame - x.value) / TABLE_FADE)),
  }));
  // In a conversation the cells follow the person's Tamanho do texto, as the words around the table do.
  const sized = useRowLook().text;
  const textStyle = (col: number, head: boolean) => [
    styles.cellText,
    sized ? chatCellOf(variantStyle(head ? "label" : "subhead"), sized) : null,
    { textAlign: align[col] ?? "left" },
  ];
  const words = (inline: Inline[], col: number, head: boolean) => {
    const site = head || kinds[col] !== "link" ? null : siteCellOf(inline);
    if (site) return <SiteCell site={site} style={textStyle(col, false)} />;
    return (
      <Text
        variant={head ? "label" : "subhead"}
        tone={head || kinds[col] === "index" ? "faint" : "ink"}
        style={textStyle(col, head)}
        maxFontSizeMultiplier={sized ? CHAT_TEXT_MAX_SCALE : undefined}
      >
        <Spans inline={inline} />
      </Text>
    );
  };
  const cellStyle = (col: number) => [styles.cell, kinds[col] === "index" && styles.count];
  const cell = (inline: Inline[], col: number, head: boolean) =>
    col < standing ? (
      <Animated.View
        key={col}
        style={[cellStyle(col), styles.standing, { width: fitted.widths[col], backgroundColor: fill }, stand]}
      >
        {words(inline, col, head)}
      </Animated.View>
    ) : (
      <View key={col} style={[cellStyle(col), { width: fitted.widths[col] }]}>
        {words(inline, col, head)}
      </View>
    );
  const headRow = (
    <View style={[styles.tr, styles.head, { borderBottomColor: edge }]}>
      {header.map((h, col) => cell(h, col, true))}
    </View>
  );
  const row = (r: Inline[][], j: number) => (
    <View key={j} style={[styles.tr, j > 0 && styles.trLine, { borderTopColor: c.line }]}>
      {header.map((_, col) => cell(r[col] ?? [], col, false))}
    </View>
  );
  const fadeOut = scrolls ? (
    <Animated.View pointerEvents="none" style={[styles.fade, fade]}>
      <LinearGradient
        colors={[withAlpha(fill, 0), fill]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  ) : null;
  const scroller = (body: ReactNode) => (
    <TableScroller
      horizontal
      style={full ? styles.fill : styles.sideways}
      directionalLockEnabled
      nestedScrollEnabled
      alwaysBounceHorizontal={false}
      showsHorizontalScrollIndicator={false}
      scrollEnabled={scrolls}
      scrollEventThrottle={16}
      onScroll={onScroll}
      snapToOffsets={snaps}
      decelerationRate={scrolls ? "fast" : "normal"}
      contentContainerStyle={{ width: total }}
    >
      {body}
    </TableScroller>
  );
  return (
    <View style={full ? styles.fill : undefined}>
      {/* Each column's cells unseen, on a sideways strip with no width to wrap them: their widths. A copy of its own for
          each content, so every column says its width (one whose width didn't change would say nothing). */}
      {unmeasured || late ? (
        <View
          key={columnsKey}
          pointerEvents="none"
          style={styles.measure}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} style={styles.sideways}>
            {header.map((h, col) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: the columns of one table, in order
                key={col}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  setMeasured((m) =>
                    m.key !== columnsKey || m.columns[col] === w ? m : { ...m, columns: { ...m.columns, [col]: w } },
                  );
                }}
              >
                {[h, ...rows.map((r) => r[col] ?? [])].map((inline, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one column, in order
                  <View key={j} style={cellStyle(col)}>
                    {words(inline, col, j === 0)}
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {full ? (
        // The whole screen's: the header stays on top while the rows scroll up under it, both moving sideways together.
        <View
          style={styles.fill}
          onLayout={(e) => {
            onFrame(e);
            setTall(e.nativeEvent.layout.height);
          }}
        >
          {scroller(
            <View style={{ width: total, height: tall }}>
              {headRow}
              <FlatList
                data={rows}
                keyExtractor={(_, j) => String(j)}
                renderItem={({ item, index }) => row(item, index)}
                extraData={fitted.widths}
                contentContainerStyle={{ paddingBottom: bottom }}
                style={styles.fill}
              />
            </View>,
          )}
          {fadeOut}
        </View>
      ) : (
        /* The message's long-press (select) is a Pressable around the whole row: the table takes its own touches so a
           sideways drag scrolls it instead of starting the press, and its scroller is the gesture handler's (native
           gesture first, ahead of the row's JS responder). Long-press elsewhere on the message still selects it. */
        <View
          style={bare ? undefined : [styles.table, { borderColor: edge }]}
          onLayout={onFrame}
          onStartShouldSetResponder={() => true}
          onResponderTerminationRequest={() => true}
        >
          {scroller(
            <View style={{ width: total }}>
              {headRow}
              {rows.map(row)}
            </View>,
          )}
          {fadeOut}
        </View>
      )}
    </View>
  );
}

/**
 * A cell that only links to a site: the site's icon and its name, on one line cut at its end; a tap opens the address
 * (a page of this server on its screen, any other in the in-app browser), the whole address said to a screen reader.
 */
function SiteCell({
  site,
  style,
}: {
  site: { href: string; label: string; host: string };
  style: StyleProp<TextStyle>;
}) {
  const c = useColors();
  const open = () => {
    const own = ownLinkHref(site.href, serverUrl());
    if (own) router.push(own as never);
    else openPage(site.href);
  };
  return (
    <Pressable onPress={open} accessibilityRole="link" accessibilityHint={site.href} style={styles.site}>
      <SiteIcon host={site.host} />
      <RNText numberOfLines={1} style={[style, styles.siteName, { color: c.ink2 }]}>
        {site.label}
      </RNText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  table: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  /**
   * A sideways scroller never grows downward. React Native's scroll view takes `flexGrow: 1`, so inside a message it
   * grew to the height the row already had: the row then measured that plus the rest of the message, the scroller grew
   * into it again, and so on with every layout. A long message with a table drew thousands of points of empty bubble
   * under its words (on a phone, each layer over the words larger than the one under it by the words less the table).
   */
  sideways: { flexGrow: 0 },
  fill: { flex: 1 },
  fade: { position: "absolute", top: 0, bottom: 0, right: 0, width: TABLE_FADE },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  tr: { flexDirection: "row" },
  head: { borderBottomWidth: StyleSheet.hairlineWidth },
  trLine: { borderTopWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 9 },
  // A count ("#") hugs its numbers: its words start where the row's do, the next column right after.
  count: { paddingRight: 4 },
  // Over the columns passing under it, its edge drawn once they do.
  standing: { zIndex: 1, borderRightWidth: StyleSheet.hairlineWidth },
  cellText: { fontVariant: ["tabular-nums"] },
  site: { flexDirection: "row", alignItems: "center", gap: 6 },
  siteName: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  link: { textDecorationLine: "underline" },
  inlineCode: { fontFamily: MONO, fontSize: 15 },
});
