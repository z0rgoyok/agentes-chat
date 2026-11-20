import {
  BODY_CUT,
  BODY_RADIUS,
  drawAgent,
  drawEyes,
  EYE_COLOR,
  eyeShapes,
  spriteGrid,
} from "@agenteschat/ui/agent/engine";
import {
  Canvas,
  createPicture,
  Fill,
  Group,
  Path,
  Picture,
  Shader,
  Skia,
  type SkPath,
  type SkPicture,
  useClock,
  usePathValue,
} from "@shopify/react-native-skia";
import { useNetworkState } from "expo-network";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { frameClock } from "@/agent/clock";
import { useFrameTime } from "@/agent/live";
import { asCtx, compile, RecordingContext, rectsToSvg } from "@/agent/recorder";
import { replay } from "@/agent/skia-ctx";
import { effectOf } from "@/sky/Dither";
import { paletteUniform } from "@/sky/math";
import { Text } from "@/ui";
import { fonts, useReducedMotion, useTheme } from "@/ui/theme";
import { markRevealed } from "./launched";
import {
  DIVE,
  DIVE_TOTAL,
  diveBody,
  diveEyes,
  diveName,
  diveScale,
  diveZoom,
  LAUNCH,
  LOGO,
  LOGO_LOOK,
  launchesAtOnce,
  launchPose,
  launchSkyTones,
  SPRITE_BODY,
  SPRITES,
  spriteBlinks,
  spriteY,
  waitLine,
} from "./logic";

/** The agent's canvas: room around the body for the turn and the breath. */
const BOX = Math.ceil(LOGO * 1.5);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const PAD = (BOX - LOGO) / 2;
/** Points per sky cell (the sprites stand on the same grid). */
const PX = 4;
const SPRITE_CELLS = 9;

export interface LaunchSplashProps {
  /** The session and the organization are known: it may leave (after its minimum). */
  ready: boolean;
  /** The brand fonts are in (the name waits for them). */
  fontsReady: boolean;
  /** Its first frame is up: the native launch image can go (they look the same). */
  onShown: () => void;
  /** It is gone. */
  onDone: () => void;
  /**
   * What it waits on when the person can act on it (a server that doesn't answer: the reason and its buttons).
   * The agent goes up, the sky with it, and this comes in at the bottom; the splash still leaves once ready.
   */
  waiting?: ReactNode;
  /** The agent's eyes closed (nothing is happening; open while it checks again). */
  eyesClosed?: boolean;
  /** The sky at dusk: the app waits on a team's own server, not the Cloud (its sky says which fell silent). */
  dusk?: boolean;
}

/**
 * Opening the app. It starts exactly on the native launch image (the logo
 * agent centered, 120 pt image), then the pixel sky rises from the bottom with little agents going up in it,
 * the agent lifts and looks at them, and the name comes in. Once the app is ready (at once when it was within the
 * splash's first frames, else after at least 0.9 s) it dives into the app (`DIVE`): the sky takes the screen, the
 * agent draws in, and its body becomes a window onto the app already drawn under the splash, growing faster and
 * faster until it covers the screen. Slow: one
 * line says it's connecting; no network: one line says so. Waiting on the person (`waiting`: a server that
 * doesn't answer) the agent goes up and closes its eyes, the sprites keep above the panel that comes in at the
 * bottom, and the splash stays until the app is ready. Reduced motion: the logo still, a short fade.
 */
export function LaunchSplash({
  ready,
  fontsReady,
  onShown,
  onDone,
  waiting,
  eyesClosed,
  dusk = false,
}: LaunchSplashProps) {
  const { t } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;

  // Its own timers (the agents' clock can start paused): the minimum, and when to say why it waits.
  const [played, setPlayed] = useState(reduced);
  const [late, setLate] = useState(false);
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    const min = setTimeout(() => setPlayed(true), LAUNCH.min * 1000);
    const why = setTimeout(() => setLate(true), LAUNCH.lineAfter * 1000);
    return () => {
      clearTimeout(min);
      clearTimeout(why);
    };
  }, []);
  // Once it starts leaving it goes, whatever happens next. Ready within its first frames (the session and the workspace
  // kept from last time), it leaves at once; later, its rise is under way and plays its minimum.
  const [leaving, setLeaving] = useState(false);
  // Where the agent's choreography stops while it leaves (its last pose, smiling).
  const [heldAt, setHeldAt] = useState(0);
  useEffect(() => {
    if (leaving || !ready) return;
    if (!played && !launchesAtOnce(Date.now() - startedAt)) return;
    setHeldAt(frameClock.time());
    setLeaving(true);
  }, [ready, played, leaving, startedAt]);
  const asking = Boolean(waiting) && !leaving;
  const line = leaving || asking ? null : waitLine(late, offline);

  const level = useSharedValue(0);
  const lift = useSharedValue(0);
  const name = useSharedValue(0);
  const lineIn = useSharedValue(0);
  const shown = useSharedValue(1);
  // The dive's clock (seconds since it left) and whether it dives (0/1): one clock drives the window, the agent and
  // the fades on the UI thread.
  const dive = useSharedValue(0);
  const diving = useSharedValue(0);
  // Waiting on the person: the agent up (0 → 1), the panel in, and where the sprites start (above the panel).
  const up = useSharedValue(0);
  const floor = useSharedValue(0.95);
  const [panelTop, setPanelTop] = useState<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    const rise = { duration: LAUNCH.rise * 1000, easing: Easing.out(Easing.cubic) };
    level.value = withTiming(LAUNCH.sky, rise);
    lift.value = withTiming(1, rise);
    name.value = withDelay(LAUNCH.nameAt * 1000, withTiming(1, { duration: 350 }));
  }, [reduced, level, lift, name]);

  useEffect(() => {
    lineIn.value = withTiming(line ? 1 : 0, { duration: 300 });
  }, [line, lineIn]);

  // Only once it has waited on the person: an ordinary launch keeps its own rise.
  const asked = useRef(false);
  useEffect(() => {
    if (leaving || (!asking && !asked.current)) return;
    asked.current = asking;
    const move = { duration: reduced ? 0 : 450, easing: Easing.inOut(Easing.cubic) };
    up.value = withTiming(asking ? 1 : 0, move);
    if (!reduced) level.value = withTiming(asking ? LAUNCH.waitingSky : LAUNCH.sky, move);
    // The sprites rise from just above the panel (a sprite's height and a little more), so none crosses its text.
    const above = panelTop === null ? 0.95 : (panelTop - SPRITE_CELLS * PX - 12) / height;
    floor.value = withTiming(asking ? Math.min(0.95, above) : 0.95, move);
  }, [asking, leaving, reduced, panelTop, height, up, level, floor]);

  const done = useRef(onDone);
  done.current = onDone;
  const finish = useCallback(() => done.current(), []);
  useEffect(() => {
    if (!leaving) return;
    const end = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(finish);
    };
    if (reduced) {
      shown.value = withTiming(0, { duration: LAUNCH.reducedExit * 1000 }, end);
      return;
    }
    // The handover into the app, one gesture on the UI thread (`DIVE`): the sky takes the screen, the agent draws in,
    // and its body becomes a window onto the app under the splash, growing until it covers the screen. The app is in
    // view from here: its first screen arrives as the window grows.
    markRevealed();
    level.value = withTiming(DIVE.floodLevel, { duration: DIVE.flood * 1000, easing: EASE_OUT });
    diving.value = 1;
    dive.value = withTiming(DIVE_TOTAL, { duration: DIVE_TOTAL * 1000, easing: Easing.linear }, end);
  }, [leaving, reduced, level, shown, dive, diving, finish]);

  // The native image goes once this first frame is laid out (it looks the same).
  const shownOnce = useRef(false);
  const onLayout = () => {
    if (shownOnce.current) return;
    shownOnce.current = true;
    requestAnimationFrame(onShown);
  };

  // The agent: drawn by the shared engine ~25 times a second, its pose from the choreography. Leaving, nothing here
  // is drawn again (the dive is on the UI thread): the JS thread is the app's, arriving under it.
  const now = useFrameTime(!reduced && !leaving, heldAt);
  const [t0] = useState(() => frameClock.time());
  const a = reduced ? 0 : Math.max(0, now - t0);
  const picture = useMemo(() => {
    const rec = new RecordingContext();
    drawAgent(asCtx(rec), PAD, PAD, LOGO, {
      color: LOGO_LOOK.color,
      eyes: LOGO_LOOK.eyes,
      pose: reduced ? {} : launchPose(a, { offline: offline || Boolean(eyesClosed), leaving }),
    });
    const ops = compile(rec.commands);
    return createPicture((canvas) => replay(canvas, ops), { width: BOX, height: BOX });
  }, [a, offline, eyesClosed, leaving, reduced]);

  // Diving: the body (no eyes) and the eyes apart, facing front and smiling, so each lets go on its own. Drawn by
  // the sky's canvas, sharp at any size.
  const divers = useMemo(() => {
    if (!leaving || reduced) return null;
    const pose = { turn: [0, 0] as [number, number], expression: "happy" as const };
    const record = (draw: (rec: RecordingContext) => void) => {
      const rec = new RecordingContext();
      draw(rec);
      const ops = compile(rec.commands);
      return createPicture((canvas) => replay(canvas, ops), { width: BOX, height: BOX });
    };
    return {
      body: record((rec) =>
        drawAgent(asCtx(rec), PAD, PAD, LOGO, { color: LOGO_LOOK.color, eyes: LOGO_LOOK.eyes, pose, withEyes: false }),
      ),
      eyes: record((rec) => drawEyes(asCtx(rec), PAD, PAD, LOGO, eyeShapes(LOGO_LOOK.eyes, pose), EYE_COLOR)),
    };
  }, [leaving, reduced]);

  const overlay = useAnimatedStyle(() => ({ opacity: shown.value }));
  // The splash's own ground until the dive opens its window: the sky's canvas paints over it from its first frame and
  // carries the ground (with the window cut out of it) from there.
  const ground = useAnimatedStyle(() => ({ opacity: diving.value && dive.value >= DIVE.at ? 0 : 1 }));
  const raise = height * (0.5 - LAUNCH.waitingAgent);
  const mark = useAnimatedStyle(() => ({
    transform: [{ translateY: -LAUNCH.lift * lift.value - raise * up.value }],
  }));
  // The agent here steps aside on the dive's first frame, for the one the sky's canvas draws diving.
  const agentStyle = useAnimatedStyle(() => ({ opacity: diving.value && dive.value > 0 ? 0 : 1 }));
  const panelStyle = useAnimatedStyle(() => ({ opacity: up.value * (diving.value ? diveName(dive.value) : 1) }));
  const nameStyle = useAnimatedStyle(() => ({ opacity: name.value * (diving.value ? diveName(dive.value) : 1) }));
  const lineStyle = useAnimatedStyle(() => ({ opacity: lineIn.value }));
  const tones = useMemo(() => launchSkyTones(c.bg, scheme === "dark", dusk), [c.bg, scheme, dusk]);
  const lineText = line ? t(`mobile.splash.${line}`) : "";

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, overlay]}
      pointerEvents={leaving ? "none" : "auto"}
      onLayout={onLayout}
      // One element for screen readers, except while it waits on the person: then its buttons are reachable.
      accessible={!asking}
      accessibilityLabel={lineText ? `Tich Rooms. ${lineText}` : "Tich Rooms"}
      accessibilityLiveRegion="polite"
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }, ground]} />
      {reduced ? null : (
        <LaunchSky
          width={width}
          height={height}
          level={level}
          floor={floor}
          tones={tones}
          lift={lift}
          up={up}
          raise={raise}
          dive={dive}
          diving={diving}
          divers={divers}
        />
      )}
      <Animated.View
        style={[styles.mark, { left: width / 2 - BOX / 2, top: height / 2 - BOX / 2 }, mark]}
        pointerEvents="none"
      >
        <Animated.View style={[styles.agent, agentStyle]}>
          <Canvas style={styles.agent}>
            <Picture picture={picture} />
          </Canvas>
        </Animated.View>
        {fontsReady ? (
          <Animated.View style={[styles.name, reduced ? styles.still : nameStyle]}>
            <RNText allowFontScaling={false} style={[styles.word, { color: c.ink }]}>
              Tich Rooms
            </RNText>
          </Animated.View>
        ) : null}
        <Animated.View style={[styles.line, lineStyle]}>
          <Text variant="callout" tone="muted" style={styles.center}>
            {lineText}
          </Text>
        </Animated.View>
      </Animated.View>
      {waiting ? (
        <Animated.View
          style={[styles.panel, { paddingBottom: insets.bottom + 24 }, panelStyle]}
          pointerEvents={asking ? "auto" : "none"}
        >
          <View onLayout={(e) => setPanelTop(height - insets.bottom - 24 - e.nativeEvent.layout.height)}>
            {waiting}
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/**
 * The sky rising to `level`, and the little agents going up in it (all on the UI thread; memo: the agent's
 * frames above don't touch it). Diving (`DIVE`), it is the splash's whole ground with the agent's body cut out as
 * the window onto the app, the camera taking it a little way, and it draws the diving agent over it.
 */
const LaunchSky = memo(function LaunchSky({
  width,
  height,
  level,
  floor,
  tones,
  lift,
  up,
  raise,
  dive,
  diving,
  divers,
}: {
  width: number;
  height: number;
  level: SharedValue<number>;
  /** Where the sprites start rising (`spriteY`'s bottom). */
  floor: SharedValue<number>;
  tones: string[];
  /** Where the agent stands (the splash's `mark`): the window opens there. */
  lift: SharedValue<number>;
  up: SharedValue<number>;
  raise: number;
  dive: SharedValue<number>;
  diving: SharedValue<number>;
  divers: { body: SkPicture; eyes: SkPicture } | null;
}) {
  const effect = effectOf("horizon");
  const clock = useClock();
  const { pal, last } = useMemo(() => paletteUniform(tones), [tones]);
  const uniforms = useDerivedValue(() => ({
    size: [width, height],
    px: PX,
    t: clock.value / 1000,
    last,
    fade: 2,
    // Every uniform of the shared sky shader must be given (Skia throws on a missing one): no fade in from the top.
    fadeTop: 0,
    clear: 0,
    pal,
    level: level.value,
  }));
  const paths = useMemo(() => {
    const grid = spriteGrid(SPRITE_CELLS);
    const cells = (ch: string) =>
      grid.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === ch ? [x * PX, y * PX, PX, PX] : [])));
    return {
      body: Skia.Path.MakeFromSVGString(rectsToSvg(cells("X"))),
      eyes: Skia.Path.MakeFromSVGString(rectsToSvg(cells("o"))),
    };
  }, []);
  // The window: the agent's body (three round corners and the cut one) at the dive's size, where the agent stands.
  // Empty before the dive, so nothing is cut.
  const opening = usePathValue((path) => {
    "worklet";
    if (!diving.value) return;
    const size = LOGO * diveScale(dive.value);
    const cy = height / 2 - LAUNCH.lift * lift.value - raise * up.value;
    const r = size * BODY_RADIUS;
    const cut = size * BODY_CUT;
    path.addRRect({
      rect: { x: width / 2 - size / 2, y: cy - size / 2, width: size, height: size },
      topLeft: { x: r, y: r },
      topRight: { x: r, y: r },
      bottomRight: { x: r, y: r },
      bottomLeft: { x: cut, y: cut },
    });
  });
  const camera = useDerivedValue(() => {
    const k = diving.value ? 1 + (DIVE.camera - 1) * diveZoom(dive.value) : 1;
    const cy = height / 2 - LAUNCH.lift * lift.value - raise * up.value;
    return [
      { translateX: width / 2 },
      { translateY: cy },
      { scale: k },
      { translateX: -width / 2 },
      { translateY: -cy },
    ];
  });
  const agent = useDerivedValue(() => {
    const k = diving.value ? diveScale(dive.value) : 1;
    const cy = height / 2 - LAUNCH.lift * lift.value - raise * up.value;
    return [
      { translateX: width / 2 },
      { translateY: cy },
      { scale: k },
      { translateX: -BOX / 2 },
      { translateY: -BOX / 2 },
    ];
  });
  const bodyShown = useDerivedValue(() => (diving.value && dive.value > 0 ? diveBody(dive.value) : 0));
  const eyesShown = useDerivedValue(() => (diving.value && dive.value > 0 ? diveEyes(dive.value) : 0));
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Group clip={opening} invertClip>
        <Group transform={camera}>
          {effect ? (
            <Fill>
              <Shader source={effect} uniforms={uniforms} />
            </Fill>
          ) : (
            <Fill color={tones[0]} />
          )}
          {effect && paths.body && paths.eyes
            ? SPRITES.map((sprite) => (
                <Sprite
                  key={sprite.x}
                  sprite={sprite}
                  clock={clock}
                  level={level}
                  floor={floor}
                  width={width}
                  height={height}
                  body={paths.body as SkPath}
                  eyes={paths.eyes as SkPath}
                />
              ))
            : null}
        </Group>
      </Group>
      {divers ? (
        <Group transform={agent}>
          <Group opacity={bodyShown}>
            <Picture picture={divers.body} />
          </Group>
          <Group opacity={eyesShown}>
            <Picture picture={divers.eyes} />
          </Group>
        </Group>
      ) : null}
    </Canvas>
  );
});

function Sprite({
  sprite,
  clock,
  level,
  floor,
  width,
  height,
  body,
  eyes,
}: {
  sprite: (typeof SPRITES)[number];
  clock: SharedValue<number>;
  level: SharedValue<number>;
  floor: SharedValue<number>;
  width: number;
  height: number;
  body: SkPath;
  eyes: SkPath;
}) {
  // On the sky's grid, like the prototype's sprites.
  const x = Math.round((sprite.x * (width - SPRITE_CELLS * PX)) / PX) * PX;
  const transform = useDerivedValue(() => {
    const y = spriteY(sprite, clock.value / 1000, level.value, floor.value);
    return [{ translateX: x }, { translateY: y === null ? -100 : Math.round((y * height) / PX) * PX }];
  });
  const opacity = useDerivedValue(() =>
    spriteY(sprite, clock.value / 1000, level.value, floor.value) === null ? 0 : 1,
  );
  const eyeColor = useDerivedValue(() => (spriteBlinks(sprite, clock.value / 1000) ? SPRITE_BODY : "#ffffff"));
  return (
    <Group transform={transform} opacity={opacity}>
      <Path path={body} color={SPRITE_BODY} />
      <Path path={eyes} color={eyeColor} />
    </Group>
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute", width: BOX, height: BOX },
  agent: { width: BOX, height: BOX },
  // Under the body (the canvas has room around it), centered on the agent.
  name: { position: "absolute", top: PAD + LOGO + 18, left: BOX / 2 - 160, width: 320, alignItems: "center" },
  word: { fontFamily: fonts.display, fontSize: 30, lineHeight: 38 },
  dot: { fontFamily: fonts.dot, fontSize: 27 },
  line: { position: "absolute", top: PAD + LOGO + 64, left: BOX / 2 - 160, width: 320, alignItems: "center" },
  center: { textAlign: "center" },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 24 },
  still: { opacity: 1 },
});
