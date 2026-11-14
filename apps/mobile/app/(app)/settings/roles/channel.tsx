import { useLocalSearchParams } from "expo-router";
import { ChannelWhoScreen } from "@/features/roles/ChannelsScreen";

/** Quem vê a channel (`channelId`, from `roleId`), pushed over Canais. */
export default function SettingsRoleChannelRoute() {
  const { roleId, channelId } = useLocalSearchParams<{ roleId: string; channelId: string }>();
  return <ChannelWhoScreen roleId={roleId ?? ""} channelId={channelId ?? ""} />;
}
