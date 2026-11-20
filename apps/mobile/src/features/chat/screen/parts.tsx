import { type ConnectionStatus, useMarkChannelRead, useMarkThreadRead, useThreadActivity } from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { type ComponentProps, memo, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { KeyboardGestureArea } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import { useAppActive } from "@/lib/useAppActive";
import {
  Composer,
  type ComposerProps,
  Count,
  Icon,
  LineIcon,
  PressScale,
  Text,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { useColors, useDirectory } from "../../shared/hooks";
import { useVoiceComposer } from "../../voice/useVoiceComposer";
import type { VoiceTarget } from "../../voice/useVoiceTake";
import { ChannelWelcome } from "../ChannelWelcome";
import type { DockHeight } from "../dock-height";
import { readMark } from "../logic";
import type { Unseen } from "../scroll";
import { withOpacity } from "../turn";
import { useValueOf, type ValueStore } from "./hooks";

/** A dropped connection shows only past this long (a quick reconnect says nothing). */
const OFFLINE_AFTER_MS = 1200;
/** "Conectado de novo" stays this long. */
const BACK_ONLINE_MS = 1600;

/** The dock's height where it is drawn (`DockHeight`): what reads it redraws, not the conversation around it. */
const useDockHeight = (dock: DockHeight) => useSyncExternalStore(dock.subscribe, dock.get, dock.get);

/**
 * The keyboard's gesture area around the conversation and its dock, its offset the dock's room above the keys: on
 * Android the keyboard starts following a drag there. No `textInputNativeID`: with it the composer could stay down while
 * the keyboard was up (iOS 26); without it iOS takes no offset (the keyboard follows the finger from its own top edge).
 * The offset is whole points: a fractional one made the overscroll glitch.
 */
export function DockGestureArea({ dock, lift, children }: { dock: DockHeight; lift: number; children: ReactNode }) {
  const height = useDockHeight(dock);
  return (
    <KeyboardGestureArea style={styles.grow} interpolator="ios" offset={Math.round(Math.max(0, height - lift))}>
      {children}
    </KeyboardGestureArea>
  );
}

/** What is drawn from the dock's height (an empty conversation's greeting, the skeleton), redrawn alone with it. */
export function DockRoom({ dock, children }: { dock: DockHeight; children: (height: number) => ReactNode }) {
  const height = useDockHeight(dock);
  return <>{children(height)}</>;
}

/**
 * Marks the conversation read up to the message posted last, wherever its place: the list's badges (a channel's or a
 * DM's, or a thread's) clear at once. Only in view (`focused`): under another screen, or with the app in the
 * background, what arrives stays unread, and is read once the person is back on it. On its own: its requests' states
 * and the threads' replies redraw it, not the whole conversation (twice for every message that landed).
 */
export const ReadMark = memo(function ReadMark({
  orgId,
  channelId,
  threadId,
  member,
  postedNow,
  peeking,
  focused,
}: {
  orgId: string;
  channelId: string;
  threadId: string | null;
  member: boolean;
  postedNow: string | undefined;
  peeking: boolean;
  focused: boolean;
}) {
  const markRead = useMarkChannelRead(orgId).mutate;
  const markThreadRead = useMarkThreadRead(orgId).mutate;
  const inFront = useAppActive();
  // A reply in one of its threads counts in the conversation's mark and is no message of this list: read again on it.
  const threadReplies = useThreadActivity(orgId, channelId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread's reply marks the conversation read again
  useEffect(() => {
    if (peeking || !focused || !inFront || !member || !postedNow) return;
    const mark = readMark(channelId, threadId);
    if (mark.kind === "thread") markThreadRead(mark.id);
    else markRead(mark.id);
  }, [peeking, focused, inFront, markRead, markThreadRead, channelId, threadId, member, postedNow, threadReplies]);
  return null;
});

/**
 * The conversation's field with its voice messages. On its own so that it redraws for what it shows (the words, a
 * take's clock and wave) and never for the conversation above it: everything it is handed keeps its identity between
 * the conversation's renders.
 */
export const ChatComposer = memo(function ChatComposer({
  orgId,
  channelId,
  threadId,
  agentId,
  replyTo,
  authorId,
  voiceOn,
  onVoiceSent,
  prepareVoice,
  voiceTakeBack,
  onRecording,
  ...composer
}: Omit<ComposerProps, "voice"> & {
  orgId: string;
  channelId: string;
  threadId: string | null;
  /** The agent this conversation is with, if one (its face listens in the field). */
  agentId: string | null;
  /** The message a voice take answers. */
  replyTo: string | null;
  authorId: string;
  voiceOn: boolean;
  onVoiceSent: () => void;
  /** What goes with a take: the words typed beside it and the files, uploaded (`VoiceTarget.prepare`). */
  prepareVoice: NonNullable<VoiceTarget["prepare"]>;
  voiceTakeBack: NonNullable<VoiceTarget["takeBack"]>;
  /** While a take records: the others see "recording audio…" (throttled by the caller). */
  onRecording: () => void;
}) {
  const voice = useVoiceComposer({
    orgId,
    channelId,
    threadId,
    agentId,
    replyTo,
    authorId,
    enabled: voiceOn,
    prepare: prepareVoice,
    takeBack: voiceTakeBack,
    afterSend: onVoiceSent,
    onRecording,
  });
  return <Composer {...composer} voice={voice} />;
});

/**
 * Back to the latest messages: a round button at the bottom right, right above the composer, as on the web.
 * It counts what arrived below, in red when one mentions me; its label says who spoke and who is writing.
 */
export function ToLatest({ unseen, onPress }: { unseen: Unseen; onPress: () => void }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors, shadows, reducedMotion } = useTheme();
  const nameOf = (who: string) => {
    const at = who.indexOf(":");
    return dir.nameOf({ type: who.slice(0, at), id: who.slice(at + 1) });
  };
  const said = [
    unseen.messages > 0 ? t("mobile.chat.unseen.count", { count: unseen.messages }) : "",
    unseen.authors.length > 0 ? listNames(t, unseen.authors.map(nameOf)) : "",
    unseen.working.length > 0
      ? t("mobile.chat.unseen.working", { names: listNames(t, unseen.working.map(nameOf)) })
      : "",
    unseen.mentionsMe ? t("mobile.chat.unseen.mentionsYou") : "",
  ].filter(Boolean);
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(160)}
      exiting={reducedMotion ? undefined : FadeOut.duration(120)}
      pointerEvents="box-none"
    >
      <PressScale
        to={0.92}
        onPress={onPress}
        accessibilityRole="button"
        // A 40-point circle: 4 around it gives the 48 a thumb needs.
        hitSlop={4}
        accessibilityLabel={
          said.length > 0 ? t("mobile.chat.toLatestNew", { text: said.join(" · ") }) : t("mobile.chat.toLatest")
        }
        style={[styles.jump, { backgroundColor: colors.raised, boxShadow: `${shadows.e2}, ${shadows.top}` }]}
      >
        <View style={styles.jumpIcon}>
          <Icon name="down" size={20} color={colors.ink2} />
        </View>
      </PressScale>
      {unseen.messages > 0 ? (
        <View style={[styles.jumpCount, { borderColor: colors.bg }]} pointerEvents="none">
          <Count
            value={unseen.messages}
            size={11}
            inverted
            max={99}
            {...(unseen.mentionsMe ? { fill: colors.danger, color: colors.raised } : {})}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * The connection, above the composer: "No connection. What you send goes out on its own when it's back." while it is
 * down (a quick reconnect says nothing), then "Connected again" for a moment.
 */
export function Connection({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const down = status === "reconnecting" || status === "closed";
  const [shown, setShown] = useState<"down" | "back" | null>(null);
  useEffect(() => {
    if (down) {
      const id = setTimeout(() => setShown("down"), OFFLINE_AFTER_MS);
      return () => clearTimeout(id);
    }
    if (status === "open") setShown((s) => (s === "down" ? "back" : s));
  }, [down, status]);
  useEffect(() => {
    if (shown !== "back") return;
    const id = setTimeout(() => setShown(null), BACK_ONLINE_MS);
    return () => clearTimeout(id);
  }, [shown]);
  if (!shown) return null;
  const back = shown === "back";
  return (
    <Animated.View
      key={shown}
      entering={reduced ? undefined : FadeInDown.duration(220)}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.conn, { backgroundColor: back ? withOpacity(c.ok, 0.14) : c.warnSoft }]}
    >
      {/* On the first line: the offline sentence wraps, and centred on both lines the icon floated between them. */}
      <LineIcon variant="small" name={back ? "check" : "wifi"} size={15} color={back ? c.ok : c.warn} />
      <Text variant="small" style={[styles.connText, { color: back ? c.ok : c.warn }]}>
        {back ? t("mobile.chat.connection.back") : t("mobile.chat.connection.down")}
      </Text>
    </Animated.View>
  );
}

/**
 * The round button's place (`ToLatest`): shown when the screen says so (`shown`), or away from the end and more than a
 * screen up (`far`, read here: crossing that line redraws this alone).
 */
export function FarGate({
  far,
  away,
  shown,
  children,
}: {
  far: ValueStore<boolean>;
  away: boolean;
  shown: boolean;
  children: ReactNode;
}) {
  const isFar = useValueOf(far);
  return shown || (away && isFar) ? children : null;
}

/** The channel's greeting (`ChannelWelcome`) with whether the person touched the conversation, which it reads itself. */
export function ChannelGreeting({
  touched,
  ...welcome
}: Omit<ComponentProps<typeof ChannelWelcome>, "touched"> & { touched: ValueStore<boolean> }) {
  return <ChannelWelcome {...welcome} touched={useValueOf(touched)} />;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  jump: { width: 40, height: 40, borderRadius: 20 },
  jumpIcon: { flex: 1, alignItems: "center", justifyContent: "center" },
  jumpCount: { position: "absolute", top: -6, right: -6, borderWidth: 2, borderRadius: 999 },
  conn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  connText: { flexShrink: 1, fontWeight: "600" },
});
