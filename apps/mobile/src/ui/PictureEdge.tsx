import { StyleSheet, View } from "react-native";
import { useTheme } from "./theme";

/**
 * A live picture's hairline, laid over its own edge inside the box that rounds and clips it. A border in the box's
 * layout would leave the picture a room that no longer has its ratio, and a strip of the box's fill shows beside it.
 * Place it right after the picture, under whatever is drawn on it (a pointer, a tag, a cover). The line color is
 * translucent: it lies on a hairline of the box's fill, so it reads as the thumbnail's over any picture (a white page
 * alone would wash it out).
 */
export function PictureEdge({ radius }: { radius: number }) {
  const { colors } = useTheme();
  const edge = [StyleSheet.absoluteFill, styles.edge, { borderRadius: radius }];
  return (
    <>
      <View pointerEvents="none" style={[edge, { borderColor: colors.sunken }]} />
      <View pointerEvents="none" style={[edge, { borderColor: colors.line }]} />
    </>
  );
}

const styles = StyleSheet.create({
  edge: { borderWidth: StyleSheet.hairlineWidth },
});
