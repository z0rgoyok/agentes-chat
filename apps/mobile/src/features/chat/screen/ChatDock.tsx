import { canTalk } from "@agenteschat/client/lib/audience";
import { LinearGradient } from "expo-linear-gradient";
import type { ComponentProps, ComponentRef, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { KeyboardStickyView, type useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { type SharedValue } from "react-native-reanimated";
import { Button, padPastFold, Text, useFoldRoom } from "@/ui";
import { ComposerFloat, type ComposerFloatSlot } from "@/ui/Composer";
import { useColors } from "../../shared/hooks";
import { type useAwayAsk, WaitingHereBar } from "../asks";
import { ChatPeek } from "../ChatPeek";
import { DOCK_FADE, WallpaperUnder } from "../ChatWallpaper";
import type { useComposerRequest } from "../composer-request";
import { insertRef, refQuery } from "../mentions";
import { NoAiBanner } from "../NoAiBanner";
import type { noAiBanner } from "../no-ai-banner";
import { AgentLocked, UnavailableLines } from "../ReachLines";
import { TeamStalledLine } from "../TeamStalledLine";
import { withOpacity } from "../turn";
import type { ListPlacement } from "./ChatList";
import { DOCK_SIDE } from "./constants";
import { ChatComposer, FarGate, ToLatest } from "./parts";
import type { ChatData } from "./useChatData";
import type { ChatRows } from "./useChatRows";
import type { ChatSend } from "./useChatSend";
import type { ConversationActions } from "./useConversationActions";
import type { FollowEnd } from "./useFollowEnd";
import { LineAskBar, LiveWorkingLine } from "./work-line";

const COMPOSER_INPUT_ID = "chat-composer";

/** A style handed to an animated view (the capsule's and its neighbours' rest at the dock's sides). */
type AnimatedViewStyle = ComponentProps<typeof Animated.View>["style"];

/**
 * The conversation's dock, riding the keyboard: the agent peeking from behind it, the way back to the latest messages,
 * the "@" picker, and the composer's box with what stands over the field (the connection, a missing AI, who won't
 * answer, a request out of view, who works while there is no conversation yet) or what stands in its place. A
 * conversation shown over the whole window folded like a book keeps the picker and what is in the box to the half past
 * the fold, the box's background still across the screen (ADR 0212); in a pane they stay as they are.
 */
export function ChatDock({
  lift,
  peekAgentId,
  showList,
  settled,
  pull,
  boxHeight,
  far,
  atEnd,
  gap,
  readHold,
  unseen,
  jumpRest,
  toEnd,
  floatRest,
  composerFloat,
  composerRef,
  onComposerBoxLayout,
  bottomPad,
  walled,
  wallSize,
  backdrop,
  keyboardAt,
  banner,
  org,
  notices,
  member,
  awayAsk,
  seeAsk,
  runs,
  lineBase,
  consultData,
  canStop,
  stopRun,
  waitingFirst,
  waitingHere,
  seeWaiting,
  live,
  meId,
  threadId,
  seeConsult,
  openBrowserLine,
  lineStop,
  returnLine,
  dmAgent,
  channel,
  capsuleRest,
  placeholder,
  sendFromField,
  working,
  plusFromField,
  composerMedia,
  channelId,
  prefill,
  captionBack,
  replyAt,
  composerBanner,
  composerAttachments,
  pending,
  canAttach,
  longFromField,
  mentionCard,
  onType,
  orgId,
  dmAgentId,
  quote,
  voiceOn,
  afterVoice,
  voiceFromField,
  voiceTakeBack,
  onRecording,
  admin,
  join,
}: Pick<
  ChatData,
  | "gap"
  | "walled"
  | "backdrop"
  | "org"
  | "notices"
  | "member"
  | "runs"
  | "canStop"
  | "stopRun"
  | "live"
  | "lineStop"
  | "dmAgent"
  | "channel"
  | "working"
  | "dmAgentId"
  | "admin"
  | "join"
> &
  Pick<ChatRows, "lineBase" | "consultData"> &
  Pick<
    FollowEnd,
    "far" | "atEnd" | "readHold" | "unseen" | "toEnd" | "seeAsk" | "waitingFirst" | "waitingHere" | "seeWaiting"
  > &
  Pick<ListPlacement, "peekAgentId" | "pull"> &
  Pick<ConversationActions, "seeConsult" | "openBrowserLine" | "returnLine"> &
  Pick<
    ChatSend,
    | "sendFromField"
    | "plusFromField"
    | "composerMedia"
    | "captionBack"
    | "replyAt"
    | "composerBanner"
    | "composerAttachments"
    | "pending"
    | "canAttach"
    | "longFromField"
    | "mentionCard"
    | "onType"
    | "quote"
    | "voiceOn"
    | "afterVoice"
    | "voiceFromField"
    | "voiceTakeBack"
    | "onRecording"
  > & {
    lift: number;
    showList: boolean;
    settled: boolean;
    boxHeight: SharedValue<number>;
    jumpRest: AnimatedViewStyle;
    floatRest: AnimatedViewStyle;
    capsuleRest: AnimatedViewStyle;
    composerFloat: ComposerFloatSlot;
    composerRef: RefObject<ComponentRef<typeof View> | null>;
    onComposerBoxLayout: (e: LayoutChangeEvent) => void;
    bottomPad: number;
    wallSize: { width: number; height: number } | null;
    keyboardAt: ReturnType<typeof useReanimatedKeyboardAnimation>;
    banner: ReturnType<typeof noAiBanner>;
    awayAsk: ReturnType<typeof useAwayAsk>;
    meId: string | null;
    threadId: string | null;
    channelId: string;
    orgId: string;
    placeholder: string;
    prefill: ReturnType<typeof useComposerRequest> | null;
  }) {
  const { t } = useTranslation();
  const c = useColors();
  const room = useFoldRoom();
  return (
    <KeyboardStickyView offset={{ opened: lift }} style={styles.composerDock} pointerEvents="box-none">
      {/* First in the dock, so everything in it draws over the face. Unseen until a pull past the end: it
          mounts after the push. */}
      {peekAgentId && showList && settled ? <ChatPeek agentId={peekAgentId} pull={pull} dock={boxHeight} /> : null}
      {/* Right above the composer and its working line, in the same dock: it rides the keyboard with them and
          moves with the box in the same frame when the field grows a line (placed from the box's measured
          height it came a render later). */}
      {showList ? (
        // Far up with nothing new below shows it too: the line's crossing (`far`) redraws the gate alone.
        <FarGate
          far={far}
          away={!atEnd}
          shown={gap || readHold || (!atEnd && (unseen.messages > 0 || unseen.working.length > 0))}
        >
          <Animated.View style={[styles.jumpAt, jumpRest]} pointerEvents="box-none">
            <ToLatest unseen={unseen} onPress={toEnd} />
          </Animated.View>
        </FarGate>
      ) : null}
      {/* The "@" picker, right above the box and outside it: the box's height insets the list, and the picker
          comes and goes with each key typed. */}
      {/* Its rest padding moves on the UI thread with the keyboard; the fold's room is added around it. */}
      <View pointerEvents="box-none" style={room && padPastFold(room, 0)}>
        <Animated.View style={[styles.float, floatRest]} pointerEvents="box-none">
          <ComposerFloat slot={composerFloat} />
        </Animated.View>
      </View>
      <View
        ref={composerRef}
        onLayout={onComposerBoxLayout}
        style={[styles.composer, { paddingBottom: bottomPad }, room && padPastFold(room, DOCK_SIDE)]}
      >
        {/* The conversation fades under the box: no hard edge above it. Over a background, into the
            background itself. */}
        {walled && wallSize ? (
          <WallpaperUnder
            wallpaper={backdrop.wallpaper}
            strength={backdrop.strength}
            width={wallSize.width}
            height={wallSize.height}
            box={boxHeight}
            keyboard={keyboardAt}
            lift={lift}
          />
        ) : (
          // A short fade at the box's top (`DOCK_FADE`), then the page: its first line never sits over words.
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <LinearGradient colors={[withOpacity(c.bg, 0), c.bg]} style={styles.dockFade} />
            <View style={[styles.grow, { backgroundColor: c.bg }]} />
          </View>
        )}
        {banner && !org?.deletion ? <NoAiBanner banner={banner} /> : null}
        {channel?.name === "general" && !threadId && !dmAgentId && !org?.deletion ? <TeamStalledLine /> : null}
        <UnavailableLines notices={notices} />
        {/* A request waiting out of view, with "Ver" (and the working line's stop while one agent works).
            Who is working sits here only while there is no conversation yet: once there is one, it is the
            conversation's last line (`WORK_FOOTER`), scrolling with it. */}
        {member && awayAsk ? (
          <LineAskBar
            away={awayAsk}
            onSee={seeAsk}
            runs={runs}
            consults={lineBase}
            consultData={consultData}
            canStop={canStop}
            onStop={stopRun}
          />
        ) : null}
        {member && waitingFirst ? (
          <WaitingHereBar
            count={waitingHere.length}
            agentId={waitingFirst.asker?.type === "agent" ? waitingFirst.asker.id : null}
            onSee={seeWaiting}
          />
        ) : null}
        {member && !awayAsk && !waitingFirst && !showList ? (
          <LiveWorkingLine
            runs={runs}
            consults={lineBase}
            consultData={consultData}
            typing={live.typing}
            meId={meId}
            threadId={threadId}
            onSeeConsult={seeConsult}
            onOpenBrowser={openBrowserLine}
            stop={lineStop}
            rest={returnLine}
          />
        ) : null}
        {org?.deletion ? (
          // Being deleted, it reads as ever and takes no message, nor anyone joining (ADR 0088 §7).
          <Text variant="footnote" tone="muted" style={styles.readOnly}>
            {t("deleting.composer")}
          </Text>
        ) : member && dmAgent && !canTalk(dmAgent) ? (
          <AgentLocked agent={dmAgent} />
        ) : member && channel?.can?.post === false ? (
          // The channel's exceptions keep me from sending here (ADR 0134): reading stays open.
          <Text variant="footnote" tone="muted" style={styles.readOnly}>
            {t("channel.perms.readOnlyComposer")}
          </Text>
        ) : member ? (
          <Animated.View style={capsuleRest}>
            <ChatComposer
              placeholder={placeholder}
              onSend={sendFromField}
              working={working}
              // GIFs and stickers in the "+", with the photos, and beside the mic in the empty field.
              onPlus={plusFromField}
              media={composerMedia}
              draftKey={threadId ? `${channelId}:${threadId}` : channelId}
              inputNativeID={COMPOSER_INPUT_ID}
              float={composerFloat}
              mentionAt={refQuery}
              insertMention={insertRef}
              prefill={prefill ?? captionBack}
              focusAt={replyAt}
              banner={composerBanner}
              attachments={composerAttachments}
              sendEmpty={pending.length > 0}
              {...(canAttach ? { onLongAsFile: longFromField } : {})}
              mention={mentionCard}
              onType={onType}
              orgId={orgId}
              channelId={channelId}
              threadId={threadId}
              agentId={dmAgentId}
              replyTo={quote?.id ?? null}
              authorId={meId ?? ""}
              voiceOn={voiceOn}
              onVoiceSent={afterVoice}
              prepareVoice={voiceFromField}
              voiceTakeBack={voiceTakeBack}
              onRecording={onRecording}
            />
          </Animated.View>
        ) : (
          <>
            {admin ? (
              <Text variant="footnote" tone="muted" style={styles.readOnly}>
                {t("channel.adminReading")}
              </Text>
            ) : null}
            <Button
              variant="primary"
              wide
              label={t("mobile.chat.join")}
              disabled={join.isPending}
              onPress={() => join.mutate()}
            />
          </>
        )}
      </View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  dockFade: { height: DOCK_FADE },
  grow: { flex: 1 },
  composer: { paddingHorizontal: DOCK_SIDE, paddingTop: 6 },
  readOnly: { textAlign: "center", paddingHorizontal: 16, paddingVertical: 12 },
  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  // Over the list, at the dock's top right, centered over the capsule's last button (its 6 inset and half its 36)
  // under it; the list under the rest of its row still takes the touches.
  jumpAt: { alignSelf: "flex-end", marginRight: DOCK_SIDE + 4, marginBottom: 10 },
  // The composer's side inset, so the picker and the pills line up with the field under them.
  float: { paddingHorizontal: DOCK_SIDE },
});
