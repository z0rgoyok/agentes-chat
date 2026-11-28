import { glidePoint } from "@agenteschat/client";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { gradientOf, prefersReducedMotion } from "@agenteschat/ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CursorMark } from "@/components/browser/AgentCursor";
import { NAV_ID, PHONE_QUERY, useNavDrawer } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { type Arrival, arrivals, useArrivals } from "./arrivals";
import {
  type ArrivingRow,
  type CursorHandle,
  drawIn,
  findRows,
  inSight,
  type Point,
  playLodi,
  RUN,
  travelMs,
} from "./runner";
import "@/components/browser/agent-cursor.css";
import "./lodi-cursor.css";

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const idOf = (row: ArrivingRow) => row.el.dataset.channelRow ?? row.el.dataset.agentRow ?? "";

/** The rows of an arrival once the sidebar has them (its lists refetch after the team is made), or what came in time. */
async function rowsOf(a: Arrival, signal: AbortSignal) {
  const nav = document.getElementById(NAV_ID);
  const until = Date.now() + RUN.waitRowsMs;
  let channels: ArrivingRow[] = [];
  let agents: ArrivingRow[] = [];
  while (!signal.aborted) {
    channels = nav ? findRows(nav, "channel", a.channelIds) : [];
    agents = nav ? findRows(nav, "agent", a.agentIds) : [];
    if (channels.length === a.channelIds.length && agents.length === a.agentIds.length) break;
    if (Date.now() > until) break;
    await frame();
  }
  return { nav, channels, agents };
}

/**
 * Lodi's cursor: after "Criar o time" (or an import), for the person who clicked, Lodi's own pointer builds the
 * sidebar from what was made. It presses the channels' +, types each new channel into its row, presses the agents' +
 * and drops each agent in. It is over the page and never takes the pointer. Pular and Esc land everything at once.
 * Where the sidebar isn't there to aim at (rail, collapsed, scrolled away, under a dialog) or with reduced motion, the
 * rows draw themselves. At phone width the cursor drops them into the menu button, which counts them.
 */
export function LodiCursor() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const drawer = useNavDrawer();
  const state = useArrivals();
  const lodi = dir.agents.find(isRightHand);
  const pointer = useRef<HTMLSpanElement>(null);
  const at = useRef<Point>({ x: 0, y: 0 });
  const [shown, setShown] = useState(false);
  const live = useRef({ drawerOpen: false, compact: false, lodi: false });
  live.current = { drawerOpen: drawer?.open ?? false, compact: drawer?.compact ?? false, lodi: Boolean(lodi) };

  // The cursor the script drives: it glides on the product's arc (`glidePoint`) and shrinks a moment on a press.
  const cursor = useRef<CursorHandle>({
    step({ presses, instant, ...to }) {
      const el = pointer.current;
      if (!el) return;
      const from = at.current;
      const place = (p: Point) => {
        at.current = p;
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      };
      if (instant) return place(to);
      const ms = travelMs(from, to);
      const t0 = performance.now();
      const glide = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        place(k >= 1 ? to : glidePoint(from, to, k, 1));
        if (k < 1) requestAnimationFrame(glide);
        else if (presses) {
          el.classList.add("is-press");
          setTimeout(() => el.classList.remove("is-press"), RUN.pressMs / 2);
        }
      };
      requestAnimationFrame(glide);
    },
  });

  // Opening the drawer shows the rows dropped into it, once, as they draw themselves in.
  useEffect(() => {
    if (!drawer?.open) return;
    const dropped = arrivals.drawerOpened();
    if (!dropped) return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      const nav = document.getElementById(NAV_ID);
      if (!nav) return;
      void drawIn(
        [...findRows(nav, "channel", dropped.channelIds), ...findRows(nav, "agent", dropped.agentIds)],
        stop.signal,
      );
    }, RUN.drawerMs);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [drawer?.open]);

  useEffect(() => {
    if (!state.waiting) return;
    const a = arrivals.take();
    if (!a) return;
    const stop = new AbortController();
    const { signal } = stop;
    const unskip = arrivals.onSkip(() => stop.abort());
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop.abort();
    };
    window.addEventListener("keydown", esc);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      await wait(RUN.settleMs);
      const { nav, channels, agents } = await rowsOf(a, signal);
      const rows = [...channels, ...agents];
      if (signal.aborted || rows.length === 0) return;
      if (prefersReducedMotion() || !live.current.lodi) return drawIn(rows, signal);
      const phone = live.current.compact && window.matchMedia(PHONE_QUERY).matches && !live.current.drawerOpen;
      const start = startPoint();
      if (phone) {
        const box = document.querySelector<HTMLElement>(".nav-toggle")?.getBoundingClientRect();
        if (!box || box.width === 0) return;
        cursor.current.step({ ...start, instant: true });
        setShown(true);
        await frame();
        const target = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const bunches = [
          { channelIds: channels.map(idOf), agentIds: [] },
          { channelIds: [], agentIds: agents.map(idOf) },
        ];
        for (const bunch of bunches) {
          if (bunch.channelIds.length + bunch.agentIds.length === 0 || signal.aborted) continue;
          // It gathers the bunch where the person's eyes are, then drops it into the menu button.
          cursor.current.step(start);
          await wait(RUN.gatherMs + travelMs(target, start));
          cursor.current.step({ ...target, presses: 1 });
          await wait(RUN.dropMs + travelMs(start, target));
          arrivals.dropIntoDrawer(bunch);
        }
        if (signal.aborted) arrivals.dropIntoDrawer({ channelIds: channels.map(idOf), agentIds: agents.map(idOf) });
        return;
      }
      if (!inSight(nav, rows)) return drawIn(rows, signal);
      cursor.current.step({ ...start, instant: true });
      setShown(true);
      await frame();
      // A section's button beside its title (`SidebarSection`).
      const plus = (part: "channels" | "agents") =>
        document
          .getElementById(`sidebar-section-${part}`)
          ?.parentElement?.querySelector<HTMLElement>(".sidebar__section-add") ?? null;
      await playLodi(
        cursor.current,
        start,
        [
          { add: plus("channels"), rows: channels },
          { add: plus("agents"), rows: agents },
        ],
        signal,
      );
    };
    void run().finally(() => {
      window.removeEventListener("keydown", esc);
      unskip();
      setShown(false);
      arrivals.done();
    });
    return () => stop.abort();
  }, [state.waiting]);

  if (!lodi) return null;
  const [, deep] = gradientOf(colorOf(lodi));
  return createPortal(
    <div className="lodi-cursor" aria-hidden="true" data-shown={shown || undefined}>
      <span ref={pointer} className="brw-cur lodi-cursor__cur" style={{ "--cursor": deep } as CSSProperties}>
        <CursorMark agentId={lodi.id} name={lodi.name} />
      </span>
    </div>,
    document.body,
  );
}

/** Where the cursor comes from: the receipt's Pular, where the person's eyes are, else the window's middle. */
function startPoint(): Point {
  const from = document.querySelector(".lodi-skip")?.getBoundingClientRect();
  return from && from.width > 0
    ? { x: from.left + from.width / 2, y: from.top + from.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
