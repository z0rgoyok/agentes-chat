import {
  type BoardItem,
  boardItems,
  type Dashboard,
  layoutOf,
  resizeItem,
  useRemoveWidget,
  useSaveLayout,
} from "@agenteschat/client";
import { layoutToSize, sizeToLayout, WIDGET_SIZES, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { GestureDetector, ScrollView, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeOut,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import {
  EmptyState,
  GroupedFooter,
  haptics,
  IconButton,
  Locked,
  Segmented,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { useFailed } from "../routines/hooks";
import { useUnsavedGuard } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic, useSurface } from "../shared/parts";
import { useBoard } from "./hooks";
import { layoutChanged, moveWidgetItem, shownWidgetTitle, widgetPlace } from "./logic";
import { dragTarget, footprint, moveIndex, orderWidgets } from "./organize-logic";
import { MissingScreen } from "./parts";

/** A hold this long picks a widget up; a quicker swipe still scrolls. */
const HOLD_MS = 280;
const GAP = 10;
/** A row's height before it is measured (they are all alike: a title line, then the size line). */
const ROW_GUESS = 104;
/** Rows sliding to their places and a size's drawing settling: a reposition, no overshoot past it. */
const SPRING = { duration: 400, dampingRatio: 0.8 };
/** The held row lifting: a press's quick ease-out, not a bounce. */
const LIFT = { duration: 150, easing: Easing.bezier(0.23, 1, 0.32, 1) };
/** The size's small drawing: a square of two columns and two rows. */
const FOOT_W = 22;
const FOOT_H = 22;
const FOOT_GAP = 2;

/**
 * Organize a board on the phone, pushed from its "…" (ADR 0135): each widget in the board's order, held and dragged
 * to a new place (the others slide out of its way) or moved with Move up and Move down, its size (S, M, L, drawn as
 * the room it takes) and Remove. "Done" saves the order and sizes at once (leaving without it asks first); a home
 * board's tiles keep their places.
 * `id` is `home` for My Home.
 */
export function OrganizeScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { board, loading, failed, refetch } = useBoard(id);
  if (!board)
    return (
      <MissingScreen
        title={t("widgets.organize.start")}
        state={loading ? "loading" : failed ? "failed" : "gone"}
        onRetry={() => void refetch()}
        gone={t("dashboards.errors.notFound")}
      />
    );
  return <Arrange key={board.id} board={board} />;
}

function Arrange({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const reduced = useReducedMotion();
  const save = useSaveLayout(orgId);
  const remove = useRemoveWidget(orgId);
  const dir = useDirectory();
  const [before] = useState(() => boardItems(board.widgets, board.tiles));
  const [items, setItems] = useState<BoardItem[]>(before);
  const home = board.kind === "home";
  const widgets = items.flatMap((item) => (item.type === "widget" ? [item] : []));
  // A new order or size not saved asks before a back swipe drops it (a widget removed here is already gone).
  const leave = useUnsavedGuard(
    layoutChanged(
      before.filter((x) => items.some((i) => i.id === x.id)),
      items,
    ),
  );

  // The rows stand in a column of their own, each at its place in `order` (shared with the UI thread): a drag or a
  // move changes the order and every row springs to its new place; the screen's state follows on the drop.
  const ids = widgets.map((w) => w.id).join(",");
  const order = useSharedValue<string[]>(ids ? ids.split(",") : []);
  const held = useSharedValue<string | null>(null);
  const from = useSharedValue(0);
  const offset = useSharedValue(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const rowH = Math.max(0, ...Object.values(heights)) || ROW_GUESS;
  const step = useSharedValue(rowH + GAP);
  const settled = useSharedValue(false);
  const [lifted, setLifted] = useState<string | null>(null);
  useEffect(() => {
    order.set(ids ? ids.split(",") : []);
  }, [ids, order]);
  useEffect(() => {
    step.set(rowH + GAP);
  }, [rowH, step]);
  useEffect(() => {
    // First drawn in place; from then on every change springs.
    const timer = setTimeout(() => settled.set(true), 0);
    return () => clearTimeout(timer);
  }, [settled]);

  const measure = (id: string, h: number) =>
    setHeights((all) => (Math.abs((all[id] ?? 0) - h) < 0.5 ? all : { ...all, [id]: h }));
  const lift = (id: string) => {
    haptics.medium();
    setLifted(id);
  };
  const drop = (next: string[]) => {
    haptics.light();
    setLifted(null);
    setItems((list) => orderWidgets(list, next));
  };
  const move = (itemId: string, by: -1 | 1) => {
    haptics.selection();
    setItems((list) => moveWidgetItem(list, itemId, by));
  };
  const resize = (itemId: string, size: WidgetSize) => {
    haptics.selection();
    setItems((list) => resizeItem(list, itemId, sizeToLayout(size)));
  };
  const done = () => {
    if (!layoutChanged(before, items)) {
      goBack();
      return;
    }
    save.mutate(
      { dashboardId: board.id, ...layoutOf(items), home },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.organize.saved") });
          leave();
          goBack();
        },
        onError: failed,
      },
    );
  };
  // The same words as the web's confirmation (ADR 0135): its routine stops and its history goes.
  const confirmRemove = (item: Extract<BoardItem, { type: "widget" }>) =>
    Alert.alert(
      t("widgets.removeConfirm.title", {
        title: shownWidgetTitle(item.widget.title, item.widget.kind, (k) => t(k)),
      }),
      item.widget.schedule === "manual"
        ? t("widgets.removeConfirm.textManual")
        : t("widgets.removeConfirm.textRoutine", {
            name: dir.anyAgent(item.widget.agentId)?.name ?? t("channel.unknownAgent"),
          }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("widgets.removeConfirm.confirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(item.id, {
              onSuccess: () => {
                successHaptic();
                setItems((list) => list.filter((x) => x.id !== item.id));
                toast({ title: t("mobile.dashboards.widget.removed") });
              },
              onError: failed,
            }),
        },
      ],
    );
  const motion: RowMotion = { order, held, from, offset, step, settled, reduced };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("widgets.organize.start")}
        subtitle={home ? t("dashboards.home") : board.title}
        solid={false}
        grouped
        action={{ label: t("widgets.organize.done"), disabled: save.isPending, onPress: done }}
      />
      <ScrollView
        scrollEnabled={lifted === null}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <GroupedFooter>{t("mobile.dashboards.organize.hint")}</GroupedFooter>
        {widgets.length === 0 ? <EmptyState size="inline" title={t("dashboards.empty.text")} /> : null}
        <Locked when={save.isPending}>
          <View style={{ height: widgets.length ? widgets.length * (rowH + GAP) - GAP : 0 }}>
            {widgets.map((item) => (
              <OrganizeRow
                key={item.id}
                item={item}
                place={widgetPlace(items, item.id)}
                lifted={lifted === item.id}
                motion={motion}
                onLayoutHeight={(h) => measure(item.id, h)}
                onLift={lift}
                onDrop={drop}
                onMove={(by) => move(item.id, by)}
                onSize={(size) => resize(item.id, size)}
                onRemove={() => confirmRemove(item)}
              />
            ))}
          </View>
        </Locked>
      </ScrollView>
    </View>
  );
}

/** What the rows share with the UI thread: the order, the held row and how far it went, the row's step. */
interface RowMotion {
  order: SharedValue<string[]>;
  held: SharedValue<string | null>;
  from: SharedValue<number>;
  offset: SharedValue<number>;
  step: SharedValue<number>;
  settled: SharedValue<boolean>;
  reduced: boolean;
}

/**
 * One widget in Organize: its size drawn and its agent, its title and where it stands, up and down, its size, and
 * Remove. Held, it lifts and follows the finger; the others spring out of its way.
 */
function OrganizeRow({
  item,
  place,
  lifted,
  motion,
  onLayoutHeight,
  onLift,
  onDrop,
  onMove,
  onSize,
  onRemove,
}: {
  item: Extract<BoardItem, { type: "widget" }>;
  place: { at: number; count: number };
  lifted: boolean;
  motion: RowMotion;
  onLayoutHeight: (h: number) => void;
  onLift: (id: string) => void;
  onDrop: (order: string[]) => void;
  onMove: (by: -1 | 1) => void;
  onSize: (size: WidgetSize) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const surface = useSurface(lifted ? "e2" : "e1");
  const size = layoutToSize(item);
  const id = item.id;
  const { order, held, from, offset, step, settled, reduced } = motion;
  const pan = usePanGesture({
    activateAfterLongPress: HOLD_MS,
    onActivate: () => {
      "worklet";
      held.set(id);
      from.set(Math.max(0, order.get().indexOf(id)));
      offset.set(0);
      scheduleOnRN(onLift, id);
    },
    onUpdate: (e) => {
      "worklet";
      if (held.get() !== id) return;
      offset.set(e.translationY);
      const ids = order.get();
      const at = ids.indexOf(id);
      const to = dragTarget(from.get(), e.translationY, step.get(), ids.length);
      // Only when the row crosses into another place: the others move and one tick is felt.
      if (at < 0 || to === at) return;
      order.set(moveIndex(ids, at, to));
      scheduleOnRN(haptics.selection);
    },
    onDeactivate: () => {
      "worklet";
      if (held.get() !== id) return;
      held.set(null);
      scheduleOnRN(onDrop, order.get());
    },
  });
  const placed = useAnimatedStyle(() => {
    const y = Math.max(0, order.get().indexOf(id)) * step.get();
    if (held.get() === id)
      return {
        zIndex: 2,
        transform: [
          { translateY: from.get() * step.get() + offset.get() },
          { scale: reduced ? 1 : withTiming(1.03, LIFT) },
        ],
      };
    const still = reduced || !settled.get();
    return {
      zIndex: 0,
      transform: [{ translateY: still ? y : withSpring(y, SPRING) }, { scale: still ? 1 : withTiming(1, LIFT) }],
    };
  });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        exiting={reduced ? undefined : FadeOut.duration(160)}
        style={[styles.slot, placed]}
        onLayout={(e) => onLayoutHeight(e.nativeEvent.layout.height)}
        accessibilityHint={t("mobile.dashboards.organize.holdHint")}
      >
        <View style={[styles.row, surface]}>
          <View style={styles.top}>
            <Footprint size={size} />
            <AgentFace agentId={item.widget.agentId} size={26} live={false} />
            <View style={styles.grow}>
              <Text variant="body" numberOfLines={1} style={styles.semibold}>
                {shownWidgetTitle(item.widget.title, item.widget.kind, (k) => t(k))}
              </Text>
              <Text variant="footnote" tone="faint">
                {t("mobile.dashboards.organize.position", { at: place.at, count: place.count })}
              </Text>
            </View>
            <IconButton
              icon="up"
              label={t("mobile.dashboards.organize.up")}
              disabled={place.at <= 1}
              onPress={() => onMove(-1)}
            />
            <IconButton
              icon="down"
              label={t("mobile.dashboards.organize.down")}
              disabled={place.at >= place.count}
              onPress={() => onMove(1)}
            />
          </View>
          <View style={styles.bottom}>
            <Text variant="footnote" tone="muted">
              {t("widgets.organize.size")}
            </Text>
            <Segmented
              items={WIDGET_SIZES.map((s) => ({ key: s, label: t(`widgets.sizes.${s}`) }))}
              value={size}
              onChange={(k) => onSize(k as WidgetSize)}
            />
            <View style={styles.grow} />
            <IconButton icon="trash" label={t("widgets.organize.remove")} onPress={onRemove} />
          </View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/** The room a size takes on the phone's 2-column board, drawn small; it grows and shrinks as the size changes. */
function Footprint({ size }: { size: WidgetSize }) {
  const { colors: c } = useTheme();
  const reduced = useReducedMotion();
  const { cols, rows } = footprint(size);
  const width = cols === 2 ? FOOT_W : (FOOT_W - FOOT_GAP) / 2;
  const height = rows === 2 ? FOOT_H : (FOOT_H - FOOT_GAP) / 2;
  const fill = useAnimatedStyle(() => ({
    width: reduced ? width : withSpring(width, SPRING),
    height: reduced ? height : withSpring(height, SPRING),
  }));
  return (
    <View
      style={[styles.foot, { backgroundColor: c.sunken }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.footFill, { backgroundColor: c.faint }, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  slot: { position: "absolute", top: 0, left: 0, right: 0 },
  row: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 8,
    gap: 6,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  bottom: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  foot: { width: FOOT_W + 4, height: FOOT_H + 4, padding: 2, borderRadius: 6, borderBottomLeftRadius: 2 },
  footFill: { borderRadius: 3, borderBottomLeftRadius: 1, opacity: 0.55 },
});
