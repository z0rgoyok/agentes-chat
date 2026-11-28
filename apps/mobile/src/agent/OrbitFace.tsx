import { ORBIT_LIGHT, ORBIT_RINGS, ORBIT_SPAN, orbitColors, orbitFade, orbitTaper } from "@agenteschat/ui/agent/orbit";
import { Canvas, Circle, Group, Oval, Path, Skia } from "@shopify/react-native-skia";
import { type ReactNode, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useDrawingClock } from "../sky/clock";
import { useLivePaused } from "./live";

type Ring = (typeof ORBIT_RINGS)[number];
type Colors = { rings: readonly [string, string]; head: string };
/** Where in its turn each ring's light and the ring itself start, in seconds. */
type Phase = { light: number; roll: number };

/** Points along each piece of the light: enough for a smooth arc at a face's size. */
const PIECE_POINTS = 4;
const PIECE = (ORBIT_LIGHT.arc / ORBIT_LIGHT.steps) * (Math.PI / 180);

/**
 * Where the light's head is on its ring (radians, in the ring's own frame) at `ms`: its start, then a turn every
 * `turn` seconds, the other way round for a ring that turns back.
 */
function headAngle(ring: Ring, phase: number, ms: number): number {
  "worklet";
  const dir = ring.back ? -1 : 1;
  return (ring.start * Math.PI) / 180 + dir * 2 * Math.PI * ((ms / 1000 + phase) / ring.turn);
}

/** The ring's own angle round the face (radians) at `ms`: its tilt, then a turn every `|spin|` seconds. */
function ringAngle(ring: Ring, roll: number, ms: number): number {
  "worklet";
  return ((ring.tilt + (360 * (ms / 1000 + roll)) / ring.spin) * Math.PI) / 180;
}

/**
 * The group one ring is drawn in: centred in the layer and turned round the face by the shared clock, so both layers
 * turn it as one and its light rides it. `still` rests it at its tilt whatever the clock has reached: Reduce Motion
 * can turn on after the clock ran (the setting resolves after the first frames, or changes while the app is open).
 */
function RingGroup({
  clock,
  ring,
  c,
  roll,
  still,
  children,
}: {
  clock: SharedValue<number>;
  ring: Ring;
  c: number;
  roll: number;
  still: boolean;
  children: ReactNode;
}) {
  const transform = useDerivedValue(() => [
    { translateX: c },
    { translateY: c },
    { rotate: still ? (ring.tilt * Math.PI) / 180 : ringAngle(ring, roll, clock.value) },
  ]);
  return <Group transform={transform}>{children}</Group>;
}

/**
 * One piece of the light on one half of its ring (the far half runs over the top, y < 0): the arc from `step` pieces
 * behind the head to one piece further, only where it is on that half.
 */
function LightPiece({
  clock,
  ring,
  rx,
  phase,
  step,
  back,
  color,
  width,
}: {
  clock: SharedValue<number>;
  ring: Ring;
  rx: number;
  phase: number;
  step: number;
  back: boolean;
  color: string;
  width: number;
}) {
  const ry = rx * ring.flat;
  const path = useDerivedValue(() => {
    // Paths are immutable in this Skia: made with a builder.
    const p = Skia.PathBuilder.Make();
    const dir = ring.back ? -1 : 1;
    const head = headAngle(ring, phase, clock.value);
    let open = false;
    for (let i = 0; i <= PIECE_POINTS; i++) {
      const th = head - dir * (step + i / PIECE_POINTS) * PIECE;
      if (Math.sin(th) < 0 !== back) {
        open = false;
        continue;
      }
      const x = rx * Math.cos(th);
      const y = ry * Math.sin(th);
      if (open) p.lineTo(x, y);
      else p.moveTo(x, y);
      open = true;
    }
    return p.build();
  });
  return (
    <Path
      path={path}
      style="stroke"
      strokeWidth={width * orbitTaper(step)}
      strokeCap={step === 0 ? "round" : "butt"}
      color={color}
      opacity={orbitFade(step)}
    />
  );
}

/** The dot at the light's head, drawn on the half it is on (none on the other). */
function Head({
  clock,
  ring,
  rx,
  phase,
  back,
  r,
  color,
}: {
  clock: SharedValue<number>;
  ring: Ring;
  rx: number;
  phase: number;
  back: boolean;
  r: number;
  color: string;
}) {
  const ry = rx * ring.flat;
  const cx = useDerivedValue(() => rx * Math.cos(headAngle(ring, phase, clock.value)));
  const cy = useDerivedValue(() => ry * Math.sin(headAngle(ring, phase, clock.value)));
  const radius = useDerivedValue(() => (Math.sin(headAngle(ring, phase, clock.value)) < 0 === back ? r : 0));
  return <Circle cx={cx} cy={cy} r={radius} color={color} opacity={back ? 0.7 : 1} />;
}

/**
 * One layer of the orbit: the far one (behind the face) holds both rings whole and the light on their far halves; the
 * near one only the light on their near halves, so the light passes over the face while no line ever crosses it.
 */
function Layer({
  half,
  size,
  clock,
  phases,
  still,
  colors,
  dark,
}: {
  half: "back" | "front";
  size: number;
  clock: SharedValue<number>;
  phases: readonly Phase[];
  still: boolean;
  colors: Colors;
  dark: boolean;
}) {
  const box = size * ORBIT_SPAN;
  const c = box / 2;
  const back = half === "back";
  const width = size > 36 ? 2.6 : 2.2;
  return (
    <Canvas
      pointerEvents="none"
      style={[styles.layer, { width: box, height: box, left: -(box - size) / 2, top: -(box - size) / 2 }]}
    >
      {ORBIT_RINGS.map((ring, i) => {
        const rx = (ring.r * size) / 2;
        const ringColor = colors.rings[i] ?? colors.head;
        return (
          <RingGroup
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of rings
            key={i}
            clock={clock}
            ring={ring}
            c={c}
            roll={phases[i]?.roll ?? 0}
            still={still}
          >
            {back && (
              <Oval
                x={-rx}
                y={-rx * ring.flat}
                width={rx * 2}
                height={rx * 2 * ring.flat}
                style="stroke"
                strokeWidth={size > 36 ? 1.5 : 1.25}
                color={ringColor}
                opacity={dark ? 0.55 : 0.45}
              />
            )}
            {Array.from({ length: ORBIT_LIGHT.steps }, (_, step) => (
              <LightPiece
                // biome-ignore lint/suspicious/noArrayIndexKey: the light's fixed pieces, head first
                key={step}
                clock={clock}
                ring={ring}
                rx={rx}
                phase={phases[i]?.light ?? 0}
                step={step}
                back={back}
                color={step === 0 ? colors.head : ringColor}
                width={width}
              />
            ))}
            <Head
              clock={clock}
              ring={ring}
              rx={rx}
              phase={phases[i]?.light ?? 0}
              back={back}
              r={(ORBIT_LIGHT.dot * size) / 100}
              color={colors.head}
            />
          </RingGroup>
        );
      })}
    </Canvas>
  );
}

/**
 * An agent at work (the web's `OrbitGlyph`): its face with two tilted rings around it, in its own colours, each slowly
 * turning round it. The rings
 * stay behind the face; on each a light runs round, a fading arc with a small dot at its head, over the face on the
 * near half and behind it on the far one. Drawn by Skia on the UI thread from a clock that runs only while it moves:
 * still with Reduce Motion and on a screen that isn't showing (`LivePause`). Each face starts at its own point of the
 * turn. The rings take no room: they reach past the face.
 */
export function OrbitFace({ color, size, children }: { color: string; size: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const dark = useTheme().scheme === "dark";
  const colors = useMemo(() => orbitColors(color, dark), [color, dark]);
  const [phases] = useState(() =>
    ORBIT_RINGS.map((ring) => ({ light: Math.random() * ring.turn, roll: Math.random() * Math.abs(ring.spin) })),
  );
  const clock = useDrawingClock(!reduced && !paused);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Layer half="back" size={size} clock={clock} phases={phases} still={reduced} colors={colors} dark={dark} />
      {children}
      <Layer half="front" size={size} clock={clock} phases={phases} still={reduced} colors={colors} dark={dark} />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute" },
});
