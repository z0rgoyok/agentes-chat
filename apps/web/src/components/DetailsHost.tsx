import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { type DetailsItem, OpenDetailsContext } from "@/components/details-link";
import { lazyDialog } from "@/lib/lazy-dialog";

// Each dialog's code comes when one opens: the workspace's shell holds this host on every page, and the routines'
// and approvals' pages (with the conversations they show) would otherwise load with the first page of any workspace.
const RoutineDetailsDialog = lazyDialog(() => import("@/pages/RoutinesPage").then((m) => m.RoutineDetailsDialog));
const ApprovalDetailsDialog = lazyDialog(() => import("@/pages/ApprovalsPage").then((m) => m.ApprovalDetailsDialog));
const UsageQueueDialog = lazyDialog(() => import("@/components/UsageQueue").then((m) => m.UsageQueueDialog));

/**
 * One details dialog for the workspace, over the page the person is on: a `DetailsLink` opens it in place and
 * the page underneath keeps its place. Like the agent panel, it lives outside the URL; any navigation closes it,
 * a search change too (a run's "Abrir na conversa" into the conversation underneath only sets `?m=`).
 */
export function DetailsHost({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<DetailsItem | null>(null);
  const close = useCallback(() => setItem(null), []);
  const href = useRouterState({ select: (s) => s.location.href });
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setItem(null), [href]);
  return (
    <OpenDetailsContext.Provider value={setItem}>
      {children}
      <Suspense fallback={null}>
        {item?.kind === "routine" && <RoutineDetailsDialog key={item.id} routineId={item.id} onClose={close} />}
        {item?.kind === "approval" && <ApprovalDetailsDialog key={item.id} approvalId={item.id} onClose={close} />}
        {item?.kind === "usage_queue" && (
          <UsageQueueDialog
            key={item.id}
            agentId={item.id}
            tab={item.tab}
            open
            onOpenChange={(open) => !open && close()}
          />
        )}
      </Suspense>
    </OpenDetailsContext.Provider>
  );
}
