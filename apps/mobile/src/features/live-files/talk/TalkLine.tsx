import { type Artifact, type ArtifactDetail, useFileUnread } from "@agenteschat/client";
import { activityText } from "@agenteschat/client/lib/activity";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass, Icon, PixelOrbit, PressScale, padPastFold, SCREEN_X, Text, useFoldRoom, useTheme } from "@/ui";
import { nameInk, workingEntries } from "../../chat/logic";
import { Face } from "../../shared/Face";
import { useDirectory, useOrgId } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import { MentionCount } from "../../shared/parts";
import { useOpenFileTalk, useTalkMessages, useTalkRuns } from "./hooks";
import { talkKindOf, talkLine } from "./logic";

/** The line's height, and the least room under it (over a phone with no home indicator). */
export const TALK_LINE_H = 56;
const SIDE = 12;
/** Faces of who took part, at most, their side and the ring that parts them. */
const FACES = 3;
const FACE = 24;
const RING = 2;

type TalkFile = Pick<Artifact, "id" | "kind" | "title" | "conversation" | "createdBy"> & {
  content?: ArtifactDetail["content"];
};

/** The room the line takes at the bottom of a file's screen, the home indicator's with it: what floats clears it. */
export function useTalkLineRoom(): number {
  const insets = useSafeAreaInsets();
  return TALK_LINE_H + Math.max(insets.bottom, SIDE) + 8;
}

/**
 * The conversation under a live file (ADR 0199, the task's conversation row in glass), a picture, a video or a PDF
 * (ADR 0208): the faces of who took part, then what an agent is doing there now in its color with the pixel orbit
 * ("Atlas is making images…"), else the last message ("Atlas: Done, summed by status."), else "Talk about this
 * canvas"; how many, my mentions in red, and the chevron. A tap pushes the conversation over the file (ADR 0208), the
 * only way into it from the file. It floats over the file at the bottom (`floating`), sits in a bar of the screen's
 * own (`bare`: the picture viewer's, which keeps the home indicator's room) or closes the screen's column; with the
 * keyboard up it goes, and comes back when it goes down. `onOpen`: what a tap does instead. Folded like a book, the
 * line keeps to the half past the fold rather than across it (ADR 0212); a bar it sits in keeps it there itself.
 */
export function FileTalkLine({
  file,
  floating = false,
  bare = false,
  onOpen,
}: {
  file: TalkFile | undefined;
  floating?: boolean;
  bare?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c, scheme, shadows } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const dir = useDirectory();
  const keyboardUp = useKeyboardState((state) => state.isVisible);
  const talk = file?.conversation ?? null;
  const messages = useTalkMessages(talk);
  const runs = useTalkRuns(file?.id ?? "", talk);
  const { mentions } = useFileUnread(orgId, file?.id ?? "");
  const open = useOpenFileTalk(file);
  const foldSide = useFoldRoom();

  const line = useMemo(() => {
    const entries = workingEntries(runs, [], (id) => dir.anyAgent(id)?.name ?? "");
    const agent = entries.find((e) => e.type === "agent");
    const last = messages.at(-1);
    return talkLine({
      count: talk?.count ?? messages.length,
      working: agent ? { agentId: agent.id, text: activityText(t, entries) } : null,
      last: last ? { name: dir.nameOf(last.author), text: textOrMedia(t, last.body, last.meta) } : null,
    });
  }, [runs, messages, talk?.count, dir, t]);

  if (keyboardUp) return null;
  const kind = talkKindOf(file);
  // Not known yet: the home indicator's room, where the line will be (a floating one waits unseen).
  if (!file || !kind) return floating || bare ? null : <View style={{ height: Math.max(insets.bottom, SIDE) + 8 }} />;
  const people = (talk?.participants ?? []).slice(0, FACES);
  const workingAgent = line.state === "working" ? dir.agentById.get(line.agentId) : undefined;
  const color = agentLook(workingAgent).color;
  const ink = workingAgent ? nameInk(color, scheme === "dark") : c.agent;
  const words =
    line.state === "start"
      ? t("mobile.live.talk.start", { what: t(`live.conversation.this.${kind}`) })
      : line.text || t(`live.conversation.title.${kind}`);
  const label = [
    t(`live.conversation.title.${kind}`),
    words,
    line.count > 0 ? t("live.conversation.toggle", { count: line.count }) : null,
    mentions > 0 ? t("shell.unreadMentions", { count: mentions }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.at,
        floating && styles.floating,
        !bare && { paddingBottom: Math.max(insets.bottom, SIDE) },
        !floating && !bare && { backgroundColor: c.bg },
        !bare && foldSide && padPastFold(foldSide, SCREEN_X),
      ]}
    >
      <PressScale
        haptic={false}
        onPress={onOpen ?? (() => open({ selection: null }))}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("mobile.live.talk.openHint")}
        style={Platform.OS === "android" ? { borderRadius: TALK_LINE_H / 2, boxShadow: shadows.e1 } : undefined}
      >
        <Glass liquid interactive={false} intensity={70} style={[styles.pill, { borderColor: c.line2 }]}>
          {people.length > 0 ? (
            <View style={styles.faces}>
              {people.map((p, i) => (
                <View
                  key={`${p.type}:${p.id}`}
                  style={[
                    styles.face,
                    i > 0 && styles.faceOver,
                    p.type === "agent" ? styles.tile : styles.round,
                    { borderColor: c.glassSolid },
                  ]}
                >
                  <Face who={p} size={FACE} live={false} />
                </View>
              ))}
            </View>
          ) : (
            <Icon name="chat" size={20} color={c.muted} />
          )}
          <View style={styles.words}>
            {line.state === "working" ? (
              <>
                <PixelOrbit color={color} size={12} />
                <Text variant="body" numberOfLines={1} style={[styles.working, { color: ink }]}>
                  {words}
                </Text>
              </>
            ) : (
              <Text variant="body" tone={line.state === "start" ? "muted" : "ink2"} numberOfLines={1}>
                {words}
              </Text>
            )}
          </View>
          {line.count > 0 ? (
            <Text variant="subhead" tone="faint" style={styles.count}>
              {line.count}
            </Text>
          ) : null}
          <MentionCount count={mentions} />
          <Icon name="right" size={16} color={c.faint} />
        </Glass>
      </PressScale>
    </View>
  );
}

const styles = StyleSheet.create({
  // On the page's own sides, as the slides, pages and cells over it.
  at: { paddingHorizontal: SCREEN_X, paddingTop: 8 },
  floating: { position: "absolute", left: 0, right: 0, bottom: 0 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: TALK_LINE_H,
    paddingHorizontal: 12,
    borderRadius: TALK_LINE_H / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  faces: { flexDirection: "row", alignItems: "center" },
  face: { borderWidth: RING, overflow: "hidden" },
  faceOver: { marginLeft: -6 },
  round: { borderRadius: (FACE + RING * 2) / 2 },
  // An agent's tile keeps its corner: 30% of the side, as every face tile.
  tile: { borderRadius: Math.round((FACE + RING * 2) * 0.3) },
  words: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  working: { flexShrink: 1, fontWeight: "600" },
  count: { fontWeight: "600" },
});
