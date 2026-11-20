import { useLocalSearchParams } from "expo-router";
import { RoleLookScreen } from "@/features/roles/LookScreen";

/** A cargo's Nome, cor e ícone (`roleId`), pushed over it. */
export default function SettingsRoleLookRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RoleLookScreen roleId={roleId ?? ""} />;
}
