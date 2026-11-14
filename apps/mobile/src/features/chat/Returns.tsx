import { type PendingReturn, useCancelFollowUp, useFollowUps } from "@agenteschat/client";
import { returnClock, returnFaces, returnSentence, returnsHere, returnWhen } from "@agenteschat/client/lib/agent-work";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut } from "react-native-reanimated";
import { Card, CHROME_MAX_SCALE, Icon, IconButton, Row, Text, useReducedMotion, useTheme, useToast } from "@/ui";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useNow, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { aboutFits, markedParts, markName } from "./logic";
import { WaitMark } from "./WaitMark";

/**
 * The returns agents set in this conversation (ADR 0037 addendum of 2026-11-13), the soonest first: a thread's own, or
 * the main timeline's.
 */
export function useReturnsHere(channelId: string, threadId: string | null) {
  return returnsHere(useFollowUps(useOrgId(), channelId).data, threadId);
}

/**
 * The dock's line at rest, in the working line's slot while nobody works here (the web's resting bar): 28 points,
 * bare, up to three faces (one per agent), the clock (the amber wait mark when it waits on the reader's answer),
 * "Ada retorna às 00:32", her words after " · " only when they fit whole beside it, "+1", then ⋯. The whole line
 * opens the Retornos sheet.
 */
export function ReturnLine({ returns, onOpen }: { returns: PendingReturn[]; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const { colors: c } = useTheme();
  const reduced = useReducedMotion();
  // "amanhã às 09:00" turns into "às 09:00" 12 h before.
  const now = useNow(60_000);
  // What the words have, what the sentence and her words take unshrunk (measured off the line): hers show only whole.
  const [room, setRoom] = useState(0);
  const [said, setSaid] = useState(0);
  const [aboutWidth, setAboutWidth] = useState(0);
  const first = returns[0];
  if (!first) return null;
  const name = dir.agentById.get(first.agentId)?.name ?? t("channel.unknownAgent");
  const sentence = returnSentence(t, i18n.language, first, markName(name), { canAnswer: true, now });
  const parts = markedParts(sentence);
  const plain = parts.map((p) => p.text).join("");
  const about = !first.held && first.about ? ` · ${first.about}` : "";
  const shows = about !== "" && aboutFits(room, said, aboutWidth);
  const more = returns.length > 1 ? t("ask.bar.more", { count: returns.length - 1 }) : "";
  const pieces = parts.map((p, i) => (
    <Text
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      key={i}
      variant="caption"
      tone="muted"
      numberOfLines={1}
      maxFontSizeMultiplier={CHROME_MAX_SCALE}
      style={p.bold ? [styles.shrink, styles.ink, { color: c.ink }] : styles.keep}
    >
      {p.text}
    </Text>
  ));
  return (
    <View style={styles.dock}>
      <Animated.View
        entering={reduced ? undefined : LINE_IN}
        exiting={reduced ? undefined : LINE_OUT}
        accessibilityLiveRegion="polite"
      >
        <Pressable
          onPress={onOpen}
          // 28 points tall, 44 to touch.
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="button"
          accessibilityLabel={[`${plain}${about}`, more, t("followUps.title")].filter(Boolean).join(". ")}
          style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        >
          <View style={styles.stack} importantForAccessibility="no-hide-descendants">
            {returnFaces(returns).map((id, i) => (
              <View key={id} style={[styles.tok, { backgroundColor: c.bg }, i > 0 && styles.overlap]}>
                <AgentFace agentId={id} size={18} mode="idle" />
              </View>
            ))}
          </View>
          {first.held ? <WaitMark size={8} /> : <Icon name="clock" size={14} color={c.faint} />}
          <View style={styles.words} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
            {/* The name gives way ("…"), never the time after it. */}
            <View style={styles.said}>{pieces}</View>
            {shows ? (
              <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                <RNText style={{ color: c.faint }}> · </RNText>
                {first.about}
              </Text>
            ) : null}
            {/*
              The sentence's and her words' own widths, unseen. The row above shrinks the name to make room, so its
              width would keep her words in once they showed, cutting the name instead.
            */}
            <View
              style={[styles.said, styles.measure]}
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              onLayout={(e) => setSaid(e.nativeEvent.layout.width)}
            >
              {pieces}
            </View>
            {about ? (
              <Text
                variant="caption"
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={styles.measure}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                onLayout={(e) => setAboutWidth(e.nativeEvent.layout.width)}
              >
                {about}
              </Text>
            ) : null}
          </View>
          {more ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {more}
            </Text>
          ) : null}
          <View style={styles.more}>
            <Icon name="more" size={16} color={c.muted} />
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * "Retornos": the returns here, the soonest first, as the pins' sheet builds them: her face, her name, her words whole
 * (three lines), the time (the wait mark once its time passed waiting on an answer), and × for who may cancel, its
 * spinner while it goes. A tap goes to her reply.
 */
export function ReturnsSheet({
  channelId,
  threadId,
  onPick,
}: {
  channelId: string;
  threadId: string | null;
  onPick: (messageId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const { colors: c } = useTheme();
  const toast = useToast();
  const sheet = useSheet();
  const now = useNow(60_000);
  const query = useFollowUps(orgId, channelId);
  const list = returnsHere(query.data, threadId);
  const cancel = useCancelFollowUp(orgId);
  const [going, setGoing] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (id: string, on: boolean) =>
    setGoing((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // The last one canceled: nothing left to list.
  const empty = Boolean(query.data) && list.length === 0;
  useEffect(() => {
    if (empty) sheet.close();
  }, [empty, sheet]);
  return (
    <>
      <SheetTitle leading={<Tile icon="clock" />} title={t("followUps.title")} />
      {query.isLoading ? (
        <ActivityIndicator color={c.muted} />
      ) : query.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : (
        <Card>
          {list.map((r) => {
            const name = dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent");
            const g = agentGrammar(name);
            const reply = r.replyMessageId;
            return (
              <Row
                key={r.messageId}
                leading={<Face who={{ type: "agent", id: r.agentId }} size={30} live={false} />}
                title={name}
                subtitle={r.about}
                subtitleLines={3}
                meta={
                  <View style={styles.meta}>
                    {r.held ? (
                      <WaitMark size={8} />
                    ) : (
                      <Text variant="caption" tone="faint" style={styles.time}>
                        {returnClock(t, i18n.language, r.at, now)}
                      </Text>
                    )}
                    {!r.canCancel ? null : going.has(r.messageId) ? (
                      <View style={styles.going} accessible accessibilityLabel={t("followUps.cancel")}>
                        <ActivityIndicator size="small" color={c.muted} />
                      </View>
                    ) : (
                      <IconButton
                        icon="x"
                        label={t("followUps.cancelOf", {
                          name: g.name,
                          context: g.context,
                          when: returnWhen(t, i18n.language, r.at, now),
                        })}
                        onPress={() => {
                          mark(r.messageId, true);
                          cancel.mutate(
                            { channelId, messageId: r.messageId },
                            {
                              onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
                              onSettled: () => mark(r.messageId, false),
                            },
                          );
                        }}
                      />
                    )}
                  </View>
                }
                {...(reply ? { onPress: () => onPick(reply) } : {})}
              />
            );
          })}
        </Card>
      )}
    </>
  );
}

const LINE_EASE = Easing.bezier(0.23, 1, 0.32, 1);
const LINE_IN = FadeIn.duration(160).easing(LINE_EASE);
const LINE_OUT = FadeOut.duration(120).easing(LINE_EASE);

const styles = StyleSheet.create({
  // The working line's box (`LiveRows` `pill`), bare: no glass, no shadow, no sky, one line.
  dock: { paddingBottom: 6 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 28,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  pressed: { opacity: 0.6 },
  stack: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  tok: { padding: 1.5, borderRadius: 7 },
  overlap: { marginLeft: -5 },
  words: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0, overflow: "hidden" },
  said: { flexDirection: "row", flexShrink: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  keep: { flexShrink: 0 },
  ink: { fontWeight: "600" },
  // Laid out where nothing shows it, for its width alone.
  measure: { position: "absolute", left: 0, top: 0, opacity: 0 },
  // ⋯ in the line's round end, 2 points from its edge: a sign the line opens the list (the line is the button).
  more: { width: 24, height: 24, marginRight: -6, alignItems: "center", justifyContent: "center" },
  meta: { flexDirection: "row", alignItems: "center", gap: 2 },
  time: { fontVariant: ["tabular-nums"] },
  going: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
