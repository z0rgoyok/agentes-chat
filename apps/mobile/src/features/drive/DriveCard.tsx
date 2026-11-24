import { type Artifact, type ArtifactLiveContent, type LivePresent, useArtifact } from "@agenteschat/client";
import { Image } from "expo-image";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import { CHROME_MAX_SCALE, Icon, type IconName, PressScale, systemText, Text, useTheme, weights } from "@/ui";
import { useRowDirectory } from "../chat/row-data";
import { type FileRef, pdfPreviewable } from "../files/logic";
import { useOpenFile } from "../files/open";
import { PdfCover } from "../files/pdf-preview";
import { usePicture } from "../files/source";
import { PresentFaces } from "../live-files/shared/HereFaces";
import { LiveCover } from "../live-files/shared/LiveCover";
import { Face } from "../shared/Face";
import { useOrgId, useWhen } from "../shared/hooks";
import { MONO, useSurface } from "../shared/parts";
import { type CardPreview, cardPreview, cardShape, kindKey } from "./logic";

const KIND_ICON: Record<ReturnType<typeof kindKey>, IconName> = {
  document: "doc",
  table: "list",
  diff: "code",
  image: "image",
  spreadsheet: "spreadsheet",
  slides: "slides",
  canvas: "canvas",
  file: "file",
};

/** A Drive item as it's opened: at its version, its kind and name saying what it is before its details load. */
export const driveRef = (a: Pick<Artifact, "id" | "kind" | "title" | "version">): FileRef => ({
  id: a.id,
  version: a.version,
  title: a.title,
  kind: a.kind,
});

/**
 * A Drive card: the real preview at the item's version (a document's first lines under its title, a table's first
 * rows, a diff's first changed lines, the picture itself, a PDF's first page, a file's type tile, a live file's grid,
 * first slide or canvas map) with the kind on a small chip, then the name and who made it, when, and the faces of who
 * is in a live file now (`present`, asked for the whole grid at once). A tap opens it as every file opens
 * (`openFile`): a picture or a video in the picture viewer, among the grid's (`siblings`, in the grid's order), a
 * live file on its own screen.
 */
export const DriveCard = memo(function DriveCard({
  artifact: a,
  highlighted = false,
  siblings,
  onLongPress,
  present,
}: {
  artifact: Artifact;
  highlighted?: boolean;
  siblings?: readonly FileRef[];
  /** Its actions (open, send a copy, rename, move, delete); `open` opens it as a tap does. */
  onLongPress?: (a: Artifact, open: () => void) => void;
  present?: readonly LivePresent[];
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const surface = useSurface();
  const dir = useRowDirectory();
  const when = useWhen();
  const kind = kindKey(a);
  const author = dir.nameOf(a.createdBy);
  const open = useOpenFile();
  return (
    // Opening it is navigation, as every file's: the card gives under the finger, no tap.
    <PressScale
      to={0.97}
      haptic={false}
      fill={false}
      onPress={() => void open(driveRef(a), siblings)}
      {...(onLongPress ? { onLongPress: () => onLongPress(a, () => void open(driveRef(a), siblings)) } : {})}
      accessibilityRole="button"
      accessibilityLabel={[a.title, t(`mobile.drive.kind.${kind}`), author, when.short(a.updatedAt)]
        .filter(Boolean)
        .join(", ")}
      style={styles.card}
    >
      <View style={[styles.preview, surface, highlighted && { borderWidth: 2, borderColor: c.ink }]}>
        <Preview artifact={a} />
        <View style={[styles.kind, { backgroundColor: c.raised }]}>
          <Icon name={KIND_ICON[kind]} size={11} color={c.ink2} />
          <RNText maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[styles.kindText, { color: c.ink2 }]}>
            {t(`mobile.drive.kind.${kind}`)}
          </RNText>
        </View>
      </View>
      <Text variant="subhead" numberOfLines={1} style={styles.name}>
        {a.title}
      </Text>
      <View style={styles.by}>
        <Face who={a.createdBy} size={16} live={false} />
        <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.grow}>
          {author ? t("mobile.drive.by", { name: author, when: when.short(a.updatedAt) }) : when.short(a.updatedAt)}
        </Text>
        <PresentFaces present={present} ring={c.bg} />
      </View>
    </PressScale>
  );
});

function Preview({ artifact: a }: { artifact: Artifact }) {
  const orgId = useOrgId();
  const image = cardShape(a) === "image";
  // At its exact version: never stale, and shared with the viewer.
  const detail = useArtifact(orgId, image ? null : a.id, a.version);
  if (image) return <ImagePreview artifact={a} />;
  const content = detail.data?.content;
  if (!content) return <Placeholder />;
  const p = cardPreview(a.title, content);
  if (p.kind === "image") return <ImagePreview artifact={a} />;
  if (p.kind === "live") return <LivePreview content={p.content} />;
  // A PDF shows its first page over its type's tile, downloaded only once its card is in sight: the grid draws every
  // card at once.
  if (p.kind === "file" && detail.data && pdfPreviewable(detail.data))
    return (
      <PdfCover detail={detail.data} waitForSight>
        <ContentPreview preview={p} />
      </PdfCover>
    );
  return <ContentPreview preview={p} />;
}

/** A live file's preview at the card's size (its slide and its canvas map fit the box). */
function LivePreview({ content }: { content: ArtifactLiveContent }) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        // The same box keeps its object: a layout pass that changed nothing doesn't draw the cover again.
        setBox((was) => (was.width === width && was.height === height ? was : { width, height }));
      }}
    >
      {box.width > 0 ? <LiveCover content={content} width={box.width} height={box.height} /> : null}
    </View>
  );
}

function ImagePreview({ artifact: a }: { artifact: Artifact }) {
  const { colors: c } = useTheme();
  const picture = usePicture(useOrgId(), a.id, a.version);
  if (!picture.source) return <View style={[StyleSheet.absoluteFill, { backgroundColor: c.sunken }]} />;
  return (
    <Image
      source={picture.source}
      recyclingKey={picture.key}
      onError={picture.onError}
      // Kept decoded in memory too: a card scrolled back or a grid drawn again shows it without decoding it anew.
      cachePolicy="memory-disk"
      contentFit="cover"
      transition={160}
      style={StyleSheet.absoluteFill}
      accessible={false}
    />
  );
}

/**
 * A file on its way into the Drive, in a card's shape until it's there: a spinner where its preview goes, its name and
 * "Sending the file…".
 */
export function UploadingCard({ name }: { name: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const surface = useSurface();
  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={t("mobile.chat.attach.sending", { name })}
      accessibilityState={{ busy: true }}
    >
      <View style={[styles.preview, styles.waiting, surface]}>
        <ActivityIndicator color={c.faint} />
      </View>
      <Text variant="subhead" numberOfLines={1} style={styles.name}>
        {name}
      </Text>
      <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.sending}>
        {t("mobile.chat.uploading")}
      </Text>
    </View>
  );
}

/** Before the content arrives: neutral lines. */
function Placeholder() {
  const { colors: c } = useTheme();
  return (
    <View style={styles.pad}>
      {[90, 75, 82].map((w) => (
        <View key={w} style={[styles.line, { width: `${w}%`, backgroundColor: c.sunken }]} />
      ))}
    </View>
  );
}

function ContentPreview({ preview: p }: { preview: Exclude<CardPreview, { kind: "image" } | { kind: "live" }> }) {
  const { colors: c, fonts } = useTheme();
  switch (p.kind) {
    case "document":
      return (
        <View style={styles.pad}>
          <RNText
            numberOfLines={2}
            maxFontSizeMultiplier={1}
            style={[styles.docHead, { fontFamily: fonts.display, color: c.ink }]}
          >
            {p.head}
          </RNText>
          {p.lines.map((l, i) => (
            <RNText
              // biome-ignore lint/suspicious/noArrayIndexKey: a static preview
              key={i}
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={[styles.docLine, { color: c.muted }]}
            >
              {l}
            </RNText>
          ))}
        </View>
      );
    case "table": {
      const cols = Math.max(1, p.columns.length);
      const cell = (text: string, head: boolean, key: string) => (
        <View
          key={key}
          style={[
            styles.cell,
            { width: `${100 / cols}%`, borderColor: c.line2 },
            head && { backgroundColor: c.sunken },
          ]}
        >
          <RNText
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            style={[styles.cellText, { color: head ? c.ink2 : c.muted }, head && styles.bold]}
          >
            {text}
          </RNText>
        </View>
      );
      return (
        <View style={styles.table}>
          {p.columns.map((h, j) => cell(h, true, `h${j}`))}
          {p.rows.flatMap((r, i) => r.map((v, j) => cell(v, false, `${i}:${j}`)))}
        </View>
      );
    }
    case "diff":
      return (
        <View style={styles.pad}>
          {p.lines.map((l, i) => (
            <RNText
              // biome-ignore lint/suspicious/noArrayIndexKey: a static preview
              key={i}
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={[
                styles.code,
                { fontFamily: MONO, color: l.kind === "add" ? c.ok : l.kind === "del" ? c.danger : c.faint },
              ]}
            >
              {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
              {l.text}
            </RNText>
          ))}
        </View>
      );
    case "file":
      return (
        <View style={styles.fileWrap}>
          <View style={[styles.fileTile, { backgroundColor: c.sunken }]}>
            <RNText maxFontSizeMultiplier={1} style={[styles.fileExt, { color: c.muted }]}>
              {p.ext}
            </RNText>
          </View>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0 },
  preview: { aspectRatio: 4 / 3, borderRadius: 14, overflow: "hidden" },
  pad: { padding: 12, gap: 4 },
  line: { height: 5, borderRadius: 2, marginBottom: 2 },
  docHead: { fontSize: 15, lineHeight: 17, fontWeight: "300", marginBottom: 4 },
  docLine: { fontSize: 10, lineHeight: 13 },
  table: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  cellText: { fontSize: 9 },
  bold: { fontWeight: "700" },
  code: { fontSize: 9.5, lineHeight: 14 },
  fileWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 16 },
  fileTile: { width: 52, height: 62, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  fileExt: { ...systemText("caption", weights.bold) },
  kind: {
    position: "absolute",
    left: 8,
    bottom: 8,
    height: 20,
    paddingHorizontal: 8,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    opacity: 0.94,
  },
  kindText: { fontSize: 11, fontWeight: "700" },
  name: { fontWeight: "600", marginTop: 8 },
  by: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  grow: { flex: 1, minWidth: 0 },
  waiting: { alignItems: "center", justifyContent: "center" },
  sending: { marginTop: 4 },
});
