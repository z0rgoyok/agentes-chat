import { CURSOR_IDLE_MS, glideMs, glidePoint } from "@agenteschat/client";
import { gradientOf, idlePose } from "@agenteschat/ui";
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CursorMark } from "@/components/browser/AgentCursor";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { fullLook, lookOf } from "@/lib/look";
import { agentCubes, BUILD_MS, voxelView } from "./agent-voxel";

/** CSS px per cube. */
const UNIT = 5.5;
/** The canvas: room for the figure to turn. */
const W = 260;
const H = 240;
/** Its pose at rest, and how far it turns toward the pointer (radians). */
const REST = { yaw: -0.3, pitch: 0.2 };
const TILT = { yaw: 0.38, pitch: 0.22 };
/** Dither cells per cube. */
const DITHER = 2;
/** When its cursor comes in: as the figure's last cube lands (ms after it starts building). */
const CURSOR_IN_MS = BUILD_MS - 120;

/** The avatar's own seed for its idle blink (`Avatar`'s `seedOf`), so the figure and its face blink together. */
const seedOf = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 100;
};

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The Code home's agent (ADR 0215): the agent picked in the field, in cubes from its own avatar, standing over the
 * title. It builds itself as it shows (each cube dropping into place from its foot up, `BUILD_MS`), turns a little
 * toward the pointer anywhere over the home (`area`) and blinks when its avatar does; its cursor glides in as the last
 * cube lands and waits beside it. Decoration (the field says who works): hidden from screen readers. Without
 * WebGL it is the flat avatar.
 */
export function CodeHomeAgent({
  agent,
  name,
  area,
}: {
  agent: { id: string; appearance?: unknown };
  name: string;
  area: RefObject<HTMLElement | null>;
}) {
  const reduced = usePrefersReducedMotion();
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = fullLook(lookOf(agent));
  const shapeKey = `${look.color}|${look.eyes}|${look.accessory}`;
  const shape = useMemo(
    () => agentCubes({ color: String(look.color), eyes: String(look.eyes), accessory: String(look.accessory) }),
    [look.color, look.eyes, look.accessory],
  );
  // What it draws at rest, in the canvas's px: placed so its foot's middle is the anchor (this box's 0,0).
  const [ink, setInk] = useState<Box | null>(null);
  const [flat, setFlat] = useState(false);

  useLayoutEffect(() => {
    const el = canvas.current;
    const home = area.current;
    if (!el) return;
    const view = voxelView(el, shape, { width: W, height: H, unit: UNIT, dither: DITHER, rest: REST });
    if (!view) {
      setFlat(true);
      return;
    }
    setFlat(false);
    // Measured built (where its cursor waits), then drawn from nothing: it builds itself from the first frame on.
    view.draw(0, 0, false);
    setInk(view.inked());
    if (!reduced) view.draw(0, 0, false, 0);
    const born = performance.now();
    const seed = seedOf(name);
    const aim = { x: 0, y: 0 };
    const now = { x: 0, y: 0 };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const f = home?.getBoundingClientRect();
      if (!f) return;
      aim.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (f.width / 2)));
      aim.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (f.height * 0.6)));
    };
    const leave = () => {
      aim.x = 0;
      aim.y = 0;
    };
    if (reduced) return () => view.destroy();
    home?.addEventListener("pointermove", move);
    home?.addEventListener("pointerleave", leave);
    let frame = 0;
    let last = performance.now();
    let seen = true;
    const tick = (t: number) => {
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      const k = 1 - Math.exp(-dt * 3.2);
      now.x += (aim.x - now.x) * k;
      now.y += (aim.y - now.y) * k;
      view.draw(TILT.yaw * now.x, TILT.pitch * now.y, idlePose(t / 1000, seed).blink, (t - born) / 1000);
      frame = seen && !document.hidden ? requestAnimationFrame(tick) : 0;
    };
    const resume = () => {
      if (frame || !seen || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    // Only while it shows: a hidden tab or a scrolled-away home draws nothing.
    const watch = new IntersectionObserver(([e]) => {
      seen = Boolean(e?.isIntersecting);
      resume();
    });
    watch.observe(el);
    document.addEventListener("visibilitychange", resume);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      document.removeEventListener("visibilitychange", resume);
      home?.removeEventListener("pointermove", move);
      home?.removeEventListener("pointerleave", leave);
      view.destroy();
    };
  }, [shape, area, name, reduced]);

  // Where its cursor waits: right of the figure, at its head's height (the anchor's px).
  const spot = ink
    ? {
        x: Math.round(ink.right - (ink.left + ink.right) / 2 + 14),
        y: Math.round(ink.top - ink.bottom + (ink.bottom - ink.top) * 0.42),
      }
    : null;
  const cursor = useCursorGlide(spot, reduced);
  const [, deep] = gradientOf(look.color);
  const place: CSSProperties | undefined = ink
    ? { left: `${-Math.round((ink.left + ink.right) / 2)}px`, top: `${-Math.round(ink.bottom)}px` }
    : { visibility: "hidden" };
  return (
    <div className="code-agent" aria-hidden="true" style={{ "--cursor": deep } as CSSProperties}>
      {flat ? (
        <span className="code-agent__flat">
          <AgentAvatar agent={agent} agentId={agent.id} name={name} size="xl" state="idle" />
        </span>
      ) : (
        // A new canvas for each look: a WebGL context lost on its way out can't draw the next one.
        <canvas key={shapeKey} ref={canvas} className="code-agent__art" style={place} />
      )}
      {!flat && cursor && (
        <span
          className={["brw-cur", "code-agent__cur", cursor.idle && "is-idle"].filter(Boolean).join(" ")}
          style={{ left: `${cursor.x}px`, top: `${cursor.y}px` }}
        >
          <CursorMark agentId={agent.id} name={name} />
        </span>
      )}
    </div>
  );
}

/**
 * Its cursor coming in to `to` (px from the anchor) the way the product's does (`glidePoint`), from a little below and
 * to the right; dimmed once it has rested a while. Reduced motion: already there, at rest.
 */
function useCursorGlide(to: { x: number; y: number } | null, reduced: boolean) {
  const [at, setAt] = useState<{ x: number; y: number; idle: boolean } | null>(null);
  const x = to?.x;
  const y = to?.y;
  useEffect(() => {
    if (x === undefined || y === undefined) return;
    if (reduced) {
      setAt({ x, y, idle: true });
      return;
    }
    const from = { x: x + 56, y: y + 40 };
    let frame = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        const ms = glideMs(Math.hypot(x - from.x, y - from.y) / 400);
        const t0 = performance.now();
        const step = (t: number) => {
          const k = Math.min(1, (t - t0) / ms);
          const p = glidePoint(from, { x, y }, k, 1);
          setAt({ x: Math.round(p.x), y: Math.round(p.y), idle: false });
          if (k < 1) frame = requestAnimationFrame(step);
          else timers.push(setTimeout(() => setAt({ x, y, idle: true }), CURSOR_IDLE_MS));
        };
        frame = requestAnimationFrame(step);
      }, CURSOR_IN_MS),
    );
    return () => {
      cancelAnimationFrame(frame);
      for (const id of timers) clearTimeout(id);
    };
  }, [x, y, reduced]);
  return at;
}
