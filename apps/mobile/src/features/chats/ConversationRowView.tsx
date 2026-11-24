import { usePrefetchConversation } from "@agenteschat/client";
import { Link } from "expo-router";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { TAB_BADGE } from "@/lib/nav";
import { Count, LIST_AVATAR, LIST_PREVIEW, LineIcon, ListRow, PixelOrbit, Tag, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import type { RowAction } from "../categories/menus";
import { WaitMark } from "../chat/WaitMark";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useOrgId } from "../shared/hooks";
import { Tile } from "../shared/parts";
import type { ConversationRow } from "./logic";
import type { AgentRowState } from "./now";
import type { RowFacts } from "./rowFacts";
import { chatOfRow, useChatOpener, useIsChosen } from "./split";
import { useRowFacts } from "./useRows";

/** The avatar column. */
const AVATAR = LIST_AVATAR;
/** The open conversation's row beside the list (ADR 0212): the ink this faint over the page, in both themes. */
const CHOSEN_TINT = 0.08;
/** The orbit before what an agent does: the preview line's own height, so it reads as a word of it. */
const ORBIT = 16;

export interface ConversationItemProps {
  row: ConversationRow;
  /** What it says, worked out once per screen (`useRowFacts`). */
  facts: RowFacts;
  /** A hairline above (every row but the first). */
  divider?: boolean;
  /** Its agent's face moves (the first rows only); further down it holds still. The orbit turns on every row. */
  live?: boolean;
  /** A row on the home: its menu (Fixar no topo, or Tirar do topo, a channel's Mover para…), given the row. */
  onHold?: (row: ConversationRow) => void;
  /** What the long press does, for screen readers. */
  holdLabel?: string;
  /** An agent with no conversation yet (`channelId: ""`): opens one with it, given the agent (stable, memoized row). */
  onStart?: (agentId: string) => void;
  /** In the time's place: the right hand's label (ADR 0137). */
  meta?: string;
  /** Not opened yet on this phone: the dot. */
  fresh?: boolean;
  /** Told when the row opens its conversation. */
  onOpen?: () => void;
  /** The long press's actions for iOS's own menu under the preview (`onHold`'s sheet elsewhere). */
  holdActions?: (row: ConversationRow) => RowAction[];
}

/**
 * One conversation in the list, in the shared
 * `ListRow`: the agent's living body (moving while it works), a person's face, or the tile of a channel;
 * the name and the time; the last line ("Nome: …", one line, cut where it runs out: the conversation has the
 * rest, and the list stays one row per conversation). An agent's row says what matters instead
 * (`facts`): it waits on your ok (amber, "espera seu ok · PR #128"), it waits for its offline computer
 * (dozing, "Esperando o MacBook Air"), or what it is doing with the pixel orbit. Unread: bold name, darker time and preview, the count. Threads and missions
 * add a faint line with what and where ("Missão · #canal"): a mission shows its agent, its state
 * and items ("Esperando você · 4 de 9 itens") and what waits on you in it; a thread shows the face and the
 * line of its last reply. `live`: the agent's face moves (the first rows only; the orbit always turns). A DM's face
 * carries the presence badge (ADR 0084; no status emoji in the list); an agent with a line says it in place of its last
 * message. Drawn from plain values the screen worked out once (`facts`): memoized, it draws again only when its row or
 * its words change.
 */
export const ConversationItem = memo(function ConversationItem({
  row: r,
  facts,
  divider = false,
  live = false,
  onHold,
  holdLabel,
  onStart,
  meta,
  fresh = false,
  onOpen,
  holdActions,
}: ConversationItemProps) {
  const { t } = useTranslation();
  const c = useColors();
  // Beside the list (ADR 0212) the open conversation's row stays lit, and a press opens it there: nothing is pushed.
  // Conversas and Threads each light their own (the opener's split).
  const opener = useChatOpener();
  const chosen = useIsChosen(opener, chatOfRow(r));
  const agentDm = r.kind === "dm" && r.with.type === "agent";
  // An agent's role (its Função, "Ops") beside its name as a tag, as the web's lists show it: read once for the list
  // with the row's other facts, never by the row itself.
  const role = facts.role;
  const leading =
    r.kind === "dm" ? (
      agentDm ? (
        <AgentFace agentId={r.with.id} size={AVATAR - 2} mode={facts.face} live={live} presence />
      ) : (
        <Face who={{ type: r.with.type, id: r.with.id }} size={AVATAR} live={false} presence />
      )
    ) : r.kind === "mission" && r.mission ? (
      <AgentFace agentId={r.mission.agentId} size={AVATAR - 2} mode={facts.face} live={live} />
    ) : r.kind === "thread" || r.kind === "mission" ? (
      <Face who={r.face} size={r.face.type === "agent" ? AVATAR - 2 : AVATAR} live={live} />
    ) : (
      <Tile icon="hash" size={AVATAR} />
    );
  // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
  const name = r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title || t("mobile.chat.thread");
  // The orbit turns on every row at work, past the moving faces too: held on one frame it read as work that hung.
  // It turns on the UI thread, in step with the others, and stops with the screen (`PixelOrbit`).
  const orbit = <PixelOrbit color={facts.orbit} size={ORBIT} />;
  const l = facts.line;
  const line =
    l.kind === "state" ? (
      <View style={styles.work}>
        {l.mark === "orbit" ? (
          orbit
        ) : l.mark === "wait" ? (
          <WaitMark size={8} still />
        ) : l.mark === "clock" ? (
          <LineIcon name="clock" size={15} color={c.faint} variant="small" text={LIST_PREVIEW} />
        ) : null}
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text
            variant="small"
            tone={l.strong ? "ink2" : "muted"}
            style={[LIST_PREVIEW, l.em ? styles.em : null, l.amber ? { color: c.amber } : null]}
          >
            {l.word}
          </Text>
          {l.rest}
        </Text>
      </View>
    ) : l.kind === "away" ? (
      <View style={styles.work}>
        <LineIcon name="clock" size={15} color={c.muted} variant="small" text={LIST_PREVIEW} />
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {l.text}
        </Text>
      </View>
    ) : l.kind === "doing" ? (
      <View style={styles.work}>
        {orbit}
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.em, styles.shrink]}>
          {l.text}
        </Text>
      </View>
    ) : (
      <Text variant="small" tone={r.unread > 0 ? "ink2" : "muted"} numberOfLines={1} style={LIST_PREVIEW}>
        {l.lead ? (
          <Text variant="small" tone="ink2" style={[LIST_PREVIEW, styles.em]}>
            {`${l.lead}: `}
          </Text>
        ) : null}
        {l.text}
      </Text>
    );
  const { badge, mention } = facts;
  const a11y = [
    name,
    role,
    meta ?? null,
    facts.presence,
    facts.status,
    facts.place,
    facts.label,
    facts.time,
    r.unread > 0 ? t("mobile.chats.unreadLabel", { count: r.unread }) : null,
    mention ? t("shell.unreadMentions", { count: badge }) : null,
    r.kind === "mission" && badge > 0
      ? t("mobile.tabs.withCount", { label: t("mobile.home.waiting"), count: badge })
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <OpensConversation
      row={r}
      onStart={onStart}
      onOpen={onOpen}
      onHold={onHold}
      holdLabel={holdLabel ?? name}
      holdActions={holdActions}
    >
      {({ press, warm, hold }) => (
        <ListRow
          onPress={press}
          onTouchStart={warm}
          {...hold}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          divider={divider}
          unread={r.unread > 0}
          opens={!opener}
          {...(chosen ? { background: withAlpha(c.ink, CHOSEN_TINT), accessibilityState: { selected: true } } : {})}
          leading={leading}
          title={name}
          {...(role ? { titleAside: <Tag label={role} /> } : {})}
          time={meta ?? facts.time}
          dot={fresh && badge === 0}
          over={
            // A closed thread isn't marked here: it goes to the end of its list, and screen readers hear it.
            facts.place ? (
              <Text variant="footnote" tone="faint" numberOfLines={1}>
                {facts.place}
              </Text>
            ) : null
          }
          sub={line}
          trailing={
            badge > 0 ? (
              <Count
                value={badge}
                max={99}
                inverted
                {...(mention ? { fill: TAB_BADGE.background, color: TAB_BADGE.text } : {})}
              />
            ) : null
          }
        />
      )}
    </OpensConversation>
  );
});

/**
 * One conversation's row that works out what it says by itself, for a list that isn't one of Conversas' screens
 * (Search's results). The lists of conversations work it out once for all their rows and draw `ConversationItem`.
 */
export const ConversationRowView = memo(function ConversationRowView({
  agent,
  ...props
}: Omit<ConversationItemProps, "facts"> & {
  /** An agent DM: it waits on you, or what it is doing (from `agentRowState`). */
  agent?: AgentRowState;
}) {
  const factsOf = useRowFacts();
  return <ConversationItem {...props} facts={factsOf(props.row, agent)} />;
});

/** A long press for screen readers and away from iOS: the row's menu (`onHold`'s sheet). */
export interface HoldProps {
  onLongPress?: () => void;
  delayLongPress?: number;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (e: { nativeEvent: { actionName: string } }) => void;
}

/**
 * How a conversation opens from a list, for its row and for its face on Conversas' pinned strip: a tap opens it (an
 * agent with no conversation yet starts one, `onStart`), and the finger landing on it already asks for what its screen
 * shows first (`warm`, `prefetchConversation`: its messages, or a thread's replies, and the threads' links and agents'
 * questions its rows wait for), so they are on their way, or here, by the time its screen slides in. On touch-down, not
 * after the press delay, which left the read only a few milliseconds ahead of the screen; a finger that only starts a
 * scroll asks for one conversation once, and what is fresh isn't read again. iOS's own long press shows the
 * conversation itself in the system preview (tapping it opens it), with the row's actions (Pin to the top, a channel's
 * Move to…) in the system menu under it; an agent with no conversation yet peeks at its profile instead, with Talk
 * first, while a tap still starts the conversation. Elsewhere the long press is `onHold`'s sheet (`hold`).
 */
export function OpensConversation({
  row: r,
  onStart,
  onOpen,
  onHold,
  holdLabel,
  holdActions,
  children,
}: {
  row: ConversationRow;
  onStart?: ((agentId: string) => void) | undefined;
  onOpen?: (() => void) | undefined;
  onHold?: ((row: ConversationRow) => void) | undefined;
  /** What the long press does, for screen readers. */
  holdLabel: string;
  holdActions?: ((row: ConversationRow) => RowAction[]) | undefined;
  children: (how: { press: () => void; warm: () => void; hold: HoldProps }) => ReactNode;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const opener = useChatOpener();
  const starts = Boolean(onStart && r.kind === "dm");
  const href = r.channelId
    ? chatHref(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null)
    : null;
  const open = () => {
    onOpen?.();
    if (onStart && r.kind === "dm") onStart(r.with.id);
    else if (opener && r.channelId) {
      const chat = chatOfRow(r);
      if (chat) opener.open(chat);
    } else if (href) router.push(href);
  };
  const prefetch = usePrefetchConversation(orgId);
  const warm = () => {
    if (r.channelId) prefetch(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null);
  };
  const peekHref = starts && r.kind === "dm" ? (`/agent/${r.with.id}` as const) : href;
  // Beside the list (ADR 0212) the conversation opens next to it: no preview to peek at, the long press is the menu.
  const peeks = Platform.OS === "ios" && peekHref !== null && !opener;
  const hold: HoldProps =
    onHold && !peeks
      ? {
          onLongPress: () => onHold(r),
          delayLongPress: 380,
          accessibilityActions: [{ name: "menu", label: holdLabel }],
          onAccessibilityAction: (e) => {
            if (e.nativeEvent.actionName === "menu") onHold(r);
          },
        }
      : {};
  const item = (press: () => void) => children({ press, warm, hold });
  if (!peeks || !peekHref) return item(open);
  const actions = holdActions?.(r) ?? [];
  return (
    <Link href={peekHref} asChild>
      <Link.Trigger>
        {/* A conversation that starts keeps its own press; the link only serves its preview. */}
        <RowTrigger row={item} onOpen={onOpen} own={starts ? open : undefined} />
      </Link.Trigger>
      <Link.Preview />
      {starts || actions.length > 0 ? (
        <Link.Menu>
          {starts ? (
            <Link.MenuAction icon="bubble.left" onPress={open}>
              {t("mobile.agent.talk")}
            </Link.MenuAction>
          ) : null}
          {actions.map((a) => (
            <Link.MenuAction key={a.key} icon={a.symbol} onPress={a.run}>
              {a.label}
            </Link.MenuAction>
          ))}
        </Link.Menu>
      ) : null}
    </Link>
  );
}

/**
 * What sits under the link's trigger: the link's press opens the conversation, after the row's own `onOpen`; `own`
 * replaces it (a conversation that starts, whose link is only its preview).
 */
function RowTrigger({
  row,
  onOpen,
  own,
  onPress,
}: {
  row: (press: () => void) => ReactNode;
  onOpen?: (() => void) | undefined;
  own?: (() => void) | undefined;
  onPress?: () => void;
}) {
  return row(
    own ??
      (() => {
        onOpen?.();
        onPress?.();
      }),
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  work: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  em: { fontWeight: "500" },
});
