import type { Agent } from "@agenteschat/client";
import { canEditAudience, editorsMode, editorsOf, seesDetails } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedList, GroupedRow } from "@/ui";
import { usePersonalView } from "../settings/hooks";
import { Gap } from "../settings/parts";
import { useMeId, useMyRoleIds } from "../shared/hooks";
import { openAgentEditors, useEditorsSummary } from "./AgentEditorsScreen";

/**
 * "Who can edit" on Edit agent (ADR 0085 addendum of 2026-11-17), after who talks to it as on the web's overview: who
 * changes how it works besides who looks after it, in one line under its name (a list of names, never cut short at the
 * row's end). Its owner and who manages it open the choice on a screen of its own; anyone else who sees how it works
 * reads it. Who doesn't gets no row: the server sends its editors to nobody else, so the line would name nobody. Never
 * on the right hand (ADR 0137); alone in a personal workspace, only once it names someone (ADR 0159).
 */
export function EditorsSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const meId = useMeId();
  const { solo } = usePersonalView();
  const summary = useEditorsSummary();
  const myRoleIds = useMyRoleIds();
  if (isRightHand(agent) || !seesDetails(agent) || (solo && editorsMode(editorsOf(agent)) === "owner")) return null;
  // Who holds the role that answers for it changes it too (ADR 0085, addendum of 2026-11-21).
  const changes = canEditAudience(org ?? undefined, agent, meId ?? "", myRoleIds);
  return (
    <>
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="pen"
          label={t("editors.section")}
          hint={{
            name: t("common.about", { label: t("editors.section") }),
            text: t("editors.note", agentGrammar(agent.name)),
          }}
          sub={summary(agent)}
          subLines={2}
          {...(changes ? { chevron: true, onPress: () => openAgentEditors(agent.id) } : {})}
        />
      </GroupedList>
    </>
  );
}
