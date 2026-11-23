import { gradientOf, isHexColor } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar, GroupedHeader, GroupedList, GroupedRow, Icon, PressScale, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES } from "../shared/logic";
import { goBack, PushedHeader, tapHaptic } from "../shared/parts";
import { ColorSheet } from "./ColorSheet";
import { type FullLook, shuffleLook } from "./edit";
import { chooseLook, closeLookPart, type LookPart, openLookPart, useLookPart } from "./look-part";

/**
 * An agent's look on a grouped list, for "Create agent" and "Edit agent" on the grouped gray: the colors in one row,
 * the chosen one checked inside, then "Eyes" and "Accessory" showing what it wears, each opening its choices on a
 * screen of their own (`LookPartScreen`), and "Shuffle".
 */
export function LookList({ look, onChange }: { look: FullLook; onChange: (next: FullLook) => void }) {
  const { t } = useTranslation();
  const color = useColorSheet(look, onChange);
  const set = (patch: Partial<FullLook>) => {
    tapHaptic();
    onChange({ ...look, ...patch });
  };
  // The part's screen wears its choice through the latest `onChange` (the form as it is then).
  const latest = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => () => closeLookPart(), []);
  const openPart = (part: "eyes" | "accessory") => {
    openLookPart({ part, look, apply: (next) => latest.current(next) });
    router.push("/agent-look");
  };
  return (
    <>
      <GroupedHeader>{t("look.color")}</GroupedHeader>
      <GroupedList>
        <Swatches look={look} onPick={(next) => set({ color: next })} onCustom={color.open} />
        <GroupedRow
          label={t("look.eyes")}
          value={t(`look.eyesNames.${look.eyes}`)}
          chevron
          onPress={() => openPart("eyes")}
        />
        <GroupedRow
          label={t("look.accessory")}
          value={t(`look.accessories.${look.accessory}`)}
          chevron
          onPress={() => openPart("accessory")}
        />
        <GroupedRow
          icon="sparkle"
          label={t("newAgent.shuffle")}
          onPress={() => {
            tapHaptic();
            onChange(shuffleLook(look));
          }}
        />
      </GroupedList>
      {color.sheet}
    </>
  );
}

/**
 * The custom color's sheet: a new one per opening starts from the color shown then; the same key lets it animate away.
 */
function useColorSheet(look: FullLook, onChange: (next: FullLook) => void) {
  const [picking, setPicking] = useState(false);
  const [opens, setOpens] = useState(0);
  const open = () => {
    tapHaptic();
    setOpens((n) => n + 1);
    setPicking(true);
  };
  const sheet = (
    <ColorSheet
      key={opens}
      open={picking}
      value={look.color}
      onChange={(color) => onChange({ ...look, color })}
      onClose={() => setPicking(false)}
    />
  );
  return { open, sheet };
}

/**
 * The presets and the custom color (a rainbow until one is picked), a row of the list: the chosen one checked inside,
 * the only mark, the row spreading them across.
 */
function Swatches({
  look,
  onPick,
  onCustom,
}: {
  look: FullLook;
  onPick: (color: (typeof AGENT_COLORS)[number]) => void;
  onCustom: () => void;
}) {
  const { t } = useTranslation();
  const custom = isHexColor(look.color);
  // A swatch is 30 pt: 7 more around it reach the 44 pt a finger needs.
  const slop = 7;
  return (
    <View style={styles.swatchRow} accessibilityRole="radiogroup" accessibilityLabel={t("look.color")}>
      {AGENT_COLORS.map((color) => {
        const [top, bottom] = gradientOf(color);
        const on = look.color === color;
        return (
          <PressScale
            key={color}
            onPress={() => onPick(color)}
            accessibilityRole="radio"
            accessibilityLabel={t(`look.colors.${color}`)}
            accessibilityState={{ selected: on }}
            hitSlop={slop}
            // The pick's own tap is felt once, from the form (`set`).
            haptic={false}
          >
            <LinearGradient colors={[top, bottom]} style={styles.swatch}>
              {on ? <Icon name="check" size={16} color="#fff" /> : null}
            </LinearGradient>
          </PressScale>
        );
      })}
      <PressScale
        onPress={onCustom}
        accessibilityRole="radio"
        accessibilityLabel={t("look.customColor")}
        accessibilityState={{ selected: custom }}
        hitSlop={slop}
        haptic={false}
      >
        <LinearGradient
          colors={custom ? gradientOf(look.color) : RAINBOW}
          start={custom ? undefined : { x: 0, y: 0 }}
          end={custom ? undefined : { x: 1, y: 1 }}
          style={styles.swatch}
        >
          {custom ? <Icon name="check" size={16} color="#fff" /> : null}
        </LinearGradient>
      </PressScale>
    </View>
  );
}

/**
 * The eyes or the accessory, pushed from the look's row (ADR 0135: screens, never sheets): each choice drawn on the
 * agent as it looks now (the eyes bare, so the face is what changes), the one it wears checked; a tap wears it and goes
 * back.
 */
export function LookPartScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const pick = useLookPart();
  // Opened with no form under it (its address on its own): nothing to choose for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  // `drawn`: how the row shows it; `wear`: the look it gives.
  const options = (
    look: FullLook,
    part: LookPart["part"],
  ): { key: string; label: string; drawn: FullLook; wear: FullLook }[] =>
    part === "eyes"
      ? AGENT_EYES.map((eyes) => ({
          key: eyes,
          label: t(`look.eyesNames.${eyes}`),
          drawn: { ...look, eyes, accessory: "none" },
          wear: { ...look, eyes },
        }))
      : AGENT_ACCESSORIES.map((accessory) => ({
          key: accessory,
          label: t(`look.accessories.${accessory}`),
          drawn: { ...look, accessory },
          wear: { ...look, accessory },
        }));
  const value = !pick ? null : pick.part === "eyes" ? pick.look.eyes : pick.look.accessory;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={pick?.part === "accessory" ? t("look.accessory") : t("look.eyes")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, { paddingBottom: 24 + insets.bottom }]}
      >
        <GroupedList>
          {(pick ? options(pick.look, pick.part) : []).map((o) => (
            <GroupedRow
              key={o.key}
              leading={<AgentAvatar agent={o.drawn} size={36} live={false} />}
              label={o.label}
              checked={o.key === value}
              onPress={() => {
                tapHaptic();
                chooseLook(o.wear);
                goBack();
              }}
            />
          ))}
        </GroupedList>
      </ScrollView>
    </View>
  );
}

/** The ninth swatch before a custom color is picked: the presets' tops, as a rainbow. */
const RAINBOW = ["#f58aa6", "#f3c25c", "#5fcf8b", "#8cc3ff", "#ae8cf7"] as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { paddingHorizontal: 16, paddingTop: 4 },
  // Nine across a phone's list: spread over the row, onto a second line only on the narrowest screens.
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  swatch: { width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
});
