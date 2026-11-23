import { type LivePresent, type LiveRoom, useLivePeers } from "@agenteschat/client";
import type { Peer } from "@agenteschat/live/awareness";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Count, PressScale, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { Face } from "../../shared/Face";
import { hereFaces } from "../logic";
import { hereRoute } from "../routes";
import { usePeerLook } from "./peers";

/** The faces' size in the bar, and the ring around each (the bar's color, or the person's while they edit). */
const FACE = 20;
const RING = 2;

/**
 * Who else is in a live file now, in its bar (ADR 0196 §5): up to three faces overlapping, then "+N", as a
 * conversation's pill shows who is in it. People are circles, agents their tile; whoever edits is ringed in their own
 * color, and an agent at work moves. Hidden people never come (the server leaves them out). A tap opens the list of who
 * is here, to follow one of them. Nothing while the person is alone in the file.
 */
export const HereFaces = memo(function HereFaces({
  room,
  fileId,
  ring,
}: {
  room: LiveRoom | null;
  fileId: string;
  /** The color behind the faces (the bar's): each face is ringed in it, so the overlap reads. */
  ring?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const look = usePeerLook();
  const peers = useLivePeers(room);
  const { shown, more } = hereFaces(peers);
  if (shown.length === 0) return null;
  const others = shown.length + more;
  const editing = peers.filter((p) => !p.self && p.state.mode === "editing").length;
  return (
    <PressScale
      haptic={false}
      onPress={() => router.push(hereRoute(fileId))}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.live.here.faces", { count: others, editing })}
      hitSlop={10}
      contentStyle={styles.rowIn}
    >
      {shown.map((peer, i) => (
        <StackFace
          key={`${peer.user.kind}:${peer.user.id}`}
          peer={peer}
          first={i === 0}
          ring={ring ?? colors.bg}
          look={look}
        />
      ))}
      {more > 0 ? (
        <View style={[styles.more, styles.overlap, { borderColor: ring ?? colors.bg, backgroundColor: colors.plate }]}>
          <Count value={more} size={11} color={colors.muted} />
        </View>
      ) : null}
    </PressScale>
  );
});

function StackFace({
  peer,
  first,
  ring,
  look,
}: {
  peer: Peer;
  first: boolean;
  ring: string;
  look: ReturnType<typeof usePeerLook>;
}) {
  const agent = peer.user.kind === "agent";
  const editing = peer.state.mode === "editing";
  return (
    <View
      style={[
        styles.face,
        !first && styles.overlap,
        agent ? styles.tile : styles.round,
        { borderColor: editing ? look(peer.user).tint : ring },
      ]}
    >
      <Face
        who={{ type: agent ? "agent" : "person", id: peer.user.id }}
        size={FACE}
        live={false}
        mode={agent && editing ? "run" : "idle"}
      />
    </View>
  );
}

/** A card's faces: this many at most, then "+N". */
const CARD_FACES = 3;
const CARD_FACE = 18;

/**
 * Who is in a file now, on its card (the Drive's, a message's): up to three faces of 18 overlapping, then "+N", from
 * the presence the cards ask for (`useLivePresence`); whoever edits ringed in their color. Nothing when nobody is in.
 */
export const PresentFaces = memo(function PresentFaces({
  present,
  ring,
}: {
  present: readonly LivePresent[] | undefined;
  /** The color behind the faces. */
  ring: string;
}) {
  const look = usePeerLook();
  const { colors } = useTheme();
  if (!present || present.length === 0) return null;
  const shown = present.slice(0, CARD_FACES);
  const more = present.length - shown.length;
  return (
    <View style={styles.row} accessible={false} importantForAccessibility="no-hide-descendants">
      {shown.map((p, i) => {
        const agent = p.kind === "agent";
        const editing = p.mode === "editing";
        return (
          <View
            key={`${p.kind}:${p.id}`}
            style={[
              styles.face,
              i > 0 && styles.overlap,
              agent ? styles.cardTile : styles.cardRound,
              { borderColor: editing ? look({ kind: p.kind, id: p.id }).tint : ring },
            ]}
          >
            <Face
              who={{ type: agent ? "agent" : "person", id: p.id }}
              size={CARD_FACE}
              live={false}
              mode={agent && editing ? "run" : "idle"}
            />
          </View>
        );
      })}
      {more > 0 ? (
        <View style={styles.cardMore}>
          <Count value={more} size={11} color={colors.muted} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  cardRound: { borderRadius: (CARD_FACE + RING * 2) / 2, overflow: "hidden" },
  cardTile: { borderRadius: Math.round((CARD_FACE + RING * 2) * 0.3) },
  cardMore: { marginLeft: 4 },
  // The bar's faces (inside their press: `contentStyle`), and a card's.
  rowIn: { flexDirection: "row", alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center" },
  face: { borderWidth: RING },
  overlap: { marginLeft: -6 },
  round: { borderRadius: (FACE + RING * 2) / 2, overflow: "hidden" },
  // An agent's tile keeps its corner: 30% of the side, as every face tile.
  tile: { borderRadius: Math.round((FACE + RING * 2) * 0.3) },
  more: {
    minWidth: FACE + RING * 2,
    height: FACE + RING * 2,
    paddingHorizontal: 4,
    borderWidth: RING,
    borderRadius: (FACE + RING * 2) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
