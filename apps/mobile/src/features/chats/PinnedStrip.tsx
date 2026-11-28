import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { TAB_BADGE } from "@/lib/nav";
import { Count, LineIcon, PixelOrbit, PressScale, SCREEN_X, SideScroll, Text, weights } from "@/ui";
import type { RowAction } from "../channel-sectors/menus";
import { WaitMark } from "../chat/WaitMark";
import { AgentFace, Face } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { OpensConversation } from "./ConversationRowView";
import { CollapsibleSection } from "./HomeSection";
import type { ConversationRow } from "./logic";
import { faceMark, type RowFacts } from "./rowFacts";

/** A face on the strip: a little larger than a row's, as the faces people keep at hand are. */
const FACE = 56;
/** Each one's column, the same for every face: room for a short name under it, and the next face peeks past the edge. */
const ITEM = 72;
const GAP = 8;
/** The marks before the name: the footnote's own height, so they read as part of its line. */
const MARK = 12;

/** One conversation on the strip, with what its row would say (`useRowFacts`) and whether its face moves. */
export interface PinnedItem {
  row: ConversationRow;
  facts: RowFacts;
  live: boolean;
}

export interface PinnedStripProps {
  items: readonly PinnedItem[];
  collapsed: boolean;
  onToggle: () => void;
  /** An agent with no conversation yet: starts one (stable). */
  onStart: (agentId: string) => void;
  /** The row's long press: its sheet, its actions for iOS's own menu, and what it does, for screen readers. */
  onHold: (row: ConversationRow) => void;
  holdActions: (row: ConversationRow) => RowAction[];
  holdLabel: string;
}

/**
 * Favoritos, under Início's widgets: what the person keeps there (the web sidebar's Favoritos, ADR 0260: their own agents
 * until they choose),
 * side by side on a strip that scrolls sideways. Each is the app's own face for it: an agent's living body (at work,
 * dozing while it waits for its offline computer, its presence on the corner), a person's photo, a channel's tile; its
 * name under it on one line, after the mark its row's second line would carry (the orbit at work, the amber square for
 * what waits on you, a clock for a wait elsewhere), and its unread count on the face's corner as the app's badge. A tap
 * opens the conversation as its row does (an agent with none yet starts one); the long press is the row's own (iOS's
 * menu under the conversation's preview, the sheet elsewhere), with Tirar do topo. A section like the others: its
 * header hides it, remembered. Nothing pinned: no strip.
 */
export function PinnedStrip({ items, collapsed, onToggle, onStart, onHold, holdActions, holdLabel }: PinnedStripProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <CollapsibleSection
      title={t("mobile.chats.favorites")}
      count={items.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {/* A fade at the edge where more pinned faces wait past it. */}
      <SideScroll contentContainerStyle={styles.strip}>
        {items.map((it) => (
          <PinnedFace
            key={it.row.key}
            row={it.row}
            facts={it.facts}
            live={it.live}
            onStart={onStart}
            onHold={onHold}
            holdActions={holdActions}
            holdLabel={holdLabel}
          />
        ))}
      </SideScroll>
    </CollapsibleSection>
  );
}

/**
 * One face of the strip. Memoized on plain values and stable handlers, as the rows are: it draws again only when its
 * own conversation or what it says changes. Opening it is plain navigation: the press shows, with no haptic.
 */
const PinnedFace = memo(function PinnedFace({
  row: r,
  facts,
  live,
  onStart,
  onHold,
  holdActions,
  holdLabel,
}: PinnedItem & Omit<PinnedStripProps, "items" | "collapsed" | "onToggle">) {
  const { t } = useTranslation();
  const c = useColors();
  const name = r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title;
  // At work, an agent's face wears the orbit, as its row's does; the mark before the name then says nothing more.
  const ringed = r.kind === "dm" && r.with.type === "agent" && facts.face === "run";
  const face =
    r.kind === "dm" ? (
      r.with.type === "agent" ? (
        <AgentFace agentId={r.with.id} size={FACE - 2} mode={facts.face} live={live} presence orbit={ringed} />
      ) : (
        <Face who={{ type: r.with.type, id: r.with.id }} size={FACE} live={false} presence />
      )
    ) : (
      <Tile icon="hash" size={FACE} />
    );
  const lineMark = faceMark(facts.line);
  const mark = ringed && lineMark === "orbit" ? null : lineMark;
  const unread = r.unread > 0;
  const a11y = [
    name,
    facts.presence,
    facts.status,
    facts.label,
    unread ? t("mobile.chats.unreadLabel", { count: r.unread }) : null,
    facts.mention ? t("shell.unreadMentions", { count: facts.badge }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <OpensConversation
      row={r}
      // Only a pinned agent never talked to starts its conversation; the others open theirs.
      onStart={r.kind === "dm" && !r.channelId ? onStart : undefined}
      onHold={onHold}
      holdLabel={holdLabel}
      holdActions={holdActions}
    >
      {({ press, warm, hold }) => (
        <PressScale
          haptic={false}
          fill={false}
          onPress={press}
          onTouchStart={warm}
          {...hold}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          style={styles.item}
          contentStyle={styles.itemIn}
        >
          <View>
            {face}
            {facts.badge > 0 ? (
              // Ringed in the page's color, as the presence badge is, so it stands apart from the face.
              <View style={[styles.badge, { backgroundColor: c.bg }]}>
                <Count
                  value={facts.badge}
                  max={99}
                  inverted
                  {...(facts.mention ? { fill: TAB_BADGE.background, color: TAB_BADGE.text } : {})}
                />
              </View>
            ) : null}
          </View>
          <View style={styles.name}>
            {mark === "orbit" ? (
              <LineIcon variant="footnote" size={MARK} mark>
                <PixelOrbit color={facts.orbit} size={MARK} />
              </LineIcon>
            ) : mark === "wait" ? (
              <LineIcon variant="footnote" size={7} mark>
                <WaitMark size={7} still />
              </LineIcon>
            ) : mark === "clock" ? (
              <LineIcon name="clock" size={MARK} color={c.faint} variant="footnote" />
            ) : null}
            <Text
              variant="footnote"
              tone={unread ? "ink" : "ink2"}
              numberOfLines={1}
              style={[styles.shrink, unread && styles.unread]}
            >
              {name}
            </Text>
          </View>
        </PressScale>
      )}
    </OpensConversation>
  );
});

const styles = StyleSheet.create({
  // The screen's sides, and room above for a badge standing over a face's corner and for the orbit's tip: a ring turned
  // upright reaches 0.24 of the face past it (13 points here), and the strip scrolls, so it clips what passes its top.
  strip: { paddingHorizontal: SCREEN_X, gap: GAP, paddingTop: 9, paddingBottom: 4 },
  item: { width: ITEM },
  // The name far enough under the face that the upright ring's tip stays above its letters.
  itemIn: { alignItems: "center", gap: 10, paddingVertical: 4 },
  badge: { position: "absolute", top: -6, right: -8, padding: 2, borderRadius: 999 },
  name: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: ITEM },
  shrink: { flexShrink: 1 },
  unread: { fontWeight: weights.semibold },
});
