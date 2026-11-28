import { frozenBoard, useHomeBoard, type Widget } from "@agenteschat/client";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon, type IconName, RowPressable, SideScroll, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { newWidgetHref } from "../dashboards/BoardScreen";
import { HOME, widgetsInOrder } from "../dashboards/logic";
import { WidgetPeek } from "../dashboards/WidgetPeek";
import { useColors } from "../shared/hooks";
import { CollapsibleSection } from "./HomeSection";

/** Between the cards: the lists' 12. */
const GAP = 12;

/**
 * A widget's width on the strip (ADR 0135 §15): a small one takes a column (two show whole and the third peeks past
 * the edge, so it reads as one that scrolls); a medium or large one takes two columns and the gap between them, as on
 * a board, so its rows and sentences show whole.
 */
const STRIP_WIDGET = 162;
const STRIP_WIDE = STRIP_WIDGET * 2 + GAP;
const isWide = (w: Widget) => w.layout.w === 2;

/** Where each card starts on the strip: its stops when a swipe lets go. */
function stripStops(widgets: readonly Widget[]): number[] {
  let x = 0;
  return widgets.map((w) => {
    const at = x;
    x += (isWide(w) ? STRIP_WIDE : STRIP_WIDGET) + GAP;
    return at;
  });
}

/**
 * The home's widgets (ADR 0135 §15, §18): a head with what Início shows (My Home, or the board chosen with "Use on
 * Home") and "See all", which pushes Dashboards; then its widgets side by side, each one or two columns wide, on a strip that scrolls
 * sideways. Tapping one opens it. With none yet, one card asks for a widget (when the person edits that board).
 */
export const HomeWidgets = memo(function HomeWidgets({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const home = useHomeBoard(orgId);
  // One object while the board stays: each card is memoized on it.
  const where = useMemo(() => ({ id: home.chosenId ?? HOME, home: !home.chosenId }), [home.chosenId]);
  if (home.loading && !home.board) return null;
  const board = home.board && frozenBoard(home.board, org);
  const title = home.chosenId ? (board?.title ?? home.chosenTitle ?? "") : t("dashboards.home");
  const widgets: Widget[] = board ? widgetsInOrder(board.widgets) : [];
  const canAdd = Boolean(board?.canEdit);
  const add = () => router.push(newWidgetHref(home.chosenId ?? HOME));
  // A section of Conversas like the others: its header hides the widgets (remembered on this phone) and shows them.
  return (
    <CollapsibleSection title={title} count={widgets.length} collapsed={collapsed} onToggle={onToggle}>
      {widgets.length > 0 || !canAdd ? (
        <SideScroll snapToOffsets={stripStops(widgets)} decelerationRate="fast" contentContainerStyle={styles.strip}>
          {widgets.map((w) => (
            <View key={w.id} style={isWide(w) ? styles.wide : styles.item}>
              <WidgetPeek widget={w} canEdit={canAdd} board={where} compact />
            </View>
          ))}
          {/* The strip ends on round buttons on no plate, their words under them: "Add" (who edits this board)
              beside "See all". */}
          <View style={styles.ends}>
            {canAdd ? (
              <StripButton icon="plus" label={t("widgets.add.word")} said={t("widgets.add.label")} onPress={add} />
            ) : null}
            <StripButton icon="right" label={t("dashboards.seeAll")} onPress={() => router.push("/dashboards")} />
          </View>
        </SideScroll>
      ) : canAdd ? (
        <RowPressable
          // A full-width row: it lights a beat after the finger lands, as the list's rows do.
          onPress={add}
          accessibilityRole="button"
          radius={EMPTY_RADIUS}
          style={[styles.empty, { borderColor: c.line2 ?? c.line }]}
        >
          <Icon name="plus" size={18} color={c.muted} />
          <Text variant="subhead" tone="muted" style={styles.medium}>
            {t("widgets.add.label")}
          </Text>
        </RowPressable>
      ) : null}
    </CollapsibleSection>
  );
});

/** A round button at the strip's end, its words under it; `said` is what VoiceOver reads when the words are short. */
function StripButton({
  icon,
  label,
  said,
  onPress,
}: {
  icon: IconName;
  label: string;
  said?: string;
  onPress: () => void;
}) {
  const c = useColors();
  const { shadows } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={said ?? label}
      style={({ pressed }) => [styles.all, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.allButton,
          { backgroundColor: c.raised, boxShadow: `0px 0px 0px 0.5px ${c.line2}, ${shadows.e1}` },
        ]}
      >
        <Icon name={icon} size={20} color={c.ink2} />
      </View>
      <Text variant="footnote" tone="muted" style={styles.medium} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The "add a widget" box's corner; its press light keeps it. */
const EMPTY_RADIUS = 20;

const styles = StyleSheet.create({
  medium: { fontWeight: "500" },
  // Room above and below: the cards' hairline and shadow are never cut by the strip's edge.
  strip: { paddingHorizontal: 16, gap: GAP, paddingTop: 4, paddingBottom: 6 },
  // The end's buttons side by side, as one pair (each its own 84 of room).
  ends: { flexDirection: "row" },
  all: { width: 84, alignItems: "center", justifyContent: "center", gap: 8 },
  allButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.7 },
  item: { width: STRIP_WIDGET },
  wide: { width: STRIP_WIDE },
  empty: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    paddingVertical: 20,
    borderRadius: EMPTY_RADIUS,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
});
