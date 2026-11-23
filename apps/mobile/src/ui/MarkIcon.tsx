import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { useTheme } from "./theme";

/**
 * A one-color brand logo (a `/connectors/` file) as one of the line icons: the `Icon` box at `size`, in its color, the
 * logo where their strokes sit on the 24 grid (4 clear on each side), so it weighs what the icons beside it do. The
 * `fallback` icon while it has no address or its file fails to load.
 */
export function MarkIcon({
  uri,
  size = 20,
  color,
  fallback,
}: {
  uri: string | null;
  size?: number;
  color?: string;
  fallback: IconName;
}) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  if (!uri || failed === uri) return <Icon name={fallback} size={size} {...(color ? { color } : {})} />;
  const drawn = Math.round((size * 16) / 24);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessible={false}>
      <Image
        source={{ uri }}
        cachePolicy="memory-disk"
        tintColor={color ?? colors.ink2}
        contentFit="contain"
        style={{ width: drawn, height: drawn }}
        onError={() => setFailed(uri)}
      />
    </View>
  );
}
