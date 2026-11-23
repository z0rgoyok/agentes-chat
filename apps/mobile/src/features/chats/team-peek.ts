/**
 * The team peeking up from behind the tab bar as Conversas is pulled past its last row (`TeamPeek`): the conversation's
 * own peek (`../chat/peek.ts`) with a row of faces. Who peeks, where each one stands and how it rises with the pull.
 * Pure, so the pose runs on the UI thread (a worklet) and in tests.
 */
import { PEEK_AT, PEEK_RISE, PEEK_SIZE } from "../chat/peek";

/** At most this many faces: the right hand in the middle, two on each side. */
export const TEAM_PEEK_MAX = 5;
/** Each step out from the middle starts rising this many points of pull later. */
export const TEAM_PEEK_STEP = 8;
/** Between two faces of the row. */
export const TEAM_PEEK_GAP = 8;

interface PeekRow {
  kind: string;
  with?: { type: string; id: string };
}

/**
 * Who peeks: the right hand first (it takes the middle), then the agents of the most recent conversations as the list
 * has them, each once; never a hidden agent, at most `TEAM_PEEK_MAX`. Nobody where the home has no agent.
 */
export function teamPeekers(
  rightHandId: string | null,
  rows: readonly PeekRow[],
  hidden: ReadonlySet<string>,
  max = TEAM_PEEK_MAX,
): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (ids.length < max && !hidden.has(id) && !ids.includes(id)) ids.push(id);
  };
  if (rightHandId) add(rightHandId);
  for (const r of rows) if (r.kind === "dm" && r.with?.type === "agent") add(r.with.id);
  return ids;
}

/**
 * The row left to right: the first face in the middle, the next ones out from it (the left side first), and each one's
 * rank, how many steps from the middle it stands.
 */
export function teamRow(ids: readonly string[]): { id: string; rank: number }[] {
  const middle = (ids.length - 1) / 2;
  const slots = ids.map((_, i) => i).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
  const row: { id: string; rank: number }[] = new Array(ids.length);
  slots.forEach((slot, i) => {
    row[slot] = { id: ids[i] ?? "", rank: Math.floor(Math.abs(slot - middle)) };
  });
  return row;
}

/**
 * Where a face of the row stands for a pull, as the conversation's face (`peekPose`): `y` down in its box and its
 * opacity. The middle one starts first; each step out starts `TEAM_PEEK_STEP` later and rises over the same stretch,
 * so the outermost (`lastRank`) arrives exactly at `PEEK_AT`, the moment the phone taps. Straight from the pull, no
 * spring. Reduced motion: none moves, each fades in where it arrives.
 */
export function teamFacePose(
  pull: number,
  rank: number,
  lastRank: number,
  reduced: boolean,
): { y: number; opacity: number } {
  "worklet";
  const span = PEEK_AT - lastRank * TEAM_PEEK_STEP;
  const t = Math.min(1, Math.max(0, (pull - rank * TEAM_PEEK_STEP) / span));
  if (reduced) return { y: PEEK_SIZE - PEEK_RISE, opacity: t };
  return { y: PEEK_SIZE - PEEK_RISE * t, opacity: Math.min(1, t * 2) };
}
