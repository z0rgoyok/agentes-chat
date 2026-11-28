import {
  bodyTones,
  drawAccessory,
  drawAgent,
  drawnKey,
  drawSleep,
  type Expression,
  EYE_COLOR,
} from "@agenteschat/ui/agent/engine";
import { avatarSkyCell, avatarSkyCells, avatarSkyTones } from "@agenteschat/ui/sky/avatar";
import { Canvas, createPicture, Picture, type SkPicture } from "@shopify/react-native-skia";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PixelRatio, StyleSheet, View } from "react-native";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useFrameTime } from "./live";
import type { AgentLookInput } from "./looks";
import { type AgentMode, agentLayout, framedByDefault, framedLayout, poseFor, STILL_T, seedOf } from "./poses";
import { asCtx, compile, RecordingContext } from "./recorder";
import { replay } from "./skia-ctx";

export interface AgentAvatarProps {
  agent: AgentLookInput;
  /** Box size in points (the body sits at the bottom; room above for an accessory). */
  size: number;
  mode?: AgentMode;
  /** false: one still frame (use it in long lists). Default true. */
  live?: boolean;
  /** The agent's name, for screen readers. */
  name?: string;
  /**
   * The agent standing in its own pixel sky, in a rounded tile (like the web's framed avatar). Default:
   * framed from 20 to 63pt; the tiny faces and the big hero stand on their own.
   */
  framed?: boolean;
  /** Holds one face (the sign-in screens: eyes shut while a password is typed); writing still wins. */
  expression?: Expression;
  /**
   * Where it looks for a moment, up or down the screen (at a field being typed in, at a newcomer's row): the eyes and
   * the head turn that way and hold, instead of wandering.
   */
  gaze?: Gaze;
  /** Only its sky, no body (framed only): out on a routine, it comes back into the frame when the run ends. */
  bodyless?: boolean;
  /** The tile's corner (framed only). Default 30% of the side; `size / 2` inside a fully round pill. */
  radius?: number;
}

/** Up or down the screen. */
export type Gaze = "up" | "down";

/** The eyes and the head turned toward `gaze` (fractions of the body, as the engine's `look` and `turn`). */
const GAZE: Record<Gaze, { look: [number, number]; turn: [number, number] }> = {
  up: { look: [0, -0.14], turn: [0, -0.35] },
  down: { look: [0, 0.14], turn: [0, 0.35] },
};

/**
 * One frame of an agent as drawing commands (the engine draws, the recorder keeps the commands). `extra.px`: screen
 * pixels per unit of `size` (the screen's scale when `size` is in points). The engine's thinnest line, its pixel
 * snapping and its overlaps are in canvas pixels, as on the web's canvas, so it draws at that scale: in points, the
 * eyes' 1.4 floor came out three times as thick, and on a 13pt face the two arcs of happy or closed eyes met in one bar.
 */
export function agentFrame(
  agent: AgentLookInput,
  size: number,
  mode: AgentMode,
  t: number,
  seed: number,
  reduced: boolean,
  frame?: { dark: boolean },
  expression?: Expression,
  dark = frame?.dark ?? false,
  extra?: { gaze?: Gaze | undefined; bodyless?: boolean | undefined; sky?: boolean | undefined; px?: number },
) {
  const accessory = agent.accessory && agent.accessory !== "none" ? agent.accessory : undefined;
  const box = frame ? framedLayout(size, Boolean(accessory)) : agentLayout(size, Boolean(accessory));
  const rec = new RecordingContext();
  if (frame && extra?.sky !== false) drawSky(rec, agent.color, size, frame.dark);
  // Away on a routine: the frame keeps its sky and waits for it.
  if (frame && extra?.bodyless) return compile(rec.commands);
  const base = poseFor(mode, t, seed, reduced);
  const looked = extra?.gaze ? { ...base, ...GAZE[extra.gaze] } : base;
  const px = extra?.px ?? 1;
  rec.save();
  rec.scale(1 / px, 1 / px);
  drawAgent(asCtx(rec), box.x * px, box.y * px, box.inner * px, {
    color: agent.color,
    eyes: agent.eyes,
    cells: box.cells,
    pose: expression ? { ...looked, expression, blink: false } : looked,
    after: (ctx, side, body) => {
      if (box.withAccessory && accessory) drawAccessory(ctx, side, accessory, body, t, mode === "run");
      // A sleeping agent's zz: the body's darkest tone on a light page, white on a dark one.
      if (mode === "sleep")
        drawSleep(
          ctx,
          side,
          body,
          dark ? EYE_COLOR : (bodyTones(agent.color)[0] ?? EYE_COLOR),
          // A still frame shows both z's.
          reduced || t === STILL_T ? undefined : t,
        );
    },
  });
  rec.restore();
  return compile(rec.commands);
}

/** The tile's sky (`@agenteschat/ui/sky/avatar`): a Bayer dither from the top tone to the bottom one. */
function drawSky(rec: RecordingContext, color: AgentLookInput["color"], size: number, dark: boolean) {
  const [top, bottom] = avatarSkyTones(color, dark);
  const n = avatarSkyCells(size * 2);
  const cell = size / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      rec.fillStyle = avatarSkyCell(x, y, n) ? bottom : top;
      rec.fillRect(x * cell, y * cell, cell, cell);
    }
}

/**
 * Pictures kept across mounts, most recently used last: a face scrolled back into view, the same agent in many rows,
 * a sky under every frame of a living face. Recording one costs hundreds of rects and a path parse each.
 */
const KEPT = 400;
const skies = new Map<string, SkPicture>();
const stills = new Map<string, SkPicture>();
function kept(map: Map<string, SkPicture>, key: string, make: () => SkPicture): SkPicture {
  const hit = map.get(key);
  if (hit) {
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const made = make();
  map.set(key, made);
  const oldest = map.size > KEPT ? map.keys().next().value : undefined;
  if (oldest !== undefined) map.delete(oldest);
  return made;
}

function AgentAvatarView({
  agent,
  size,
  mode = "idle",
  live = true,
  name,
  framed,
  expression,
  gaze,
  bodyless = false,
  radius,
}: AgentAvatarProps) {
  const reduced = useReducedMotion();
  const { scheme, colors: c } = useTheme();
  const tile = framed ?? framedByDefault(size);
  const dark = scheme === "dark";
  const { t: tr } = useTranslation();
  const { color, eyes, accessory, id } = agent;
  const seed = useMemo(() => seedOf(id ?? `${color}:${eyes}:${accessory ?? ""}`), [id, color, eyes, accessory]);
  const t = useFrameTime(live && !reduced, STILL_T);
  // By the colors it resolves to: `sky` follows the workspace's accent.
  const drawn = drawnKey(color);
  // The sky never moves: drawn once per color, size and theme (`drawn`: what `color` draws as now), under every frame.
  const sky = useMemo(() => {
    if (!tile) return null;
    return kept(skies, `${drawn}|${size}|${dark}`, () => {
      const rec = new RecordingContext();
      drawSky(rec, color, size, dark);
      const ops = compile(rec.commands);
      return createPicture((canvas) => replay(canvas, ops), { width: size, height: size });
    });
  }, [color, drawn, size, dark, tile]);
  // Drawn in the screen's pixels, as the web draws its canvas (see `agentFrame`).
  const px = PixelRatio.get();
  const picture = useMemo(() => {
    const draw = () => {
      const frame = agentFrame(
        { color, eyes, accessory },
        size,
        mode,
        t,
        seed,
        reduced,
        tile ? { dark } : undefined,
        expression,
        dark,
        { gaze, bodyless, sky: false, px },
      );
      return createPicture((canvas) => replay(canvas, frame), { width: size, height: size });
    };
    // A still face is the same picture wherever it shows: kept, never recorded again on the next mount.
    if (t !== STILL_T) return draw();
    const key = [
      drawn,
      eyes,
      accessory ?? "",
      size,
      mode,
      seed,
      reduced,
      tile,
      dark,
      expression ?? "",
      gaze ?? "",
      bodyless,
      px,
    ];
    return kept(stills, key.join("|"), draw);
  }, [color, drawn, eyes, accessory, size, mode, t, seed, reduced, tile, dark, expression, gaze, bodyless, px]);
  const label = name
    ? tr(mode === "run" ? "mobile.a11y.agentWorking" : "mobile.a11y.agent", { name })
    : tr("mobile.a11y.agentPlain");
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[
        { width: size, height: size },
        tile && {
          borderRadius: radius ?? size * 0.3,
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: c.line,
        },
      ]}
    >
      <Canvas style={{ width: size, height: size }}>
        {sky ? <Picture picture={sky} /> : null}
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

/**
 * An agent, drawn by the shared engine (`@agenteschat/ui/agent/engine`) on a Skia canvas: never any
 * other way. Living agents share one ~25 fps clock; with reduced motion, `live={false}`, an off-screen
 * screen or the app in the background they hold a still frame.
 */
export const AgentAvatar = memo(
  AgentAvatarView,
  (a, b) =>
    a.size === b.size &&
    a.mode === b.mode &&
    a.live === b.live &&
    a.name === b.name &&
    a.framed === b.framed &&
    a.expression === b.expression &&
    a.gaze === b.gaze &&
    a.bodyless === b.bodyless &&
    a.radius === b.radius &&
    a.agent.color === b.agent.color &&
    a.agent.eyes === b.agent.eyes &&
    a.agent.accessory === b.agent.accessory &&
    a.agent.id === b.agent.id,
);
