import { useLocalSearchParams } from "expo-router";
import { RoleScreen } from "@/features/roles/RoleScreen";

/** A cargo (`roleId`; `owner`: the owners), pushed over the cargos. */
export default function SettingsRoleRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RoleScreen roleId={roleId ?? ""} />;
}
