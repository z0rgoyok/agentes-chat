import { useLocalSearchParams } from "expo-router";
import { RoleChannelsScreen } from "@/features/roles/ChannelsScreen";

/** A cargo's Canais (`roleId`), pushed over it. */
export default function SettingsRoleChannelsRoute() {
  const { roleId } = useLocalSearchParams<{ roleId: string }>();
  return <RoleChannelsScreen roleId={roleId ?? ""} />;
}
