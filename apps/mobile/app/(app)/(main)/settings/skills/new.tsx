import { useLocalSearchParams } from "expo-router";
import { routeAgent } from "@/features/settings/install-from-card";
import { InstallSkillScreen } from "@/features/settings/SkillsScreen";

/**
 * "Instalar skill", pushed over Skills; `url`: an agent's card, the link read to pick from; `agent`: that agent, kept
 * only when its card opened this screen (`routeAgent`); `scope`: the Skills tab it was opened from.
 */
export default function SettingsInstallSkillRoute() {
  const { url, agent, scope } = useLocalSearchParams<{ url?: string; agent?: string; scope?: string }>();
  return (
    <InstallSkillScreen
      initialUrl={url}
      forAgentId={routeAgent(url, agent)}
      scope={scope === "personal" || scope === "team" ? scope : undefined}
    />
  );
}
