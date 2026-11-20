import { useLocalSearchParams } from "expo-router";
import { AddToRoleScreen } from "@/features/roles/PeopleScreen";

/** Adicionar pessoas to a cargo (`roleId`; `owner`: make owners), pushed over its people. */
export default function SettingsRoleAddRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <AddToRoleScreen roleId={roleId ?? ""} />;
}
