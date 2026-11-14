import { type SeatOf, SHARED_SEAT, screenId } from "@agenteschat/client/lib/seat";
import { SeatContext } from "@agenteschat/client/lib/seat-context";
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ComputerScreen } from "@/features/computer/ComputerScreen";
import { FocusLive } from "@/features/shared/parts";

/**
 * An agent's computer, full screen (presentation set in `_layout`; from its profile's Computador). `seat=shared`: the
 * right hand's shared place on the workspace's computer (ADR 0175), which everything on the screen then reads and
 * drives instead of the viewer's own.
 */
export default function ComputerRoute() {
  const { agentId, seat } = useLocalSearchParams<{ agentId: string; seat?: string }>();
  const shared = seat === SHARED_SEAT ? SHARED_SEAT : undefined;
  const seatOf = useMemo<SeatOf | undefined>(() => (shared ? { agentId, seat: shared } : undefined), [agentId, shared]);
  return (
    <FocusLive>
      <SeatContext.Provider value={seatOf}>
        <ComputerScreen key={screenId(agentId, shared)} agentId={agentId} />
      </SeatContext.Provider>
    </FocusLive>
  );
}
