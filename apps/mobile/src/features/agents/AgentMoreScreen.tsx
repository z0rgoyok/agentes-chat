import { managesAgent } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedList, GroupedRow } from "@/ui";
import { Gap, SettingsPage } from "../settings/parts";
import { useDirectory, useMeId } from "../shared/hooks";
import { AlwaysApproved } from "./AgentProfileScreen";
import { BrakesSection } from "./BrakesSection";
import { openAgentDelete } from "./DeleteAgentScreen";
import { MergeReposSection } from "./MergeReposSection";
import { ReportsToSection } from "./ReportsToSection";

/**
 * An agent's Advanced, as the web's tab in a personal workspace (ADR 0159 §3): its brakes (work nobody asked for), who
 * it reports to, the actions approved for good, its repositories, and deleting it. Each saves on its own, as on the
 * screens they left; nothing here is new, only out of the way. The settings screens' own page: the bar, the grouped
 * gray under it, the keyboard's room for the project's field.
 */
export function AgentMoreScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const org = useOrg().org;
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const mine = Boolean(meId && agent?.ownerUserId === meId);
  // Who manages it (the server's `canManage`: "Editar qualquer agente" where it reaches).
  const admin = managesAgent(agent);
  const rightHand = isRightHand(agent);
  if (!agent)
    return (
      <SettingsPage title={t("agentPage.tabs.advanced")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  return (
    <SettingsPage title={t("agentPage.tabs.advanced")}>
      {!rightHand ? (
        <>
          <BrakesSection agent={agent} />
          <ReportsToSection agentId={agentId} />
        </>
      ) : null}
      <AlwaysApproved agentId={agentId} name={name} mayRemove={mine || can(org, "approve_actions")} />
      <MergeReposSection agentId={agentId} mayEdit={mine || admin} />
      {/* Deleting for good asks for its name on a screen of its own (ADR 0082). */}
      {admin && !rightHand ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="x"
              label={t("agentPage.delete.action", agentGrammar(name))}
              sub={t("agentPage.delete.help")}
              subLines={2}
              danger
              chevron
              onPress={() => openAgentDelete(agentId)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}
