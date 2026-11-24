import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { Text, useTheme } from "@/ui";
import { Face } from "../../shared/Face";
import { useDirectory } from "../../shared/hooks";
import { DRAFT_PIN, MEDIA_PIN_H, type MediaPin, pinAnchor } from "./logic";

/**
 * The comments pinned on a picture (ADR 0208), over it in the viewer, in its box as it zooms: each one the canvas's
 * pin (ADR 0199), a raised bubble with its author's face and its number, its cut corner on the spot it points at (an
 * area's top right corner). It stays the screen's own size at any zoom (`zoom`, the picture's now). The viewer reads a
 * tap on one (`pinUnder`): the pins take no touch of their own. `draft`: the comment being written in the sheet over
 * the file (`draftPin`), the person's face and the number it will take, ringed, over the others. The same pins stand
 * on a video's frame and on a PDF's page.
 */
export function PicturePins({
  pins,
  zoom,
  draft = null,
}: {
  pins: readonly MediaPin[];
  zoom: Readonly<SharedValue<number>>;
  draft?: MediaPin | null;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pins.map((pin) => (
        <PicturePin key={pin.messageId} pin={pin} zoom={zoom} />
      ))}
      {draft ? <PicturePin key={DRAFT_PIN} pin={draft} zoom={zoom} draft /> : null}
    </View>
  );
}

function PicturePin({
  pin,
  zoom,
  draft = false,
}: {
  pin: MediaPin;
  zoom: Readonly<SharedValue<number>>;
  draft?: boolean;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const name = useDirectory().nameOf(pin.author);
  // Its corner stays on its spot while the picture grows around it.
  const steady = useAnimatedStyle(() => ({ transform: [{ scale: 1 / Math.max(zoom.value, 0.01) }] }));
  const mark = pin.selection.mark;
  if (!mark) return null;
  const at = pinAnchor(mark);
  return (
    <Animated.View
      accessible
      accessibilityLabel={t("mobile.live.canvas.pin", { n: pin.n, name })}
      style={[
        styles.pin,
        {
          left: `${at.x * 100}%`,
          bottom: `${(1 - at.y) * 100}%`,
          backgroundColor: c.raised,
          // The draft is ringed in ink, a ring of its own white around that: it reads as the one being written.
          boxShadow: draft ? `${shadows.e2}, 0px 0px 0px 2px ${c.ink}, 0px 0px 0px 4px ${c.raised}` : shadows.e2,
        },
        pin.old && styles.old,
        steady,
      ]}
    >
      <Face who={pin.author} size={18} live={false} />
      <Text variant="caption" style={styles.n}>
        {pin.n}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pin: {
    position: "absolute",
    height: MEDIA_PIN_H,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingLeft: 3,
    paddingRight: 7,
    // Its corners follow the face's: the face's radius (30% of 18) plus the 3 around it.
    borderRadius: 8,
    // The corner on the spot it points at, cut as the app's cards are; the zoom's steadying keeps it there.
    borderBottomLeftRadius: 3,
    transformOrigin: "left bottom",
  },
  // Made on an older version than the one shown.
  old: { opacity: 0.55 },
  n: { fontWeight: "700" },
});
