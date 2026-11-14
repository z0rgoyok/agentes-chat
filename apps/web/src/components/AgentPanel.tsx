import type { AgentSection, AgentTab, BrainScreen } from "@agenteschat/client/lib/agent-edit";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { AgentPage } from "@/pages/AgentPage";

/**
 * The agent's page in the side panel (`SidePanel`), wider than a thread. Its ×, the scrim, Esc (`useEscClose`) and its
 * opener again (`closeRequest`, a new number each time) close it, asking first when something is unsaved. Its tab is
 * the URL's (`useAgentPanel`): a tab picked inside goes to `onTab`.
 */
export function AgentPanel({
  agentId,
  tab,
  item,
  closeRequest: asked,
  onTab,
  onClose,
}: {
  agentId: string;
  tab?: AgentTab;
  /** The memory or skill to land on in Memória; with `tab` "settings", `brain:<screen>` for "Quem pensa". */
  item?: string;
  closeRequest?: number;
  onTab: (tab: AgentTab) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const shown = tab ?? "overview";
  // "brain:<screen>" (the model picker's "Mais opções"): "Quem pensa" opens on that screen.
  const [brainAt] = useState(() =>
    tab === "settings" && item?.startsWith("brain:") ? (item.slice(6) as BrainScreen) : undefined,
  );
  // A section belongs to the tab it was picked on: a tab the URL moves to (Back, a card) opens at its top.
  const [picked, setPicked] = useState<{ tab: AgentTab; section?: AgentSection }>(() =>
    brainAt ? { tab: "settings", section: "brain" } : { tab: shown },
  );
  const [closeRequest, setCloseRequest] = useState(0);
  const request = () => setCloseRequest((n) => n + 1);
  useEscClose(request);
  useEffect(() => {
    if (asked) setCloseRequest((n) => n + 1);
  }, [asked]);
  return (
    <SidePanel
      inAddress
      className="thread-panel--wide"
      label={t("agentPage.panel.label", agentGrammar(name))}
      onClose={request}
    >
      <Button
        size="sm"
        iconOnly
        icon="close"
        className="agp-glass thread-panel__close"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={request}
      />
      <div className="thread-panel__page">
        <AgentPage
          agentId={agentId}
          tab={shown}
          section={picked.tab === shown ? picked.section : undefined}
          {...(brainAt ? { brainAt } : { item })}
          onNavigate={(next, section) => {
            setPicked({ tab: next, section });
            if (next !== shown) onTab(next);
          }}
          onClose={onClose}
          closeRequest={closeRequest}
        />
      </div>
    </SidePanel>
  );
}
