import { useLocalSearchParams } from "expo-router";
import { AccountAudienceScreen } from "@/features/ai/AiHubScreens";
import type { Permission } from "@/features/ai/hub";

/** The roles or people of an AI account's permission (`?permission=&mode=roles|people`). */
export default function AccountAudienceRoute() {
  const { id, permission, mode } = useLocalSearchParams<{ id: string; permission: Permission; mode: string }>();
  return (
    <AccountAudienceScreen
      accountId={id ?? ""}
      permission={permission ?? "use"}
      mode={mode === "roles" ? "roles" : "people"}
    />
  );
}
