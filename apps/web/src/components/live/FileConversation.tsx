import type { Agent, Artifact, LiveKind } from "@agenteschat/client";
import { keys, useFileUnread, useThreadMessages } from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { badgeCount } from "@agenteschat/client/lib/unread";
import { Button, CountBadge, CountChip, cx } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useDirectory } from "@/hooks/useDirectory";
import { nearerEsc } from "@/hooks/useEscClose";
import { useSideColumn } from "@/hooks/useMembersColumn";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { ThreadPage } from "@/pages/ThreadPage";
import { useChannelEvents } from "@/realtime/context";
import "@/components/threads/threads.css";
import "@/pages/issues.css";

/*
 * A live file's own conversation (ADR 0199), the task's (ADR 0145) beside a file: "Conversa 4" in the page's header
 * opens it, the app's thread panel shows it, and the file's page keeps its width for it so it never covers the file.
 */

/** From this width the conversation is a column beside the file; under it, it opens over the page like a task's. */
export const LIVE_TALK_DOCKED = "(min-width: 1100px)";
const LIVE_TALK_OVER = "(max-width: 1099px)";

/**
 * Whether the conversation is open, the person's last choice (kept per person and workspace); a file with a
 * conversation opens it by itself the first time. Under `LIVE_TALK_DOCKED` it opens over the page, until closed.
 */
export function useFileTalkColumn(artifact: Pick<Artifact, "conversation"> | null | undefined) {
  const has = (artifact?.conversation?.count ?? 0) > 0;
  return useSideColumn(STORAGE_KEYS.liveTalk, LIVE_TALK_OVER, LIVE_TALK_DOCKED, has);
}

/**
 * "Conversa 4" in the file's header (the task's `TaskConversationButton`): opens or closes the conversation. A reply I
 * haven't read there lights it like an unread channel; a mention of me adds its red number. `compact` (a narrow
 * header): its glyph and count without the word.
 */
export function FileConversationButton({
  artifact,
  open,
  compact = false,
  onToggle,
}: {
  artifact: Artifact;
  open: boolean;
  compact?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { unread, mentions } = useFileUnread(org.id, artifact.id);
  const count = artifact.conversation?.count ?? 0;
  return (
    <Button
      size="sm"
      variant={open ? "default" : "ghost"}
      icon="message"
      aria-pressed={open}
      aria-label={count > 0 ? t("live.conversation.toggle", { count }) : t("live.conversation.button")}
      // Narrow and nothing to count: the glyph alone, square.
      iconOnly={compact && count === 0 && mentions === 0}
      title={compact ? t("live.conversation.button") : undefined}
      className={cx("task-talk__toggle", compact && "lf-talk-toggle--glyph")}
      data-unread={unread > 0 || undefined}
      onClick={onToggle}
    >
      {!compact && t("live.conversation.button")}
      {count > 0 && <CountChip size="sm">{count}</CountChip>}
      {mentions > 0 && (
        <CountBadge
          className="task-talk__mentions"
          role="img"
          aria-label={t("shell.unreadMentions", { count: mentions })}
        >
          {badgeCount(mentions)}
        </CountBadge>
      )}
    </Button>
  );
}

/** What in the conversation changes "Conversa N": a message, an agent starting or ending its turn. */
const TALK_EVENTS: ReadonlySet<string> = new Set(["message.created", "agent.thinking", "agent.run", "run.finished"]);
/** A burst of them (an agent's steps) reads the file once. */
const TALK_REFRESH_MS = 1000;

/**
 * While the file's page is open, "Conversa N" stays true with the conversation closed (ADR 0199 §6): its channel's
 * events read the file's summary (`Artifact.conversation`) again, once per burst.
 */
export function useFileTalkLive(artifactId: string, channelId: string | null | undefined) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useChannelEvents(channelId ?? "", Boolean(channelId), (event) => {
    if (!TALK_EVENTS.has(event.type) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void qc.invalidateQueries({ queryKey: keys.artifact(org.id, artifactId), exact: true });
    }, TALK_REFRESH_MS);
  });
}

/**
 * The conversation itself: the thread panel at its root (`useFileConversation` makes it on first use; the skeleton
 * until then). Docked, it hangs from the work area at the page's right (the page keeps that width:
 * `.lf-page[data-talk]`), never over the file, and Esc closes it only from inside it, so the editor keeps its own Esc.
 * Not docked, it is the task's panel over the page.
 */
export function FileConversationPanel({
  kind,
  rootId,
  docked,
  focusMessageId,
  onClose,
}: {
  kind: LiveKind;
  rootId: string | null;
  docked: boolean;
  focusMessageId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`live.conversation.title.${kind}` as "live.conversation.title.file");
  const body = rootId ? (
    <ThreadPage threadId={rootId} focusMessageId={focusMessageId} onClose={onClose} escInside={docked} />
  ) : (
    <ChannelSkeleton thread panel />
  );
  if (!docked) {
    return (
      <SidePanel label={label} onClose={onClose}>
        {body}
      </SidePanel>
    );
  }
  // First, before the composer's own keys, as a panel's Esc is (`useEscClose`), but only from inside it.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || nearerEsc(e.nativeEvent)) return;
    e.preventDefault();
    onClose();
  };
  // Hung from the work area (the page's own box runs an entrance that would hold a fixed panel inside it).
  const work = document.querySelector<HTMLElement>(".shell__work");
  return createPortal(
    <>
      {work && <TalkGrip work={work} />}
      <aside className="thread-panel lf-talk" aria-label={label} onKeyDownCapture={onKey}>
        {body}
      </aside>
    </>,
    work ?? document.body,
  );
}

/** The docked conversation's narrowest width, and its widest (and never more than half the window). */
export const TALK_MIN = 340;
export const TALK_MAX = 720;
/** An arrow key's step. */
const TALK_STEP = 16;
const talkMax = () => Math.max(TALK_MIN, Math.min(TALK_MAX, Math.round(window.innerWidth / 2)));
/** A width within the bounds the window allows now. */
export const clampTalk = (width: number) => Math.round(Math.min(talkMax(), Math.max(TALK_MIN, width)));

/**
 * The handle on the docked conversation's left edge (ADR 0199): dragged, the conversation takes that width and the
 * file beside it follows as it moves; ←/→ change it a step, Home and End go to the narrowest and the widest, a double
 * click gives back the default (`--lf-talk-w` in live.css). The width is the person's, kept per person and workspace,
 * and set on the work area, whose right padding keeps the file clear of it.
 */
function TalkGrip({ work }: { work: HTMLElement }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const key = `${STORAGE_KEYS.liveTalkWidth}.${me.user.id}.${org.id}`;
  const [saved, setSaved] = useState<number | null>(() => readWidth(storage.get(key)));
  const [shown, setShown] = useState<number | null>(null);
  const drag = useRef<{ pointer: number; x: number; from: number; to: number } | null>(null);
  const frame = useRef(0);
  const now = () => talkWidth(work);
  const show = (width: number | null) => showTalkWidth(work, width);

  // The person's width while docked (within what the window allows now, again as it resizes); the default after.
  useEffect(() => {
    const apply = () => {
      if (drag.current) return;
      showTalkWidth(work, saved === null ? null : clampTalk(saved));
      setShown(talkWidth(work));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      cancelAnimationFrame(frame.current);
      showTalkWidth(work, null);
    };
  }, [saved, work]);

  const save = (width: number | null) => {
    if (width === null) storage.remove(key);
    else storage.set(key, String(width));
    setSaved(width);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const from = now();
    drag.current = { pointer: e.pointerId, x: e.clientX, from, to: from };
    e.currentTarget.dataset.active = "";
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    // The handle is the panel's left edge: leftwards widens it.
    const to = clampTalk(d.from + d.x - e.clientX);
    if (to === d.to) return;
    d.to = to;
    e.currentTarget.setAttribute("aria-valuenow", String(to));
    // One layout a frame, however fast the pointer reports.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => show(to));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    delete e.currentTarget.dataset.active;
    cancelAnimationFrame(frame.current);
    if (d.to === d.from) return;
    show(d.to);
    save(d.to);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowLeft"
        ? now() + TALK_STEP
        : e.key === "ArrowRight"
          ? now() - TALK_STEP
          : e.key === "Home"
            ? TALK_MIN
            : e.key === "End"
              ? talkMax()
              : null;
    if (next === null) return;
    e.preventDefault();
    const width = clampTalk(next);
    show(width);
    save(width);
  };
  const label = t("live.conversation.resize");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that moves is a control with a value, which `hr` is not.
    <div
      className="lf-talk-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={shown ?? undefined}
      aria-valuemin={TALK_MIN}
      aria-valuemax={TALK_MAX}
      title={t("live.conversation.resizeHint")}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => save(null)}
      onKeyDown={onKeyDown}
    />
  );
}

/** The docked conversation's width on screen now. */
const talkWidth = (work: HTMLElement) =>
  Math.round(work.querySelector<HTMLElement>(":scope > .lf-talk")?.getBoundingClientRect().width ?? TALK_MIN);

/** Sets the conversation's width on the work area (`--lf-talk-w`: the panel's width and the room kept for it). */
function showTalkWidth(work: HTMLElement, width: number | null) {
  if (width === null) work.style.removeProperty("--lf-talk-w");
  else work.style.setProperty("--lf-talk-w", `${width}px`);
}

/** A stored width, or null for none (or one that isn't a width). */
function readWidth(value: string | null): number | null {
  const width = value === null ? Number.NaN : Number(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

/**
 * The file's agent (ADR 0199), whom "Pedir ao Atlas" calls: the one that made it, else the last agent that spoke in
 * its conversation, else the workspace's right hand; only one this person may ask. Null: none.
 */
export function useFileAgent(artifact: Pick<Artifact, "createdBy" | "conversation"> | null | undefined): Agent | null {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const talk = artifact?.conversation ?? null;
  const messages = useThreadMessages(org.id, talk?.channelId, talk?.rootId ?? "");
  const askable = (id: string | null | undefined) => {
    const agent = id ? dir.agentById.get(id) : undefined;
    return agent && !agent.former && mayAsk(org, agent) ? agent : null;
  };
  if (!artifact) return null;
  if (artifact.createdBy.type === "agent") {
    const maker = askable(artifact.createdBy.id);
    if (maker) return maker;
  }
  const spoke = [...(messages.data ?? [])].reverse().find((m) => m.author.type === "agent" && askable(m.author.id));
  if (spoke) return askable(spoke.author.id);
  const wrote = [...(talk?.participants ?? [])].reverse().find((p) => p.type === "agent" && askable(p.id));
  if (wrote) return askable(wrote.id);
  return askable(rightHandOf(dir.agents)?.id) ?? dir.agents.find((a) => askable(a.id)) ?? null;
}
