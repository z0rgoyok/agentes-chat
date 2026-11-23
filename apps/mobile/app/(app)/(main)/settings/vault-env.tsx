import { useLocalSearchParams } from "expo-router";
import { scopeParam } from "@/features/vault/logic";
import { VaultEnvScreen } from "@/features/vault/VaultEnvScreen";

/** Keys from a .env file (`?scope=personal|team`, the tab it was started from; ADR 0144 §11). */
export default function SettingsVaultEnvRoute() {
  const params = useLocalSearchParams<{ scope?: string }>();
  return <VaultEnvScreen scope={scopeParam(params.scope)} />;
}
