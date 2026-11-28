import type { Agent, AgentDetail } from "@agenteschat/client";
import { agentUsageFacts, createdText, lockedText, usageTitle } from "@agenteschat/client/lib/agent-facts";
import { audienceSummary, editorsSummary } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { useDirectory, useOwnerRoles } from "../shared/hooks";

/**
 * A teammate's private agent seen through "Editar agentes" (the web's facts page): who answers for it, who talks to it
 * and edits it, who made it and when, where it works and this month's usage; then what stays locked, and with whom.
 */
export function AgentFacts({
  agent,
  detail,
  owner,
  thinks,
}: {
  agent: Agent;
  detail: AgentDetail | undefined;
  /** Who answers for it, by name (a person or a role). */
  owner: string | null;
  /** What thinks for it, in the profile's words. */
  thinks: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const roles = useOwnerRoles();
  const nameOf = (id: string) => dir.memberById.get(id)?.name;
  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name;
  const g = agentGrammar(agent.name);
  const person = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
  return (
    <>
      <GroupedList>
        {owner ? <GroupedRow icon="person" label={t("agentPage.overview.who", g)} value={owner} /> : null}
        <GroupedRow
          icon="message"
          label={t("audience.section")}
          sub={audienceSummary(t, agent, nameOf, roleName)}
          subLines={0}
        />
        {detail ? (
          <>
            <GroupedRow
              icon="pen"
              label={t("editors.section")}
              sub={editorsSummary(t, { ...agent, editors: detail.editors }, nameOf, roleName)}
              subLines={0}
            />
            <GroupedRow
              icon="calendar"
              label={t("agentPage.facts.created", g)}
              value={createdText(t, i18n.language, detail, nameOf)}
            />
            <GroupedRow
              icon="hash"
              label={t("agentPage.overview.where", g)}
              sub={
                detail.channels.length
                  ? detail.channels.map((c) => `#${c.name}`).join(", ")
                  : t("agentPage.overview.noChannels", { handle: agent.handle })
              }
              subLines={0}
            />
          </>
        ) : null}
      </GroupedList>
      {detail ? (
        <>
          <GroupedHeader>{usageTitle(t, i18n.language)}</GroupedHeader>
          <GroupedList>
            {agentUsageFacts(t, i18n.language, detail, thinks).map((f) => (
              <GroupedRow key={f.key} label={f.label} value={f.value} />
            ))}
          </GroupedList>
        </>
      ) : null}
      <GroupedHeader>{t("agentPage.facts.title", g)}</GroupedHeader>
      <GroupedFooter>{lockedText(t, agent, person)}</GroupedFooter>
    </>
  );
}
