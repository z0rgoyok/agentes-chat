import type { LiveFileStatus, LiveKind, LiveMode, LiveRoomError } from "@agenteschat/client";
import type { Peer } from "@agenteschat/live/awareness";
import { colIds, formatA1Range, indexOf, rowIds, sheetIds, sheetName } from "@agenteschat/live/spreadsheet";
import type * as Y from "yjs";

/**
 * Live files on the phone (ADR 0196): where each kind opens, what the bar says about the connection, and how the
 * people and agents in a file are said ("editando B4:C10", "no slide 3"). Pure: the screens draw it.
 */

export type { LiveScreen } from "./routes";
export { hereRoute, LIVE_ICON, LIVE_KINDS_MADE, LIVE_SCREENS, LIVE_SF, LIVE_TOOL_SF, liveRoute } from "./routes";

/** What the bar says under a live file's name. */
export type LiveStatusWord = "opening" | "saved" | "saving" | "offline" | "offlineKept" | "readOnly";

/**
 * The bar's status: opening until the file came, read-only when it is (the trash, a workspace closing), offline while
 * the connection is down (saying so when changes wait on the phone), saving while changes wait for the server, saved.
 */
export function liveStatusWord(view: {
  status: LiveFileStatus;
  mode: LiveMode;
  unsent: boolean;
  loaded: boolean;
}): LiveStatusWord {
  if (!view.loaded) return view.status === "offline" ? "offline" : "opening";
  if (view.status === "offline" || view.status === "connecting") return view.unsent ? "offlineKept" : "offline";
  if (view.mode === "view") return "readOnly";
  return view.unsent ? "saving" : "saved";
}

/** Why a file can't be opened, for the screen's empty state; null while it can. */
export type LiveClosed = "missing" | "signedOut" | "broken";

export function liveClosed(view: { status: LiveFileStatus; error: LiveRoomError | null }): LiveClosed | null {
  if (view.status !== "closed") return null;
  if (view.error === "unauthorized") return "signedOut";
  if (view.error === "invalid") return "broken";
  return "missing";
}

/** Where a person or an agent is in a file, as words ("editando B4:C10", "no slide 3", "vendo"). */
export type PeerWhere =
  | { kind: "range"; label: string; editing: boolean }
  | { kind: "slide"; n: number; editing: boolean }
  | { kind: "shapes"; count: number }
  | { kind: "activity"; key: string; params: Record<string, string> }
  | { kind: "viewing" }
  | { kind: "editing" };

/** An agent's activity key ("live.activity.writing" or "writing") as the key under `live.activity`. */
export const activityKey = (key: string) => (key.startsWith("live.activity.") ? key.slice(14) : key);

/** Where `peer` is in this file's document, for the faces' list and the bar. */
export function peerWhere(doc: Y.Doc | null, kind: LiveKind | null, peer: Pick<Peer, "state">): PeerWhere {
  const state = peer.state;
  const editing = state.mode === "editing";
  if (state.activity?.key)
    return { kind: "activity", key: activityKey(state.activity.key), params: state.activity.params ?? {} };
  if (doc && kind === "spreadsheet" && state.sel?.sheet) {
    const label = sheetRangeLabel(doc, state.sel.sheet);
    if (label) return { kind: "range", label, editing };
  }
  if (doc && kind === "slides") {
    const slide = state.at?.slide ?? state.sel?.slide?.[0];
    const order = slide ? doc.getArray<string>("slideOrder").toArray().indexOf(slide) : -1;
    if (order >= 0) return { kind: "slide", n: order + 1, editing };
  }
  if (kind === "canvas" && editing && state.sel?.canvas?.length)
    return { kind: "shapes", count: state.sel.canvas.length };
  return editing ? { kind: "editing" } : { kind: "viewing" };
}

/**
 * A selection by ids as A1 ("B4:C10"), with the sheet's name when the file has more than one ("Vendas!B4"); null when
 * its rows or columns are gone.
 */
export function sheetRangeLabel(
  doc: Y.Doc,
  sel: { sheet: string; r1: string; c1: string; r2: string; c2: string },
): string | null {
  const rows = indexOf(rowIds(doc, sel.sheet));
  const cols = indexOf(colIds(doc, sel.sheet));
  const r1 = rows.get(sel.r1);
  const r2 = rows.get(sel.r2);
  const c1 = cols.get(sel.c1);
  const c2 = cols.get(sel.c2);
  if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return null;
  const range = formatA1Range(r1, c1, r2, c2, { rows: rows.size, cols: cols.size });
  return sheetIds(doc).length > 1 ? `${sheetName(doc, sel.sheet)}!${range}` : range;
}

/** The faces a bar has room for; the rest is "+N". */
export const HERE_FACES = 3;

/**
 * Who the bar's faces show: everyone in the file but this person (agents at work first, then people editing, then the
 * rest, as `peersOf` orders them), at most `max`, and how many more there are.
 */
export function hereFaces<P extends Pick<Peer, "self">>(
  peers: readonly P[],
  max = HERE_FACES,
): { shown: P[]; more: number } {
  const others = peers.filter((p) => !p.self);
  return { shown: others.slice(0, max), more: Math.max(0, others.length - max) };
}

/** The groups of the "who's here" list: who edits (agents at work first), then who looks, this person first in each. */
export function hereGroups<P extends Pick<Peer, "self" | "state">>(
  peers: readonly P[],
): { key: "editing" | "viewing"; peers: P[] }[] {
  const editing = peers.filter((p) => p.state.mode === "editing");
  const viewing = peers.filter((p) => p.state.mode !== "editing");
  const own = (list: P[]) => [...list.filter((p) => p.self), ...list.filter((p) => !p.self)];
  return [
    { key: "editing" as const, peers: own(editing) },
    { key: "viewing" as const, peers: own(viewing) },
  ].filter((g) => g.peers.length > 0);
}

/** How an Office file shows in the file screen (ADR 0198): a workbook's grid, a deck's slides, a Word page. */
export type OfficeView = "sheet" | "deck" | "word";

/** What an upload is, in the words over its preview (`live.office.kind.*`): by its name, else by how it shows. */
export function officeKindOf(name: string, view: OfficeView): "excel" | "ods" | "csv" | "powerpoint" | "word" {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  if (ext === "ods") return "ods";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (view === "deck") return "powerpoint";
  if (view === "word") return "word";
  return "excel";
}
