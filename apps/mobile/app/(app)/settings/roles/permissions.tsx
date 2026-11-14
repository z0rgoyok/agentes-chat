import { useLocalSearchParams } from "expo-router";
import { RolePermissionsScreen } from "@/features/roles/PermissionsScreen";

/** A cargo's Permissões (`roleId`), pushed over it. */
export default function SettingsRolePermissionsRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RolePermissionsScreen roleId={roleId ?? ""} />;
}
