/**
 * The right hand's shared place on the workspace's computer (ADR 0175): the one it works in where others read, like a
 * channel. Without it, an agent's screen is the agent's own, and the right hand's is the viewer's own place.
 */
export const SHARED_SEAT = "shared";
export type Seat = typeof SHARED_SEAT;

/** An agent's screen as the cache names it: the agent's id, or that agent's shared place. */
export const screenId = (agentId: string, seat?: Seat | null) => (seat ? `${agentId}:${seat}` : agentId);

/** Which agent's screens a view shows in a place other than the viewer's own: only the right hand has more than one. */
export interface SeatOf {
  agentId: string;
  seat: Seat;
}

/**
 * The place the right hand's work in a conversation is on, as the server chooses it (`runSeat` in
 * `packages/engine/src/right-hand-seats.ts`): the viewer's own only in their own DM with it, the shared one anywhere
 * else it answers. `ownDm`: the conversation is the viewer's DM with it. Undefined: the viewer's own.
 */
export const conversationSeat = (rightHandId: string | undefined, ownDm: boolean): SeatOf | undefined =>
  rightHandId && !ownDm ? { agentId: rightHandId, seat: SHARED_SEAT } : undefined;
