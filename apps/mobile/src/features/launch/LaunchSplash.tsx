import { bodyTones, drawAgent, type Pose, spriteGrid } from "@agenteschat/ui/agent/engine";
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
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSequence,
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
  burstCells,
  burstDrift,
  EXIT,
  EXIT_TOTAL,
  GATHER_FRAMES,
  gatherFrame,
  gatherPose,
  LAUNCH,
  LOGO,
  LOGO_LOOK,
  launchesAtOnce,
  launchPose,
  launchSkyTones,
  nameUnderRing,
  OPENING_END,
  OPENING_FPS,
  OPENING_FRAMES,
  openingFrame,
  panelOut,
  ringRadius,
  ringTones,
  SPRITE_BODY,
  SPRITES,
  spriteBlinks,
  spriteY,
  waitLine,
} from "./logic";
import { ringEffect } from "./ring";

/** The agent's canvas: room around the body for the turn and the breath. */
const BOX = Math.ceil(LOGO * 1.5);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const PAD = (BOX - LOGO) / 2;
/** Points per sky cell (the sprites, the ring and the agent's pixels stand on the same grid). */
const PX = 4;
const SPRITE_CELLS = 9;
/** The agent's pixels as it comes apart, and their tones (the same every launch). */
const BURST = burstCells();
const BURST_TONES = bodyTones(LOGO_LOOK.color);

/**
 * The app under the splash settles from a little larger as the ring opens it (`EXIT.appFrom`): the root's scale,
 * read by `useLaunchSettle` around the navigator.
 */
const settle = makeMutable(1);

/** The style the app's root takes for that (`settle`): a scale of 1 except while the splash leaves. */
export function useLaunchSettle() {
  return useAnimatedStyle(() => ({ transform: [{ scale: settle.value }] }));
}

/** The logo agent in `pose`, drawn once by the shared engine. */
function agentPicture(pose: Pose): SkPicture {
  const rec = new RecordingContext();
  drawAgent(asCtx(rec), PAD, PAD, LOGO, { color: LOGO_LOOK.color, eyes: LOGO_LOOK.eyes, pose });
  const ops = compile(rec.commands);
  return createPicture((canvas) => replay(canvas, ops), { width: BOX, height: BOX });
}

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
 * Opening the app. It starts exactly on the native launch image (the logo agent centered, 120 pt image), then the
 * pixel sky rises from the bottom with little agents going up in it, the agent lifts and looks at them, and the
 * name comes in. The agent's opening is drawn ahead and shown by the UI thread (`OPENING_FPS`), so it moves
 * smoothly while the app loads under it. Once the app is ready (at once when it was within the splash's first frames,
 * else after at least `LAUNCH.min`) it leaves (`EXIT`): the agent faces front, smiles and squashes, then comes apart
 * into its own pixels while a ring of pixel sky goes out from it past every corner, the splash outside it and the app
 * inside, settling from a little larger. Slow: one line says it's connecting; no network: one line says so. Waiting
 * on the person (`waiting`: a server that doesn't answer) the agent goes up and closes its eyes, the sprites keep
 * above the panel that comes in at the bottom, and the splash stays until the app is ready. Reduced motion: the logo
 * still, a short fade.
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
  const ring = reduced ? null : ringEffect();

  // Its own timers (the agents' clock can start paused): the minimum, the end of the drawn opening, and when to say
  // why it waits.
  const [played, setPlayed] = useState(reduced);
  const [idling, setIdling] = useState(false);
  const [late, setLate] = useState(false);
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    const min = setTimeout(() => setPlayed(true), LAUNCH.min * 1000);
    const idle = setTimeout(() => setIdling(true), OPENING_END * 1000);
    const why = setTimeout(() => setLate(true), LAUNCH.lineAfter * 1000);
    return () => {
      clearTimeout(min);
      clearTimeout(idle);
      clearTimeout(why);
    };
  }, []);
  // Once it starts leaving it goes, whatever happens next. Ready within its first frames (the session and the workspace
  // kept from last time), it leaves at once; later, its rise is under way and plays its minimum.
  const [leaving, setLeaving] = useState(false);
  // Where the agent's choreography stops as it leaves (the pose it gathers itself from).
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
  // The exit's clock (seconds since it left) and whether it plays (0/1): one clock drives the agent, its pixels, the
  // ring and the fades on the UI thread.
  const exit = useSharedValue(0);
  const exiting = useSharedValue(0);
  // Waiting on the person: the agent up (0 → 1), the panel in, and where the sprites start (above the panel).
  const up = useSharedValue(0);
  const floor = useSharedValue(0.95);
  const [panelTop, setPanelTop] = useState<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    const rise = { duration: LAUNCH.rise * 1000, easing: Easing.out(Easing.cubic) };
    level.value = withTiming(LAUNCH.sky, rise);
    lift.value = withTiming(1, rise);
    name.value = withDelay(LAUNCH.nameAt * 1000, withTiming(1, { duration: LAUNCH.nameIn * 1000 }));
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

  // The agent's opening, drawn ahead a few frames at a time (the first now: the native image's twin), and shown by
  // the UI thread on its own clock.
  const [first] = useState(() => agentPicture(reduced ? {} : launchPose(0)));
  const frames = useSharedValue<SkPicture[]>([first]);
  useEffect(() => {
    if (reduced) return;
    const list = [first];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      for (let n = 0; n < 3 && list.length < OPENING_FRAMES; n++)
        list.push(agentPicture(launchPose(list.length / OPENING_FPS)));
      frames.value = [...list];
      timer = list.length < OPENING_FRAMES ? setTimeout(step, 0) : null;
    };
    timer = setTimeout(step, 0);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [reduced, first, frames]);

  // Past the opening, while it still waits (a slow network, a server that doesn't answer), the agent idles, drawn as
  // it goes: the app has nothing to load on the JS thread then.
  const now = useFrameTime(!reduced && idling && !leaving, heldAt);
  const [t0] = useState(() => frameClock.time());
  const idlePicture = useMemo(
    () =>
      idling && !reduced
        ? agentPicture(launchPose(Math.max(OPENING_END, now - t0), { offline: offline || Boolean(eyesClosed) }))
        : null,
    [idling, reduced, now, t0, offline, eyesClosed],
  );
  const idle = useSharedValue<SkPicture | null>(null);
  useEffect(() => {
    idle.value = idlePicture;
  }, [idlePicture, idle]);
  const gather = useSharedValue<SkPicture[]>([]);

  const done = useRef(onDone);
  done.current = onDone;
  const finish = useCallback(() => done.current(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it leaves once, from the pose it had then
  useEffect(() => {
    if (!leaving) return;
    const end = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(finish);
    };
    if (reduced || !ring) {
      shown.value = withTiming(0, { duration: LAUNCH.reducedExit * 1000 }, end);
      return;
    }
    // The handover into the app, one gesture on the UI thread (`EXIT`): the agent gathers itself from the pose it
    // was in, then comes apart as the ring opens the app. The app is in view from here.
    const held = launchPose(Math.max(0, heldAt - t0), { offline: offline || Boolean(eyesClosed) });
    gather.value = Array.from({ length: GATHER_FRAMES }, (_, j) => agentPicture(gatherPose(held, j)));
    markRevealed();
    settle.value = withSequence(
      withTiming(EXIT.appFrom, { duration: 0 }),
      withDelay(EXIT.gather * 1000, withTiming(1, { duration: EXIT.wave * 1000, easing: EASE_OUT })),
    );
    exiting.value = 1;
    exit.value = withTiming(EXIT_TOTAL, { duration: EXIT_TOTAL * 1000, easing: Easing.linear }, end);
    // Settled at the end whatever happens to the splash after.
    return () => {
      settle.value = 1;
    };
  }, [leaving]);

  // The native image goes once this first frame is laid out (it looks the same).
  const shownOnce = useRef(false);
  const onLayout = () => {
    if (shownOnce.current) return;
    shownOnce.current = true;
    requestAnimationFrame(onShown);
  };

  const raise = height * (0.5 - LAUNCH.waitingAgent);
  // Where the agent stands (its center), and the ring's edge from there.
  const agentY = useDerivedValue(() => height / 2 - LAUNCH.lift * lift.value - raise * up.value);
  const ringEdge = useDerivedValue(() => (exiting.value ? ringRadius(exit.value, agentY.value, width, height) : 0));
  const clock = useClock();
  const agentNow = useDerivedValue(() => {
    if (exiting.value) {
      const g = gather.value;
      if (g.length > 0) return g[gatherFrame(exit.value)] as SkPicture;
    }
    const list = frames.value;
    const i = openingFrame(clock.value / 1000, list.length);
    if (i >= 0) return list[i] as SkPicture;
    return idle.value ?? (list[list.length - 1] as SkPicture);
  });

  const overlay = useAnimatedStyle(() => ({ opacity: shown.value }));
  // The splash's own ground until the ring starts: the sky's canvas paints the whole screen (its top is this ground's
  // tone) and is cut by the ring from there.
  const ground = useAnimatedStyle(() => ({ opacity: exiting.value && exit.value >= EXIT.gather ? 0 : 1 }));
  const mark = useAnimatedStyle(() => ({
    transform: [{ translateY: -LAUNCH.lift * lift.value - raise * up.value }],
  }));
  // The agent here gives way to its pixels (drawn over the ring) once it has gathered itself.
  const agentStyle = useAnimatedStyle(() => ({ opacity: exiting.value && exit.value >= EXIT.gather ? 0 : 1 }));
  const panelStyle = useAnimatedStyle(() => ({ opacity: up.value * (exiting.value ? panelOut(exit.value) : 1) }));
  const under = (v: number) => {
    "worklet";
    return v * (exiting.value ? nameUnderRing(ringEdge.value) : 1);
  };
  const nameStyle = useAnimatedStyle(() => ({ opacity: under(name.value) }));
  const lineStyle = useAnimatedStyle(() => ({ opacity: under(lineIn.value) }));
  const tones = useMemo(() => launchSkyTones(c.bg, scheme === "dark", dusk), [c.bg, scheme, dusk]);
  const ringPal = useMemo(
    () => paletteUniform(ringTones(c.bg, scheme === "dark", dusk)).pal.slice(0, 16),
    [c.bg, scheme, dusk],
  );
  const lineText = line ? t(`mobile.splash.${line}`) : "";
  const cutting = leaving && ring !== null;

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
          ring={cutting ? ring : null}
          ringPal={ringPal}
          ringEdge={ringEdge}
          agentY={agentY}
        />
      )}
      <Animated.View
        style={[styles.mark, { left: width / 2 - BOX / 2, top: height / 2 - BOX / 2 }, mark]}
        pointerEvents="none"
      >
        <Animated.View style={[styles.agent, agentStyle]}>
          <Canvas style={styles.agent}>
            <Picture picture={agentNow} />
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
      {cutting && ring ? (
        <RingFront
          width={width}
          height={height}
          ring={ring}
          ringPal={ringPal}
          ringEdge={ringEdge}
          agentY={agentY}
          exit={exit}
          exiting={exiting}
        />
      ) : null}
    </Animated.View>
  );
}

/** The ring shader's uniforms: the agent's center, the ring's edge, what it draws (0: what it clears, 1: its band). */
function useRingUniforms(
  width: number,
  ringPal: number[],
  ringEdge: SharedValue<number>,
  agentY: SharedValue<number>,
  mode: 0 | 1,
) {
  return useDerivedValue(() => ({
    center: [width / 2, agentY.value],
    r: ringEdge.value,
    band: EXIT.band,
    px: PX,
    mode,
    pal: ringPal,
  }));
}

/**
 * The sky rising to `level`, and the little agents going up in it (all on the UI thread; memo: the agent's frames
 * don't touch it). Leaving (`ring`), the ring cuts it: inside the ring the app under the splash shows.
 */
const LaunchSky = memo(function LaunchSky({
  width,
  height,
  level,
  floor,
  tones,
  ring,
  ringPal,
  ringEdge,
  agentY,
}: {
  width: number;
  height: number;
  level: SharedValue<number>;
  /** Where the sprites start rising (`spriteY`'s bottom). */
  floor: SharedValue<number>;
  tones: string[];
  ring: ReturnType<typeof ringEffect>;
  ringPal: number[];
  ringEdge: SharedValue<number>;
  agentY: SharedValue<number>;
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
  const cut = useRingUniforms(width, ringPal, ringEdge, agentY, 0);
  const paths = useMemo(() => {
    const grid = spriteGrid(SPRITE_CELLS);
    const cells = (ch: string) =>
      grid.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === ch ? [x * PX, y * PX, PX, PX] : [])));
    return {
      body: Skia.Path.MakeFromSVGString(rectsToSvg(cells("X"))),
      eyes: Skia.Path.MakeFromSVGString(rectsToSvg(cells("o"))),
    };
  }, []);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Its own layer, so the ring takes out the splash alone. */}
      <Group layer={ring !== null}>
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
        {ring ? (
          <Fill blendMode="dstOut">
            <Shader source={ring} uniforms={cut} />
          </Fill>
        ) : null}
      </Group>
    </Canvas>
  );
});

/**
 * Over the splash as it leaves: the ring's band of pixel sky, and the agent's pixels drifting apart (one path a tone,
 * on the sky's grid). Over the name too, which goes under the band.
 */
function RingFront({
  width,
  height,
  ring,
  ringPal,
  ringEdge,
  agentY,
  exit,
  exiting,
}: {
  width: number;
  height: number;
  ring: NonNullable<ReturnType<typeof ringEffect>>;
  ringPal: number[];
  ringEdge: SharedValue<number>;
  agentY: SharedValue<number>;
  exit: SharedValue<number>;
  exiting: SharedValue<number>;
}) {
  const band = useRingUniforms(width, ringPal, ringEdge, agentY, 1);
  return (
    <Canvas style={[StyleSheet.absoluteFill, { width, height }]} pointerEvents="none">
      <Fill>
        <Shader source={ring} uniforms={band} />
      </Fill>
      {BURST_TONES.map((color, tone) => (
        <BurstTone key={color} tone={tone} color={color} width={width} agentY={agentY} exit={exit} exiting={exiting} />
      ))}
    </Canvas>
  );
}

/** The agent's pixels of one tone, where they have drifted to `exit` seconds after it left. */
function BurstTone({
  tone,
  color,
  width,
  agentY,
  exit,
  exiting,
}: {
  tone: number;
  color: string;
  width: number;
  agentY: SharedValue<number>;
  exit: SharedValue<number>;
  exiting: SharedValue<number>;
}) {
  const path = usePathValue((p) => {
    "worklet";
    const k = exit.value - EXIT.gather;
    if (!exiting.value || k < 0 || k > EXIT.burst) return;
    const cx = width / 2;
    const cy = agentY.value;
    for (const cell of BURST) {
      if (cell.tone !== tone) continue;
      const drift = burstDrift(cell, k);
      if (drift === null) continue;
      const x = Math.round((cx + cell.dx * drift) / PX) * PX;
      const y = Math.round((cy + cell.dy * drift) / PX) * PX;
      p.addRect({ x: x - PX / 2, y: y - PX / 2, width: PX, height: PX });
    }
  });
  return <Path path={path} color={color} />;
}

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
