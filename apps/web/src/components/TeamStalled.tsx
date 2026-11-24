import { useAgentStatuses } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { budgetPausedIds, budgetStalledText } from "@agenteschat/client/lib/team-watch";
import { Button, Icon } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./no-ai.css";

/**
 * Above #general's composer: the agents whose work waits on their monthly budget, so a stall that started in a DM
 * between agents is seen where the team reads. Who manages agents raises it from here: the agent's budget, or Uso for
 * several.
 */
export function TeamStalledBanner() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const paused = budgetPausedIds(useAgentStatuses(org.id).data).flatMap((id) => dir.agentById.get(id) ?? []);
  const first = paused[0];
  if (!first) return null;
  const raise = () =>
    paused.length === 1
      ? void navigate({
          to: "/org/$orgId/agents/$agentId",
          params: { orgId: org.id, agentId: first.id },
          search: { tab: "settings", sec: "budget" },
        })
      : void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } });
  return (
    <div className="noai-banner ac-actline" role="status">
      <span className="noai-banner__text ac-iconline">
        <Icon name="pause" size={16} />
        <span>
          <b>{t("channel.teamStalled")}</b>{" "}
          {budgetStalledText(
            t,
            paused.map((a) => a.name),
          )}
        </span>
      </span>
      {can(org, "manage_agents") && (
        <Button size="sm" onClick={raise}>
          {t("notifications.teamWatch.act.budget")}
        </Button>
      )}
    </div>
  );
}
