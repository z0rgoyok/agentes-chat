import type { AppNotification, Channel, DirectMessage, Message } from "@agenteschat/client";
import {
  useChannels,
  useDms,
  useMarkChannelRead,
  useMessages,
  useNotificationAction,
  useNotifications,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { allItems, sortWaiting } from "@agenteschat/client/lib/notifications";
import { badgeCount, looksUnread } from "@agenteschat/client/lib/unread";
import { Button, CountBadge, EmptyState, GroupHeading, Icon, PageHeader } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useNotificationOpener } from "@/components/NotificationOpen";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { InboxItemRow } from "./NotificationsPage";
import "./unreads.css";

/** How many of a conversation's unread messages show; the rest are one line ("Mais 3 mensagens"). */
const SHOWN = 5;

/** A conversation with something unread: a channel or a DM, where its unread starts, and whether it calls on me. */
interface Unread {
  channelId: string;
  name: string;
  channel?: Channel;
  dm?: DirectMessage;
  count: number;
  forMe: boolean;
  lastReadAt: string | null;
  at: string;
}

/**
 * Não lidas (ADR 0260): one place for everything waiting for the person. What waits for them in the inbox, and what
 * reached it unread today, on top (each opens where the inbox opens it); then every channel and DM with unread
 * messages, the ones that call on them (a mention, a DM) first, each with its unread messages, Abrir and Marcar como
 * lida. The inbox page stays for the rest of its history.
 */
export function UnreadsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const orgId = org.id;
  const navigate = useNavigate();
  const toast = useToast();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const notifications = useNotifications(orgId, "all");
  const action = useNotificationAction(orgId);
  const markRead = useMarkChannelRead(orgId);
  const openNotification = useNotificationOpener();

  const today = new Date().toDateString();
  const items = allItems(notifications.data).filter((n) => !n.doneAt && n.kind !== "proposal_waiting");
  const forYou = [
    ...sortWaiting(items.filter((n) => n.waiting)),
    ...items.filter((n) => !n.waiting && n.readAt === null && new Date(n.updatedAt).toDateString() === today),
  ];
  const open = (n: AppNotification) => {
    if (n.readAt === null) action.mutate({ type: "read", item: n, read: true });
    // A request is decided in the inbox, beside its list; anything else opens where it happened.
    if (n.kind === "approval" && n.source.approvalId)
      void navigate({ to: "/org/$orgId/notifications", params: { orgId }, search: { approval: n.source.approvalId } });
    else openNotification(n, orgId);
  };

  const conversations: Unread[] = [
    ...(channels.data ?? []).flatMap((c): Unread[] =>
      c.isMember && (looksUnread(c) || (c.mentionCount ?? 0) > 0)
        ? [
            {
              channelId: c.id,
              name: `#${c.name}`,
              channel: c,
              count: c.mentionCount || c.unreadCount || 0,
              forMe: (c.mentionCount ?? 0) > 0,
              lastReadAt: c.lastReadAt ?? null,
              at: c.lastMessage?.createdAt ?? c.createdAt,
            },
          ]
        : [],
    ),
    ...(dms.data ?? []).flatMap((d): Unread[] =>
      d.unread > 0
        ? [
            {
              channelId: d.channelId,
              name: d.with.name,
              dm: d,
              count: d.unread,
              forMe: true,
              lastReadAt: d.lastReadAt ?? null,
              at: d.lastMessage?.createdAt ?? "",
            },
          ]
        : [],
    ),
  ].sort((a, b) => Number(b.forMe) - Number(a.forMe) || b.at.localeCompare(a.at));

  const loaded = channels.isSuccess && dms.isSuccess && notifications.isSuccess;
  const failed = [channels, dms, notifications].find((q) => q.isError && !q.data);
  const nothing = loaded && forYou.length === 0 && conversations.length === 0;
  const markAll = () => {
    for (const c of conversations) markRead.mutate(c.channelId);
    toast.show(t("unreads.markedAll"), "info");
  };

  return (
    <div className="page page--list unreads">
      <PageHeader
        title={t("unreads.title")}
        actions={
          conversations.length > 0 && (
            <Button variant="default" icon="checks" onClick={markAll}>
              {t("unreads.markAll")}
            </Button>
          )
        }
      />
      {!loaded && !failed && <LoadingCards count={3} />}
      {failed && <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />}
      {nothing && (
        <EmptyState size="page" mood="wave" title={t("unreads.emptyTitle")}>
          {t("unreads.emptyText")}
        </EmptyState>
      )}
      {forYou.length > 0 && (
        <section className="unreads__part" aria-labelledby="unreads-for-you">
          <GroupHeading
            id="unreads-for-you"
            title={t("unreads.forYou")}
            count={forYou.length}
            aside={
              <Link to="/org/$orgId/notifications" params={{ orgId }} className="ac-link">
                {t("unreads.seeInbox")}
              </Link>
            }
          />
          <div className="unreads__inbox">
            {forYou.map((n) => (
              <InboxItemRow key={n.id} n={n} onOpen={open} />
            ))}
          </div>
        </section>
      )}
      {conversations.length > 0 && (
        <section className="unreads__part" aria-labelledby="unreads-conversations">
          <GroupHeading id="unreads-conversations" title={t("unreads.conversations")} count={conversations.length} />
          {conversations.map((c) => (
            <UnreadConversation key={c.channelId} c={c} onRead={() => markRead.mutate(c.channelId)} />
          ))}
        </section>
      )}
    </div>
  );
}

/** One conversation's card: its name (a channel's #, a DM's face), its unread messages, Abrir and Marcar como lida. */
function UnreadConversation({ c, onRead }: { c: Unread; onRead: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const dir = useDirectory(org.id);
  const messages = useMessages(org.id, c.channelId).data ?? [];
  const unread = messages.filter(
    (m) => m.threadId === null && m.author.id !== me.user.id && (c.lastReadAt === null || m.createdAt > c.lastReadAt),
  );
  const shown = unread.slice(-SHOWN);
  const more = Math.max(0, c.count - shown.length);
  const to = c.dm
    ? c.dm.with.type === "agent"
      ? ({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: c.dm.with.id } } as const)
      : ({ to: "/org/$orgId/dm/person/$userId", params: { orgId: org.id, userId: c.dm.with.id } } as const)
    : ({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: c.channelId } } as const);
  const nameOf = (m: Message) =>
    m.author.type === "agent"
      ? (dir.anyAgent(m.author.id ?? "")?.name ?? "")
      : m.author.type === "person"
        ? (dir.memberById.get(m.author.id ?? "")?.name ?? "")
        : "";
  return (
    <article className="unreads__conv" aria-label={c.name}>
      <div className="unreads__head">
        <Link {...to} className="unreads__name">
          {c.dm ? (
            <ActorAvatar
              actor={{ type: c.dm.with.type === "agent" ? "agent" : "person", id: c.dm.with.id }}
              name={c.name}
              size="xs"
            />
          ) : (
            <Icon name="channel" size={16} />
          )}
          <span>{c.dm ? c.name : c.name.slice(1)}</span>
        </Link>
        {c.forMe && (
          <CountBadge className="unreads__count" role="img" aria-label={t("shell.unread", { count: c.count })}>
            {badgeCount(c.count)}
          </CountBadge>
        )}
        <span className="unreads__acts">
          <Button variant="ghost" size="sm" icon="check" onClick={onRead}>
            {t("unreads.markRead")}
          </Button>
          <Button variant="default" size="sm" onClick={() => void navigate(to)}>
            {t("unreads.open")}
          </Button>
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="unreads__msgs">
          {shown.map((m) => (
            <li key={m.id} className="unreads__msg ac-iconline">
              {m.author.id && m.author.type !== "app" && (
                <ActorAvatar actor={{ type: m.author.type, id: m.author.id }} name={nameOf(m)} size="xs" />
              )}
              <span className="unreads__msg-text">
                <b>{nameOf(m)}</b> <time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>
                <span className="unreads__msg-body">{previewBody(t, m.body, m.meta ?? null)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* None of its messages here yet (an older page, a thread's): how many wait, not "more". */}
      {more > 0 && (
        <p className="unreads__more">
          {shown.length > 0 ? t("unreads.more", { count: more }) : t("shell.unread", { count: more })}
        </p>
      )}
    </article>
  );
}
