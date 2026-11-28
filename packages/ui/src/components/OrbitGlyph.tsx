import { type CSSProperties, type HTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ORBIT_LIGHT, ORBIT_RINGS, ORBIT_SPAN, orbitColors, orbitFade, orbitTaper } from "../agent/orbit-rings";
import { cx } from "../cx";
import { onScreenNow } from "../device";
import type { AgentAppearance } from "./AgentLook";

/** The glyph's half side in the overlay's units. */
const HALF = 50;

/** Where in its turn each ring's light and the ring itself start, in seconds. */
type Phase = { light: number; roll: number };

/** One piece of the light, in degrees of its ring (`pathLength` 360). */
const PIECE = ORBIT_LIGHT.arc / ORBIT_LIGHT.steps;

/**
 * The light riding one ring and its dot: a turn (a transform, on the compositor) moves both along the ellipse, the dot
 * turning back as much so it stays round. A ring that turns the other way is mirrored, so its light still trails
 * behind its head.
 */
function Light({ ring, i, phase }: { ring: (typeof ORBIT_RINGS)[number]; i: number; phase: number }) {
  const rx = ring.r * HALF;
  const timing = { "--turn": `${ring.turn}s`, "--start": `${ring.start}deg`, animationDelay: `${-phase}s` };
  return (
    <g transform={ring.back ? "scale(1 -1)" : undefined}>
      <g className="ac-orbit__spin" style={timing as CSSProperties}>
        {Array.from({ length: ORBIT_LIGHT.steps }, (_, k) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: the light's fixed pieces, head first
            key={k}
            className="ac-orbit__light"
            r={rx}
            pathLength={360}
            strokeDasharray={`${PIECE + 0.5} 360`}
            strokeDashoffset={-(ORBIT_LIGHT.arc - (k + 1) * PIECE)}
            opacity={orbitFade(k)}
            style={{
              strokeWidth: `calc(var(--orbit-w) * ${orbitTaper(k)})`,
              stroke: k === 0 ? "var(--orbit-head)" : `var(--orbit-${i + 1})`,
            }}
          />
        ))}
        <g transform={`rotate(${ORBIT_LIGHT.arc})`}>
          <g transform={`translate(${rx} 0)`}>
            <g className="ac-orbit__unspin" style={timing as CSSProperties}>
              <ellipse
                className="ac-orbit__dot"
                transform={`rotate(${-ORBIT_LIGHT.arc})`}
                rx={ORBIT_LIGHT.dot}
                ry={ORBIT_LIGHT.dot / ring.flat}
              />
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

/**
 * One layer of the orbit: the far one (`back`, behind the glyph) holds both rings whole and the light on their far
 * halves; the near one only the light on their near halves, so the light passes over the face while no line ever
 * crosses it. Each ring is a circle squashed and tilted by static groups, then turned slowly round the face
 * (`ac-orbit__roll`, the same in both layers) with its light and its near and far halves on it.
 */
function Layer({ half, id, phases }: { half: "back" | "front"; id: string; phases: readonly Phase[] }) {
  const box = ORBIT_SPAN * 2 * HALF;
  return (
    <svg
      className={`ac-orbit__${half}`}
      viewBox={`${-box / 2} ${-box / 2} ${box} ${box}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}-${half}`} clipPathUnits="userSpaceOnUse">
          <rect x={-box} y={half === "back" ? -box : 0} width={box * 2} height={box} />
        </clipPath>
      </defs>
      {ORBIT_RINGS.map((ring, i) => {
        const roll = {
          "--spin": `${Math.abs(ring.spin)}s`,
          animationDelay: `${-(phases[i]?.roll ?? 0)}s`,
          animationDirection: ring.spin < 0 ? "reverse" : undefined,
        };
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of rings
          <g key={i} className={`ac-orbit__ring ac-orbit__ring--${i + 1}`} transform={`rotate(${ring.tilt})`}>
            <g className="ac-orbit__roll" style={roll as CSSProperties}>
              <g transform={`scale(1 ${ring.flat})`}>
                {half === "back" && <circle className="ac-orbit__path" r={ring.r * HALF} />}
                <g clipPath={`url(#${id}-${half})`}>
                  <Light ring={ring} i={i} phase={phases[i]?.light ?? 0} />
                </g>
              </g>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * An agent at work: its glyph with two tilted rings around it, in its own colours, each slowly turning round it. The
 * rings stay behind the glyph; on each a light runs round, a fading arc with a small dot at its head, over the face on the near half and behind it on
 * the far one. Each glyph starts at its own point of the turn, so faces side by side never move in step. Only
 * transforms move; the rings hold still with reduced motion and pause off screen.
 */
export function OrbitGlyph({
  appearance,
  children,
  className,
  style,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  /** The agent's look: its colour paints the rings. */
  appearance?: AgentAppearance;
  /** The glyph (an agent's `Avatar`). */
  children: ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const host = useRef<HTMLSpanElement>(null);
  // Where in its turn each ring starts, once per glyph.
  const [phases] = useState(() =>
    ORBIT_RINGS.map((ring) => ({ light: Math.random() * ring.turn, roll: Math.random() * Math.abs(ring.spin) })),
  );
  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const on = onScreenNow(entries);
      if (on !== undefined) el.dataset.paused = on ? "" : "true";
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const light = orbitColors(appearance?.color);
  const dark = orbitColors(appearance?.color, true);
  return (
    <span
      ref={host}
      className={cx("ac-orbit", className)}
      style={
        {
          "--orbit-l1": light.rings[0],
          "--orbit-l2": light.rings[1],
          "--orbit-lh": light.head,
          "--orbit-d1": dark.rings[0],
          "--orbit-d2": dark.rings[1],
          "--orbit-dh": dark.head,
          ...style,
        } as CSSProperties
      }
      {...rest}
    >
      <Layer half="back" id={id} phases={phases} />
      {children}
      <Layer half="front" id={id} phases={phases} />
    </span>
  );
}
