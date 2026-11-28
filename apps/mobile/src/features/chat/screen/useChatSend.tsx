import {
  type Agent,
  type ArtifactDetail,
  type ArtifactRef,
  keys,
  type Message,
  type MessageMedia,
  newClientId,
  sendHelpers,
  type useApi,
  useCreateMission,
  useMissionControl,
  usePostMessage,
  useSettings,
} from "@agenteschat/client";
import { type FoundKey, looksLikeApiKey, withoutApiKeys } from "@agenteschat/client/lib/api-key-text";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText, sendFailureOf, sendNeedsEdit } from "@agenteschat/client/lib/errors";
import { offersEveryone } from "@agenteschat/client/lib/everyone";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "@agenteschat/client/lib/files";
import { isMediaAlone, mediaTabsOf } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { localMeta } from "@agenteschat/client/lib/reply";
import { retryAnswer } from "@agenteschat/client/lib/retry-answer";
import { upsertMessage } from "@agenteschat/client/lib/timeline";
import { micShown, voiceOf, voiceSetupAsk } from "@agenteschat/client/lib/voice";
import { isIdHandle } from "@agenteschat/ui/names";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import { voiceSetupSeen } from "@/lib/storage";
import type { ComposerProps, SendHow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { handKeyToConnectAi } from "../../ai/connect-flow";
import { openConnectAi } from "../../ai/NoAiCard";
import { isLocalMedia, LOCAL_FILES, type LocalFile, localFilesOf } from "../../files/local-files";
import { rememberLocalCopy } from "../../files/source";
import { uploadPart } from "../../files/upload-part";
import { chatHref } from "../../links/logic";
import { LiveQuoteBar } from "../../live-files/talk/AboutLine";
import { dropTalkAbout, useTalkAbout } from "../../live-files/talk/store";
import { RemindSheet } from "../../reminders/RemindSheet";
import { takeShareHandoff, useShareHandoff } from "../../share/handoff";
import { suggestAgent } from "../../share/suggestions";
import type { useDirectory } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import type { useSheet } from "../../shared/SheetHost";
import { vaultHref } from "../../vault/logic";
import { retryVoice } from "../../voice/outbox";
import { useSayVoiceRefusal } from "../../voice/useVoiceTake";
import { VoiceSetupSheet } from "../../voice/VoiceSetupSheet";
import { AttachmentStrip, MAX_PENDING, type PendingFile } from "../AttachmentStrip";
import { ChannelPicker } from "../ChannelPicker";
import { KeyGuardSheet } from "../KeyGuardSheet";
import { handKeyToVault } from "../key-guard";
import { parseSlash, runInConversation } from "../logic";
import { MediaPickerSheet } from "../MediaPickerSheet";
import { MentionPicker } from "../MentionPicker";
import { newMissionHref } from "../new-mission";
import { QuoteBar } from "../QuoteLine";
import { datedBehind } from "../send-order";
import { MissionSummaryView, PlusActions, type PlusPick } from "../sheets";
import { useLatest } from "./hooks";
import type { ChatData } from "./useChatData";

/** How long a photo or file picker takes to cover the screen as it opens (ms). */
const PICKER_COVERS_MS = 500;
/**
 * A run in these takes a new message of its conversation into its work (the server steers it there): no second
 * "pensando…" for it. One waiting for an approval never does (the message gets a run of its own).
 */
const AT_WORK: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * Writing in the conversation: sending (behind files still going up), the slash commands, photos and files, voice
 * takes, GIFs and stickers, the "+", a key caught in the words, and what the composer is handed.
 */
export function useChatSend({
  channelId,
  threadId,
  orgId,
  meId,
  api,
  dir,
  t,
  i18n,
  toast,
  sheet,
  toEnd,
  leavePlace,
  data,
}: {
  channelId: string;
  threadId: string | null;
  orgId: string;
  meId: string | null;
  api: ReturnType<typeof useApi>;
  dir: ReturnType<typeof useDirectory>;
  t: ReturnType<typeof useTranslation>["t"];
  i18n: ReturnType<typeof useTranslation>["i18n"];
  toast: ReturnType<typeof useToast>;
  sheet: ReturnType<typeof useSheet>;
  toEnd: () => void;
  leavePlace: () => void;
  data: Pick<
    ChatData,
    | "channel"
    | "dm"
    | "dmAgentId"
    | "isThread"
    | "list"
    | "live"
    | "mentionMembers"
    | "mission"
    | "org"
    | "planHeld"
    | "roster"
    | "sendTyping"
  >;
}) {
  const { channel, dm, dmAgentId, isThread, list, live, mentionMembers, mission, org, planHeld, roster, sendTyping } =
    data;
  // ── Sending ──
  // Without a connection (no internet, or the server restarting) a message isn't "failed": it waits with a
  // clock and goes by itself when the connection is back, from whatever screen is open (`useSendWaiting`).
  const post = usePostMessage(orgId, channelId, {
    me: { id: meId ?? "" },
    // The moment my message is in the conversation, as on the web: an agent DM's "pensando…" on it, so the conversation's
    // last line says it in the frame the message appears, one glide down to both (from the server's answer it came
    // while the list was still going down to the message). Not
    // when the agent is at work here already: the server takes the message into that work ("reads it at the next pause"), no
    // second run; nor for a GIF or a sticker alone, which no agent answers (ADR 0091).
    onOptimistic: (local) => {
      // What waits behind it stays under it (`keepBehind`).
      if (waitingBehind.current.length > 0) keepBehind(local);
      if (isMediaAlone(local)) return;
      const atWork = live.runs.some(
        (r) =>
          !r.provisional &&
          r.agentId === dmAgentId &&
          AT_WORK.has(r.status) &&
          runInConversation(r, local.threadId ?? null),
      );
      if (dmAgentId && !atWork) live.expect(local.threadId ?? local.id, [dmAgentId], local.id);
      // A channel with agents: the router (or a mention) decides who answers, and `message.routed` always follows.
      if (channel && channelAgents.length > 0) live.picking(local.id);
    },
    // Its server id: what was guessed on its copy moves there (in the same update when the socket's copy comes first).
    // Taken into work already going here after all (the server steered it into a run with its own row), its
    // "pensando…" goes: no second run comes. Steered into a run waiting with no row (a wait this message ends), the
    // guess stays until the run resumes and takes its place: dropped now, the line went and came back a moment later.
    onSent: (message, local) => {
      live.retarget(local.id, message.id);
      // A message to an agent: it comes up among the share sheet's suggestions (ADR 0213).
      const agent = dmAgentId ? dir.agents.find((a) => a.id === dmAgentId) : undefined;
      if (agent) suggestAgent(orgId, { id: agent.id, name: agent.name, look: agentLook(agent) });
      const steered = Array.isArray(message.meta?.steeredRunIds) ? (message.meta.steeredRunIds as string[]) : [];
      if (live.runs.some((r) => !r.provisional && steered.includes(r.runId))) live.forget(message.id, false);
    },
    // Why, in words: the failed row under it says the same and keeps the text. Not sent, nothing answers it yet.
    onFailed: (error, { clientId, waits }) => {
      live.forget(`local-${clientId}`, true);
      if (!waits) toast({ title: errorText(t, error, i18n.language), icon: "x" });
    },
  });
  const { send, retry } = sendHelpers(post);
  // A message with files goes once they are up (seconds for a video), and the server dates it then: one sent meanwhile
  // went before it, its files landing under it, for everyone. While files of mine go up here, what I send next waits
  // behind them (`sendText`): its copy in its place at once, under them, and its request after theirs.
  const filesAhead = useRef<Promise<void> | null>(null);
  // The copies waiting there, in the order they were sent (their `clientId`s).
  const waitingBehind = useRef<string[]>([]);
  const behindFiles = useCallback((task: () => Promise<unknown>) => {
    const turn = (filesAhead.current ?? Promise.resolve()).then(task).then(
      () => undefined,
      () => undefined,
    );
    filesAhead.current = turn;
    void turn.then(() => {
      if (filesAhead.current === turn) filesAhead.current = null;
    });
  }, []);
  // "Responder" in a thread: the next message answers this one (`meta.replyTo`).
  const [quote, setQuote] = useState<Message | null>(null);
  const [replyAt, setReplyAt] = useState(0);
  const onReply = useCallback((m: Message) => {
    setQuote(m);
    setReplyAt(Date.now());
  }, []);
  // In a live file's conversation (ADR 0199), what the person had selected in the file (the quote over the field)
  // rides on the next message as `meta.liveRef`, once.
  const about = useTalkAbout(isThread ? channelId : "");
  const takeAbout = (): Record<string, unknown> => {
    if (!about) return {};
    dropTalkAbout(channelId);
    return { liveRef: about };
  };
  const takeQuote = (files: ArtifactRef[] = []) => {
    const liveRef = takeAbout();
    if (!quote) return files.length > 0 ? { ...localMeta(null, "", files), ...liveRef } : about ? liveRef : undefined;
    setQuote(null);
    return { ...localMeta(quote, dir.nameOf(quote.author), files), ...liveRef };
  };
  const qc = useQueryClient();
  const voiceRefused = useSayVoiceRefusal();
  // Rows keep the same callback (so a streaming reply doesn't re-render every message).
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const onRetry = useCallback(
    (m: Message) => {
      // Files that didn't go up go again, from the phone, then the message with them.
      if (m.local && localFilesOf(m.meta).length > 0) {
        qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
          list?.map((x) => (x.id === m.id ? { ...x, local: "pending" as const, sendFailure: undefined } : x)),
        );
        behindFiles(() => deliverFilesRef.current(m));
      }
      // A voice note waits in its own outbox: tried again there, now.
      else if (voiceOf(m.meta) && m.local) retryVoice(qc, m.clientId, voiceRefused);
      // Only a change to its text can make it go: it leaves the list and the text returns to the field.
      else if (sendNeedsEdit(m.sendFailure)) {
        qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => list?.filter((x) => x.id !== m.id));
        setCaptionBack({ text: m.body, at: Date.now(), join: true });
      } else retryRef.current(m);
    },
    [qc, voiceRefused, orgId, channelId, behindFiles],
  );
  // "Try again" under a message no agent could answer: the agent answers that same message again; only when it
  // can't, the same words go again, here (the web's `resend`).
  const sendRef = useRef(send);
  sendRef.current = send;
  const onResend = useCallback(
    (m: Message) =>
      retryAnswer(api, orgId, m, () => {
        sendRef.current(m.body, threadId);
        toEnd();
      }).catch((error) => toast({ title: errorText(t, error), icon: "x" })),
    [api, orgId, threadId, toEnd, toast, t],
  );
  const control = useMissionControl(orgId);
  const createMission = useCreateMission(orgId);
  const channelAgents = (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id);
  const soleAgent = dmAgentId ?? (channelAgents.length === 1 ? (channelAgents[0] ?? null) : null);
  // An empty channel says hi through one of its agents that answers me, by a handle people can read (as the web).
  const talkable = channelAgents.map((id) => dir.agentById.get(id)).filter((a): a is Agent => Boolean(a) && canTalk(a));
  const helloAgent = talkable.find((a) => !isIdHandle(a.handle)) ?? talkable[0];

  // A form, so a screen pushed over the conversation (its place kept for the way back), from wherever it is asked: the
  // "+", the thread's options or a message's actions (their sheet goes), the system's menu, `/mission`.
  const openNewMission = (goal = "", homeThreadId: string | null = threadId) => {
    sheet.close();
    leavePlace();
    router.push(
      newMissionHref({
        channelId,
        threadId: homeThreadId,
        goal,
        agentId: mission?.agentId ?? soleAgent,
        currentThreadId: threadId,
      }),
    );
  };
  const openRemind = (input: { text?: string; message?: Message } = {}) =>
    sheet.push(
      <RemindSheet
        channelId={channelId}
        threadId={threadId}
        {...(input.message ? { message: input.message } : {})}
        {...(input.text ? { initialText: input.text } : {})}
      />,
    );
  /** My words (or a GIF, a sticker) here: at once, or behind files of mine still going up (`filesAhead`). */
  const sendText = (body: string, meta?: Record<string, unknown>) => {
    if (!filesAhead.current) {
      send(body, threadId, meta);
      return;
    }
    // As `send` puts it: "Parar e mandar" rides as the request's `steer`, not in what the message carries.
    const { steer, ...rest } = meta ?? {};
    const clientId = newClientId();
    const local: Message = {
      id: `local-${clientId}`,
      channelId,
      threadId: threadId ?? null,
      author: { type: "person", id: meId ?? "" },
      body,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: rest,
      clientId,
      local: "pending",
      createdAt: new Date().toISOString(),
    };
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));
    waitingBehind.current.push(clientId);
    behindFiles(() => {
      waitingBehind.current = waitingBehind.current.filter((id) => id !== clientId);
      return post.mutateAsync({
        body,
        clientId,
        threadId,
        meta: meta ? rest : undefined,
        ...(steer === "now" ? { steer: "now" as const } : {}),
      });
    });
  };
  /** The copies waiting behind files stay under `ahead`, the message going out before them (`datedBehind`). */
  const keepBehind = (ahead: Message) =>
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
      datedBehind(list, ahead, waitingBehind.current),
    );
  const summarize = () => {
    if (mission) sheet.push(<MissionSummaryView missionId={mission.id} />);
    else sendText(t("mobile.chat.summaryMessage"));
  };

  /**
   * A key in the words (`KeyGuardSheet`, the web's `KeyGuardDialog`): the field already let them go, so nothing is sent
   * until the person picks, and the words come back to the field unless they send them as typed.
   */
  const guardKey = (text: string, found: FoundKey, sendAnyway: () => void) => {
    let picked = false;
    const back = (words: string) => {
      if (words) setCaptionBack({ text: words, at: Date.now(), join: true });
    };
    sheet.open(
      <KeyGuardSheet
        found={found}
        managesKeys={can(org, "manage_credentials") && !planHeld}
        onPick={(choice) => {
          picked = true;
          sheet.close(() => {
            if (choice === "send") return sendAnyway();
            back(withoutApiKeys(text));
            if (choice === "vault") {
              handKeyToVault(found);
              router.push(vaultHref.create("personal") as never);
            } else if (choice === "ai") {
              handKeyToConnectAi(found.key);
              openConnectAi({ intent: "api_key" });
            }
          });
        }}
      />,
      { onClose: () => !picked && back(text) },
    );
  };

  // Sending always goes to the end. While an agent works, "Parar e mandar" makes it read this one now.
  const onSend = (raw: string, how: SendHow = "join", keyChecked = false) => {
    const text = raw.trim();
    const found = keyChecked ? null : looksLikeApiKey(text);
    if (found) {
      guardKey(text, found, () => sendFromField(text, how, true));
      return;
    }
    // Photos or files waiting above the field: they go with the words, which are their caption (or with none).
    if (pending.length > 0) {
      sendWithFiles(text, how);
      return;
    }
    if (!text) return;
    const cmd = parseSlash(text);
    if (!cmd) {
      const meta = takeQuote();
      sendText(text, how === "now" ? { ...meta, steer: "now" } : meta);
      toEnd();
      return;
    }
    switch (cmd.command) {
      case "mission":
        if (cmd.arg && soleAgent && !mission)
          createMission.mutate(
            { agentId: soleAgent, goal: cmd.arg, ...(threadId ? { threadId } : { channelId }) },
            {
              onSuccess: (m) => {
                toast({
                  title: t("mobile.newMission.created", { name: dir.agentById.get(soleAgent)?.name ?? "" }),
                  agentId: m.agentId,
                });
                if (m.threadId !== threadId) router.push(chatHref(m.channelId, m.threadId));
              },
              onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
            },
          );
        else openNewMission(cmd.arg);
        return;
      case "summary":
        summarize();
        return;
      case "remind":
        openRemind({ text: cmd.arg });
        return;
      case "plan":
        if (mission) router.push(`/mission/${mission.id}`);
        else toast({ title: t("mobile.chat.noMission"), icon: "x" });
        return;
      default: {
        if (!mission) {
          toast({ title: t("mobile.chat.noMission"), icon: "x" });
          return;
        }
        const action = cmd.command;
        control.mutate(
          { missionId: mission.id, action },
          {
            onSuccess: () => toast({ title: t(`mobile.chat.missionDone.${action}`), agentId: mission.agentId }),
            onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
          },
        );
      }
    }
  };

  // GIFs and stickers (ADR 0091): the button only where one can go; one tap in the sheet sends it like any message of
  // mine. The list is aimed at the end before the sheet closes: the place it held under the sheet doesn't come back.
  const settings = useSettings(orgId).data;
  const mediaTabs = mediaTabsOf(settings, dir.agents.length, Boolean(api.gifs));
  // The microphone follows the workspace's switch (a server older than `speechState` shows it only with an engine);
  // where voice doesn't become text yet, the first hold shows `VoiceSetupSheet` instead.
  const voiceOn = Boolean(meId && micShown(settings));
  const voiceFresh = voiceSetupSeen.useFresh(meId ?? "");
  const askVoice = () => {
    const ask = voiceSetupAsk(settings, meId, voiceFresh);
    if (!ask || !meId) return false;
    sheet.open(
      <VoiceSetupSheet
        orgId={orgId}
        owner={ask.owner}
        isOwner={ask.isOwner}
        onDone={() => {
          voiceSetupSeen.mark(meId);
          sheet.close();
        }}
      />,
    );
    return true;
  };
  const afterVoice = useCallback(() => {
    setQuote(null);
    toEnd();
  }, [toEnd]);
  // A take goes with the words typed beside it and the files waiting above the field, in one message. The files that
  // can't upload keep the take, paused, and the words in the field (the composer puts them back).
  const withVoice = async (typed: string) => {
    // A key typed beside the take: the take goes without the words, which wait on the key guard. Asked only once the
    // take goes: when the files can't upload, the composer keeps the words, key and all, and nothing was sent.
    const found = looksLikeApiKey(typed);
    const text = found ? "" : typed;
    let artifacts: ArtifactRef[] = [];
    if (pending.length > 0) {
      const uploaded = await uploadPending(pending);
      if (!uploaded) return null;
      uploaded.forEach((a, i) => {
        const file = pending[i];
        if (file) sentWithVoice.current.set(a.id, file);
      });
      setPending([]);
      artifacts = uploaded;
    }
    if (found) guardKey(typed, found, () => sendFromField(typed, "join", true));
    return { text, artifacts };
  };
  const onRecording = useCallback(() => sendTyping(threadId, undefined, "voice"), [sendTyping, threadId]);
  // "recording audio…" goes on for the others while my recording uploads here; the server keeps it from then until the
  // message comes.
  const uploading = useMemo(
    () =>
      list.some(
        (m) =>
          m.local === "pending" &&
          m.author.id === meId &&
          voiceOf(m.meta) &&
          !m.meta?.voiceAccepted &&
          (m.threadId ?? null) === (threadId ?? null),
      ),
    [list, meId, threadId],
  );
  useEffect(() => {
    if (!uploading) return;
    const timer = setInterval(() => sendTyping(threadId, undefined, "voice", true), 1000);
    return () => clearInterval(timer);
  }, [uploading, sendTyping, threadId]);
  const sendMedia = (media: MessageMedia) => {
    sendText("", { ...takeQuote(), media });
    toEnd();
    sheet.close();
  };
  // Over the "+" when it opens from there (a step back to it), on its own from the field's button.
  const openMedia = () =>
    sheet.push(
      <MediaPickerSheet
        tabs={mediaTabs}
        channelId={channelId}
        isDm={Boolean(dm)}
        dmAgentId={dmAgentId}
        onSend={sendMedia}
      />,
    );

  // ── Photos and files ──
  // Picked, they wait in the field (`AttachmentStrip`): × takes one out, the words typed are their caption, and
  // send uploads them and sends everything as one message. A thumbnail dims while its upload runs; one that fails
  // stays, marked, and the caption comes back to the field, so nothing typed is lost.
  const [pending, setPending] = useState<PendingFile[]>([]);
  // A picker is open or still handing its files over (a video being converted): a thumbnail says so in the field.
  const [preparing, setPreparing] = useState(false);
  // That thumbnail only once the picker covers the screen: set as the picker opened, it came up in the dock for the
  // moment before the picker did (growing the dock, moving the conversation), and a cancel took it away again.
  const whilePicking = async <T,>(pick: () => Promise<T>): Promise<T> => {
    const covered = setTimeout(() => setPreparing(true), PICKER_COVERS_MS);
    try {
      return await pick();
    } finally {
      clearTimeout(covered);
      setPreparing(false);
    }
  };
  const [captionBack, setCaptionBack] = useState<{ text: string; at: number; join?: boolean } | null>(null);
  // The local files a take carried, by their uploaded ids: a refused take puts them back above the field.
  const sentWithVoice = useRef(new Map<string, PendingFile>());
  const voiceTakeBack = useCallback(({ text, artifacts }: { text: string; artifacts: ArtifactRef[] }) => {
    if (text) setCaptionBack({ text, at: Date.now(), join: true });
    const files = artifacts.flatMap((a) => {
      const file = sentWithVoice.current.get(a.id);
      return file ? [{ ...file, state: "waiting" as const }] : [];
    });
    if (files.length > 0) setPending((now) => [...files, ...now].slice(0, MAX_PENDING));
  }, []);
  const addPending = (all: Omit<PendingFile, "id" | "state">[]) => {
    // Past the upload limit a file never goes: said as it is picked, not after a wait at send.
    const files = all.filter((f) => f.size === undefined || f.size <= MAX_UPLOAD_BYTES);
    if (files.length < all.length)
      toast({ title: t("errors.artifact.fileTooLarge", { max: MAX_UPLOAD_MB }), icon: "x" });
    if (files.length === 0) return;
    const at = Date.now();
    const picked = files.map((f, i): PendingFile => ({ ...f, id: `${at}-${i}-${f.uri}`, state: "waiting" }));
    if (pending.length + picked.length > MAX_PENDING)
      toast({ title: t("mobile.chat.attach.tooMany", { count: MAX_PENDING }), icon: "file" });
    setPending((now) => [...now, ...picked].slice(0, MAX_PENDING));
  };
  const removePending = (id: string) => setPending((now) => now.filter((f) => f.id !== id));
  // A draft past the length limit goes as a text file instead, which agents open like any other.
  const longAsFile = (text: string) => {
    const dir = new Directory(Paths.cache, "drafts", String(Date.now()));
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, t("channel.tooLong.fileName"));
    file.write(text);
    addPending([{ uri: file.uri, name: file.name, type: "text/plain" }]);
  };
  const uploadOne = async (file: LocalFile): Promise<ArtifactRef> => {
    const saved: ArtifactDetail = await api.artifacts.upload(orgId, uploadPart(file), {
      channelId,
      ...(threadId ? { threadId } : {}),
    });
    return { id: saved.id, version: saved.version, title: saved.title };
  };
  /** Uploads what waits above the field; null when one failed (they stay, the failed ones marked). */
  const uploadPending = async (files: PendingFile[]): Promise<ArtifactRef[] | null> => {
    setPending((now) => now.map((f): PendingFile => ({ ...f, state: "sending" })));
    const results = await Promise.allSettled(files.map(uploadOne));
    const failed = new Set(files.filter((_, i) => results[i]?.status === "rejected").map((f) => f.id));
    if (failed.size > 0) {
      // Nothing goes half sent: the ones that failed stay marked.
      const after = (f: PendingFile): PendingFile["state"] => (failed.has(f.id) ? "failed" : "waiting");
      setPending((now) => now.map((f) => ({ ...f, state: after(f) })));
      // Why, when it is known (too large, the workspace's storage full, no connection…); else the plain line.
      const reason = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
      const said = reason ? errorText(t, reason, i18n.language, { maxMb: MAX_UPLOAD_MB }) : null;
      toast({ title: said && said !== t("common.unknownError") ? said : t("mobile.chat.uploadFailed"), icon: "x" });
      return null;
    }
    return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  };
  // Sent with files, the message is in the conversation at once, its files drawn from the phone (`LocalFiles`), and
  // the field is free for the next one: they upload behind it, then it goes with them under the same `clientId`, so
  // the server's copy takes its place. One that can't go up turns "Not sent" with "Try again".
  const sendWithFiles = (text: string, how: SendHow, files: PendingFile[] = pending) => {
    if (files.length === 0) return;
    const replyTo = quote;
    if (replyTo) setQuote(null);
    const liveRef = takeAbout();
    const clientId = newClientId();
    const local: Message = {
      id: `local-${clientId}`,
      channelId,
      threadId: threadId ?? null,
      author: { type: "person", id: meId ?? "" },
      body: text,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        ...localMeta(replyTo, replyTo ? dir.nameOf(replyTo.author) : "", []),
        ...liveRef,
        [LOCAL_FILES]: files.map(
          (f): LocalFile => ({
            uri: f.uri,
            name: f.name,
            type: f.type,
            ...(f.size !== undefined ? { size: f.size } : {}),
            ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
            ...(f.duration ? { duration: f.duration } : {}),
          }),
        ),
      },
      clientId,
      local: "pending",
      createdAt: new Date().toISOString(),
    };
    qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));
    const sent = new Set(files.map((f) => f.id));
    setPending((now) => now.filter((f) => !sent.has(f.id)));
    toEnd();
    // Behind files still going up, it waits as words do (`sendText`): kept under them as they go (`keepBehind`), where
    // dated when sent it jumped above them (and what was sent between) when they went.
    if (filesAhead.current) waitingBehind.current.push(clientId);
    behindFiles(() => {
      waitingBehind.current = waitingBehind.current.filter((id) => id !== clientId);
      return deliverFiles(local, how);
    });
  };
  /** A just-sent message's files go up, then the message goes with them; one that can't turns it "Not sent". */
  const deliverFiles = async (local: Message, how?: SendHow) => {
    const files = localFilesOf(local.meta);
    const results = await Promise.allSettled(files.map(uploadOne));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) =>
        list?.map((m) =>
          m.local && m.clientId === local.clientId
            ? { ...m, local: "failed" as const, sendFailure: sendFailureOf(failed.reason) }
            : m,
        ),
      );
      // Why, when it is known (too large, the workspace's storage full, no connection…); else the plain line.
      const said = errorText(t, failed.reason, i18n.language, { maxMb: MAX_UPLOAD_MB });
      toast({ title: said !== t("common.unknownError") ? said : t("mobile.chat.uploadFailed"), icon: "x" });
      return;
    }
    const refs = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    // The phone's own copies stand in for the server's: the sent pictures never fade out and back in.
    results.forEach((r, i) => {
      const f = files[i];
      if (r.status === "fulfilled" && f && isLocalMedia(f)) rememberLocalCopy(r.value.id, f.uri);
    });
    const meta = Object.fromEntries(Object.entries(local.meta ?? {}).filter(([k]) => k !== LOCAL_FILES));
    // Awaited (its answer or its failure, which marks the row): what waits behind it goes after it (`behindFiles`).
    await post
      .mutateAsync({
        body: local.body,
        clientId: local.clientId ?? newClientId(),
        threadId: local.threadId,
        meta: { ...meta, artifacts: refs },
        ...(how === "now" ? { steer: "now" as const } : {}),
      })
      .catch(() => undefined);
  };
  const deliverFilesRef = useRef(deliverFiles);
  deliverFilesRef.current = deliverFiles;
  // What another app shared ("Compartilhar com…" picked this agent): it goes at once, through this conversation's own
  // sending, so the photos show in the strip while they upload and the agent starts reading as soon as it lands.
  const shareIn = useShareHandoff(channelId);
  const shareReady = Boolean(meId) && (Boolean(dm) || Boolean(channel));
  // biome-ignore lint/correctness/useExhaustiveDependencies: sent once per handoff (`at`), when the conversation is known
  useEffect(() => {
    if (!shareIn || !shareReady) return;
    takeShareHandoff(shareIn.at);
    if (shareIn.files.length > 0) {
      const files = shareIn.files.map(
        (f, i): PendingFile => ({ ...f, id: `${shareIn.at}-${i}-${f.uri}`, state: "sending" }),
      );
      sendWithFiles(shareIn.text, "join", files);
    } else if (shareIn.text) {
      sendText(shareIn.text);
      toEnd();
    }
  }, [shareIn?.at, shareReady]);
  const pickedAsset = (a: ImagePicker.ImagePickerAsset) => ({
    uri: a.uri,
    name: a.fileName ?? (a.type === "video" ? "video.mp4" : "photo.jpg"),
    type: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
    ...(a.fileSize ? { size: a.fileSize } : {}),
    // Its shape and length for its thumbnail in the field.
    ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {}),
    ...(a.type === "video" && a.duration ? { duration: a.duration / 1000 } : {}),
  });
  const openPlus = async () => {
    // Asked before the sheet opens, so its tiles never move under the thumb. Only whether there is one: reading it is
    // what makes iOS ask, at the tap on Paste.
    const paste = await Clipboard.hasImageAsync().catch(() => false);
    sheet.open(<PlusActions media={mediaTabs.length > 0} paste={paste} onPick={(p) => void onPlus(p)} />);
  };
  const onPlus = async (pick: PlusPick) => {
    // A next step of the "+" stacks over it at once (the GIFs, a reminder, a mission's summary): a flick down goes back
    // to the "+". What the system presents (the camera, the library, the files picker) waits for the sheet to be gone:
    // presented over it while it slid out, iOS took it away with it, and the app waited for an answer that never came.
    switch (pick) {
      case "media":
        openMedia();
        return;
      case "remind":
        openRemind();
        return;
      case "summary":
        // A mission's summary is a sheet; elsewhere the summary is a message, and the conversation shows it.
        if (!mission) sheet.close();
        summarize();
        return;
    }
    await new Promise<void>((done) => sheet.close(done));
    switch (pick) {
      case "camera": {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          toast({
            title: t("mobile.plus.noCamera"),
            icon: "camera",
            action: { label: t("mobile.common.openSettings"), onPress: () => void Linking.openSettings() },
          });
          return;
        }
        const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        if (!res.canceled) addPending(res.assets.map(pickedAsset));
        return;
      }
      case "photos": {
        // iOS closes its picker as soon as the person picks and converts a video after (seconds for a long one), with
        // nothing on the screen: a thumbnail that says "preparing" holds the place until the files arrive.
        const res = await whilePicking(() =>
          ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"],
            quality: 0.8,
            // A video goes as 720p H.264 (iOS converts it as it is picked): the library's own (4K, HEVC) passed the
            // upload limit in seconds, and H.264 plays in every browser. Android hands the original, checked by size.
            videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
            allowsMultipleSelection: true,
            selectionLimit: Math.max(1, MAX_PENDING - pending.length),
            orderedSelection: true,
          }),
        );
        if (!res.canceled) addPending(res.assets.map(pickedAsset));
        return;
      }
      case "paste": {
        const image = await Clipboard.getImageAsync({ format: "png" }).catch(() => null);
        if (!image) {
          toast({ title: t("mobile.plus.pasteGone"), icon: "paste" });
          return;
        }
        const dir = new Directory(Paths.cache, "pasted", String(Date.now()));
        dir.create({ intermediates: true, idempotent: true });
        const file = new File(dir, "image.png");
        file.write(image.data.slice(image.data.indexOf(",") + 1), { encoding: "base64" });
        addPending([
          {
            uri: file.uri,
            name: file.name,
            type: "image/png",
            size: file.size,
            ...(image.size.width > 0 && image.size.height > 0
              ? { width: image.size.width, height: image.size.height }
              : {}),
          },
        ]);
        return;
      }
      case "file": {
        // A large file is copied before the picker answers: the same "preparing" thumbnail meanwhile.
        const res = await whilePicking(() =>
          DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true }),
        );
        if (!res.canceled)
          addPending(
            res.assets.map((a) => ({
              uri: a.uri,
              name: a.name,
              type: a.mimeType ?? "application/octet-stream",
              ...(a.size ? { size: a.size } : {}),
            })),
          );
        return;
      }
    }
  };

  // ── Composer and keyboard ──
  // The field is its own piece (`ChatComposer`), handed things that stay the same from one render of the conversation
  // to the next: an agent's work arrives here many times a second, and none of it redraws the field under the
  // person's typing. What it calls reads the conversation as it is at that moment (`useLatest`).
  const sendFromField = useLatest(onSend);
  const voiceFromField = useLatest(withVoice);
  const voiceAsk = useLatest(askVoice);
  const plusFromField = useLatest(openPlus);
  // GIFs and stickers also beside the mic while the field is empty, where they can be sent: one tap from the field.
  const mediaFromField = useLatest(openMedia);
  const canSendMedia = mediaTabs.length > 0;
  const composerMedia = useMemo(
    () => (canSendMedia ? { label: t("media.picker.send"), onPress: mediaFromField } : null),
    [canSendMedia, t, mediaFromField],
  );
  const longFromField = useLatest(longAsFile);
  const removeFromStrip = useLatest(removePending);
  const cancelQuote = useCallback(() => setQuote(null), []);
  const quoteName = quote ? dir.nameOf(quote.author) : null;
  const canAttach = pending.length < MAX_PENDING;
  const dropAbout = useCallback(() => dropTalkAbout(channelId), [channelId]);
  // Whom it answers, over the field; in a live file's conversation, else what the person had selected in the file.
  const composerBanner = useMemo(
    () =>
      quoteName !== null ? (
        <QuoteBar name={quoteName} onCancel={cancelQuote} />
      ) : about ? (
        <LiveQuoteBar liveRef={about} onDrop={dropAbout} />
      ) : undefined,
    [quoteName, cancelQuote, about, dropAbout],
  );
  // Photos and files waiting to go, inside the field over their caption.
  const composerAttachments = useMemo(
    () =>
      pending.length > 0 || preparing ? (
        <AttachmentStrip files={pending} preparing={preparing} onRemove={removeFromStrip} />
      ) : undefined,
    [pending, preparing, removeFromStrip],
  );
  const everyoneOffered = offersEveryone(org, Boolean(dm));
  const mentionCard = useCallback<NonNullable<ComposerProps["mention"]>>(
    ({ query, sigil, pick }) =>
      sigil === "#" ? (
        <ChannelPicker query={query} pick={pick} />
      ) : (
        <MentionPicker
          query={query}
          pick={pick}
          channelId={channelId}
          members={mentionMembers}
          everyone={everyoneOffered}
        />
      ),
    [channelId, mentionMembers, everyoneOffered],
  );
  const onType = useCallback((text: string) => sendTyping(threadId, text), [sendTyping, threadId]);
  return {
    afterVoice,
    canAttach,
    captionBack,
    channelAgents,
    composerAttachments,
    composerBanner,
    composerMedia,
    helloAgent,
    longFromField,
    mentionCard,
    onRecording,
    onReply,
    onResend,
    onRetry,
    onSend,
    onType,
    openNewMission,
    openRemind,
    pending,
    plusFromField,
    quote,
    replyAt,
    sendFromField,
    talkable,
    voiceFromField,
    voiceOn,
    voiceTakeBack,
    voiceAsk,
  };
}

export type ChatSend = ReturnType<typeof useChatSend>;
