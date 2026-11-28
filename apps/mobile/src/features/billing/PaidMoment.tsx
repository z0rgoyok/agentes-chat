import {
  keys,
  useAiStatus,
  useApi,
  useComputerSetup,
  useMachines,
  useMe,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { paidComputerLine, paidLine, paidRoom, planHeldNext } from "@agenteschat/client/lib/billing";
import { setupView, workspaceComputerOn } from "@agenteschat/client/lib/computer";
import { mayConnectAi, teamThinks } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openConnectAi } from "@/features/ai/NoAiCard";
import { useRevealed } from "@/features/launch/launched";
import { useOpenDm } from "@/features/new/useOpenDm";
import { useDirectory, useMeId } from "@/features/shared/hooks";
import { TeamSkyEmpty } from "@/features/shared/TeamSkyEmpty";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { Button, SheetScreen } from "@/ui";
import { router } from "@/ui/navigation";

const heldList = (): string[] => {
  try {
    const v: unknown = JSON.parse(readValueSync(STORED.planHeld) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The web's moment right after paying (ADR 0079), on the phone, which never sees the billing service's return: the
 * first time it opens a workspace whose plan turned on since it last looked (`planHeldNext`), the sheet opens once
 * the app is in view, with what it says already read. Never on a first look at a workspace.
 */
export function usePlanTurnedOn() {
  const orgs = useMe().data?.organizations;
  const { orgId } = useOrg();
  const revealed = useRevealed();
  const api = useApi();
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgs || !revealed) return;
    const before = heldList();
    const next = planHeldNext(before, orgs, orgId);
    if (next.held.join() !== before.join()) writeValueSync(STORED.planHeld, JSON.stringify(next.held));
    if (!next.turnedOn) return;
    // The sheet opens whole: its words never change under the person.
    void Promise.all([
      qc.prefetchQuery({ queryKey: keys.limits(orgId), queryFn: () => api.orgs.limits(orgId) }),
      qc.prefetchQuery({ queryKey: keys.computerSetup(orgId), queryFn: () => api.machines.computerSetup(orgId) }),
      qc.prefetchQuery({ queryKey: keys.machines(orgId), queryFn: () => api.machines.list(orgId) }),
    ]).then(() => router.push("/paid-moment"));
  }, [orgs, orgId, revealed, api, qc]);
}

/**
 * The plan just turned on: the team hops up happy on its sky, the plan in force (the phone never knows its name), the
 * workspace's computer as it is now (else what the plan gives), and the web's one way on: an AI for the team to think
 * with while it has none and the person may connect one, else the first conversation, with the right hand. The button
 * waits for the AI status, so it never changes under the person.
 */
export function PaidMomentSheet({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const limits = useWorkspaceLimits(orgId);
  const setup = useComputerSetup(orgId);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const machines = useMachines(orgId, view?.phase === "ready");
  const meId = useMeId();
  const openDm = useOpenDm();
  const lead = rightHandOf(dir.agents);
  const thinks = teamThinks(
    dir.agents.map((a) => a.id),
    status.data,
  );
  const toConnect = thinks === false && (can(org, "create_agents") || mayConnectAi(lead, meId, org));
  const next =
    thinks === undefined
      ? null
      : toConnect
        ? { label: t("paidMoment.next.ai"), run: () => openConnectAi({}) }
        : lead
          ? { label: t("paidMoment.next.talk", { name: lead.name }), run: () => void openDm({ agentId: lead.id }) }
          : null;
  const on = workspaceComputerOn(view, machines.data);
  const text =
    on === null ? (paidRoom(t, i18n.language, limits.data) ?? "") : paidComputerLine(t, on, org?.role === "owner");
  return (
    <SheetScreen fit>
      <TeamSkyEmpty
        celebrate
        title={paidLine(t, null, undefined)}
        text={text}
        action={
          next ? (
            <Button
              variant="primary"
              wide
              label={next.label}
              onPress={() => {
                onClose();
                next.run();
              }}
            />
          ) : undefined
        }
      />
    </SheetScreen>
  );
}
