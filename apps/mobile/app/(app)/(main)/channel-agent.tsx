import { useLocalSearchParams } from "expo-router";
import { ChannelAgentScreen } from "@/features/chat/ChannelMembers";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** One agent in a channel (`?channelId=&agentId=`), pushed from the channel's members; anything else: the home. */
export default function ChannelAgentRoute() {
  const { channelId, agentId } = useLocalSearchParams<{ channelId?: string; agentId?: string }>();
  if (!isSafeId(channelId) || !isSafeId(agentId)) return <LandOn href="/" />;
  return <ChannelAgentScreen key={`${channelId}:${agentId}`} channelId={channelId} agentId={agentId} />;
}
