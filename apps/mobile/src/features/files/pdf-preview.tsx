import { type ArtifactDetail, useApi } from "@agenteschat/client";
import { useQuery } from "@tanstack/react-query";
import { type ComponentRef, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { PdfUtil, PdfView } from "react-native-pdf-light";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useReducedMotion } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { localPdfPath, pdfCopyKey, pdfPreviewable } from "./logic";
import { pdfCopy, pictureDrawn, pictureFade } from "./source";

/*
 * A PDF's first page on its cards (a message's tile, the Drive's card) and on the file waiting in the composer, drawn
 * on the phone by the system's PDF renderer (`react-native-pdf-light`, as the PDF's own screen draws its pages): the
 * server keeps no picture of a PDF. A card's page comes from the PDF's copy in the cache, the same one its screen
 * reads (`usePdfCopy`), so a PDF previewed in a conversation opens at once.
 */

/** A PDF's copy in the cache (downloaded once per version) and its pages' sizes; `enabled` false reads nothing. */
export function usePdfCopy(detail: ArtifactDetail | undefined, enabled = true) {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: pdfCopyKey(orgId, detail?.id ?? "", detail?.shownVersion ?? 0),
    queryFn: async () => {
      if (!detail) throw new Error("no PDF");
      const path = await pdfCopy(api, orgId, detail);
      return { path, sizes: await PdfUtil.getPageSizes(path) };
    },
    enabled: enabled && detail !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * A PDF's first page filling the box it is given, from the top (`fitWidth`: as wide as the box, cut at its foot, as a
 * page seen on a card), over what the box shows until it is drawn. It fades in the first time this run draws it, and
 * is there at once after that (a card scrolled back, a conversation opened again). `onFailed`: it couldn't be read or
 * drawn (the box keeps what it shows).
 */
export function PdfFirstPage({ path, drawnKey, onFailed }: { path: string; drawnKey: string; onFailed: () => void }) {
  const reduced = useReducedMotion();
  const [fade] = useState(() => (reduced ? 0 : pictureFade(drawnKey)));
  const shown = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <PdfView
        source={path}
        page={0}
        resizeMode="fitWidth"
        style={StyleSheet.absoluteFill}
        onLoadComplete={() => {
          pictureDrawn(drawnKey);
          shown.value = fade > 0 ? withTiming(1, { duration: fade }) : 1;
        }}
        onError={onFailed}
      />
    </Animated.View>
  );
}

/** Cards outside a list that draws only what is in sight (the Drive's grid draws every card at once) wait for sight. */
const sightWatchers = new Set<() => void>();

/** A scroll view whose cards wait for sight came to rest: they look whether they are in sight now. */
export function noteCardsScrolled(): void {
  for (const look of [...sightWatchers]) look();
}

/**
 * Whether the view has come within a screen of the window (true from the start unless `wait`), and stays so: a card
 * looks when it is laid out and each time its scroll view comes to rest (`noteCardsScrolled`), and downloads its PDF
 * only then.
 */
function useInSight(wait: boolean) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const { height } = useWindowDimensions();
  const [seen, setSeen] = useState(!wait);
  const look = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _width, h) => {
      if (h > 0 && y < height * 2 && y + h > -height) setSeen(true);
    });
  }, [height]);
  useEffect(() => {
    if (seen) return;
    look();
    sightWatchers.add(look);
    return () => {
      sightWatchers.delete(look);
    };
  }, [seen, look]);
  return { ref, seen, look };
}

/**
 * A PDF's card cover: its first page once its copy is in and drawn; until then, and for good when it can't be (too
 * heavy for a card, unreadable), what the card shows today (`children`, its type's tile). Seen before in this run,
 * the page is under way at once: a plain page holds its place instead of the tile flashing before it. `waitForSight`:
 * on a screen that draws all its cards at once, only the ones in sight (or a flick away) download their PDF.
 */
export function PdfCover({
  detail,
  waitForSight = false,
  children,
}: {
  detail: ArtifactDetail;
  waitForSight?: boolean;
  children: ReactNode;
}) {
  const allowed = pdfPreviewable(detail);
  const sight = useInSight(waitForSight && allowed);
  const copy = usePdfCopy(detail, allowed && sight.seen);
  const [failed, setFailed] = useState(false);
  const key = `pdf:${detail.id}@${detail.shownVersion}`;
  const path = allowed && !failed ? copy.data?.path : undefined;
  const drawnBefore = path !== undefined && pictureFade(key) === 0;
  return (
    <View
      ref={sight.ref}
      onLayout={sight.seen ? undefined : sight.look}
      style={StyleSheet.absoluteFill}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {drawnBefore ? <View style={[StyleSheet.absoluteFill, styles.paper]} /> : children}
      {path ? <PdfFirstPage path={path} drawnKey={key} onFailed={() => setFailed(true)} /> : null}
    </View>
  );
}

/**
 * The first page of a PDF on the phone (one waiting in the composer) over the box it is given, read straight from the
 * file: nothing downloads. The box keeps what it shows if the file can't be drawn.
 */
export function LocalPdfPage({ uri }: { uri: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <PdfFirstPage path={localPdfPath(uri)} drawnKey={`pdf:${uri}`} onFailed={() => setFailed(true)} />;
}

const styles = StyleSheet.create({
  // The renderer draws on white whatever the theme: the page's own color while it comes.
  paper: { backgroundColor: "#fff" },
});
