import { bodyPath, bodyTones, eyeShapes, gradientOf, type SkyPair, toneAt } from "@agenteschat/ui/agent/engine";
import { useId, useMemo } from "react";
import Svg, { ClipPath, Defs, G, Path, Rect } from "react-native-svg";
import { useTheme } from "./theme";

/** The mark is the agent from the engine: body at (2, 2), side 28, and its eyes (as the web's `LogoMark`). */
const BODY = bodyPath(2, 2, 28);
const SIDE = 28;
const EYES = eyeShapes("round").map((e) => ({ x: 2 + e.x * SIDE, y: 2 + e.y * SIDE, w: e.w * SIDE, h: e.h * SIDE }));
/** The sky's dither on the body: 12 cells a side, one rect per run of a tone in a row. */
const CELLS = 12;
function dither(top: string, bottom: string) {
  const tones = bodyTones([top, bottom]);
  const cell = SIDE / CELLS;
  const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  for (let y = 0; y < CELLS; y++) {
    let start = 0;
    let run = toneAt(0, y, CELLS);
    for (let x = 1; x <= CELLS; x++) {
      const tone = x < CELLS ? toneAt(x, y, CELLS) : -1;
      if (tone === run) continue;
      rects.push({ x: 2 + start * cell, y: 2 + y * cell, w: (x - start) * cell, h: cell, fill: tones[run] ?? "" });
      start = x;
      run = tone;
    }
  }
  return rects;
}

/**
 * The agent mark, as the web's (`packages/ui` `LogoMark`): the square with the cut corner in the sky's dither, on
 * the theme's `agent` color, and the engine's white eyes. A workspace without a logo of its own wears it. `sky`: a
 * given workspace's pair (`workspaceSky`) in place of the active one's.
 */
export function LogoMark({ size, sky }: { size: number; sky?: SkyPair }) {
  const { colors } = useTheme();
  const [top, bottom] = sky ?? gradientOf("sky");
  // By the colors `sky` resolves to now: it follows the workspace's accent.
  const rects = useMemo(() => dither(top, bottom), [top, bottom]);
  const clip = `logo-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityElementsHidden importantForAccessibility="no">
      <Defs>
        <ClipPath id={clip}>
          <Path d={BODY} />
        </ClipPath>
      </Defs>
      <Path d={BODY} fill={sky ? bottom : colors.agent} />
      <G clipPath={`url(#${clip})`}>
        {rects.map((r) => (
          <Rect key={`${r.x}:${r.y}`} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
        ))}
      </G>
      <G fill="#ffffff">
        {EYES.map((e) => (
          <Rect key={e.x} x={e.x} y={e.y} width={e.w} height={e.h} rx={e.w / 2} />
        ))}
      </G>
    </Svg>
  );
}
