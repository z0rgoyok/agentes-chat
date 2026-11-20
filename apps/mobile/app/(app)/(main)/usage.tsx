import { useLocalSearchParams } from "expo-router";
import { UsageScreen } from "@/features/usage/UsageScreen";

/**
 * Uso: the workspace's plan accounts and API use, as the web's Configurações › Uso. `?view=people` opens on the people's
 * months (one's own, for who doesn't see money): a person's "See my usage" lands there.
 */
export default function UsageRoute() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return <UsageScreen initialView={view === "people" ? "people" : "summary"} />;
}
