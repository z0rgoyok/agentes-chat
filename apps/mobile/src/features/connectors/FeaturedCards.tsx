import type { ConnectorDef } from "@agenteschat/client";
import { brandLook } from "@agenteschat/client/lib/brand-look";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { PressScale, SideScroll, Text, useTheme } from "@/ui";
import { useSurface } from "../shared/parts";
import { BrandArt } from "./BrandArt";
import { ConnectorIcon } from "./ConnectorIcon";

/** A card's height. */
const CARD_H = 196;
/** Between two cards, and the next card's edge left in sight past the one in view. */
const GAP = 10;
const PEEK = 37;
/** The screen's sides. */
const SIDE = 16;
/** No wider than this on a large screen (ADR 0212: the iPhone Duo's inner display), the strip still paging. */
const CARD_MAX = 420;
const MARK = 52;

/**
 * Conectores' featured services, above what is connected: one wide card at a time that pages sideways, the next one's
 * edge in sight. Each card is the service's brand art, as on the web (its colors as soft light, its mark huge and
 * tilted behind), its mark on it, and under it its name and one line of what it is. No button of its own: the whole card opens the
 * service's page (`onOpen`), where it connects, as the catalog's rows do.
 */
export function FeaturedCards({
  defs,
  name,
  text,
  onOpen,
}: {
  defs: readonly ConnectorDef[];
  name: (d: ConnectorDef) => string;
  text: (d: ConnectorDef) => string;
  onOpen: (d: ConnectorDef) => void;
}) {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const card = Math.min(CARD_MAX, Math.max(240, width - SIDE - PEEK - GAP));
  if (defs.length === 0) return null;
  return (
    <SideScroll
      fade={colors.grouped}
      // A card at a time, snapped to the screen's side, as the shelves' columns; a fade at the edge where more wait.
      snapToInterval={card + GAP}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      contentContainerStyle={styles.strip}
    >
      {defs.map((d) => (
        <FeaturedCard key={d.id} def={d} width={card} name={name(d)} text={text(d)} onOpen={() => onOpen(d)} />
      ))}
    </SideScroll>
  );
}

function FeaturedCard({
  def,
  width,
  name,
  text,
  onOpen,
}: {
  def: ConnectorDef;
  width: number;
  name: string;
  text: string;
  onOpen: () => void;
}) {
  const { colors, scheme } = useTheme();
  const surface = useSurface();
  const dark = scheme === "dark";
  return (
    // The app's card with its cut corner; it gives a little under the finger, and opens the service's page.
    <PressScale
      haptic={false}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={[styles.card, surface, { width }]}
    >
      {/* The art and the words clipped to the card's corners; the card's shadow stays outside, on the card. */}
      <View style={styles.clip}>
        <BrandArt
          look={brandLook(def.iconUrl, def.brandColor)}
          template="glow"
          surface={colors.raised}
          dark={dark}
          words="bottom"
        />
        <View style={[styles.mark, { boxShadow: dark ? MARK_RING_DARK : MARK_RING }]}>
          <ConnectorIcon def={def} label={name} size={MARK} />
        </View>
        <View style={styles.body}>
          <Text variant="title2" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {text}
          </Text>
        </View>
      </View>
    </PressScale>
  );
}

/** The mark lifted off its art: a light ring around it and a soft shadow under it (a fainter ring in the dark). */
const MARK_RING = "0 0 0 1.5px rgba(255,255,255,0.9), 0 6px 16px -6px rgba(0,0,0,0.35)";
const MARK_RING_DARK = "0 0 0 1.5px rgba(255,255,255,0.16), 0 6px 16px -6px rgba(0,0,0,0.6)";

const styles = StyleSheet.create({
  strip: { gap: GAP, paddingHorizontal: SIDE, paddingTop: 8, paddingBottom: 4 },
  // Radius 20 with the cut corner, as every card standing on the page; the art stays inside it.
  card: { height: CARD_H, borderRadius: 20, borderBottomLeftRadius: 6 },
  clip: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
  },
  mark: { position: "absolute", top: 16, left: 16, borderRadius: Math.round(MARK * 0.3) },
  body: { position: "absolute", left: 0, right: 0, bottom: 0, gap: 2, paddingHorizontal: 16, paddingBottom: 16 },
});
