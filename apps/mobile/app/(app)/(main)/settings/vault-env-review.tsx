import { VaultEnvReviewScreen } from "@/features/vault/VaultEnvScreen";

/** The keys of a .env file reviewed and saved: the step after `vault-env` (ADR 0144 §11), pushed by it. */
export default function SettingsVaultEnvReviewRoute() {
  return <VaultEnvReviewScreen />;
}
