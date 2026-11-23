import type { Peer } from "@agenteschat/live/awareness";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PeerCursor } from "../PeerCursor";
import { PeerTag, peerWorking, usePeerLooks } from "../peers";
import type { RangeMark } from "./draw";
import type { GridTag, GridView, SheetPoint } from "./Grid";
import type { Axis, GridRange } from "./model";
import { normalize } from "./model";
import type { DocSource } from "./source";

/**
 * Other people and agents on the sheet being shown (ADR 0196 §5): each one's range outlined in their color. A person's
 * name tag sits at its top-right corner while they type, for a moment after they move, and while the pointer is over
 * it; an agent's cursor (its pixel arrow, face and name) glides to the range it works on, as over its browser (ADR
 * 0040 §7.2). An agent writing washes its range in its own color, and the range it leaves fades out over 1.2 s (at
 * once with reduced motion), so people see where its hand went.
 */

/** How long a tag stays after its owner moved. */
export const TAG_MS = 3000;
/** How long an agent's last range takes to fade. */
export const FADE_MS = 1200;
const WASH = 0.14;

/** A peer's selection on a sheet, in indexes (null when on another sheet or its rows or columns are gone). */
export function peerRange(peer: Peer, sheet: string, source: DocSource): GridRange | null {
  const sel = peer.state.sel?.sheet;
  if (!sel || sel.sheet !== sheet) return null;
  const r1 = source.rowIndex(sel.r1);
  const r2 = source.rowIndex(sel.r2);
  const c1 = source.colIndex(sel.c1);
  const c2 = source.colIndex(sel.c2);
  if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
  return normalize({ r: r1, c: c1 }, { r: r2, c: c2 });
}

const keyOf = (r: GridRange) => `${r.r1}:${r.c1}:${r.r2}:${r.c2}`;

export function useSheetPeers(
  peers: readonly Peer[],
  sheet: string | undefined,
  source: DocSource | null,
  reduced: boolean,
): { marks: RangeMark[]; tags: GridTag[] } {
  const looks = usePeerLooks();
  const moved = useRef(new Map<number, { key: string; at: number }>());
  const [fades, setFades] = useState<RangeMark[]>([]);
  const [, setTick] = useState(0);

  const marks: RangeMark[] = [];
  const tags: GridTag[] = [];
  const now = Date.now();
  const placed: { id: number; key: string; range: GridRange; color: string; agent: boolean }[] = [];
  if (sheet && source) {
    for (const peer of peers) {
      if (peer.self) continue;
      const range = peerRange(peer, sheet, source);
      if (!range) continue;
      const look = looks(peer.user);
      const agent = peer.user.kind === "agent";
      const working = peerWorking(peer);
      marks.push({ range, color: look.color, wash: agent && working ? WASH : 0, width: 2 });
      const key = keyOf(range);
      placed.push({ id: peer.clientId, key, range, color: look.color, agent: agent && working });
      // An agent's cursor says who it is (`SheetCursors`); a person's range gets their name.
      if (agent) continue;
      const last = moved.current.get(peer.clientId);
      const recent = last?.key === key ? now - last.at < TAG_MS : true;
      tags.push({
        id: String(peer.clientId),
        range,
        color: look.color,
        show: recent || !!peer.state.sel?.sheet?.editing,
        content: <PeerTag look={look} className="sheet-grid__name" />,
      });
    }
  }

  const signature = placed.map((p) => `${p.id}=${p.key}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when someone's range changed (`signature`)
  useEffect(() => {
    const at = Date.now();
    const gone: RangeMark[] = [];
    const seen = new Set<number>();
    for (const p of placed) {
      seen.add(p.id);
      const last = moved.current.get(p.id);
      if (last?.key === p.key) continue;
      if (last && p.agent && !reduced) {
        const [r1, c1, r2, c2] = last.key.split(":").map(Number) as [number, number, number, number];
        gone.push({
          range: { r1, c1, r2, c2 },
          color: p.color,
          wash: WASH,
          fade: { from: performance.now(), ms: FADE_MS },
        });
      }
      moved.current.set(p.id, { key: p.key, at });
    }
    for (const id of [...moved.current.keys()]) if (!seen.has(id)) moved.current.delete(id);
    if (gone.length) setFades((list) => [...list, ...gone]);
    // Tags hide once their owner has been still a while.
    const hide = setTimeout(() => setTick((n) => n + 1), TAG_MS + 50);
    return () => clearTimeout(hide);
  }, [signature, reduced]);

  // Faded ranges leave the list.
  useEffect(() => {
    if (!fades.length) return;
    const id = setTimeout(
      () => setFades((list) => list.filter((m) => m.fade && performance.now() - m.fade.from < m.fade.ms)),
      FADE_MS + 50,
    );
    return () => clearTimeout(id);
  }, [fades]);

  return { marks: fades.length ? [...fades, ...marks] : marks, tags };
}

/** Where an agent's arrow points in its range: just inside its bottom-right cell, so its name hangs below the range. */
export function cursorPoint(range: GridRange, rows: Axis, cols: Axis): SheetPoint {
  const right = cols.end(range.c2);
  const bottom = rows.end(range.r2);
  return {
    x: Math.max(cols.start(range.c2), right - Math.min(12, cols.size(range.c2) / 2)),
    y: Math.max(rows.start(range.r2), bottom - Math.min(8, rows.size(range.r2) / 2)),
  };
}

/**
 * Agents' cursors on the sheet shown, on the grid's layer over the cells: each glides to the range its agent works on
 * and follows the grid's own scrolling at once (`view`, redrawn with every frame the grid draws).
 */
export function SheetCursors({
  peers,
  sheet,
  source,
  view,
}: {
  peers: readonly Peer[];
  sheet: string;
  source: DocSource;
  view: GridView;
}) {
  useSyncExternalStore(view.subscribe, view.frame, view.frame);
  const agents = peers.flatMap((peer) => {
    if (peer.self || peer.user.kind !== "agent") return [];
    const range = peerRange(peer, sheet, source);
    return range ? [{ peer, range }] : [];
  });
  return (
    <>
      {agents.map(({ peer, range }) => (
        <PeerCursor
          key={peer.clientId}
          user={peer.user}
          at={cursorPoint(range, source.rows, source.cols)}
          toScreen={view.toScreen}
          working={peerWorking(peer)}
        />
      ))}
    </>
  );
}
