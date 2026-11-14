import { useLocalSearchParams } from "expo-router";
import { RoleAgentsScreen } from "@/features/roles/AgentsScreen";

/** A cargo's Agentes (`roleId`), pushed over it. */
export default function SettingsRoleAgentsRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RoleAgentsScreen roleId={roleId ?? ""} />;
}
