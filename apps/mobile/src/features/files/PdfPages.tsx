import type { ArtifactDetail } from "@agenteschat/client";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { type PageDim, PdfView } from "react-native-pdf-light";
import { type SharedValue, useSharedValue } from "react-native-reanimated";
import { haptics, SCREEN_X, Text } from "@/ui";
import { useMediaPins, useOpenFileTalk, useRevealHere } from "../live-files/talk/hooks";
import { commentSelection, draftPin, type MediaPin, pagePins, pinUnder, pointMark } from "../live-files/talk/logic";
import { PicturePins } from "../live-files/talk/PicturePins";
import { useTalkAbout } from "../live-files/talk/store";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useMeId } from "../shared/hooks";
import { PageBones } from "./PageBones";
import { usePdfCopy } from "./pdf-preview";

/** Between two pages, and above the first and under the last. */
const GAP = 12;

/**
 * A PDF on its screen (ADR 0208): its pages one under the other on the grouped gray, each a white page as wide as the
 * screen less its sides, drawn by the system's own PDF renderer (CGPDFDocument on iOS, PdfRenderer on Android, through
 * `react-native-pdf-light`) from a copy in the cache, read once per version. Each page's open comments are pinned on
 * it (a tap on one opens its message). A touch held on a page marks that page and that point: the conversation is
 * pushed over the PDF about it ("About page 3 of the PDF" over the composer), the person's pin left on the spot while
 * the comment is unsent. A message's line about a page scrolls to it. No pinch zoom: the pins stand on the page as
 * laid out, and a zoom of the system's would draw over them.
 */
export function PdfPages({ detail }: { detail: ArtifactDetail }) {
  const { t } = useTranslation();
  const c = useColors();
  const { width } = useWindowDimensions();
  // The copy its cards' first page was drawn from, when one was (`usePdfCopy`): one download for both.
  const copy = usePdfCopy(detail);
  const pageWidth = Math.max(0, width - SCREEN_X * 2);
  const heights = useMemo(
    () => (copy.data?.sizes ?? []).map((s) => (s.width > 0 ? Math.round((pageWidth * s.height) / s.width) : pageWidth)),
    [copy.data, pageWidth],
  );
  const offsets = useMemo(() => {
    let at = GAP;
    return heights.map((h) => {
      const here = at;
      at += h + GAP;
      return here;
    });
  }, [heights]);

  // ── Its conversation (ADR 0208) ──
  const pins = useMediaPins(detail);
  const openTalk = useOpenFileTalk(detail);
  const meId = useMeId();
  // The comment being written about a point of it: its pin stays there while the comment is unsent.
  const about = useTalkAbout(detail.conversation?.channelId ?? "");
  const draft = useMemo(
    () => draftPin(about, detail.id, meId ? { type: "user", id: meId } : null),
    [about, detail.id, meId],
  );
  const zoom = useSharedValue(1);
  const onPin = useCallback((messageId: string) => openTalk({ messageId, selection: null }), [openTalk]);
  const onMark = useCallback(
    (page: number, mark: NonNullable<ReturnType<typeof pointMark>>) => {
      haptics.medium();
      openTalk({ selection: commentSelection(pins, { mark, page }, detail.shownVersion) });
    },
    [openTalk, pins, detail.shownVersion],
  );
  // A message's line about a page: the list goes to it.
  const list = useRef<FlatList<PageDim>>(null);
  useRevealHere(detail.id, heights.length > 0, (selection) => {
    const page = selection.page;
    if (page && page >= 1 && page <= heights.length)
      list.current?.scrollToOffset({ offset: Math.max(0, (offsets[page - 1] ?? 0) - GAP), animated: true });
  });

  if (copy.isError)
    return (
      <View style={[styles.middle, { backgroundColor: c.grouped }]}>
        <LoadFailed onRetry={() => void copy.refetch()} />
      </View>
    );
  if (!copy.data) return <PageBones />;
  const { path, sizes } = copy.data;
  return (
    <View style={styles.fill}>
      <FlatList
        ref={list}
        data={sizes}
        keyExtractor={(_, i) => String(i)}
        style={[styles.fill, { backgroundColor: c.grouped }]}
        // The line under the screen keeps the bottom's room.
        contentContainerStyle={styles.pages}
        getItemLayout={(_, i) => ({ length: (heights[i] ?? 0) + GAP, offset: offsets[i] ?? 0, index: i })}
        initialNumToRender={2}
        windowSize={5}
        showsVerticalScrollIndicator
        renderItem={({ index }) => (
          <PdfPage
            path={path}
            page={index + 1}
            count={sizes.length}
            width={pageWidth}
            height={heights[index] ?? pageWidth}
            pins={pins}
            draft={draft?.selection.page === index + 1 ? draft : null}
            zoom={zoom}
            failedWords={t("mobile.files.talk.pdfFailed")}
            onPin={onPin}
            onMark={onMark}
          />
        )}
      />
    </View>
  );
}

/** One page: white, its comments' pins over it, a tap reading a pin, a held touch marking a point there. */
const PdfPage = memo(function PdfPage({
  path,
  page,
  count,
  width,
  height,
  pins,
  draft,
  zoom,
  failedWords,
  onPin,
  onMark,
}: {
  path: string;
  /** From 1. */
  page: number;
  count: number;
  width: number;
  height: number;
  pins: readonly MediaPin[];
  draft: MediaPin | null;
  zoom: SharedValue<number>;
  failedWords: string;
  onPin: (messageId: string) => void;
  onMark: (page: number, mark: NonNullable<ReturnType<typeof pointMark>>) => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const here = useMemo(() => pagePins(pins, page), [pins, page]);
  const spot = (x: number, y: number) => ({ x: x / width, y: y / height, width, height });
  const tap = (x: number, y: number) => {
    const pin = pinUnder(here, spot(x, y));
    if (pin) onPin(pin.messageId);
  };
  const hold = (x: number, y: number) => {
    const mark = pointMark(spot(x, y));
    if (mark) onMark(page, mark);
  };
  return (
    <Pressable
      onPress={(e) => tap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      onLongPress={(e) => hold(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      // The system's own press and hold; a finger that scrolls the pages instead cancels it.
      delayLongPress={450}
      accessibilityLabel={t("mobile.files.talk.pdfPage", { page, count })}
      accessibilityHint={t("mobile.files.talk.hint.pdf")}
      style={[styles.page, { width, height }]}
    >
      {failed ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text variant="footnote" style={styles.failed}>
            {failedWords}
          </Text>
        </View>
      ) : (
        <PdfView
          source={path}
          page={page - 1}
          resizeMode="contain"
          style={{ width, height }}
          onError={() => setFailed(true)}
        />
      )}
      {here.length > 0 || draft ? <PicturePins pins={here} zoom={zoom} draft={draft} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pages: { paddingTop: GAP },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  // A page as paper reads: white whatever the theme, on the gray between pages.
  page: { alignSelf: "center", marginBottom: GAP, backgroundColor: "#fff" },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  failed: { textAlign: "center", color: "#3c3c43" },
});
