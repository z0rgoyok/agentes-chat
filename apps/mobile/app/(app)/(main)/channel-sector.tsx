import { useLocalSearchParams } from "expo-router";
import { PickSectorScreen } from "@/features/channel-sectors/PickSectorScreen";
import { LandOn } from "@/ui/navigation";

/** "Setor" of a channel (`?channelId=`), from its ⋯ sheet or a long press on the home (ADR 0240); none: the home. */
export default function ChannelSectorRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  if (!channelId) return <LandOn href="/" />;
  return <PickSectorScreen channelId={channelId} />;
}
