import { useLocalSearchParams } from "expo-router";
import { ChannelMembersScreen } from "@/features/chat/ChannelMembers";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A channel's members (`?channelId=`), pushed from its conversation's pill or "…"; none: the home. */
export default function ChannelMembersRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  if (!isSafeId(channelId)) return <LandOn href="/" />;
  return <ChannelMembersScreen key={channelId} channelId={channelId} />;
}
