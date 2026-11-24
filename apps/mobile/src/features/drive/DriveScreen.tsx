import { type Artifact, isLiveFileKind, LIVE_PRESENCE_BATCH, useArtifacts, useLivePresence } from "@agenteschat/client";
import { folderChildren, folderTrail } from "@agenteschat/client/lib/drive";
import { can } from "@agenteschat/client/lib/permissions";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  type HeaderMenuItem,
  SCREEN_X,
  SearchField,
  SectionHeader,
  SkeletonList,
  useReducedMotion,
} from "@/ui";
import { noteCardsScrolled } from "../files/pdf-preview";
import { LIVE_ICON, LIVE_KINDS_MADE, LIVE_SF } from "../live-files/routes";
import { useCreateLive } from "../live-files/shared/useCreateLive";
import { chooseAction } from "../settings/parts";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useLatest } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { DriveCard, driveRef, UploadingCard } from "./DriveCard";
import { FolderPath, FolderRows, useFolderActions } from "./folders";
import {
  DRIVE_TYPES,
  type DriveDaySection,
  type DriveType,
  driveFilters,
  driveSections,
  driveView,
  gridRows,
  keepsLooking,
  matchesType,
} from "./logic";
import { useDriveUpload } from "./useDriveUpload";

/** Cards shown at first and added by "Mostrar mais" (each card loads its own preview). */
const PAGE = 24;

/** A month's heading format per language and whether it says the year, made once: a format is costly to build. */
const monthFormats = new Map<string, Intl.DateTimeFormat>();
const monthFormat = (locale: string, withYear: boolean) => {
  const key = `${locale}\n${withYear}`;
  let format = monthFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { month: "long", ...(withYear ? { year: "numeric" as const } : {}) });
    monthFormats.set(key, format);
  }
  return format;
};

/**
 * Drive, pushed from Você: the search, the type chips (Tudo, Documentos, Planilhas, Apresentações, Quadros, Imagens,
 * Tabelas, Diffs), and everything the person can see grouped by day (Hoje, Esta semana, then by month) in a two-column
 * grid of real previews, with the faces of who is in each live file now, and a file sent from the phone. "+" makes a
 * spreadsheet, a presentation or a canvas (ADR 0196 §9) or sends a file. A card opens the file as every file opens.
 * `highlightId`: the item "Ver no Drive" came from, outlined.
 *
 * A chip narrows the list on the server to the kinds that can hold its type (`driveFilters`); an uploaded file is one
 * kind there whatever it holds, so the phone keeps the files its name says are of the type, and reads the server's
 * next pages by itself until it has a page of them to show or the server has no more (`keepsLooking`), the rows'
 * shape on screen while it finds none yet.
 */
export function DriveScreen(props: { highlightId?: string | null; folderId?: string | null }) {
  return (
    <SheetHostProvider>
      <DriveBody {...props} />
    </SheetHostProvider>
  );
}

/**
 * A folder (`folderId`, null = the top level) shows its folders, then its files; a search or a type looks through the
 * whole Drive, as on the web.
 */
function DriveBody({ highlightId = null, folderId = null }: { highlightId?: string | null; folderId?: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const when = useWhen();
  const [q, setQ] = useState("");
  const [type, setType] = useState<DriveType>("all");
  const [shown, setShown] = useState(PAGE);
  const search = useDeferredValue(q.trim());
  const browsing = search === "" && type === "all";
  const filters = useMemo(
    () => ({ ...driveFilters(search, type), ...(browsing ? { folderId } : {}) }),
    [search, type, browsing, folderId],
  );
  const arrange = useFolderActions();
  const trail = folderTrail(arrange.folders, folderId);
  const here = trail.at(-1) ?? null;
  const subfolders = browsing ? (folderChildren(arrange.folders).get(folderId ?? "") ?? []) : [];
  const list = useArtifacts(orgId, filters);
  const pull = usePullRefresh(list.refetch);
  const matches = useMemo(() => (list.artifacts ?? []).filter((a) => matchesType(a, type)), [list.artifacts, type]);
  const hasNextPage = Boolean(list.hasNextPage);
  const looking = keepsLooking({
    matched: matches.length,
    wanted: shown,
    hasNextPage,
    fetching: list.isFetching,
    placeholder: list.isPlaceholderData,
    failed: list.isFetchNextPageError,
  });
  const { fetchNextPage } = list;
  useEffect(() => {
    if (looking) void fetchNextPage();
  }, [looking, fetchNextPage]);
  // Newest first; the highlighted item is always among those shown.
  const sections = useMemo(() => {
    const sorted = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const at = highlightId ? sorted.findIndex((a) => a.id === highlightId) : -1;
    return driveSections(sorted.slice(0, Math.max(shown, at + 1)));
  }, [matches, shown, highlightId]);
  // What the grid shows, in its order: a picture or a video opens among the grid's others, to swipe through.
  const shownRefs = useMemo(() => sections.flatMap((s) => s.items.map(driveRef)), [sections]);
  // Who is in the live files shown, asked for all of them at once.
  const liveIds = useMemo(
    () =>
      sections
        .flatMap((s) => s.items.filter((a) => isLiveFileKind(a.kind)).map((a) => a.id))
        .slice(0, LIVE_PRESENCE_BATCH),
    [sections],
  );
  const presence = useLivePresence(orgId, liveIds);
  const label = (s: DriveDaySection) =>
    s.label.kind === "month"
      ? monthFormat(when.locale, s.label.year !== new Date().getFullYear())
          .format(new Date(s.label.year, s.label.month, 1))
          .replace(/^./, (x) => x.toLocaleUpperCase())
      : t(`mobile.drive.section.${s.label.kind}`);
  const mayUpload = can(useOrg().org, "upload_files");
  // One long press for every card, reading the menu as of this render: a new one each render would draw every card
  // again (they are memoized) at each letter typed in the search.
  const fileMenu = useLatest((x: Artifact, open: () => void) => arrange.fileMenu(x, open, mayUpload));
  const uploader = useDriveUpload(list.refetch, folderId);
  const maker = useCreateLive();
  const newItems: HeaderMenuItem[] = [
    ...LIVE_KINDS_MADE.map((kind) => ({
      icon: LIVE_ICON[kind],
      sf: LIVE_SF[kind],
      label: t(`live.kinds.${kind}`),
      onPress: () => void maker.make(kind),
    })),
    { icon: "drive", sf: "folder.badge.plus", label: t("drive.newFolder"), onPress: () => arrange.newFolder(folderId) },
    { icon: "share", sf: "square.and.arrow.up", label: t("files.upload"), onPress: uploader.pick },
  ];
  const clear = () => {
    setQ("");
    setType("all");
    setShown(PAGE);
  };
  const visible = sections.reduce((n, s) => n + s.items.length, 0);
  const view = driveView({
    loading: list.isLoading,
    // Nothing to show: the first page didn't load, or the next one failed before any file of the type turned up.
    failed: (list.isError && !list.data) || (list.isFetchNextPageError && matches.length === 0),
    matched: matches.length,
    hasNextPage,
    placeholder: list.isPlaceholderData,
    filtered: search !== "" || type !== "all",
  });
  // The grid fades in over the rows' shape, and a day that comes with "Show more" fades in under the others; what
  // shows when the screen opens doesn't fade card by card.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  return (
    <PushedLargeTitle
      title={here?.name ?? t("mobile.drive.title")}
      {...(mayUpload
        ? {
            actions: [
              {
                icon: "plus",
                sf: "plus",
                label: t("live.kinds.newMenu"),
                disabled: uploader.busy || maker.busy !== null,
                menu: newItems,
                // Android: the same choices in the app's list (iOS opens the menu from the button itself).
                onPress: () => chooseAction(t("live.kinds.newMenu"), newItems, t("mobile.common.cancel")),
              },
            ],
          }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      // The grid draws every card at once: a PDF's card downloads its first page only once it comes in sight.
      onScrollEnd={noteCardsScrolled}
    >
      {here ? <FolderPath trail={trail} /> : null}
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.drive.search")}
          accessibilityLabel={t("mobile.drive.search")}
          returnKeyType="search"
        />
      </View>
      <Filters
        items={DRIVE_TYPES.map((k) => ({ key: k, label: t(`mobile.drive.type.${k}`) }))}
        value={type}
        onChange={(k) => {
          setType(k as DriveType);
          setShown(PAGE);
        }}
      />
      <FolderRows folders={subfolders} onMenu={(f) => arrange.folderMenu(f, mayUpload)} more={mayUpload} />
      {view === "loading" ? (
        // Loading, or still looking for files of the type: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : view === "failed" ? (
        <LoadFailed onRetry={() => void (list.isFetchNextPageError ? fetchNextPage() : list.refetch())} />
      ) : view === "noMatch" ? (
        <EmptyState
          size="inline"
          title={t("mobile.drive.noResults")}
          action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
        />
      ) : view === "empty" && (folderId || subfolders.length > 0) ? (
        subfolders.length > 0 ? null : (
          <EmptyState
            size="inline"
            title={t("drive.folderEmptyTitle")}
            action={
              mayUpload ? (
                <Button variant="secondary" size="sm" label={t("files.upload")} onPress={uploader.pick} />
              ) : undefined
            }
          />
        )
      ) : view === "empty" ? (
        <FirstUse
          place="drive"
          acts={mayUpload}
          label={t("files.upload")}
          busy={uploader.busy}
          onPress={uploader.pick}
        />
      ) : (
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            {/* A file on its way in holds a card's place above the days, so a large one shows it's going. */}
            {uploader.uploading !== null ? (
              <Animated.View {...fade} style={[styles.row, styles.uploading]}>
                <UploadingCard name={uploader.uploading} />
                <View style={styles.spacer} />
              </Animated.View>
            ) : null}
            {sections.map((s) => (
              <Animated.View key={s.key} {...fade}>
                <SectionHeader title={label(s)} count={s.items.length} />
                <View style={styles.grid}>
                  {gridRows(s.items).map((row) => (
                    <View key={row.map((a) => a.id).join(":")} style={styles.row}>
                      {row.map((a) => (
                        <DriveCard
                          key={a.id}
                          artifact={a}
                          highlighted={a.id === highlightId}
                          siblings={shownRefs}
                          onLongPress={fileMenu}
                          present={presence.data?.[a.id]}
                        />
                      ))}
                      {row.length === 1 ? <View style={styles.spacer} /> : null}
                    </View>
                  ))}
                </View>
              </Animated.View>
            ))}
            {visible < matches.length || hasNextPage ? (
              // Centred across the screen inside its margins (a button keeps to its own width at the row's start).
              <View style={styles.more}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("mobile.drive.more")}
                  loading={list.isFetchingNextPage}
                  onPress={() => {
                    setShown((n) => n + PAGE);
                    // A page that failed is asked for again only when the person asks for more.
                    if (list.isFetchNextPageError) void fetchNextPage();
                  }}
                />
              </View>
            ) : null}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: SCREEN_X, paddingBottom: 10 },
  grid: { paddingHorizontal: SCREEN_X, gap: 16 },
  row: { flexDirection: "row", gap: 12 },
  uploading: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 4 },
  spacer: { flex: 1 },
  more: { flexDirection: "row", justifyContent: "center", paddingHorizontal: SCREEN_X, paddingTop: 20 },
});
