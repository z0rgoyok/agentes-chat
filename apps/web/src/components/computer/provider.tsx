import { type Seat, screenId } from "@agenteschat/client/lib/seat";
import { SeatContext } from "@agenteschat/client/lib/seat-context";
import { type ReactNode, Suspense, useCallback, useMemo, useState } from "react";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lazyDialog } from "@/lib/lazy-dialog";
import { type OpenComputer, OpenComputerContext, OpenedComputerContext } from "./open";

// The dialog (the agent's screen, its browser and desktop views) comes when a computer opens, not with the shell.
const LazyComputerDialog = lazyDialog(() => import("./ComputerDialog").then((m) => m.ComputerDialog));

/**
 * One computer dialog for the workspace: its agent page's entry, the DM's button, a computer's page and the
 * chat's cards open an agent's computer here, in place.
 */
export function ComputerDialogProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [opened, setOpened] = useState<{ agentId: string; seat?: Seat } | null>(null);
  const agent = opened ? dir.agentById.get(opened.agentId) : undefined;
  const open = useCallback<OpenComputer>((agentId, seat) => setOpened({ agentId, ...(seat ? { seat } : {}) }), []);
  const close = useCallback(() => setOpened(null), []);
  const seatOf = useMemo(
    () => (opened?.seat ? { agentId: opened.agentId, seat: opened.seat } : undefined),
    [opened?.agentId, opened?.seat],
  );
  return (
    <OpenComputerContext.Provider value={open}>
      <OpenedComputerContext.Provider value={agent ? agent.id : null}>{children}</OpenedComputerContext.Provider>
      {agent && (
        // The right hand's shared place is another screen than the viewer's own: everything the dialog reads and does
        // goes to the one it was opened for.
        <SeatContext.Provider value={seatOf}>
          <Suspense fallback={null}>
            <LazyComputerDialog key={screenId(agent.id, opened?.seat)} agent={agent} open onClose={close} />
          </Suspense>
        </SeatContext.Provider>
      )}
    </OpenComputerContext.Provider>
  );
}
