import { useLocalSearchParams } from "expo-router";
import { PickCategoryScreen } from "@/features/categories/CategoryScreens";
import { LandOn } from "@/ui/navigation";

/** "Categoria" of a channel (`?channelId=`), from its ⋯ sheet or a long press on the home (ADR 0080); none: the home. */
export default function ChannelCategoryRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  if (!channelId) return <LandOn href="/" />;
  return <PickCategoryScreen channelId={channelId} />;
}
