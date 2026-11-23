import type { GifMedia, GifSize, MessageMedia, StickerMedia } from "@agenteschat/client";
import { gifLabel, gifMediaUrl, stickerLabel } from "@agenteschat/client/lib/media";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { StickerCanvas, useStickerLive } from "@/agent/StickerCanvas";
import { appHeaders, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { CHROME_MAX_SCALE, Text } from "@/ui";
import { useReducedMotion } from "@/ui/theme";
import { useColors, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useKeptWidth, useMessageCardCorners } from "./look";
import { gifBox, MESSAGE_STICKER } from "./media";
import { useRowDirectory } from "./row-data";

/**
 * A message's GIF or sticker (ADR 0091). `align="end"`: my own message, on the right. `liveId`: the name a sticker
 * goes by on the conversation's stage (`StickerStageContext`, the message's id); without one it stands still.
 */
export function ChatMedia({
  media,
  align = "start",
  liveId,
}: {
  media: MessageMedia;
  align?: "start" | "end";
  liveId?: string;
}) {
  return media.kind === "gif" ? (
    <ChatGif media={media} align={align} />
  ) : (
    <ChatSticker media={media} align={align} liveId={liveId} />
  );
}

/**
 * A GIF's file as `expo-image` loads it: from our server's media route (never the provider: the viewer's address stays
 * with us), with the session like every other picture of ours (cookie + `X-Agentes-Client`).
 */
export const gifImageSource = (orgId: string, id: string, size: GifSize) => ({
  uri: gifMediaUrl(orgId, id, size, serverUrl()),
  headers: appHeaders(lastCookie()),
  cacheKey: `gif:${orgId}:${id}:${size}`,
});

/** How long a GIF fades in the first time it shows. */
const GIF_FADE_MS = 120;
/** How many GIFs are remembered as shown (`shownGifs`): the newest, past it the one shown longest ago goes. */
const SHOWN_GIFS_MAX = 300;
/**
 * The GIFs already shown in this run of the app, by cache key: the list mounts a row again each time it scrolls back
 * into view, and one shown before comes back at once from memory, with no fade.
 */
const shownGifs = new Set<string>();

function markShown(key: string) {
  shownGifs.delete(key);
  shownGifs.add(key);
  if (shownGifs.size > SHOWN_GIFS_MAX) {
    const oldest = shownGifs.values().next();
    if (!oldest.done) shownGifs.delete(oldest.value);
  }
}

/**
 * A GIF (`gifImageSource`), at its own proportions up to 260pt in the app's cut-corner frame, a small "GIF" mark on its corner; with reduced motion, its still frame. A file
 * that no longer loads (an admin turned GIFs off, the GIF gone) leaves a quiet card of its size with its title and
 * the mark, never a broken picture. Kept decoded in memory as well as on disk (`memory-disk`): scrolled back into view
 * it shows at once, never decoded again, and fades in only the first time.
 */
function ChatGif({ media, align }: { media: GifMedia; align: "start" | "end" }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const reduced = useReducedMotion();
  const cardCorners = useMessageCardCorners();
  // Kept across the list's unmounts: a row coming back draws the GIF at its size from its first frame.
  const [width, onWidth] = useKeptWidth(`gif:${align}`);
  const room = Math.floor(width);
  const size = reduced ? "still" : "full";
  // Stable per file, so it isn't fetched again on every render.
  const source = useMemo(() => gifImageSource(orgId, media.id, size), [orgId, media.id, size]);
  const [failed, setFailed] = useState<string | null>(null);
  const off = failed === source.uri;
  // Shown before: no fade this time (read once, at mount, so a load doesn't change it under the picture).
  const [seen] = useState(() => shownGifs.has(source.cacheKey));
  const box = gifBox(media.width, media.height, room);
  const title = media.title.trim();
  return (
    <View onLayout={onWidth} style={[styles.wrap, align === "end" && styles.end]}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={gifLabel(t, media.title)}
        style={[
          styles.gif,
          { width: box.width, height: box.height, backgroundColor: c.sunken, borderColor: c.line },
          cardCorners,
        ]}
      >
        {off ? (
          title ? (
            <View style={styles.offTitle}>
              <Text variant="footnote" tone="muted" numberOfLines={3} style={styles.center}>
                {title}
              </Text>
            </View>
          ) : null
        ) : (
          <Image
            source={source}
            recyclingKey={source.cacheKey}
            contentFit="cover"
            autoplay={!reduced}
            cachePolicy="memory-disk"
            transition={seen ? 0 : GIF_FADE_MS}
            style={StyleSheet.absoluteFill}
            onLoad={() => markShown(source.cacheKey)}
            onError={() => setFailed(source.uri)}
            accessible={false}
          />
        )}
        <View style={[styles.mark, off ? [styles.markOff, { borderColor: c.faint }] : styles.markOn]}>
          <Text
            variant="caption"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.markText, { color: off ? c.faint : "#ffffff" }]}
          >
            {t("media.gifMark")}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * One of an agent's stickers: the agent itself in its mood, drawn from its look by the shared agent engine on Skia
 * (`StickerCanvas`, as avatars are), alive while its row is one of the few the stage lets play, no frame and no
 * background. A former agent's sticker keeps its look; its name and mood are what screen readers say.
 */
function ChatSticker({
  media,
  align,
  liveId,
}: {
  media: StickerMedia;
  align: "start" | "end";
  liveId: string | undefined;
}) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const agent = dir.anyAgent(media.agentId);
  const live = useStickerLive(liveId);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={stickerLabel(t, agent?.name ?? t("mobile.chat.someone"), media.mood)}
      style={[styles.sticker, align === "end" && styles.endSelf]}
    >
      <StickerCanvas
        look={agentLook(agent)}
        mood={media.mood}
        size={MESSAGE_STICKER}
        seed={media.agentId}
        live={live}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  end: { alignItems: "flex-end" },
  endSelf: { alignSelf: "flex-end" },
  // The app's cut corner ("tato com canto"): a hairline, small bottom-left corner.
  gif: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
  },
  offTitle: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 32,
  },
  center: { textAlign: "center" },
  mark: { position: "absolute", left: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6 },
  markOn: { backgroundColor: "rgba(0, 0, 0, 0.55)" },
  markOff: { borderWidth: 1.5 },
  markText: { fontSize: 10.5, lineHeight: 14, fontWeight: "700", letterSpacing: 0.5 },
  sticker: { width: MESSAGE_STICKER, height: MESSAGE_STICKER },
});
