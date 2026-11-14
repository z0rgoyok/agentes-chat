import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo } from "react";
import { useDms } from "../api/queries";
import { conversationSeat, type Seat, type SeatOf } from "./seat";

/**
 * Which of the right hand's places the screens inside show (ADR 0175): the viewer's own when absent. Set around a
 * view of the shared one, so every read and action of its screen in there goes to that place and is kept apart in
 * the cache. It names the agent: every other agent's screens inside stay their one screen.
 */
export const SeatContext = createContext<SeatOf | undefined>(undefined);

const seatFor = (of: SeatOf | undefined, agentId: string | undefined) =>
  of && of.agentId === agentId ? of.seat : undefined;

/** The place of `agentId`'s the screens here show: undefined for its one screen, or the viewer's own. */
export const useSeat = (agentId: string | undefined): Seat | undefined => seatFor(useContext(SeatContext), agentId);

/** `useSeat` for an agent known only when it is acted on. */
export const useSeatFor = () => {
  const of = useContext(SeatContext);
  return useCallback((agentId: string) => seatFor(of, agentId), [of]);
};

/**
 * Around a conversation's messages: the cards of the right hand's work in them read and act on the place that work
 * is on (`conversationSeat`), not on the viewer's own. `dm`: the conversation is a DM, which counts as the viewer's
 * own with it until their DMs have loaded.
 */
export function ConversationSeat({
  orgId,
  channelId,
  rightHandId,
  dm,
  children,
}: {
  orgId: string;
  channelId: string;
  rightHandId: string | undefined;
  dm: boolean;
  children?: ReactNode;
}) {
  const dms = useDms(orgId).data;
  const ownDm = dms ? dms.some((d) => d.channelId === channelId && d.with.id === rightHandId) : dm;
  const value = useMemo(() => conversationSeat(rightHandId, ownDm), [rightHandId, ownDm]);
  return createElement(SeatContext.Provider, { value }, children);
}
