import { type ArtifactDetail, useOfficePreview, useOpenAs } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import type { DeckData } from "@agenteschat/live/office";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { appHeaders, lastCookie } from "@/lib/auth";
import { useOrg } from "@/providers/org";
import { Button, SCREEN_X, Text, TOOL_H, textLineOf, useTheme } from "@/ui";
import { useFontScale } from "@/ui/text-scale";
import { openFile } from "../../files/open";
import { LoadFailed } from "../../shared/FirstUse";
import { useErrorToast, useOrgId } from "../../shared/hooks";
import { type OfficeView, officeKindOf } from "../logic";
import type { SketchPicture, SketchSlide } from "../shared/LiveCover";
import { SlideView } from "../slides/SlideView";
import { tableWorkbook } from "../spreadsheet/model";
import { GridBones } from "../spreadsheet/SheetGrid";
import { WorkbookView } from "../spreadsheet/WorkbookView";

/**
 * Office files and old tables in the file screen (ADR 0198): the server reads an upload (`…/preview`) and the phone
 * draws what it read, never the file's bytes: a workbook in the spreadsheet's own grid, read-only, a deck as its
 * slides, one under the other, a Word document's page in the file screen's isolated web view (`useOfficeHtml`). Under
 * the upload, what it is and "Editar como planilha / apresentação / documento", which makes an editable copy beside it.
 */

/** A workbook (an uploaded `xlsx`, `xls`, `ods`, `csv`) or an old table, read-only in the spreadsheet's grid. */
export function SheetPage({ detail }: { detail: ArtifactDetail }) {
  const orgId = useOrgId();
  const content = detail.content;
  const table = content.kind === "table" ? content : null;
  const preview = useOfficePreview(orgId, table ? null : detail.id, detail.shownVersion);
  const workbook = useMemo(
    () =>
      table
        ? tableWorkbook(detail.title, table.columns, table.rows)
        : preview.data?.kind === "workbook"
          ? preview.data.workbook
          : null,
    [table, detail.title, preview.data],
  );
  if (!table && (preview.isError || (preview.data && preview.data.kind !== "workbook")))
    return <Failed onRetry={() => void preview.refetch()} />;
  if (!workbook) return <GridBones />;
  return <WorkbookView workbook={workbook} footer={table ? null : <EditAs detail={detail} view="sheet" />} />;
}

/** An uploaded deck (`pptx`), its slides one under the other at the screen's width, read-only. */
export function DeckPage({ detail }: { detail: ArtifactDetail }) {
  const orgId = useOrgId();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const preview = useOfficePreview(orgId, detail.id, detail.shownVersion);
  const deck = preview.data?.kind === "deck" ? preview.data.deck : null;
  const slides = useMemo(() => (deck ? deckSketches(deck) : []), [deck]);
  const picture = useMemo<SketchPicture>(() => {
    const headers = appHeaders(lastCookie());
    return (name) => {
      const url = deck?.media[name]?.url;
      return url ? { uri: url, headers } : null;
    };
  }, [deck]);
  if (preview.isError || (preview.data && !deck)) return <Failed onRetry={() => void preview.refetch()} />;
  if (!deck) return <DeckBones />;
  const slideWidth = width - SCREEN_X * 2;
  return (
    <View style={[styles.fill, { backgroundColor: c.sunken }]}>
      <FlatList
        data={slides}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.deck}
        initialNumToRender={4}
        windowSize={5}
        renderItem={({ item, index }) => (
          <View style={styles.slide}>
            <Text variant="caption" tone="faint" style={styles.number}>
              {index + 1}
            </Text>
            <SlideView theme={deck.theme} slide={item} width={slideWidth} deck={deck} picture={picture} mode="thumb" />
          </View>
        )}
      />
      <EditAs detail={detail} view="deck" />
      <View style={{ height: insets.bottom, backgroundColor: c.bg }} />
    </View>
  );
}

/** A Word document's clean HTML (ADR 0198), for the file screen's isolated page. */
export function useOfficeHtml(detail: ArtifactDetail | undefined, enabled: boolean) {
  const orgId = useOrgId();
  const preview = useOfficePreview(orgId, enabled && detail ? detail.id : null, detail?.shownVersion);
  const html = preview.data?.kind === "document" ? preview.data.html : undefined;
  return {
    html,
    failed: preview.isError || (preview.data !== undefined && html === undefined),
    retry: () => void preview.refetch(),
  };
}

/** A deck's slides as sketches draw them: pictures by their media name. */
export function deckSketches(deck: DeckData): SketchSlide[] {
  return deck.slides
    .filter((s) => !s.hidden)
    .map((s) => ({
      ...(s.bg ? { bg: typeof s.bg === "string" ? s.bg : { asset: s.bg.media } } : {}),
      elements: s.elements.map(({ media, ...el }) => (media ? { ...el, asset: media } : el)),
    }));
}

/**
 * Under an upload: what it is ("Arquivo do Excel") and the way to work on it here ("Editar como planilha"), which makes
 * a copy beside it and opens that; the upload stays as it is. Only for whoever may add files.
 */
export function EditAs({ detail, view }: { detail: ArtifactDetail; view: OfficeView }) {
  const { t } = useTranslation();
  const fontScale = useFontScale();
  const { colors: c } = useTheme();
  const orgId = useOrgId();
  const { org } = useOrg();
  const openAs = useOpenAs(orgId);
  const failed = useErrorToast();
  const name = detail.content.kind === "file" ? detail.content.name || detail.title : detail.title;
  const kind = officeKindOf(name, view);
  const editAs = view === "sheet" ? "workbook" : view === "deck" ? "deck" : "document";
  const make = () =>
    openAs.mutate(detail.id, {
      onSuccess: (made) => openFile({ id: made.id, kind: made.kind, title: made.title }),
      onError: failed,
    });
  return (
    <View style={[styles.bar, { backgroundColor: c.bg, borderTopColor: c.line2 }]}>
      <Text variant="footnote" tone="faint" numberOfLines={2} style={styles.what}>
        {t(`live.office.kind.${kind}`)}
      </Text>
      {can(org, "upload_files") && detail.inDrive !== false ? (
        // On the words' first line, centred on its middle, when they wrap to two.
        <View style={{ marginTop: textLineOf("footnote", fontScale).middle - TOOL_H / 2 }}>
          <Button
            variant="secondary"
            size="sm"
            label={t(`live.office.editAs.${editAs}`)}
            hint={t("live.office.editAsHint")}
            loading={openAs.isPending}
            onPress={make}
          />
        </View>
      ) : null}
    </View>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.middle}>
      <LoadFailed onRetry={onRetry} />
    </View>
  );
}

/** A deck's shape while it is read: two slides' places. */
function DeckBones() {
  const { colors: c } = useTheme();
  const { width } = useWindowDimensions();
  const w = width - SCREEN_X * 2;
  return (
    <View style={[styles.fill, styles.deck, { backgroundColor: c.sunken }]} accessibilityState={{ busy: true }}>
      {[0, 1].map((i) => (
        <View key={i} style={[styles.slideBone, { width: w, height: (w * 9) / 16, backgroundColor: c.plate }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  deck: { paddingHorizontal: SCREEN_X, paddingTop: 16, paddingBottom: 24, gap: 16 },
  slide: { gap: 6 },
  number: { fontVariant: ["tabular-nums"] },
  slideBone: { borderRadius: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  what: { flex: 1, minWidth: 0 },
});
