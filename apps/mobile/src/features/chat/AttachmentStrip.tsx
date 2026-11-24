import { formatBytes } from "@agenteschat/client/lib/files";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Icon, PressScale, Text, useTheme } from "@/ui";
import { extensionOf, extLabel, isLocalPdf, videoClock } from "../files/logic";
import { FileTile } from "../files/MessageFiles";
import { LocalPdfPage } from "../files/pdf-preview";
import { VideoFirstFrame } from "../files/VideoPlayer";
import { TILE_H, tileWidth } from "./attachment-size";

/** A photo, video or file picked for the next message, waiting in the field until it is sent with the words. */
export interface PendingFile {
  id: string;
  uri: string;
  name: string;
  type: string;
  /** Its size in bytes, when the picker told it (checked against the upload limit as it is picked). */
  size?: number;
  /** A photo's or video's own size in pixels, when the picker told it: its thumbnail keeps that shape. */
  width?: number;
  height?: number;
  /** A video's length in seconds. */
  duration?: number;
  /** `sending` while its upload runs, `failed` when it didn't go (it stays, to try again). */
  state: "waiting" | "sending" | "failed";
}

/** How many go in one message. */
export const MAX_PENDING = 10;

const RADIUS = 12;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const TILE_IN = FadeIn.duration(180).easing(EASE_OUT);
const TILE_OUT = FadeOut.duration(120).easing(EASE_OUT);
const TILE_MOVE = LinearTransition.duration(220).easing(EASE_OUT);

const isImage = (f: PendingFile) => f.type.startsWith("image/");
const isVideo = (f: PendingFile) => f.type.startsWith("video/");

/**
 * What waits to go with the next message, inside the field over the words (the composer's `attachments`), as the
 * phone's own messages hold it: a row of thumbnails one height tall, a photo in its own shape, a video at its first
 * frame with its length, a file as a card with its type, name and size. Each has one × in its corner to take it out.
 * Sending, a thumbnail dims under a spinner; one that didn't go dims under the try-again mark and stays (send tries it
 * again; the toast said why). While a picker still hands files over (iOS converts a video after its picker closes), a
 * thumbnail with a spinner holds their place. A thumbnail that leaves fades and the others close the gap. More come
 * from the "+".
 */
export function AttachmentStrip({
  files,
  preparing = false,
  onRemove,
}: {
  files: PendingFile[];
  /** A picker is still handing files over (iOS converting a video): a thumbnail with a spinner holds their place. */
  preparing?: boolean;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  if (files.length === 0 && !preparing) return null;
  const motion = reducedMotion ? {} : { entering: TILE_IN, exiting: TILE_OUT, layout: TILE_MOVE };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.strip}
      contentContainerStyle={styles.row}
    >
      {files.map((f) => (
        <Animated.View key={f.id} {...motion}>
          <Tile file={f} onRemove={() => onRemove(f.id)} />
        </Animated.View>
      ))}
      {preparing ? (
        <Animated.View
          key="preparing"
          {...motion}
          style={[styles.tile, styles.preparing, { width: TILE_H, backgroundColor: c.sunken, borderColor: c.line2 }]}
          accessible
          accessibilityLabel={t("mobile.chat.attach.preparing")}
        >
          <ActivityIndicator color={c.faint} />
        </Animated.View>
      ) : null}
    </ScrollView>
  );
}

function Tile({ file: f, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const media = isImage(f) || isVideo(f);
  const label = t(
    f.state === "sending"
      ? "mobile.chat.attach.sending"
      : f.state === "failed"
        ? "mobile.chat.attach.failed"
        : "mobile.chat.attach.waiting",
    { name: f.name },
  );
  return (
    <View
      style={[
        styles.tile,
        { width: tileWidth(f), backgroundColor: c.sunken, borderColor: c.line2 },
        !media && styles.fileTile,
      ]}
    >
      {isImage(f) ? (
        <Image source={{ uri: f.uri }} contentFit="cover" transition={120} style={StyleSheet.absoluteFill} />
      ) : isVideo(f) ? (
        <VideoFirstFrame uri={f.uri} />
      ) : (
        <>
          {isLocalPdf(f) ? (
            // A PDF: its first page over its type's tile, read from the phone's own file.
            <View style={styles.page}>
              <FileTile ext={extLabel(extensionOf(f.name))} />
              <LocalPdfPage uri={f.uri} />
            </View>
          ) : (
            <FileTile ext={extLabel(extensionOf(f.name))} />
          )}
          <View style={styles.fileText}>
            <Text variant="caption" style={styles.fileName} numberOfLines={2}>
              {f.name}
            </Text>
            {f.size !== undefined ? (
              <Text variant="caption" tone="faint" numberOfLines={1}>
                {formatBytes(i18n.language || "en", f.size)}
              </Text>
            ) : null}
          </View>
        </>
      )}
      {isVideo(f) && f.state === "waiting" ? (
        <View style={styles.length} pointerEvents="none">
          <Icon name="play" size={8} color="#fff" />
          {f.duration ? <RNText style={styles.lengthText}>{videoClock(f.duration)}</RNText> : null}
        </View>
      ) : null}
      {f.state === "waiting" ? null : (
        <View style={[StyleSheet.absoluteFill, styles.veil]} pointerEvents="none">
          {f.state === "sending" ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.again}>
              <Icon name="replay" size={16} color="#fff" />
            </View>
          )}
        </View>
      )}
      {/* What a screen reader says of it; its × stays a button of its own. */}
      <View style={StyleSheet.absoluteFill} accessible accessibilityLabel={label} />
      {f.state === "sending" ? null : (
        // 22 drawn in the thumbnail's own corner, 44 to the finger; the kit's press, as every control.
        <PressScale
          to={0.85}
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.chat.attach.remove", { name: f.name })}
          hitSlop={11}
          style={styles.x}
          contentStyle={styles.xIn}
        >
          <Icon name="x" size={11} color="#fff" />
        </PressScale>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0 },
  row: { flexDirection: "row", gap: 8 },
  tile: { height: TILE_H, borderRadius: RADIUS, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  // A file: its type's tile and its words side by side, room on the right for the ×.
  preparing: { alignItems: "center", justifyContent: "center" },
  fileTile: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: 28 },
  // A PDF's page in the type tile's own box (`FileTile`: 40 by 48, its corners).
  page: { width: 40, height: 48, borderRadius: 8, overflow: "hidden" },
  fileText: { flex: 1, minWidth: 0, gap: 2 },
  fileName: { fontWeight: "600" },
  length: {
    position: "absolute",
    left: 5,
    bottom: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 5,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  lengthText: { color: "#fff", fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
  veil: { backgroundColor: "rgba(0,0,0,0.42)", alignItems: "center", justifyContent: "center" },
  again: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  x: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  xIn: { alignItems: "center", justifyContent: "center" },
});
