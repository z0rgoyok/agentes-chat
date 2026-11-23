import { useLocalSearchParams } from "expo-router";
import { AddChannelMembersScreen } from "@/features/chat/ChannelMembers";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** Adding people and agents to a channel (`?channelId=`), pushed from its members; none: the home. */
export default function AddChannelMembersRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  if (!isSafeId(channelId)) return <LandOn href="/" />;
  return <AddChannelMembersScreen key={channelId} channelId={channelId} />;
}
