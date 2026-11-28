import type { ArtifactDetail } from "@agenteschat/client";
import { formatBytes, mediaKindOfArtifact, pictureRatio, previewKindOfName } from "@agenteschat/client/lib/files";
import { keepWhole } from "@agenteschat/client/lib/format";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import { Icon, MESSAGE_CARD_X, PressScale, Text } from "@/ui";
import { ChoicesCard } from "../blocks/ChoicesCard";
import { LiveBlockCard } from "../blocks/LiveBlock";
import { PollCard } from "../blocks/PollCard";
import { FileCommentsLink } from "../chat/cards";
import { useKeptWidth, useMessageCardCorners, useMessageCardFrame } from "../chat/look";
import { LiveFileCard } from "../live-files/LiveFileCard";
import { opensLive } from "../live-files/routes";
import { useColors, useOrgId } from "../shared/hooks";
import { AttachmentTile } from "./AttachmentTile";
import { FileVoice } from "./FileVoice";
import { ImageStack, type StackImage } from "./ImageStack";
import { isLocalMedia, type LocalFile, localRatio } from "./local-files";
import {
  extensionOf,
  extLabel,
  type FileInfo,
  type FileRef,
  fileInfo,
  IMAGE_EXT,
  isLocalPdf,
  singleImageBox,
  VIDEO_EXT,
  videoBox,
  videoClock,
} from "./logic";
import { openFile } from "./open";
import { LocalPdfPage } from "./pdf-preview";
import { pictureDrawn, pictureFade, rememberLocalCopy, useArtifacts, usePicture, useRemoteFile } from "./source";
import { VideoFirstFrame, VideoPlayer } from "./VideoPlayer";

/**
 * A message's files. Pictures alone: one inline, whole in a box of one shape, or several as a deck to swipe through
 * (`ImageStack`), tapping opens the viewer at that picture. Any other attachment: a tile across the row
 * (`AttachmentTile`: what it holds drawn small, its name, whole, with its kind and size under it), with the pictures
 * beside them as tiles of only the picture, two to a row (as on the web's phone width). A video shows its first frame in
 * the pictures' shape and opens in the same viewer as they do. `align="end"`: the viewer's own message, its files sit on
 * the right.
 */

export interface MessageFile {
  id: string;
  version?: number;
  title: string;
  deleted: boolean;
  /** A picture's size, from its ref on the message (`artifactsOf`). */
  width?: number;
  height?: number;
}

/** Widest a picture block gets in a message. */
const MAX_WIDTH = 300;
/** Between two tiles in a row. */
const GAP = 8;

export function MessageFiles({ files, align = "start" }: { files: MessageFile[]; align?: "start" | "end" }) {
  const orgId = useOrgId();
  const live = files.filter((f) => !f.deleted);
  const queries = useArtifacts(
    orgId,
    live.map((f) => (f.version !== undefined ? { id: f.id, version: f.version } : { id: f.id })),
  );
  // The room the files have, kept across the list's unmounts: a row coming back draws its pictures at their size from
  // its first frame, not at the widest and then narrower (shorter), moving the rows under it.
  const [width, onWidth] = useKeptWidth(`files:${align}`);

  const images: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  // What lives in the conversation isn't a file: the thing itself (ADR 0113).
  const blocks: ArtifactDetail[] = [];
  // A live file is its own card: a preview of it as it is now, opening its screen (ADR 0196 §9).
  const liveFiles: ArtifactDetail[] = [];
  const videos: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  const sounds: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  const others: { file: MessageFile; detail: ArtifactDetail | undefined; failed: boolean }[] = [];
  live.forEach((file, i) => {
    const q = queries[i];
    const detail = q?.data;
    if (detail?.kind === "block" || detail?.kind === "poll" || detail?.kind === "choices") {
      blocks.push(detail);
      return;
    }
    if (detail && opensLive(detail.kind)) {
      liveFiles.push(detail);
      return;
    }
    // Until it loads, a name like "print.png" already says it's a picture (no jump into the grid).
    const isImage = detail ? fileInfo(detail).view === "image" : !q?.isError && IMAGE_EXT.has(extensionOf(file.title));
    const isVideo = detail ? fileInfo(detail).view === "video" : !q?.isError && VIDEO_EXT.has(extensionOf(file.title));
    const isAudio = detail
      ? fileInfo(detail).view === "audio"
      : !q?.isError && previewKindOfName(file.title) === "audio";
    if (isImage) images.push({ file, detail });
    else if (isVideo) videos.push({ file, detail });
    else if (isAudio) sounds.push({ file, detail });
    else others.push({ file, detail, failed: Boolean(q?.isError) });
  });
  const removed = files.filter((f) => f.deleted);
  const blockWidth = Math.min(width || MAX_WIDTH, MAX_WIDTH);
  // Beside other attachments, pictures are tiles too: one grid, never a deck next to a file.
  const tiles =
    others.length > 0
      ? [
          ...images.map((i) => ({ ...i, failed: false, picture: true })),
          ...others.map((o) => ({ ...o, picture: false })),
        ]
      : [];
  const pictures = tiles.length > 0 ? [] : images;
  // A file's name wraps whole, which half a row would take a word a line: a file takes the row, pictures two to a row.
  const halfWidth = Math.floor((blockWidth - GAP) / 2);

  const [only] = pictures;
  // A lone picture of known size: its own shape from the first frame (its file's details, else its ref).
  const onlyBox = only
    ? singleImageBox(
        blockWidth,
        pictureRatio(only.detail?.content.kind === "file" ? only.detail.content : null) ?? pictureRatio(only.file),
      )
    : null;
  // The message's pictures and videos in the order they show (pictures, then videos; beside other files the videos
  // come first, the pictures among the tiles): whichever is tapped, the viewer pages through them all.
  const media: FileRef[] = (tiles.length > 0 ? [...videos, ...images] : [...pictures, ...videos]).map(
    ({ file, detail }) => ({ id: file.id, version: file.version, title: file.title, detail }),
  );
  // The pictures, videos and PDFs here that have comments (ADR 0208), in the message's order: each gets its line.
  const commented = [...images, ...videos, ...others].flatMap(({ file, detail }) => {
    const kind = mediaKindOfArtifact(detail);
    const talk = detail?.conversation;
    return detail && kind && talk && talk.count > 0 ? [{ file, detail, kind, talk }] : [];
  });
  // Opening a file or a picture is plain navigation: the press shows it, with no haptic.
  const openOnly = () => {
    if (only)
      openFile({ id: only.file.id, version: only.file.version, title: only.file.title, detail: only.detail }, media);
  };

  return (
    <View onLayout={onWidth} style={[styles.wrap, align === "end" && styles.end]}>
      {pictures.length > 1 ? <ImageStack images={pictures} width={blockWidth} siblings={media} /> : null}
      {only && onlyBox && pictures.length === 1 ? (
        <View style={{ width: onlyBox.width }}>
          <InlineImage
            file={only.file}
            box={onlyBox}
            label={only.detail?.title || only.file.title}
            onPress={openOnly}
          />
        </View>
      ) : null}
      {videos.map(({ file, detail }) => (
        <InlineVideo key={file.id} file={file} detail={detail} width={blockWidth} siblings={media} />
      ))}
      {sounds.map(({ file, detail }) => (
        <InlineAudio key={file.id} file={file} detail={detail} width={blockWidth} />
      ))}
      {blocks.map((b) =>
        b.kind === "poll" ? (
          <PollCard key={b.id} id={b.id} version={b.shownVersion} />
        ) : b.kind === "choices" ? (
          <ChoicesCard key={b.id} id={b.id} version={b.shownVersion} />
        ) : (
          <LiveBlockCard key={b.id} id={b.id} version={b.shownVersion} />
        ),
      )}
      {liveFiles.map((d) => (
        <LiveFileCard key={d.id} detail={d} width={blockWidth} />
      ))}
      {tiles.length > 0 ? (
        <View style={[styles.grid, { width: blockWidth }, align === "end" && styles.gridEnd]}>
          {tiles.map(({ file, detail, failed, picture }) => (
            <AttachmentTile
              key={file.id}
              file={file}
              detail={detail}
              failed={failed}
              picture={picture}
              width={picture ? halfWidth : blockWidth}
              single={tiles.length === 1}
              siblings={media}
            />
          ))}
        </View>
      ) : null}
      {commented.map(({ file, detail, kind, talk }) => (
        <FileCommentsLink
          key={`talk:${file.id}`}
          talk={talk}
          media={kind}
          onPress={() =>
            openFile(
              { id: file.id, version: file.version, title: file.title, detail },
              // A PDF opens on its own screen; a picture or a video among the message's.
              kind === "pdf" ? undefined : media,
            )
          }
        />
      ))}
      {removed.map((file) => (
        <RemovedCard key={file.id} />
      ))}
    </View>
  );
}

/**
 * An audio file on a message plays in place, in the voice-message player, with its name under it, which opens it. One
 * this phone can't play is its file's card.
 */
function InlineAudio({
  file,
  detail,
  width,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  width: number;
}) {
  const { t } = useTranslation();
  const title = detail?.title || file.title;
  const size = detail?.content.kind === "file" ? detail.content.size : undefined;
  const { i18n } = useTranslation();
  return (
    <View style={[styles.audio, { width }]}>
      <FileVoice
        id={file.id}
        version={file.version}
        wave={detail?.content.kind === "file" ? detail.content.wave : undefined}
        fallback={
          <AttachmentTile
            file={file}
            detail={detail}
            failed={false}
            picture={false}
            width={width}
            single
            siblings={[]}
          />
        }
      />
      <PressScale
        haptic={false}
        onPress={() => openFile({ id: file.id, version: file.version, title: file.title, detail })}
        accessibilityRole="button"
        accessibilityLabel={t("artifacts.open", { title })}
        style={styles.audioName}
      >
        <Text variant="caption" tone="muted">
          {size === undefined ? title : `${title} · ${formatBytes(i18n.language, size)}`}
        </Text>
      </PressScale>
    </View>
  );
}

function InlineImage({
  file,
  box: { width, height },
  label,
  onPress,
}: {
  file: MessageFile;
  box: { width: number; height: number };
  label: string;
  onPress: () => void;
}) {
  const cardCorners = useMessageCardCorners();
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  // The message's own version, from the first frame: switched to the details' once they came, the link and the cache
  // key changed, and the picture went blank and faded in again.
  const picture = usePicture(orgId, file.id, file.version);
  const { key, source, failed } = picture;
  return (
    <PressScale
      haptic={false}
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label || t("mobile.files.openImage")}
      accessibilityHint={t("mobile.files.openImage")}
      style={[styles.shot, { width, height, backgroundColor: c.sunken, borderColor: c.line2 }, cardCorners]}
    >
      {source && !failed ? (
        <Image
          source={source}
          recyclingKey={key}
          cachePolicy="memory-disk"
          contentFit="contain"
          transition={pictureFade(key)}
          onLoad={() => pictureDrawn(key)}
          style={StyleSheet.absoluteFill}
          onError={picture.onError}
          accessible={false}
        />
      ) : null}
      {failed ? (
        <View style={styles.center}>
          <Icon name="image" size={22} color={c.faint} />
        </View>
      ) : null}
    </PressScale>
  );
}

/**
 * A video on a message: its first frame; a tap opens it in the viewer among the message's pictures and videos
 * (`siblings`); one this phone can't play becomes the file's card. Its link is read once, at the version the message
 * names, so a link refreshed later never reloads the frame (a flash); it's read again when the row comes back.
 */
function InlineVideo({
  file,
  detail,
  width,
  siblings,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  width: number;
  siblings: readonly FileRef[];
}) {
  const cardCorners = useMessageCardCorners();
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, file.id, file.version, { once: true });
  const [failed, setFailed] = useState(false);
  // Its own shape from the first frame when the server read its size (its file's details, else its ref).
  const box = videoBox(
    width,
    pictureRatio(detail?.content.kind === "file" ? detail.content : null) ?? pictureRatio(file),
  );
  const source = useMemo(() => (link.data ? { uri: link.data.uri, headers: link.data.headers } : null), [link.data]);
  if (failed || link.isError)
    return <AttachmentTile file={file} detail={detail} width={width} single siblings={siblings} />;
  const info = detail ? fileInfo(detail) : null;
  // In the same viewer as the pictures: one place where media opens.
  const open = () => {
    if (detail) openFile({ id: file.id, version: file.version, title: file.title, detail }, siblings);
  };
  return (
    <View>
      {source ? (
        <VideoPlayer
          key={`${file.id}@${file.version ?? "latest"}`}
          source={source}
          name={info?.name || file.title}
          width={box.width}
          height={box.height}
          onOpen={detail ? open : undefined}
          onFailed={() => setFailed(true)}
        />
      ) : (
        <View style={[styles.shot, { ...box, backgroundColor: c.sunken, borderColor: c.line2 }, cardCorners]} />
      )}
    </View>
  );
}

/**
 * My files on a message I just sent, drawn from the phone while they upload (`meta.localFiles`), in the shapes the sent
 * ones take (a lone picture or video in its own shape, several two to a row, a file as a card): the message is in the
 * conversation the moment I send and the field is free. Sending, each dims under a spinner; when they're up, the
 * message goes with them and the server's copy takes its place.
 */
export function LocalFiles({
  files,
  align = "start",
  sending,
}: {
  files: LocalFile[];
  align?: "start" | "end";
  sending: boolean;
}) {
  const c = useColors();
  // The same room as the sent ones' (`MessageFiles`), kept the same way.
  const [width, onWidth] = useKeptWidth(`files:${align}`);
  const blockWidth = Math.min(width || MAX_WIDTH, MAX_WIDTH);
  // Laid out as `MessageFiles` lays out the sent ones, so nothing moves when the server's copy takes the place.
  const pictures = useMemo(() => files.filter((f) => f.type.startsWith("image/")), [files]);
  const videos = files.filter((f) => f.type.startsWith("video/"));
  const others = files.filter((f) => !isLocalMedia(f));
  const halfWidth = Math.floor((blockWidth - GAP) / 2);
  const [lone] = pictures;
  // Several pictures alone are the same deck, drawn from the phone's copies.
  const deck = useMemo(
    () =>
      pictures.map((f): StackImage => {
        const id = `local-${hashUri(f.uri)}`;
        rememberLocalCopy(id, f.uri);
        return {
          file: {
            id,
            title: f.name,
            deleted: false,
            ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
          },
          detail: undefined,
        };
      }),
    [pictures],
  );
  return (
    <View onLayout={onWidth} style={[styles.wrap, align === "end" && styles.end]}>
      {others.length === 0 && pictures.length > 1 ? (
        <View>
          <ImageStack images={deck} width={blockWidth} openable={false} />
          {sending ? (
            <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
              <ActivityIndicator color={c.faint} />
            </View>
          ) : null}
        </View>
      ) : null}
      {others.length === 0 && lone && pictures.length === 1 ? (
        <LocalMedia file={lone} box={singleImageBox(blockWidth, localRatio(lone))} sending={sending} />
      ) : null}
      {videos.map((f) => (
        <LocalMedia key={f.uri} file={f} box={videoBox(blockWidth, localRatio(f))} sending={sending} />
      ))}
      {others.length > 0 ? (
        <View style={[styles.grid, { width: blockWidth }, align === "end" && styles.gridEnd]}>
          {pictures.map((f) => (
            <LocalMedia key={f.uri} file={f} box={{ width: halfWidth, height: halfWidth }} sending={sending} />
          ))}
          {others.map((f) => (
            <LocalFileCard key={f.uri} file={f} sending={sending} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A short, stable id for a file on the phone (an id in the link cache, never sent anywhere). */
function hashUri(uri: string): string {
  let h = 0;
  for (let i = 0; i < uri.length; i++) h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function LocalMedia({
  file,
  box,
  sending,
}: {
  file: LocalFile;
  box: { width: number; height: number };
  sending: boolean;
}) {
  const cardCorners = useMessageCardCorners();
  const c = useColors();
  const video = file.type.startsWith("video/");
  return (
    <View
      style={[
        styles.shot,
        { width: box.width, height: box.height, backgroundColor: c.sunken, borderColor: c.line2 },
        cardCorners,
      ]}
      accessible
      accessibilityLabel={file.name}
    >
      {video ? (
        <VideoFirstFrame uri={file.uri} />
      ) : (
        <Image
          source={{ uri: file.uri }}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={0}
          style={StyleSheet.absoluteFill}
        />
      )}
      {video && !sending ? (
        <View style={styles.length} pointerEvents="none">
          <Icon name="play" size={9} color="#fff" />
          {file.duration ? <RNText style={styles.lengthText}>{videoClock(file.duration)}</RNText> : null}
        </View>
      ) : null}
      {sending ? (
        <View style={[StyleSheet.absoluteFill, styles.veil]} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

function LocalFileCard({ file, sending }: { file: LocalFile; sending: boolean }) {
  const { i18n } = useTranslation();
  const c = useColors();
  const frame = useMessageCardFrame();
  return (
    <View style={[styles.card, frame.style]} accessible accessibilityLabel={file.name}>
      {isLocalPdf(file) ? (
        // A PDF on its way shows its first page already, read from the phone's own file, as it did in the composer.
        <View style={styles.page}>
          <FileTile ext={extLabel(extensionOf(file.name))} />
          <LocalPdfPage uri={file.uri} />
        </View>
      ) : (
        <FileTile ext={extLabel(extensionOf(file.name))} />
      )}
      <View style={styles.grow}>
        <Text variant="cardTitle" numberOfLines={2}>
          {file.name}
        </Text>
        {file.size !== undefined ? (
          <Text variant="footnote" tone="faint">
            {formatBytes(i18n.language || "en", file.size)}
          </Text>
        ) : null}
      </View>
      {sending ? <ActivityIndicator color={c.faint} /> : null}
    </View>
  );
}

/** The type and size line: "Documento · 4 KB". */
export function useFileLine() {
  const { t, i18n } = useTranslation();
  // Each fact whole: a narrow line breaks between them, never inside "4 KB" or a name.
  return (info: FileInfo, extra: string[] = []) =>
    [
      t(`mobile.files.type.${info.type}`),
      ...(info.size !== null ? [formatBytes(i18n.language || "en", info.size)] : []),
      ...extra.filter(Boolean),
    ]
      .map(keepWhole)
      .join(" · ");
}

/** The file type's tile: the extension in capitals on a folded page (or the file icon without one). */
export function FileTile({ ext }: { ext: string }) {
  const c = useColors();
  return (
    <View
      style={[styles.tile, { backgroundColor: c.sunken }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.fold, { backgroundColor: c.line2, borderColor: c.bg }]} />
      {ext ? (
        <Text variant="caption" tone="muted" style={styles.ext} numberOfLines={1}>
          {ext}
        </Text>
      ) : (
        <Icon name="file" size={19} color={c.muted} />
      )}
    </View>
  );
}

function RemovedCard() {
  const { t } = useTranslation();
  const c = useColors();
  const frame = useMessageCardFrame();
  return (
    <View style={[styles.card, frame.style]}>
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name="file" size={20} color={c.faint} />
      </View>
      <Text variant="small" tone="faint" style={styles.grow}>
        {t("mobile.chat.fileDeleted")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  audio: { gap: 4 },
  // Under the player, in line with its card's inner edge.
  audioName: { paddingHorizontal: 12 },
  wrap: { alignSelf: "stretch", gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  gridEnd: { justifyContent: "flex-end" },
  end: { alignItems: "flex-end" },
  shot: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // A file on its way up dims under a spinner; a video's length sits in its corner, as on a sent one.
  veil: { backgroundColor: "rgba(0,0,0,0.3)", alignItems: "center", justifyContent: "center" },
  length: {
    position: "absolute",
    left: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  lengthText: { color: "#fff", fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  card: {
    maxWidth: MAX_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: MESSAGE_CARD_X,
    paddingVertical: 10,
    // As the pictures' beside it.
    borderRadius: 14,
  },
  tile: { width: 40, height: 48, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  // A PDF's first page in the tile's own box.
  page: { width: 40, height: 48, borderRadius: 8, overflow: "hidden" },
  fold: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 13,
    height: 13,
    borderBottomLeftRadius: 3,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
  },
  ext: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  grow: { flex: 1, minWidth: 0 },
});
