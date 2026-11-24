import {
  type Agent,
  type Artifact,
  type ArtifactDetail,
  applyChannelEvent,
  cacheResolved,
  emptyStreams,
  type FileConversationRef,
  isMediaKind,
  keys,
  type LiveRef,
  type LiveRun,
  type LiveSelection,
  type Message,
  messageLiveRef,
  reconcileRuns,
  runsInChannel,
  type StreamsState,
  useApi,
  useMessages,
  useThreadMessages,
} from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { requestComposerText } from "../../chat/composer-request";
import { useOpenFile } from "../../files/open";
import { chatHref } from "../../links/logic";
import { useConnection, useDirectory, useOrgId } from "../../shared/hooks";
import { liveRoute } from "../routes";
import {
  askText,
  fileAgentId,
  fileUnder,
  type MediaPin,
  mediaPins,
  type TalkPin,
  talkKindOf,
  talkPins,
  withSending,
} from "./logic";
import { dropTalkAbout, revealOnOpen, setTalkAbout, takeReveal, useRevealFor } from "./store";

/*
 * A live file's own conversation on the phone (ADR 0199): opening it from the file (made on first use), what it holds
 * live for the line under the file, the file's agent, the canvas's comment pins, and the way back to the file from a
 * message's line about it. A picture, a video or a PDF has the same conversation, its comments pinned on it (ADR 0208).
 * The conversation opens the same way from every file: its own screen pushed over the file, the system's back to it
 * (ADR 0208). In a sheet over the file it loaded heavily and moved as it came up; pushed, it is the conversation as
 * every other one is.
 */

/** A file with a conversation: a live file, or a picture, a video or a PDF (its `content` says which). */
type TalkFile = Pick<Artifact, "id" | "kind" | "title" | "conversation" | "createdBy"> & {
  content?: ArtifactDetail["content"];
};

export interface OpenTalk {
  /** What the person had selected: the quote over the composer (null: none, an older quote goes too). */
  selection?: LiveSelection | null;
  /** Words the composer starts with ("@atlas "), the keyboard up. */
  text?: string;
  /** Open at this message (a pin, a notice). */
  messageId?: string | null;
}

/**
 * Pushes the file's conversation (the phone's conversation at its root) over the file (ADR 0208), made on first use
 * (`artifacts.conversation`), as a task's (ADR 0145): its quote and its first words set before it opens.
 */
export function useOpenFileTalk(file: TalkFile | undefined) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    (open: OpenTalk = {}) => {
      const kind = talkKindOf(file);
      if (!file || !kind) return;
      void (async () => {
        try {
          const at: FileConversationRef = file.conversation ?? (await api.artifacts.conversation(orgId, file.id));
          // Made just now: the file's head says so (its line, its count).
          if (!file.conversation) void qc.invalidateQueries({ queryKey: keys.artifact(orgId, file.id), exact: true });
          if (open.selection)
            setTalkAbout(at.channelId, { artifactId: file.id, kind, title: file.title, selection: open.selection });
          else if (open.selection === null) dropTalkAbout(at.channelId);
          if (open.text) requestComposerText(at.channelId, open.text);
          router.push(chatHref(at.channelId, at.rootId, open.messageId ?? null));
        } catch {
          toast({ title: t("mobile.app.failed"), icon: "x" });
        }
      })();
    },
    [file, api, orgId, qc, toast, t],
  );
}

/**
 * A notice or a link named a message of the file's conversation (`?m=`, ADR 0199): the conversation opens over the
 * file at that message, once the file is known (as a task's, ADR 0145).
 */
export function useTalkFocus(file: TalkFile | undefined, messageId: string | null | undefined) {
  const open = useOpenFileTalk(file);
  const done = useRef(false);
  const ready = Boolean(file);
  useEffect(() => {
    if (!ready || !messageId || done.current) return;
    done.current = true;
    open({ messageId, selection: null });
  }, [ready, messageId, open]);
}

/**
 * A message's line about this file (or its pin) was tapped: once the file's screen is in view again and `ready`, it
 * shows that part (`show`), once.
 */
export function useRevealHere(
  fileId: string,
  ready: boolean,
  show: (selection: LiveSelection, messageId: string | undefined) => void,
) {
  const waiting = useRevealFor(fileId);
  const inView = useFileInView();
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    if (!waiting || !inView || !ready) return;
    takeReveal(fileId);
    latest.current(waiting.selection, waiting.messageId);
  }, [waiting, inView, ready, fileId]);
}

/** The file's screen is the one the person sees: on top, its conversation not pushed over it. */
export function useFileInView(): boolean {
  return useIsFocused();
}

/** The conversation's messages (replies, its root left out), loaded once it exists. */
export function useTalkMessages(talk: FileConversationRef | null | undefined): Message[] {
  const orgId = useOrgId();
  const query = useThreadMessages(orgId, talk?.channelId, talk?.rootId ?? "");
  const rootId = talk?.rootId;
  return useMemo(() => (query.data ?? []).filter((m) => m.id !== rootId && !m.local), [query.data, rootId]);
}

/**
 * My comments still on their way in the file's conversation: they wait in the channel's latest page until the server's
 * copy takes their place (`useSendMessage`). Read from what the phone keeps, never fetched here.
 */
function useTalkSending(talk: FileConversationRef | null | undefined): Message[] {
  const orgId = useOrgId();
  const channel = useMessages(orgId, talk?.channelId ?? "", false);
  const rootId = talk?.rootId;
  return useMemo(
    () => (rootId ? (channel.data ?? []).filter((m) => m.local && m.threadId === rootId) : []),
    [channel.data, rootId],
  );
}

/**
 * The file's agent (ADR 0199), whom "Ask Atlas" calls: the one that made it, else the last agent that spoke in
 * its conversation, else the workspace's right hand; only one this person may ask. Null: none.
 */
export function useFileAgent(file: TalkFile | undefined, messages: readonly Message[]): Agent | null {
  const { org } = useOrg();
  const dir = useDirectory();
  return useMemo(() => {
    if (!file) return null;
    const askable = (id: string) => {
      const agent = dir.agentById.get(id);
      return Boolean(agent && !agent.former && mayAsk(org, agent));
    };
    const id = fileAgentId({
      createdBy: file.createdBy,
      spoke: messages.map((m) => m.author),
      participants: file.conversation?.participants ?? [],
      rightHandId: rightHandOf(dir.agents)?.id,
      agentIds: dir.agents.map((a) => a.id),
      askable,
    });
    return id ? (dir.agentById.get(id) ?? null) : null;
  }, [file, messages, dir.agents, dir.agentById, org]);
}

/**
 * "Ask Atlas" from a file (ADR 0199): the file's agent, its button's words ("Ask Atlas", "Ask Iris"),
 * and the ask itself: the conversation opens with "@atlas " (and `words`) in its composer and the selection over it.
 * No agent this person may ask: no button (`label` null), and `ask` opens the conversation with the selection alone.
 */
export function useAskAgent(file: TalkFile | undefined) {
  const { t } = useTranslation();
  const messages = useTalkMessages(file?.conversation);
  const agent = useFileAgent(file, messages);
  const open = useOpenFileTalk(file);
  const label = agent ? t("live.conversation.ask", agentGrammar(agent.name)) : null;
  const handle = agent?.handle ?? null;
  const ask = useCallback(
    (selection: LiveSelection | null, words?: string) =>
      open({
        selection,
        ...(handle ? { text: askText(handle, words) } : words ? { text: words } : {}),
      }),
    [open, handle],
  );
  return { agent, label, ask, messages };
}

/** The canvas's comment pins: its conversation's messages with a point (ADR 0199 §3). */
export function useTalkPins(fileId: string, messages: readonly Message[]): TalkPin[] {
  return useMemo(
    () =>
      talkPins(
        fileId,
        messages.map((m) => ({ id: m.id, author: m.author, liveRef: messageLiveRef(m) })),
      ),
    [fileId, messages],
  );
}

/**
 * The comments with a pin on a picture, a video or a PDF (ADR 0208), from its conversation, numbered oldest first;
 * `shownVersion`: the version on screen (a pin made on an older one is faded). Mine still on their way count already:
 * a comment's pin stays on its spot from the moment it is sent, never gone until the server answers.
 */
export function useMediaPins(
  file: Pick<ArtifactDetail, "id" | "conversation" | "shownVersion"> | undefined,
): MediaPin[] {
  const messages = useTalkMessages(file?.conversation);
  const sending = useTalkSending(file?.conversation);
  const id = file?.id ?? "";
  const version = file?.shownVersion ?? 0;
  return useMemo(
    () =>
      mediaPins(
        id,
        withSending(messages, sending).map((m) => ({
          id: m.id,
          author: m.author,
          liveRef: messageLiveRef(m),
          meta: m.meta,
        })),
        version,
      ),
    [id, messages, sending, version],
  );
}

/** What in the conversation changes its line: a message, an agent starting, stepping or ending its turn. */
const RUN_EVENTS: ReadonlySet<string> = new Set([
  "message.created",
  "agent.thinking",
  "agent.run",
  "agent.tool",
  "agent.step",
  "agent.typing",
  "agent.idle",
  "agent.passed",
  "agent.run.steered",
  "run.finished",
  "run.canceled",
]);
/** A burst of them (an agent's steps) reads the file's head and the messages once. */
const REFRESH_MS = 1000;
const AT_WORK: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * The agents at work in the file's conversation now, live while the file's screen is in view (its channel's events,
 * the server's active runs on open and after a reconnect); a burst of news reads the file's head (count, who took
 * part) and the conversation's messages again, once.
 */
export function useTalkRuns(fileId: string, talk: FileConversationRef | null | undefined): LiveRun[] {
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const connection = useConnection();
  const focused = useFileInView();
  const [streams, setStreams] = useState<StreamsState>(emptyStreams);
  const channelId = talk?.channelId ?? null;
  const rootId = talk?.rootId ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Back on the file (its conversation was over it): its head is read again, what was said there may have moved it.
  const shown = useRef(false);
  useEffect(() => {
    if (!channelId || !rootId || !focused) return;
    if (shown.current) void qc.invalidateQueries({ queryKey: keys.artifact(orgId, fileId), exact: true });
    shown.current = true;
    let alive = true;
    const refresh = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: keys.artifact(orgId, fileId), exact: true });
        void qc.invalidateQueries({ queryKey: keys.thread(orgId, channelId, rootId) });
      }, REFRESH_MS);
    };
    const check = () => {
      const askedAt = Date.now();
      api.agents
        .activeRuns(orgId, channelId)
        .then((active) => {
          if (alive && active) setStreams((s) => reconcileRuns(s, channelId, active, Date.now(), askedAt));
        })
        .catch(() => {});
    };
    check();
    const off = connection?.subscribe(channelId, (event) => {
      // A comment on a picture, a video or a PDF resolved or opened again (ADR 0208): its pin follows at once.
      if (event.type === "message.resolved") {
        cacheResolved(qc, orgId, event.channelId, event.messageId, event.resolved);
        return;
      }
      if (!RUN_EVENTS.has(event.type)) return;
      setStreams((s) => applyChannelEvent(s, event as Parameters<typeof applyChannelEvent>[1]));
      refresh();
    });
    const offReconnect = connection?.onReconnect(check);
    return () => {
      alive = false;
      off?.();
      offReconnect?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [channelId, rootId, focused, api, orgId, fileId, qc, connection]);
  return useMemo(
    () => (channelId ? runsInChannel(streams, channelId).filter((r) => AT_WORK.has(r.status)) : []),
    [streams, channelId],
  );
}

/**
 * A message's line about a file, tapped: the file's screen shows that part. From the file's own conversation pushed
 * over it, it goes back to the file under it (the viewer, for a picture or a video it holds); from anywhere else the
 * file opens on its screen. A picture or a video opens in the viewer (a video at the comment's moment), a PDF on its
 * screen (at the comment's page).
 */
export function useOpenLiveRef() {
  const navigation = useNavigation();
  const openFile = useOpenFile();
  return useCallback(
    (ref: LiveRef, messageId?: string) => {
      const media = isMediaKind(ref.kind);
      const selection = ref.selection;
      // What the file's screen shows of it: a live file's part, a video's moment, a PDF's page (a picture shows its
      // pins whole).
      if (
        selection &&
        (!media ||
          (ref.kind === "video" && selection.time !== undefined) ||
          (ref.kind === "pdf" && selection.page !== undefined))
      )
        revealOnOpen(ref.artifactId, selection, messageId);
      const routes = navigation.getState()?.routes as { name: string; params?: object }[] | undefined;
      if (fileUnder(routes, ref.artifactId) && router.canGoBack()) router.back();
      else if (isMediaKind(ref.kind)) void openFile({ id: ref.artifactId, kind: "file", title: ref.title });
      else router.push(liveRoute(ref.kind, ref.artifactId));
    },
    [navigation, openFile],
  );
}
