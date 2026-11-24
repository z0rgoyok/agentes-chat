import { useUpdateAgent } from "@agenteschat/client";
import { followsWorkspace, shownApprovalsLevel } from "@agenteschat/client/lib/approvals-level";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { Card } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApprovalsLevelDialog } from "@/components/ApprovalsLevelDialog";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Aprovações (ADR 0173): how much the agent asks before acting, as one line with the choice
 * in sight under its name, "Segue o workspace" while it has no choice of its own. Whoever manages the agent
 * (`managesAgent`) opens the three choices from it. A choice saves at once, outside the page's save bar, and closes the dialog. Anyone else
 * reads the line.
 */
export function ApprovalsLevelCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const update = useUpdateAgent(org.id, agent.id);
  const [open, setOpen] = useState(false);
  const level = shownApprovalsLevel(agent, update);
  const title = t("approvalsLevel.title");
  return (
    <Card as="section" aria-label={title}>
      <div className="settings-rows">
        <PrefRow
          id="agent-approvals-level"
          icon="shield"
          label={title}
          status={
            followsWorkspace(agent) && !update.isPending
              ? t("approvalsLevel.follows")
              : t(`approvalsLevel.${level}.title`)
          }
          onOpen={managesAgent(agent) ? () => setOpen(true) : undefined}
        />
      </div>
      <ApprovalsLevelDialog
        open={open}
        onOpenChange={setOpen}
        description={t("approvalsLevel.lead", { name: agent.name })}
        value={level}
        saving={update.isPending}
        onChoose={(next) => {
          // The agent shows its level at once; a refusal puts it back.
          update.mutate({ approvalsLevel: next });
          setOpen(false);
        }}
      />
    </Card>
  );
}
