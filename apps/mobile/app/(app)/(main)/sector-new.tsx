import { useLocalSearchParams } from "expo-router";
import { NewSectorScreen } from "@/features/team/NewSectorScreen";

/** "Novo setor", from Equipe with no setor yet, or a channel's Setor taking that channel along (`?channelId=`). */
export default function NewSectorRoute() {
  const { channelId } = useLocalSearchParams<{ channelId?: string }>();
  return <NewSectorScreen {...(channelId ? { channelId } : {})} />;
}
