import type { Agent } from "@agenteschat/client";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, GroupedList, GroupedRow, haptics, SearchField, useTheme } from "@/ui";
import { AGENT_SEARCH_FROM, agentsMatching } from "../dashboards/logic";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { goBack, PushedHeader } from "../shared/parts";
import { chooseAgents, useAgentChoose } from "./agent-choose";

/**
 * Agents to choose, pushed from a form on an agent's pages (ADR 0135: screens, never sheets), drawn as the widget's
 * agent picker: each agent's face, name and role, the chosen ones checked, a search past a handful. One to choose goes
 * back at once; several stay, each tap saved by the form.
 */
export function AgentChooseScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const pick = useAgentChoose();
  const [query, setQuery] = useState("");
  // Opened with no form under it (its address on its own): nothing to choose for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  const agents = useMemo(
    () => (pick?.ids ?? []).flatMap((id) => dir.agentById.get(id) ?? []),
    [pick?.ids, dir.agentById],
  );
  const shown = useMemo(() => agentsMatching(agents, query), [agents, query]);
  const picked = new Set(pick?.picked ?? []);
  const searching = query.trim() !== "";
  const choose = (agent: Agent | null) => {
    if (!pick) return;
    if (pick.multi && agent) {
      haptics.selection();
      chooseAgents(picked.has(agent.id) ? [...picked].filter((id) => id !== agent.id) : [...picked, agent.id]);
      return;
    }
    chooseAgents(agent ? [agent.id] : []);
    goBack();
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={pick?.title ?? ""} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {agents.length >= AGENT_SEARCH_FROM ? (
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t("rolesPage.agents.search")}
              accessibilityLabel={t("rolesPage.agents.search")}
            />
          </View>
        ) : null}
        {pick && (shown.length > 0 || (pick.none && !searching)) ? (
          <GroupedList>
            {pick.none && !searching && !pick.multi ? (
              <GroupedRow
                key="none"
                icon="x"
                label={pick.none}
                checked={picked.size === 0}
                onPress={() => choose(null)}
              />
            ) : null}
            {shown.map((a) => (
              <GroupedRow
                key={a.id}
                leading={<AgentFace agentId={a.id} size={36} live={false} />}
                label={a.name}
                {...(a.role.trim() ? { sub: a.role.trim() } : {})}
                checked={picked.has(a.id)}
                onPress={() => choose(a)}
              />
            ))}
          </GroupedList>
        ) : null}
        {pick && searching && shown.length === 0 ? (
          // A search that names nobody says so, and offers to clear it.
          <>
            <GroupedFooter>{t("rolesPage.agents.noMatch", { q: query.trim() })}</GroupedFooter>
            <GroupedList>
              <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
            </GroupedList>
          </>
        ) : null}
        {pick && agents.length === 0 && !pick.none ? <GroupedFooter>{t("rolesPage.agents.none")}</GroupedFooter> : null}
        {pick?.note && !searching ? <GroupedFooter>{pick.note}</GroupedFooter> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  search: { paddingBottom: 12 },
});
