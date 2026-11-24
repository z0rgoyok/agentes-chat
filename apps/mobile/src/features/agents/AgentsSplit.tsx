import { useGlobalSearchParams, useIsFocused, useSegments } from "expo-router";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { landOn, router } from "@/ui/navigation";
import { stillHref } from "../links/landing";
import { useOrgId } from "../shared/hooks";
import { FocusLive } from "../shared/parts";
import { SplitPanes, useSelectedTab, useSplitHandoff } from "../shared/SplitPanes";
import { AgentProfileScreen } from "./AgentProfileScreen";
import { AGENTS_TAB, type AgentOpener, AgentOpenerContext, agentHref, agentSplit, pushedAgentOf } from "./split";

/**
 * Agentes on a large screen (ADR 0212: the iPhone Duo's inner display): the team's list (`list`) in the left pane and
 * the chosen agent's page in the right one, the page as its pushed screen draws it (its sky, its bar clear over it with
 * Editar, no back button: the list is beside it), its foot clear of the tab bar. A row opens its agent's page here and
 * stays lit; with none chosen, the list's first agent's page shows (`agentSplit.offer`). The choice is kept per
 * workspace through redraws, remounts and the device closing and opening.
 */
export function AgentsSplit({ list }: { list: ReactNode }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const key = agentSplit.useShownKey(orgId);
  const id = key ? agentSplit.shown(orgId) : null;
  const opener = useMemo<AgentOpener>(() => ({ orgId, open: (agentId) => agentSplit.choose(orgId, agentId) }), [orgId]);
  return (
    <AgentOpenerContext.Provider value={opener}>
      <SplitPanes
        testID="agents-split"
        list={list}
        // Its safe area is its own: the tab bar floats over its foot, where the page's last rows end.
        ownInsets
        detailKey={key && id ? key : null}
        detail={id ? <AgentPane id={id} /> : null}
        empty={t("mobile.agents.splitEmpty")}
      />
    </AgentOpenerContext.Provider>
  );
}

/** The agent's page in its pane, as its route draws it: its faces still while Agentes isn't showing. */
function AgentPane({ id }: { id: string }) {
  return (
    <FocusLive>
      <AgentProfileScreen id={id} />
    </FocusLive>
  );
}

/**
 * Opening and closing the device keeps the agent's page on screen (ADR 0212): closing it with an agent chosen beside
 * the list pushes its page in place (no slide: it was already on screen); opening it with an agent's page pushed over
 * the Agents tab goes back to the tab with that agent beside the list. An agent's page pushed from another tab stays a
 * page. Draws nothing; under Agentes' root, mounted in both sizes.
 */
export function AgentsHandoff({ wide }: { wide: boolean }) {
  const orgId = useOrgId();
  const focused = useIsFocused();
  const segments = useSegments();
  const params = useGlobalSearchParams();
  const selectedTab = useSelectedTab();
  useSplitHandoff(
    wide,
    () => ({
      splitShown: focused,
      chosen: agentSplit.chosen(orgId),
      pushed: selectedTab() === AGENTS_TAB ? pushedAgentOf(segments, params) : null,
    }),
    {
      push: (id) => router.push(stillHref(agentHref(id)) as never),
      take: (id) => {
        agentSplit.choose(orgId, id, true);
        landOn("/agents");
      },
    },
  );
  return null;
}
