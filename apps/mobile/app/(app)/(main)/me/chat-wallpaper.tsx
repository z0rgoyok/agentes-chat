import { useLocalSearchParams } from "expo-router";
import { wallpaperTargetOf } from "@/features/chat/wallpaper-logic";
import { WallpaperPage } from "@/features/me/WallpaperPage";

/**
 * Background: with no params from You › Conversations (the one behind every conversation), or `?channelId=` from a
 * conversation's options (that conversation's own).
 */
export default function ChatWallpaperRoute() {
  const params = useLocalSearchParams<{ channelId?: string }>();
  return <WallpaperPage target={wallpaperTargetOf(params)} />;
}
