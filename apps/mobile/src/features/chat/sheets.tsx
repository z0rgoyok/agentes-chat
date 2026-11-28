import {
  ApiError,
  type Channel,
  cachePinned,
  channelsQuery,
  type DirectMessage,
  dmsQuery,
  isPinnedSelection,
  keys,
  type Message,
  type Mission,
  messageLiveRef,
  type ReactionCount,
  resolvedOf,
  type ThreadInfo,
  useApi,
  useCloseMission,
  useFollowThread,
  useMissionControl,
  usePinMessage,
  usePins,
  useResolveComment,
  useSidebarView,
  useThreadInfo,
  useThreadMutation,
  useToggleReaction,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { summaryParts } from "@agenteschat/client/lib/missions";
import { sectionOfChannel } from "@agenteschat/client/lib/sidebar-view";
import { listedText } from "@agenteschat/client/lib/voice";
import { conversationWallpaperOf } from "@agenteschat/client/lib/wallpaper";
import { chartBlocksOf } from "@agenteschat/ui/widgets/spec";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { CHROME_MAX_SCALE, Count, GroupedList, GroupedRow, Icon, PressScale, SkeletonList, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { sectorHref } from "../channel-sectors/logic";
import { useMovesChannel } from "../channel-sectors/menus";
import { setPinDraft } from "../dashboards/logic";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { type Directory, useColors, useDirectory, useOrgId } from "../shared/hooks";
import { genderOf, previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { type ActionItem, ActionList, copyText, successHaptic, Tile, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { useWallpaperName } from "./ChatWallpaper";
import { QUICK_REACTIONS, reactionName, reactionPills } from "./logic";
import type { MenuSymbol } from "./MessageMenu";
import { useRowDirectory, useRowMeId } from "./row-data";
import { wallpaperHrefs } from "./wallpaper-logic";

// ── Long press on a message ──────────────────────────────────────────────────

/** What a message's menu is about, beyond the message: what the screen can do with it. */
export interface MessageActionsContext {
  message: Message;
  /** "Transformar em missão" is offered (a channel or a DM, not a mission thread). */
  canMission: boolean;
  /** The screen is the thread view (no "Responder em thread"). */
  inThread: boolean;
  thread: ThreadInfo | undefined;
  onMission: (goal: string, threadId: string) => void;
  /** "Lembrar disso": the screen opens the reminder sheet for this message. */
  onRemind: (m: Message) => void;
  /** "Responder": the next message answers this one, in the conversation (a quote). Absent where nothing can be written. */
  onReply?: ((m: Message) => void) | undefined;
}

/** One action of a message's menu: the sheet's row, with the system's symbol for the native menu. */
export interface MessageAction extends ActionItem {
  symbol?: MenuSymbol;
}

/** What a message's actions do their work with (`messageActionsOf`). */
export interface MessageActionHands {
  t: TFunction;
  orgId: string;
  meId: string | null;
  dir: Pick<Directory, "nameOf">;
  toast: ReturnType<typeof useToast>;
  qc: QueryClient;
  /** Adds or takes back a reaction of mine (`useToggleReaction`). */
  toggle: ReturnType<typeof useToggleReaction>["mutate"];
  /** Pins or unpins (`usePinMessage`). */
  pin: ReturnType<typeof usePinMessage>["mutate"];
  /** Resolves a comment on a picture, a video or a PDF, or opens it again (`useResolveComment`, ADR 0208). */
  resolve: ReturnType<typeof useResolveComment>["mutate"];
}

/**
 * A message's actions, one list for the system's menu (iOS, on hold) and the app's sheet (Android): the quick
 * reactions, then the actions in groups, as the hand expects them: answer (here, in a thread), keep (copy, pin,
 * resolve a comment on a file, remind, a mission), and the rest (its link, a chart to a dashboard, the agent who wrote
 * it). `close` runs before an action that opens something else (the sheet closes; the system's menu closes itself).
 */
export function useMessageActions(context: MessageActionsContext, close: () => void) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const toast = useToast();
  const qc = useQueryClient();
  const toggle = useToggleReaction(orgId, context.message.id).mutate;
  const pin = usePinMessage(orgId).mutate;
  const resolve = useResolveComment(orgId).mutate;
  return messageActionsOf(context, close, { t, orgId, meId, dir, toast, qc, toggle, pin, resolve });
}

/**
 * `useMessageActions` without its hooks, for the system's menu, which builds its actions only once a finger is on the
 * row (`MessageMenuFor`). A reaction reads the message's reactions as they are when it is picked.
 */
export function messageActionsOf(context: MessageActionsContext, close: () => void, hands: MessageActionHands) {
  const { message: m, canMission, inThread, thread, onMission, onRemind, onReply } = context;
  const { t, orgId, meId, dir, toast, qc, toggle, pin, resolve } = hands;
  const pinned = Boolean(m.pinned);
  const togglePin = () => {
    close();
    const next = !pinned;
    // The mark shows at once; the server's answer (or its event) confirms it.
    cachePinned(qc, orgId, m.channelId, m.id, next);
    pin(
      { channelId: m.channelId, messageId: m.id, pinned: next },
      {
        onSuccess: () => toast({ title: t(next ? "mobile.pins.pinned" : "mobile.pins.unpinned"), icon: "pin" }),
        onError: (e) => {
          cachePinned(qc, orgId, m.channelId, m.id, pinned);
          const full = e instanceof ApiError && e.code === "pins.limit";
          toast({ title: t(full ? "mobile.pins.full" : "mobile.app.failed"), icon: "x" });
        },
      },
    );
  };
  // A comment with a pin on a picture, a video or a PDF (ADR 0208): Resolve takes its pin off the file, Reopen puts
  // it back; the message stays. At once here (`useResolveComment`), then as the server says (`message.resolved`).
  const resolvable = !m.local && isPinnedSelection(messageLiveRef(m)?.selection);
  const resolved = resolvable && resolvedOf(m.meta) !== null;
  const toggleResolved = () => {
    close();
    resolve(
      { channelId: m.channelId, messageId: m.id, resolved: !resolved, by: { type: "person", id: meId ?? "" } },
      { onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }) },
    );
  };
  const agentName = m.author.type === "agent" ? dir.nameOf(m.author) : "";
  const rootId = m.threadId ?? m.id;
  // Of a voice message only what was typed beside it: its words are the audio's.
  const text = previewOf(listedText(m.body, m.meta));
  // An agent's charts can be pinned to a dashboard as widgets (ADR 0135).
  const charts = m.local || m.author.type !== "agent" ? [] : chartBlocksOf(m.body);
  const pinChart = () => {
    close();
    setPinDraft({ messageId: m.id, agentId: m.author.id ?? "", blocks: charts });
    router.push("/widget-pin");
  };
  const react = (emoji: string) => {
    tapHaptic();
    const reaction = reactionName(emoji);
    const now = qc.getQueryData<ReactionCount[]>(keys.reactions(orgId, m.id)) ?? m.reactions;
    const mine = reactionPills(now, meId).find((p) => p.reaction === reaction)?.mine ?? false;
    toggle({ reaction, on: !mine });
    close();
  };
  const copied = (ok: boolean, title: string) =>
    toast(ok ? { title, icon: "copy" } : { title: t("mobile.app.failed"), icon: "x" });
  const answer: MessageAction[] = [
    ...(!m.local && onReply
      ? [
          {
            key: "reply",
            icon: "replyTo" as const,
            symbol: "arrowshape.turn.up.left" as const,
            label: t("channel.reply"),
            onPress: () => {
              close();
              onReply(m);
            },
          },
        ]
      : []),
    ...(!inThread && !m.local
      ? [
          {
            key: "thread",
            icon: "reply" as const,
            symbol: "bubble.left.and.bubble.right" as const,
            label: thread ? t("mobile.chat.openThread") : t("mobile.chat.replyInThread"),
            onPress: () => {
              close();
              router.push(chatHref(m.channelId, rootId));
            },
          },
        ]
      : []),
  ];
  const keep: MessageAction[] = [
    ...(text
      ? [
          {
            key: "copy",
            icon: "copy" as const,
            symbol: "doc.on.doc" as const,
            label: t("mobile.chat.copy"),
            onPress: () => {
              close();
              void copyText(m.body).then((ok) => copied(ok, t("mobile.chat.copied")));
            },
          },
        ]
      : []),
    ...(!m.local
      ? [
          {
            key: "pin",
            icon: "pin" as const,
            symbol: (pinned ? "pin.slash" : "pin") as MenuSymbol,
            label: pinned ? t("mobile.pins.unpin") : t("mobile.pins.pin"),
            onPress: togglePin,
          },
          ...(resolvable
            ? [
                {
                  key: "resolve",
                  icon: "check" as const,
                  symbol: (resolved ? "arrow.uturn.backward" : "checkmark.circle") as MenuSymbol,
                  label: resolved ? t("files.comments.reopen") : t("files.comments.resolve"),
                  onPress: toggleResolved,
                },
              ]
            : []),
          {
            key: "remind",
            icon: "clock" as const,
            symbol: "clock" as const,
            label: t("mobile.remind.aboutThis"),
            // The reminder's sheet takes this one's place (no close in between).
            onPress: () => onRemind(m),
          },
        ]
      : []),
    ...(canMission && !m.local
      ? [
          {
            key: "mission",
            icon: "target" as const,
            symbol: "target" as const,
            label: t("mobile.chat.toMission"),
            onPress: () => onMission(text, rootId),
          },
        ]
      : []),
  ];
  const rest: MessageAction[] = [
    ...(!m.local
      ? [
          {
            key: "link",
            icon: "link" as const,
            symbol: "link" as const,
            label: t("messageRefs.copy"),
            onPress: () => {
              close();
              void copyText(`${serverUrl()}${messagePath(orgId, m)}`).then((ok) =>
                copied(ok, t("contextMenu.linkCopied")),
              );
            },
          },
        ]
      : []),
    ...(charts.length > 0 && m.author.id
      ? [
          {
            key: "dashboard",
            icon: "chart" as const,
            symbol: "chart.bar" as const,
            label: t("widgets.pin.label"),
            onPress: pinChart,
          },
        ]
      : []),
    ...(m.author.type === "agent" && m.author.id
      ? [
          {
            key: "agent",
            leading: <AgentFace agentId={m.author.id} size={20} live={false} />,
            symbol: "person.crop.square" as const,
            label: t("mobile.chat.seeAgent", { name: agentName }),
            onPress: () => {
              close();
              router.push(`/agent/${m.author.id}`);
            },
          },
        ]
      : []),
  ];
  const groups = [answer, keep, rest].filter((g) => g.length > 0);
  return { text, react, groups };
}

/**
 * Holding a message where the platform has no menu of its own (Android): the app's sheet, in the menu's order. The
 * reactions first (the hand already knows), the message under them, then the actions in their groups.
 */
export function MessageActions(props: MessageActionsContext) {
  const { message: m } = props;
  const { t } = useTranslation();
  const surface = useSurface();
  const sheet = useSheet();
  const { text, react, groups } = useMessageActions(props, sheet.close);
  return (
    <>
      {m.local ? null : (
        <View style={[styles.emorow, surface]}>
          {QUICK_REACTIONS.map((e) => (
            // The kit's press (the reaction's own tap is its haptic).
            <PressScale
              key={e}
              to={0.9}
              haptic={false}
              onPress={() => react(e)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.chat.reactWith", { emoji: e })}
              style={styles.emo}
              contentStyle={styles.emoIn}
            >
              <Text maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.emoText}>
                {e}
              </Text>
            </PressScale>
          ))}
        </View>
      )}
      <View style={[styles.preview, surface]}>
        <Face who={m.author} size={24} live={false} />
        <Text variant="small" tone="ink2" numberOfLines={3} style={styles.grow}>
          {text || previewOf(textOrMedia(t, m.body, m.meta)) || t("mobile.chat.approvalPreview")}
        </Text>
      </View>
      <View style={styles.groups}>
        {groups.map((g) => (
          <ActionList key={g[0]?.key ?? ""} items={g} />
        ))}
      </View>
    </>
  );
}

// ── "+" in the composer ──────────────────────────────────────────────────────

export type PlusPick = "camera" | "photos" | "file" | "paste" | "media" | "summary" | "remind";

/**
 * The "+" of the chat: what goes with a message as tiles (camera, photos, file, the picture on the clipboard when
 * there is one and, where they can be sent, the GIFs and stickers, so the field itself only sends), then what to start
 * here, in words. The phone's text field can't take a pasted picture: the Paste tile is how one gets in.
 */
export function PlusActions({
  onPick,
  media = false,
  paste = false,
}: {
  onPick: (pick: PlusPick) => void;
  media?: boolean;
  /** A picture is on the clipboard. */
  paste?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const tiles: { key: PlusPick; icon: "camera" | "image" | "file" | "paste" | "sticker"; label: string }[] = [
    { key: "camera", icon: "camera", label: t("mobile.plus.camera") },
    { key: "photos", icon: "image", label: t("mobile.plus.photos") },
    { key: "file", icon: "file", label: t("mobile.plus.file") },
    ...(paste ? [{ key: "paste" as const, icon: "paste" as const, label: t("mobile.plus.paste") }] : []),
    ...(media ? [{ key: "media" as const, icon: "sticker" as const, label: t("mobile.plus.media") }] : []),
  ];
  return (
    <>
      <View style={styles.tiles}>
        {tiles.map((x) => (
          <PressScale
            key={x.key}
            onPress={() => onPick(x.key)}
            accessibilityRole="button"
            accessibilityLabel={x.label}
            style={styles.tileBtn}
            contentStyle={[styles.tileIn, { backgroundColor: c.raised }]}
          >
            <Icon name={x.icon} size={24} />
            <Text variant="caption" tone="ink2" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {x.label}
            </Text>
          </PressScale>
        ))}
      </View>
      <ActionList
        items={[
          {
            key: "summary",
            icon: "sparkle",
            label: t("mobile.plus.summary"),
            hint: t("mobile.plus.summaryHint"),
            onPress: () => onPick("summary"),
          },
          {
            key: "remind",
            icon: "clock",
            label: t("mobile.plus.remind"),
            hint: t("mobile.plus.remindHint"),
            onPress: () => onPick("remind"),
          },
        ]}
      />
    </>
  );
}

// ── ⋯ of a thread or a mission ───────────────────────────────────────────────

export function ThreadOptions({
  thread,
  mission,
  onMission,
  onPins,
}: {
  thread: ThreadInfo;
  mission: Mission | null;
  /** "Transformar em missão" (a plain thread). */
  onMission?: () => void;
  /** "Fixadas" of the conversation. */
  onPins?: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const qc = useQueryClient();
  const mutate = useThreadMutation(orgId);
  const follow = useFollowThread(orgId);
  // The sheet keeps the thread it opened with: "Seguir" reads the live view.
  const live = useThreadInfo(orgId, thread.id);
  const following = Boolean(live.data?.following ?? thread.following);
  const setFollowing = (next: boolean) => {
    const key = keys.threadInfo(orgId, thread.id);
    const put = (value: boolean) =>
      qc.setQueryData<ThreadInfo>(key, (cur) => (cur ? { ...cur, following: value } : cur));
    put(next);
    follow.mutate(
      { threadId: thread.id, following: next },
      {
        onError: () => {
          put(!next);
          fail();
        },
      },
    );
  };
  const control = useMissionControl(orgId);
  const close = useCloseMission(orgId);
  // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
  const title = thread.title?.trim() || previewOf(thread.rootText) || t("mobile.chat.thread");
  const name = mission ? (dir.agentById.get(mission.agentId)?.name ?? "") : "";
  const g = genderOf(name);
  const fail = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const act = (action: "close" | "reopen" | "archive") =>
    mutate.mutate(
      { type: "action", thread, action },
      {
        onSuccess: () => {
          sheet.close();
          toast({
            title: t(`mobile.thread.done.${action}`),
            ...(action === "close" ? { subtitle: t("mobile.thread.done.closeSub") } : {}),
            icon: action === "archive" ? "archive" : "check",
          });
          if (action !== "reopen" && router.canGoBack()) router.back();
        },
        onError: fail,
      },
    );
  const open =
    mission &&
    (mission.status === "active" ||
      mission.status === "paused" ||
      mission.status === "proposed" ||
      mission.status === "awaiting_close");
  return (
    <>
      <SheetTitle
        leading={<Tile icon={mission ? "target" : "reply"} />}
        title={title}
        subtitle={
          mission
            ? t("mobile.thread.missionIn", { channel: thread.channelName })
            : t("mobile.thread.threadIn", { channel: thread.channelName })
        }
      />
      <ActionList
        items={[
          {
            key: "follow",
            icon: "bell" as const,
            label: t("mobile.thread.follow"),
            hint: t("mobile.thread.followHint"),
            checked: following,
            onPress: () => setFollowing(!following),
          },
          ...(onPins ? [{ key: "pins", icon: "pin" as const, label: t("mobile.pins.title"), onPress: onPins }] : []),
          ...(mission
            ? [
                {
                  key: "plan",
                  icon: "list" as const,
                  label: t("mobile.thread.seePlan"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/mission/${mission.id}`);
                  },
                },
                ...(mission.canAct && mission.status === "active"
                  ? [
                      {
                        key: "pause",
                        icon: "pause" as const,
                        label: t("mobile.thread.pause"),
                        hint: t(`mobile.thread.pauseHint${g}`, { name }),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "pause" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.paused"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
                ...(mission.canAct && mission.status === "paused"
                  ? [
                      {
                        key: "resume",
                        icon: "sparkle" as const,
                        label: t("mobile.thread.resume"),
                        onPress: () =>
                          control.mutate(
                            { missionId: mission.id, action: "resume" },
                            {
                              onSuccess: () => {
                                sheet.close();
                                toast({ title: t("mobile.thread.done.resumed"), agentId: mission.agentId });
                              },
                              onError: fail,
                            },
                          ),
                      },
                    ]
                  : []),
              ]
            : onMission
              ? [
                  {
                    key: "mission",
                    icon: "target" as const,
                    label: t("mobile.chat.toMission"),
                    hint: t("mobile.thread.toMissionHint"),
                    onPress: onMission,
                  },
                ]
              : []),
        ]}
      />
      <ActionList
        items={[
          ...(mission
            ? mission.canManage && open
              ? [
                  {
                    key: "done",
                    icon: "check" as const,
                    label: t("mobile.thread.conclude"),
                    hint: t("mobile.thread.concludeHint"),
                    onPress: () =>
                      close.mutate(
                        { missionId: mission.id, outcome: "done", saveToWiki: true },
                        {
                          onSuccess: () => {
                            sheet.close();
                            successHaptic();
                            toast({ title: t("mobile.thread.done.concluded"), agentId: mission.agentId });
                          },
                          onError: fail,
                        },
                      ),
                  },
                ]
              : []
            : thread.canManage
              ? [
                  thread.state === "closed"
                    ? {
                        key: "reopen",
                        icon: "reply" as const,
                        label: t("mobile.thread.reopen"),
                        onPress: () => act("reopen"),
                      }
                    : {
                        key: "close",
                        icon: "check" as const,
                        label: t("mobile.thread.close"),
                        hint: t("mobile.thread.closeHint"),
                        onPress: () => act("close"),
                      },
                ]
              : []),
          ...(thread.canManage
            ? [
                {
                  key: "archive",
                  icon: "archive" as const,
                  label: t("mobile.thread.archive"),
                  hint: t("mobile.thread.archiveHint"),
                  onPress: () => act("archive"),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── ⋯ of a channel or a DM ───────────────────────────────────────────────────

export function ChannelOptions({
  channelId,
  title,
  subtitle,
  leading,
  agentId,
  about,
  onPins,
  onMembers,
  onSearch,
}: {
  channelId: string;
  title: string;
  subtitle?: string;
  leading: ReactNode;
  /** An agent's DM: "Perfil". */
  agentId?: string | null;
  /** Under the title: a person's status in a DM with them (ADR 0084). */
  about?: ReactNode;
  onPins: () => void;
  /** A channel: who is in it (and, for admins, adding and removing). */
  onMembers?: (() => void) | undefined;
  /** A DM: searching it (its header keeps the room for the name and the agent's own buttons). */
  onSearch?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const pins = usePins(orgId, channelId);
  const count = pins.data?.length ?? 0;
  // Who may change the channel (its "reply in threads").
  const moves = useMovesChannel(channelId);
  // Only what this sheet reads of the lists (whether it is a DM): they are read again for any message.
  const api = useApi();
  const isDm = useCallback((all: DirectMessage[]) => all.some((d) => d.channelId === channelId), [channelId]);
  // "Agents reply in threads" (ADR 0214), for whoever may change the channel: undefined where it isn't a channel.
  const threadsOf = useCallback(
    (all: Channel[]) => {
      const c = all.find((x) => x.id === channelId);
      return c ? c.replyInThreads === true : undefined;
    },
    [channelId],
  );
  const replyInThreads = useQuery({ ...channelsQuery(api, orgId), select: threadsOf }).data;
  const qc = useQueryClient();
  const toast = useToast();
  const setThreads = useMutation({
    mutationFn: (on: boolean) => api.chat.update(orgId, channelId, { replyInThreads: on }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
    onError: (e) => toast({ title: errorText(t, e, i18n.language), icon: "x" }),
  });
  // The person's own section it sits in (ADR 0260).
  const ownSections = useSidebarView(orgId).sections ?? [];
  const sectionName = ownSections.find((s) => s.id === sectionOfChannel(ownSections, channelId))?.name;
  // This conversation's own background, mine alone; none of its own: it follows the others.
  const { org } = useOrg();
  const dm = useQuery({ ...dmsQuery(api, orgId), select: isDm }).data === true;
  const ownWallpaper = conversationWallpaperOf(org?.chatPrefs, channelId);
  const nameOf = useWallpaperName();
  return (
    <>
      <SheetTitle leading={leading} title={title} {...(subtitle ? { subtitle } : {})} />
      {about}
      <ActionList
        items={[
          ...(onSearch
            ? [{ key: "search", icon: "search" as const, label: t("searchPage.searchHere"), onPress: onSearch }]
            : []),
          ...(onMembers
            ? [{ key: "members", icon: "members" as const, label: t("shell.members"), onPress: onMembers }]
            : []),
          {
            key: "pins",
            icon: "pin",
            label: t("mobile.pins.title"),
            ...(pins.isSuccess && count === 0 ? { hint: t("mobile.pins.none") } : {}),
            ...(count > 0 ? { trailing: <Count value={count} max={99} /> } : {}),
            onPress: onPins,
          },
          ...(onMembers
            ? [
                {
                  key: "sector",
                  icon: "list" as const,
                  label: t("mobile.sections.title"),
                  hint: sectionName ?? t("mobile.sections.none"),
                  onPress: () => {
                    sheet.close();
                    router.push(sectorHref(channelId));
                  },
                },
              ]
            : []),
          ...(onMembers && moves && replyInThreads !== undefined
            ? [
                {
                  key: "threads",
                  icon: "reply" as const,
                  label: t("channel.replyInThreads"),
                  checked: replyInThreads,
                  disabled: setThreads.isPending,
                  onPress: () => setThreads.mutate(!replyInThreads),
                },
              ]
            : []),
          {
            key: "wallpaper",
            icon: "image",
            label: t("settings.account.chat.wallpaper.title"),
            hint: ownWallpaper ? nameOf(ownWallpaper, dm) : t("settings.account.chat.wallpaper.sameShort"),
            onPress: () => {
              sheet.close();
              router.push(wallpaperHrefs.choose({ channelId }));
            },
          },
          ...(agentId
            ? [
                {
                  key: "profile",
                  leading: <AgentFace agentId={agentId} size={20} live={false} />,
                  label: t("mobile.chat.profile"),
                  onPress: () => {
                    sheet.close();
                    router.push(`/agent/${agentId}`);
                  },
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── /summary of a mission ────────────────────────────────────────────────────

/**
 * Where the mission stands (only for me), in the web card's lines, one fact a row: the server's `text` is English.
 * Loading, the rows' shape; failed, what happened and the way to ask again.
 */
export function MissionSummaryView({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const summary = useQuery({
    queryKey: keys.missionPart(orgId, missionId, "summary"),
    queryFn: () => api.missions.summary(orgId, missionId),
    staleTime: 0,
  });
  return (
    <>
      <SheetTitle leading={<Tile icon="sparkle" />} title={t("mobile.plus.summary")} />
      {summary.isError ? (
        <LoadFailed onRetry={() => void summary.refetch()} />
      ) : !summary.data ? (
        <SkeletonList rows={2} />
      ) : (
        <GroupedList>
          {summaryParts(summary.data).map((p) => (
            <GroupedRow
              key={p.key}
              label={t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 })}
              labelLines={0}
            />
          ))}
        </GroupedList>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  preview: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 14 },
  emorow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  emo: { width: 44, height: 44, borderRadius: 22 },
  emoIn: { alignItems: "center", justifyContent: "center" },
  emoText: { fontSize: 26, lineHeight: 34 },
  // The action groups, divided as the menu divides them.
  groups: { gap: 12 },
  tiles: { flexDirection: "row", gap: 8 },
  tileBtn: { flex: 1 },
  // The four share the list's width and edges (its sides are theirs), each a flat raised square as the list is.
  tileIn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 76,
    paddingHorizontal: 4,
    borderRadius: 18,
    borderCurve: "continuous",
  },
});
