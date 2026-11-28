import { parseChart } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { RADIUS } from "@/ui/radius";
import { useColors } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { ChartCard } from "./ChartCard";
import { CodeCard } from "./CodeCard";
import { keepOpen, keptOpen } from "./kept-sizes";
import { blockGap, blocksOf, CHAT_TEXT_MAX_SCALE, type ChatText, type Inline } from "./logic";
import { useRowLook } from "./look";
import { Spans } from "./MessageSpans";
import { TableCard } from "./TableCard";

/**
 * A message's text: paragraphs, lists, quotes, headings, bold, italic,
 * @mentions and code (mono only for code).
 */
export const MessageText = memo(function MessageText({
  body,
  muted = false,
  selectable = true,
  accent,
  channelRefs,
  everyone = false,
  ink,
  small = false,
}: {
  body: string;
  muted?: boolean;
  /**
   * false in chat rows: a long press there opens the message sheet (which has "Copiar texto"), and native
   * selection would float iOS's own "Copiar" bubble over it.
   */
  selectable?: boolean;
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColorName;
  /** The message's `meta.channelRefs`: the channel each `#name` meant when written. */
  channelRefs?: Record<string, string>;
  /** The message's `meta.mentionsEveryone`: its `@todos` shows in the reader's language, like a mention of them. */
  everyone?: boolean;
  /** Over a solid bubble: the words' color in place of the page's. */
  ink?: string;
  /** On a page, under a title: a step smaller than a conversation's words. */
  small?: boolean;
}) {
  const c = useColors();
  const look = useRowLook();
  // Kept for the texts read lately (`blocksOf`): a row scrolled back into view doesn't parse its text again.
  const blocks = useMemo(() => blocksOf(body), [body]);
  const inked = ink ? { color: ink } : undefined;
  const variant = small ? "footnote" : "body";
  // In a conversation, the person's Tamanho do texto, which the system's text size grows up to its cap.
  const sized = small ? null : look.text;
  const line = small ? undefined : (sized ?? styles.line);
  const fit = sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {};
  const spans = (inline: Inline[]) => <Spans inline={inline} channelRefs={channelRefs} everyone={everyone} ink={ink} />;
  const tone = muted ? "muted" : "ink";
  // A list's marker stands in the middle of its first line.
  const lineHeight = sized?.lineHeight ?? (small ? SMALL_LINE : styles.line.lineHeight);
  const headed = [sized ? headingOf(sized) : small ? styles.headingSmall : styles.headingBody, styles.heading];
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => {
        // The room above each block by what it follows (`blockGap`): a list's items close together, a heading apart
        // from what it ends and close to what it opens.
        const gap = blockGap(blocks[i - 1]?.kind, b.kind);
        const above = gap > 0 ? { marginTop: gap } : undefined;
        switch (b.kind) {
          case "code":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={above}>
                <Fenced lang={b.lang} text={b.text} accent={accent} />
              </View>
            );
          case "table":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[above, ink ? [styles.cut, { backgroundColor: c.bg }] : null]}>
                <TableCard header={b.header} rows={b.rows} align={b.align} />
              </View>
            );
          case "heading":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant={variant} tone="ink" style={[line, headed, inked, above]} {...fit}>
                {spans(b.inline)}
              </Text>
            );
          case "bullet":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.bullet, above]}>
                {b.ordinal ? (
                  <Text variant={variant} tone="faint" style={[line, styles.ordinal, inked]} {...fit}>
                    {`${b.ordinal}.`}
                  </Text>
                ) : (
                  // The web's marker: a small square, in the middle of the item's first line.
                  <View style={[styles.marker, { height: lineHeight }]}>
                    <View style={[styles.square, { backgroundColor: ink ?? c.faint }]} />
                  </View>
                )}
                <Text variant={variant} tone={tone} style={[line, styles.item, inked]} {...fit}>
                  {spans(b.inline)}
                </Text>
              </View>
            );
          case "details":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[above, ink ? [styles.cut, { backgroundColor: c.bg }] : null]}>
                <Details summary={b.summary} body={b.body} muted={muted} accent={accent} channelRefs={channelRefs} />
              </View>
            );
          case "quote":
            return (
              // A quote reads on a plate a step off what is around it (on my solid bubble, its ink's), never a colored
              // bar at its left edge.
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <View key={i} style={[styles.quote, { backgroundColor: ink ? `${ink}26` : c.plate }, above]}>
                <Text variant={variant} tone="muted" style={[line, inked]} {...fit}>
                  {spans(b.inline)}
                </Text>
              </View>
            );
          default:
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of one text, in order
              <Text key={i} variant={variant} tone={tone} style={[line, inked, above]} selectable={selectable} {...fit}>
                {spans(b.inline)}
              </Text>
            );
        }
      })}
    </View>
  );
});

/** A page's footnote line (`small`): its list's markers stand in its middle. */
const SMALL_LINE = 18;

/** A heading in a conversation: two points over its words, on their line and one point more. */
const headingOf = (text: ChatText) => ({ fontSize: text.fontSize + 2, lineHeight: text.lineHeight + 1 });

/** A fenced block: a ```chart that reads as one is drawn; anything else is a code card. */
function Fenced({ lang, text, accent }: { lang: string; text: string; accent?: AgentColorName }) {
  const isChart = lang.toLowerCase() === "chart";
  const chart = useMemo(() => (isChart ? parseChart(text) : null), [isChart, text]);
  if (chart) return <ChartCard spec={chart} {...(accent ? { accent } : {})} />;
  return <CodeCard lang={isChart ? "json" : lang} text={text} />;
}

/** A collapsed block (`<details>`, ADR 0147): its summary opens what only some want to read. */
function Details({
  summary,
  body,
  muted,
  accent,
  channelRefs,
}: {
  summary: Inline[];
  body: string;
  muted: boolean;
  accent?: AgentColorName;
  channelRefs?: Record<string, string>;
}) {
  const c = useColors();
  const sized = useRowLook().text;
  // Opened, it comes back open when its row comes back into view (`keptOpen`), as the person left it.
  const keep = `details:${body}`;
  const [open, setOpen] = useState(() => keptOpen(keep));
  return (
    <View style={[styles.details, { borderColor: c.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          keepOpen(keep, !open);
          setOpen(!open);
        }}
        style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
      >
        <Text
          variant="body"
          tone="muted"
          style={[sized ?? styles.line, styles.flex, styles.heading]}
          {...(sized ? { maxFontSizeMultiplier: CHAT_TEXT_MAX_SCALE } : {})}
        >
          {summary.length > 0 ? <Spans inline={summary} channelRefs={channelRefs} /> : "…"}
        </Text>
        <View style={[styles.chev, open ? styles.flip : undefined]}>
          <Icon name="chev" size={15} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <MessageText
          body={body}
          muted={muted}
          {...(accent ? { accent } : {})}
          {...(channelRefs ? { channelRefs } : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 1 },
  /** Outside a conversation (a task's text, a document): the body's size on a line of ~1.42. */
  line: { lineHeight: 24 },
  flex: { flex: 1 },
  /**
   * A list item's words: as wide as they are, wrapping where the row ends. Never `flex: 1`: my own bubble is as
   * wide as its words, and a basis of zero there leaves the item no width (a tall bubble with only the number).
   */
  item: { flexShrink: 1 },
  heading: { fontWeight: "600" },
  // A heading a step over the words: 19 on 25 beside the body's 17, 15 on 20 beside a page's footnote.
  headingBody: { fontSize: 19, lineHeight: 25 },
  headingSmall: { fontSize: 15, lineHeight: 20 },
  // The items' words start 22 in, the web's list: the marker (or the number, right aligned) in the room before them.
  bullet: { flexDirection: "row" },
  marker: { width: 22, paddingLeft: 6, justifyContent: "center" },
  square: { width: 5, height: 5, borderRadius: 1 },
  ordinal: { minWidth: 15, marginRight: 7, textAlign: "right", fontVariant: ["tabular-nums"] },
  // A plate in the words: the scale's item corner and the plates' room (12 at the sides, 10 above and under).
  quote: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS.md },
  /** On a solid bubble: a table or a collapsed block stays on the page's color, in the page's ink. */
  cut: { borderRadius: 10, overflow: "hidden" },
  details: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  // From the top: a summary that wraps keeps its chevron on the first line.
  summary: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  chev: { marginTop: 4 },
  pressed: { opacity: 0.6 },
  flip: { transform: [{ rotate: "180deg" }] },
});
