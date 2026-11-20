import { useLocalSearchParams } from "expo-router";
import { WhoCanScreen } from "@/features/roles/PermissionsScreen";

/** Quem pode (`row`, from `roleId`; `step`: the computers' step Todos goes to), pushed over Permissões. */
export default function SettingsRoleWhoRoute() {
  const { roleId, row, step } = useLocalSearchParams<{ roleId: string; row: string; step?: string }>();
  return <WhoCanScreen roleId={roleId ?? ""} row={row ?? ""} {...(step ? { step: Number(step) } : {})} />;
}
