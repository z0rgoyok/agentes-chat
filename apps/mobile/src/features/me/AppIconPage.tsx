import {
  APP_ICONS,
  type AppIconId,
  appIconNameKey,
  DEFAULT_MADE_ICON,
  isMadeIconExpression,
  isMadeIconFace,
  MADE_ICON_ACCESSORIES,
  MADE_ICON_COLORS,
  MADE_ICON_FACES,
  MADE_ICON_POSES,
  MADE_ICON_SKIES,
  type MadeIcon,
  type MadeIconLook,
  PHONE_APP_ICON,
} from "@agenteschat/client/lib/app-icons";
import { drawAccessory, drawAgent, drawnKey, gradientOf } from "@agenteschat/ui/agent/engine";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { asCtx, compile, RecordingContext } from "@/agent/recorder";
import { replay } from "@/agent/skia-ctx";
import {
  AgentAvatar,
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  Icon,
  PressScale,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { useColors } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { APP_ICON_PICTURES, MADE_ICON_SKY_PICTURES, useAppIcon } from "./app-icon";
import { type PhoneIcon, samePhoneIcon } from "./app-icon-names";
import { Page } from "./parts";

/** An icon's corner on a home screen, as a share of its side. */
const CORNER = 0.225;

/**
 * Where a made icon's agent stands on the icon's 1024 grid, as the build draws it
 * (packages/ui/scripts/app-icons/scenes.mjs): the shipped icon's place, or smaller and lower when it wears something.
 */
const BARE = { x: 224, y: 192, side: 576, cells: 18 };
const WEARING = { x: 256, y: 416, side: 512, cells: 16 };
/** Leaning in from the bottom right corner, as the Peeking icons' agent: bigger, looking up, turned around its eyes. */
const LEANING = { x: 170, y: 202, side: 960, cells: 30 };
const LEAN = { degrees: -18, about: [650, 600], look: [-0.035, -0.045] } as const;

/** What a made icon's look is to the agent engine: its eyes, a held expression and what it wears. */
function agentOf(icon: MadeIcon) {
  const face = isMadeIconFace(icon.look) ? icon.look : "round";
  return {
    color: icon.color,
    eyes: isMadeIconExpression(face) ? ("round" as const) : face,
    expression: isMadeIconExpression(face) ? face : undefined,
    accessory: isMadeIconFace(icon.look) ? ("none" as const) : icon.look,
  };
}

/** A made icon as the home screen will show it: its sky's picture and the agent drawn over it by the agent engine. */
function MadeIconPicture({ icon, size }: { icon: MadeIcon; size: number }) {
  const { color, look, pose } = icon;
  // By the colors it resolves to: `sky` follows the workspace's accent.
  const drawn = drawnKey(color);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` is what `color` draws as now
  const picture = useMemo(() => {
    const agent = agentOf({ sky: "night", color, look, pose });
    const leans = pose === "peek";
    const wears = !leans && agent.accessory !== "none";
    const at = leans ? LEANING : wears ? WEARING : BARE;
    const u = size / 1024;
    const rec = new RecordingContext();
    if (leans) {
      const [ax, ay] = LEAN.about;
      rec.save();
      rec.translate(ax * u, ay * u);
      rec.rotate((LEAN.degrees * Math.PI) / 180);
      rec.translate(-ax * u, -ay * u);
    }
    drawAgent(asCtx(rec), at.x * u, at.y * u, at.side * u, {
      color: agent.color,
      eyes: agent.eyes,
      cells: at.cells,
      pose: {
        ...(leans ? { look: [...LEAN.look] as [number, number] } : {}),
        ...(agent.expression ? { expression: agent.expression } : {}),
      },
      after: wears ? (ctx, side, frame) => drawAccessory(ctx, side, agent.accessory, frame) : undefined,
    });
    if (leans) rec.restore();
    const frame = compile(rec.commands);
    return createPicture((canvas) => replay(canvas, frame), { width: size, height: size });
  }, [color, drawn, look, pose, size]);
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * CORNER), overflow: "hidden" }}>
      <Image
        source={MADE_ICON_SKY_PICTURES[icon.pose][icon.sky]}
        style={{ width: size, height: size }}
        accessibilityIgnoresInvertColors
      />
      <Canvas style={[StyleSheet.absoluteFill, { width: size, height: size }]}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

/** An icon's picture as the home screen shows it (a ready one in this appearance), rounded like one. */
export function AppIconPicture({ icon, size = 32 }: { icon: PhoneIcon; size?: number }) {
  const theme = useTheme();
  if (typeof icon !== "string") return <MadeIconPicture icon={icon} size={size} />;
  return (
    <Image
      source={APP_ICON_PICTURES[icon][theme.scheme === "dark" ? "dark" : "light"]}
      style={{ width: size, height: size, borderRadius: Math.round(size * CORNER) }}
      accessibilityIgnoresInvertColors
    />
  );
}

/** An icon's name: a ready one's, or "Your icon". */
export function useAppIconName(icon: PhoneIcon) {
  const { t } = useTranslation();
  if (Platform.OS === "ios" && icon === PHONE_APP_ICON) return "Tich Rooms";
  return typeof icon === "string" ? t(appIconNameKey(icon)) : t("appIcon.yours");
}

/** A made icon's face or accessory, in words. */
function useLookName() {
  const { t } = useTranslation();
  return (look: MadeIconLook) =>
    !isMadeIconFace(look)
      ? t(`look.accessories.${look}`)
      : isMadeIconExpression(look)
        ? t(`appIcon.faces.${look}`)
        : t(`look.eyesNames.${look}`);
}

/**
 * App icon (ADR 0179), pushed from You: the icon as the home screen will show it, then what it is made of (its sky,
 * how the agent stands, its color and a face or an accessory) and the ready ones. Nothing changes until "Use this icon": iOS confirms every
 * change with an alert of its own, which trying the choices one by one would show each time.
 */
export function AppIconPage() {
  const { t } = useTranslation();
  const appIcon = useAppIcon();
  return (
    <Page title={t("appIcon.title")}>
      {/* The icon in use is asked of the system: the choices start from it. */}
      {appIcon.icon ? <AppIconMaker current={appIcon.icon} set={appIcon.set} /> : null}
    </Page>
  );
}

function AppIconMaker({ current, set }: { current: PhoneIcon; set: (icon: PhoneIcon) => Promise<void> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const lookName = useLookName();
  // What the choices make, and the ready icon shown instead of it while one is picked.
  const [made, setMade] = useState<MadeIcon>(typeof current === "string" ? DEFAULT_MADE_ICON : current);
  const [ready, setReady] = useState<AppIconId | null>(typeof current === "string" ? current : null);
  const [changing, setChanging] = useState(false);
  const shown: PhoneIcon = ready ?? made;
  const name = useAppIconName(shown);
  const inUse = samePhoneIcon(shown, current);
  const face = isMadeIconFace(made.look) ? made.look : "round";
  const accessory = isMadeIconFace(made.look) ? "none" : made.look;

  const make = (patch: Partial<MadeIcon>) => {
    tapHaptic();
    const next = { ...made, ...patch };
    // Leaning, the agent has a face only: picking an accessory stands it up, and leaning takes off what it wears.
    if (next.pose === "peek" && !isMadeIconFace(next.look)) {
      if (patch.pose) next.look = "round";
      else next.pose = "front";
    }
    setMade(next);
    setReady(null);
  };
  const use = () => {
    setChanging(true);
    set(shown)
      .catch(() => toast({ title: t("appIcon.failed"), icon: "x" }))
      .finally(() => setChanging(false));
  };
  const plate = (on: boolean) => [styles.plate, { backgroundColor: c.sunken, borderColor: on ? c.ink : "transparent" }];

  return (
    <>
      <View style={styles.hero}>
        <AppIconPicture icon={shown} size={96} />
        <Text variant="title" style={styles.name}>
          {name}
        </Text>
        <Text variant="footnote" tone="muted">
          {ready
            ? t("appIcon.readyOne")
            : [
                t(appIconNameKey(made.sky)),
                ...(made.pose === "peek" ? [t("appIcon.poses.peek")] : []),
                lookName(made.look),
              ].join(" · ")}
        </Text>
      </View>
      <Button
        variant="primary"
        wide
        label={inUse ? t("appIcon.inUse") : t("appIcon.use")}
        disabled={inUse}
        loading={changing}
        onPress={use}
      />

      <GroupedHeader>{t("appIcon.sky")}</GroupedHeader>
      <GroupedList>
        <View style={styles.skies} accessibilityRole="radiogroup" accessibilityLabel={t("appIcon.sky")}>
          {MADE_ICON_SKIES.map((sky) => {
            const on = !ready && made.sky === sky;
            return (
              <Choice
                key={sky}
                on={on}
                label={t(appIconNameKey(sky))}
                onPress={() => make({ sky })}
                style={styles.half}
              >
                <View style={[plate(on), styles.sky]}>
                  <MadeIconPicture icon={{ ...made, sky }} size={30} />
                  <Text variant="callout">{t(appIconNameKey(sky))}</Text>
                </View>
              </Choice>
            );
          })}
        </View>
      </GroupedList>

      <GroupedHeader>{t("appIcon.pose")}</GroupedHeader>
      <GroupedList>
        <View style={styles.skies} accessibilityRole="radiogroup" accessibilityLabel={t("appIcon.pose")}>
          {MADE_ICON_POSES.map((pose) => {
            const on = !ready && made.pose === pose;
            // The leaning one is shown with a face, as picking it gives.
            const look = pose === "peek" ? face : made.look;
            return (
              <Choice
                key={pose}
                on={on}
                label={t(`appIcon.poses.${pose}`)}
                onPress={() => make({ pose })}
                style={styles.half}
              >
                <View style={[plate(on), styles.sky]}>
                  <MadeIconPicture icon={{ ...made, look, pose }} size={30} />
                  <Text variant="callout">{t(`appIcon.poses.${pose}`)}</Text>
                </View>
              </Choice>
            );
          })}
        </View>
      </GroupedList>
      <GroupedFooter>{t("appIcon.peekBare")}</GroupedFooter>

      <GroupedHeader>{t("look.color")}</GroupedHeader>
      <GroupedList>
        <View style={styles.colors} accessibilityRole="radiogroup" accessibilityLabel={t("look.color")}>
          {MADE_ICON_COLORS.map((color) => {
            const on = !ready && made.color === color;
            return (
              <Choice key={color} on={on} label={t(`look.colors.${color}`)} onPress={() => make({ color })} slop={7}>
                <LinearGradient colors={gradientOf(color)} style={styles.color}>
                  {on ? <Icon name="check" size={16} color="#fff" /> : null}
                </LinearGradient>
              </Choice>
            );
          })}
        </View>
      </GroupedList>

      <GroupedHeader>{t("appIcon.expression")}</GroupedHeader>
      <GroupedList>
        <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel={t("appIcon.expression")}>
          {MADE_ICON_FACES.map((each) => {
            const on = !ready && face === each;
            const agent = agentOf({ ...made, look: each });
            return (
              <Choice
                key={each}
                on={on}
                label={lookName(each)}
                onPress={() => make({ look: each })}
                style={styles.fifth}
              >
                <View style={[plate(on), styles.face]}>
                  <AgentAvatar agent={agent} expression={agent.expression} size={36} framed={false} live={false} />
                </View>
              </Choice>
            );
          })}
        </View>
      </GroupedList>

      <GroupedHeader>{t("look.accessory")}</GroupedHeader>
      <GroupedList>
        <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel={t("look.accessory")}>
          {(["none", ...MADE_ICON_ACCESSORIES] as const).map((each) => {
            const on = !ready && accessory === each;
            return (
              <Choice
                key={each}
                on={on}
                label={t(`look.accessories.${each}`)}
                onPress={() => make({ look: each === "none" ? face : each })}
                style={styles.fourth}
              >
                <View style={[plate(on), styles.wearing]}>
                  <AgentAvatar
                    agent={{ color: made.color, eyes: "round", accessory: each }}
                    size={44}
                    framed={false}
                    live={false}
                  />
                </View>
              </Choice>
            );
          })}
        </View>
      </GroupedList>
      <GroupedFooter>{t("appIcon.oneOrOther")}</GroupedFooter>

      <GroupedHeader>{t("appIcon.ready")}</GroupedHeader>
      <GroupedList>
        <View style={styles.readies} accessibilityRole="radiogroup" accessibilityLabel={t("appIcon.ready")}>
          {/* The one the app ships with first. */}
          {[PHONE_APP_ICON, ...APP_ICONS.filter((x) => x !== PHONE_APP_ICON)].map((id) => {
            const on = ready === id;
            return (
              <Choice
                key={id}
                on={on}
                label={t(appIconNameKey(id))}
                onPress={() => {
                  tapHaptic();
                  setReady(id);
                }}
              >
                <View style={[styles.ready, { borderColor: on ? c.ink : "transparent" }]}>
                  <AppIconPicture icon={id} size={46} />
                </View>
              </Choice>
            );
          })}
        </View>
      </GroupedList>
      {/* iOS confirms with an alert of its own; Android's home screens take their time. */}
      {Platform.OS === "android" ? <GroupedFooter>{t("appIcon.hintAndroid")}</GroupedFooter> : null}
    </>
  );
}

/** One choice among its group's: the design system's press (it gives a little); the pick's own tap is its haptic. */
function Choice({
  on,
  label,
  onPress,
  slop,
  style,
  children,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  slop?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <PressScale
      onPress={onPress}
      haptic={false}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      {...(slop ? { hitSlop: slop } : {})}
      style={style}
      contentStyle={styles.choiceIn}
    >
      {children}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", paddingTop: 14, paddingBottom: 16, gap: 2 },
  name: { marginTop: 12 },
  plate: { borderWidth: 2, alignItems: "center", justifyContent: "center" },
  skies: { flexDirection: "row", gap: 8, padding: 12 },
  half: { flex: 1 },
  sky: {
    alignSelf: "stretch",
    flexDirection: "row",
    justifyContent: "flex-start",
    gap: 10,
    padding: 8,
    borderRadius: 14,
  },
  colors: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
  color: { width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: 10, paddingHorizontal: 8, paddingVertical: 12 },
  fifth: { width: "20%" },
  fourth: { width: "25%" },
  // A choice's mark centered in its share of the row; a plate (`sky`) stretches across it.
  choiceIn: { alignItems: "center" },
  face: { width: 52, height: 52, borderRadius: 16 },
  wearing: { width: 64, height: 64, borderRadius: 20 },
  readies: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 12 },
  ready: { borderWidth: 2, borderRadius: 15, padding: 2 },
});
