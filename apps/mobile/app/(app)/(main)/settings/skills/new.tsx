import { useLocalSearchParams } from "expo-router";
import { routeAgent } from "@/features/settings/install-from-card";
import { InstallSkillScreen } from "@/features/settings/SkillsScreen";

/**
 * "Instalar skill", pushed over Skills; `url`: an agent's card, the link read to pick from; `file` and `name`: an
 * agent's card for a .zip sent in the conversation (its Drive id and name); `agent`: that agent, kept only when its
 * card opened this screen (`routeAgent`); `scope`: the Skills tab it was opened from.
 */
export default function SettingsInstallSkillRoute() {
  const { url, file, name, agent, scope } = useLocalSearchParams<{
    url?: string;
    file?: string;
    name?: string;
    agent?: string;
    scope?: string;
  }>();
  return (
    <InstallSkillScreen
      initialUrl={file ? undefined : url}
      initialFile={file ? { id: file, name: name ?? "" } : undefined}
      forAgentId={routeAgent(file ?? url, agent)}
      scope={scope === "personal" || scope === "team" ? scope : undefined}
    />
  );
}
