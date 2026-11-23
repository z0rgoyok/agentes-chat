import type { LiveRoom } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import {
  addSlide,
  LAYOUTS,
  type LayoutSlot,
  readSlide,
  type SlideLayout,
  type SlideTheme,
  setLayout,
  type ThemeId,
  themeOf,
} from "@agenteschat/live/slides";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon, PressScale, SCREEN_X, Text, usePulse, useTheme, useToast } from "@/ui";
import { goBack, router } from "@/ui/navigation";
import { errorHaptic, PushedHeader } from "../../shared/parts";
import { liveClosed } from "../logic";
import { LiveUnavailable } from "../shared/LiveBar";
import { useLiveDoc } from "../shared/useLiveDoc";
import { LAYOUT_CHOICES, layoutKey, slideHeight, slideScale } from "./logic";
import { slideRoute } from "./routes";
import { useDeck } from "./useDeck";

/**
 * The layouts of a slide on the phone (ADR 0196 §2, §9), on a screen of their own: each drawn small in the
 * presentation's theme with its name under it, two across. For a new slide (`at`), the pick adds it there and opens it
 * in this screen's place; for a slide's new look (`slide`), the pick changes it (its texts move to the new places) and
 * goes back, its current layout checked.
 */
export function LayoutScreen({ id, at, slide }: { id: string; at: number | null; slide: string | null }) {
  const { t } = useTranslation();
  const live = useLiveDoc(id, { kind: "slides" });
  const closed = liveClosed(live);
  const title = slide ? t("live.slides.layout.label") : t("live.slides.tools.newSlide");
  if (closed)
    return (
      <>
        <PushedHeader title={title} />
        <LiveUnavailable reason={closed} />
      </>
    );
  return (
    <>
      <PushedHeader title={title} />
      {live.room && live.loaded ? (
        <Layouts room={live.room} fileId={id} at={at} slide={slide} readOnly={live.mode !== "edit"} />
      ) : (
        <LayoutBones />
      )}
    </>
  );
}

const COLS = 2;
const GAP = 16;

/** The layouts' places while the presentation opens. */
function LayoutBones() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { width: screen } = useWindowDimensions();
  const pulse = usePulse();
  const w = (screen - SCREEN_X * 2 - GAP * (COLS - 1)) / COLS;
  return (
    <Animated.View
      style={[styles.bones, pulse]}
      accessible
      accessibilityLabel={t("mobile.common.loading")}
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: 6 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <View key={i} style={[styles.bone, { width: w, height: slideHeight(w), backgroundColor: c.plate }]} />
      ))}
    </Animated.View>
  );
}

function Layouts({
  room,
  fileId,
  at,
  slide,
  readOnly,
}: {
  room: LiveRoom;
  fileId: string;
  at: number | null;
  slide: string | null;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { width: screen } = useWindowDimensions();
  const deck = useDeck(room);
  const doc = room.doc;
  const width = (screen - SCREEN_X * 2 - GAP * (COLS - 1)) / COLS;
  const current = useMemo(() => (slide ? (readSlide(doc, slide)?.layout ?? null) : null), [doc, slide]);

  const choose = (layout: SlideLayout) => {
    if (readOnly) return;
    try {
      if (slide) {
        setLayout(doc, slide, layout, LOCAL);
        goBack();
        return;
      }
      const made = addSlide(doc, { at: at ?? deck.slides.length, layout }, LOCAL);
      router.replace(slideRoute(fileId, made));
    } catch {
      errorHaptic();
      toast({ title: t("live.slides.errors.tooMany"), icon: "x" });
    }
  };

  return (
    <FlatList
      data={LAYOUT_CHOICES}
      keyExtractor={(l) => l}
      numColumns={COLS}
      contentContainerStyle={styles.list}
      columnWrapperStyle={styles.cols}
      renderItem={({ item }) => (
        <LayoutTile
          layout={item}
          theme={deck.theme}
          width={width}
          checked={item === current}
          label={t(`live.slides.layouts.${layoutKey(item)}`)}
          onPress={() => choose(item)}
        />
      )}
    />
  );
}

const LayoutTile = memo(function LayoutTile({
  layout,
  theme,
  width,
  checked,
  label,
  onPress,
}: {
  layout: SlideLayout;
  theme: ThemeId;
  width: number;
  checked: boolean;
  label: string;
  onPress: () => void;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: checked }}
      style={[{ width }]}
      contentStyle={styles.tileIn}
    >
      <View
        style={[
          styles.frame,
          { boxShadow: shadows.e1 },
          checked
            ? { borderColor: c.ink, borderWidth: 2 }
            : { borderColor: c.line2, borderWidth: StyleSheet.hairlineWidth },
        ]}
      >
        <LayoutSketch layout={layout} theme={themeOf(theme)} width={width - (checked ? 4 : 0)} />
      </View>
      <Text variant="footnote" tone={checked ? "ink" : "ink2"} style={checked && styles.checked} numberOfLines={2}>
        {label}
      </Text>
    </PressScale>
  );
});

/** A layout drawn as its places: lines where its texts go (a title's thick, a body's thin), a block for its picture. */
function LayoutSketch({ layout, theme, width }: { layout: SlideLayout; theme: SlideTheme; width: number }) {
  const k = slideScale(width);
  const height = slideHeight(width);
  return (
    <View
      style={[styles.sketch, { width, height, backgroundColor: theme.colors.bg }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {LAYOUTS[layout].map((slot, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a layout's slots, in order
        <Slot key={i} slot={slot} k={k} theme={theme} />
      ))}
    </View>
  );
}

/** One place of a layout, in slide units scaled by `k`. */
function Slot({ slot, k, theme }: { slot: LayoutSlot; k: number; theme: SlideTheme }) {
  const box = { left: slot.box.x * k, top: slot.box.y * k, width: slot.box.w * k, height: slot.box.h * k };
  if (slot.type === "image")
    return (
      <View style={[styles.abs, styles.center, box, { backgroundColor: theme.colors.surface }]}>
        <Icon name="image" size={Math.max(10, 120 * k)} color={theme.colors.muted} />
      </View>
    );
  const headline = slot.role === "title" || slot.role === "number" || slot.role === "quote";
  const color = slot.role === "number" ? theme.colors.accent : headline ? theme.colors.text : theme.colors.muted;
  const thick = (slot.role === "number" ? 200 : headline ? 64 : 28) * k;
  const lines =
    slot.role === "number" ? [0.45] : headline ? (slot.role === "quote" ? [0.9, 0.6] : [0.7]) : [0.9, 0.8, 0.55];
  return (
    <View style={[styles.abs, box, { justifyContent: headline ? "flex-end" : "flex-start", gap: thick * 0.7 }]}>
      {lines.map((w, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          style={{ width: `${w * 100}%`, height: thick, borderRadius: thick / 3, backgroundColor: color }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: SCREEN_X, paddingTop: 16, paddingBottom: 32, gap: 20 },
  cols: { gap: GAP },
  tileIn: { gap: 8 },
  frame: { borderRadius: 8, overflow: "hidden" },
  checked: { fontWeight: "600" },
  sketch: { overflow: "hidden" },
  abs: { position: "absolute" },
  center: { alignItems: "center", justifyContent: "center" },
  bones: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: GAP,
    paddingHorizontal: SCREEN_X,
    paddingTop: 16,
  },
  bone: { borderRadius: 8 },
});
