import { useLocalSearchParams } from "expo-router";
import { RolePeopleScreen } from "@/features/roles/PeopleScreen";

/** A cargo's Pessoas (`roleId`), pushed over it. */
export default function SettingsRolePeopleRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RolePeopleScreen roleId={roleId ?? ""} />;
}
