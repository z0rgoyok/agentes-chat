import { useLocalSearchParams } from "expo-router";
import { RenameRoleScreen } from "@/features/roles/LookScreen";

/** A cargo's name (`roleId`), pushed over its look. */
export default function SettingsRoleRenameRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RenameRoleScreen roleId={roleId ?? ""} />;
}
