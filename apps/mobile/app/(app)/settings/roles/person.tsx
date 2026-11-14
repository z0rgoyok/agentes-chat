import { useLocalSearchParams } from "expo-router";
import { PersonRolesScreen } from "@/features/roles/PeopleScreen";

/** Cargos de a person (`userId`), from Membros. */
export default function SettingsPersonRolesRoute() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <PersonRolesScreen userId={userId ?? ""} />;
}
