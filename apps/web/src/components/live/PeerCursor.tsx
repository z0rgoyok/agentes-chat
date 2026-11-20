import { AGENT_ARROW, CURSOR_FLIP_AT, CURSOR_IDLE_MS, cursorTagLifts, glideMs } from "@agenteschat/client";
import type { Peer, PeerUser } from "@agenteschat/live/awareness";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { PeerFace, peerWorking, usePeerLook } from "./peers";

/**
 * Someone's pointer over a live file (ADR 0196 §5), in any editor: a person's classic arrow in their color with their
 * name on a tag beside it, an agent's pixel arrow with its face and name, as its cursor over its browser (ADR 0040
 * §7.2). The editor gives the point in its own units (canvas world, slide units, sheet pixels) and how they land on
 * its layer (`toScreen`, its pan, zoom and scroll): the cursor glides between the points it is given, in those units,
 * so the editor's own scrolling moves it at once while the peer's moves glide. It moves through refs, one style write
 * a frame, never React state per frame. The tag fades after a quiet while and comes back with the next move; with
 * reduced motion nothing glides.
 */

export type CursorPoint = { x: number; y: number };

/** The tag's words fade after this long without a move; the arrow rests dimmed after `CURSOR_IDLE_MS`. */
export const CURSOR_TAG_MS = 3000;

const identity = (p: CursorPoint) => p;

export interface PeerCursorProps {
  user: PeerUser;
  /** Where the pointer is, in the editor's units; null hides it. */
  at: CursorPoint | null;
  /** The editor's units → px on the layer the cursor is drawn in. Read on every render and every frame. */
  toScreen?: (p: CursorPoint) => CursorPoint;
  /** An agent at work: its face writes. */
  working?: boolean;
}

export function PeerCursor({ user, at, toScreen = identity, working = false }: PeerCursorProps) {
  const reduced = usePrefersReducedMotion();
  const look = usePeerLook(user);
  const el = useRef<HTMLSpanElement>(null);
  /** Where it is now, in the editor's units (mid-glide too). */
  const now = useRef<CursorPoint | null>(null);
  const gliding = useRef(false);
  const project = useRef(toScreen);
  project.current = toScreen;

  const place = (p: CursorPoint) => {
    now.current = p;
    const node = el.current;
    if (!node) return;
    const s = project.current(p);
    node.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
  };

  /** Near the layer's right or bottom edge the tag opens to the arrow's left or above it, never cut. */
  const edges = (p: CursorPoint) => {
    const node = el.current;
    const box = node?.parentElement;
    if (!node || !box) return;
    const s = project.current(p);
    const w = box.clientWidth;
    const h = box.clientHeight;
    node.classList.toggle("is-flip", w > 0 && s.x > w * CURSOR_FLIP_AT);
    node.classList.toggle("is-lift", cursorTagLifts(s.y, h));
  };

  const x = at?.x;
  const y = at?.y;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per point the peer gives, reading the newest.
  useLayoutEffect(() => {
    const node = el.current;
    if (x === undefined || y === undefined || !node) return;
    const to = { x, y };
    node.classList.remove("is-idle", "is-quiet");
    edges(to);
    const timers = [
      setTimeout(() => node.classList.add("is-quiet"), CURSOR_TAG_MS),
      setTimeout(() => node.classList.add("is-idle"), CURSOR_IDLE_MS),
    ];
    const from = now.current;
    let frame = 0;
    if (!from || reduced) {
      place(to);
    } else {
      const a = project.current(from);
      const b = project.current(to);
      const width = node.parentElement?.clientWidth || 1000;
      const ms = glideMs(Math.hypot(b.x - a.x, b.y - a.y) / width);
      const t0 = performance.now();
      gliding.current = true;
      const step = (time: number) => {
        const t = Math.min(1, (time - t0) / ms);
        // Eased as the agents' cursor (`glidePoint`), without its arc: a pointer a person moves goes straight.
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        place({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
        if (t < 1) frame = requestAnimationFrame(step);
        else gliding.current = false;
      };
      frame = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(frame);
      gliding.current = false;
      for (const id of timers) clearTimeout(id);
    };
  }, [x, y, reduced]);

  // The editor's own view moved (a scroll, a zoom): the cursor stays on its point, at once.
  useLayoutEffect(() => {
    if (now.current && !gliding.current) place(now.current);
  });

  if (!look || x === undefined || y === undefined) return null;
  const agent = user.kind === "agent";
  const style = { "--peer": look.color, "--peer-on": look.onColor } as CSSProperties;
  return (
    <span ref={el} className={agent ? "lf-cur lf-cur--agent" : "lf-cur"} style={style} aria-hidden="true">
      {agent ? <AgentArrow /> : <PersonArrow />}
      {agent ? (
        <span className="lf-cur__who">
          <PeerFace user={user} name={look.name} size="xs" working={working} />
          <b>{look.name}</b>
        </span>
      ) : (
        <span className="lf-cur__tag">{look.name}</span>
      )}
    </span>
  );
}

/** A person's arrow, 16 px, filled in their color with a light edge that reads on any content. */
function PersonArrow() {
  return (
    <svg className="lf-cur__arrow" width="16" height="16" viewBox="0 0 16 16" role="presentation">
      <path d="M2 1.5v12.2l3.3-3.1 2.2 4.9 2.1-.9-2.1-4.8 4.6-.2z" />
    </svg>
  );
}

/** An agent's pixel arrow, as over its browser (`AGENT_ARROW`). */
function AgentArrow() {
  return (
    <svg
      className="lf-cur__pixels"
      width="16"
      height="24"
      viewBox="0 0 8 12"
      shapeRendering="crispEdges"
      role="presentation"
    >
      {AGENT_ARROW.flatMap((row, py) =>
        [...row].map((c, px) =>
          c === "." ? null : (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid.
              key={`${px}-${py}`}
              x={px}
              y={py}
              width="1.02"
              height="1.02"
              className={c === "X" ? "lf-cur__edge" : "lf-cur__body"}
            />
          ),
        ),
      )}
    </svg>
  );
}

/**
 * The pointers of everyone else in a layer the editor sizes over its content (`.lf-cursors`, absolute, no pointer
 * events): those whose cursor is in `space` and that `where` keeps (the slide shown, say). Agents' faces write while
 * they work.
 */
export function PeerCursors({
  peers,
  space,
  toScreen,
  where,
  children,
}: {
  peers: Peer[];
  space: "canvas" | "slide";
  toScreen?: (p: CursorPoint) => CursorPoint;
  where?: (peer: Peer) => boolean;
  children?: ReactNode;
}) {
  const shown = peers.filter((p) => !p.self && p.state.cursor?.space === space && (where ? where(p) : true));
  return (
    <div className="lf-cursors" aria-hidden="true">
      {shown.map((p) => (
        <PeerCursor
          key={p.clientId}
          user={p.user}
          at={p.state.cursor ? { x: p.state.cursor.x, y: p.state.cursor.y } : null}
          toScreen={toScreen}
          working={peerWorking(p)}
        />
      ))}
      {children}
    </div>
  );
}
