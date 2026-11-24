import {
  keys,
  useApi,
  useWikiAction,
  useWikiGraph,
  useWikiHistory,
  useWikiPage,
  useWikiTree,
  type WikiBacklink,
  type WikiPageSummary,
  type WikiVersion,
} from "@agenteschat/client";
import { capitalize, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { titleOfSlug, toggleTask, wikiImportOf } from "@agenteschat/client/lib/wiki";
import { type DiffLine, diffLines } from "@agenteschat/ui/diff";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Platform, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { Sky } from "@/sky/Sky";
import {
  Button,
  DiffView,
  EmptyState,
  Filters,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  type HeaderAction,
  Icon,
  type IconName,
  ListRow,
  Locked,
  padPastFold,
  Row,
  SCREEN_X,
  SearchField,
  SectionHeader,
  type SFSymbolName,
  SkeletonList,
  Text,
  useFieldText,
  useFoldRoom,
  useLargeTitleScroll,
  usePulse,
  useReducedMotion,
  useToast,
} from "@/ui";
import { FadingHeaderTitle } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { Constellation, StarCard } from "../constellation/Constellation";
import { aroundStar, linkCount, linksOutOf, mostLinked, pagesMap, strongest } from "../constellation/logic";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { chooseAction, NEXT_FIELD, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { FirstUse, LoadFailed, useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { copyText, goBack, PushedHeader, successHaptic, Tile } from "../shared/parts";
import {
  continueReading,
  foldersIn,
  parseRecents,
  searchWiki,
  wikiHome,
  withoutTitleHeading,
  withRecent,
} from "./logic";
import { openWikiAgents, openWikiTrash, useWikiBulkDelete } from "./WikiBulk";
import { WikiDoc } from "./WikiDoc";

/** Opens a page of the wiki (its slug in the path, encoded: a slug may carry its folder). */
export const openWikiPage = (slug: string) => router.push(`/wiki/${encodeURIComponent(slug)}`);
/** "Nova página" (a short sheet), with a title already (a link to a page that doesn't exist yet) or a folder. */
export const newWikiPage = (params: { title?: string; folder?: string } = {}) =>
  router.push({ pathname: "/wiki-new", params });
/** Writing a page: an existing one by slug, or a new one with its title and folder. */
export const writeWikiPage = (params: { slug: string } | { title: string; folder: string }) =>
  router.push({ pathname: "/wiki-write", params });

/** The whole graph of the wiki, as the web's "Grafo". */
export const openWikiMap = () => router.push("/wiki-map");

/** The pages last opened on this phone, per workspace ("Continuar lendo"), read again whenever a screen asks. */
const readRecents = () => parseRecents(readValueSync(STORED.wikiRecent));

/** A page by the `[[title]]` of a link: opens it, or offers to create it. */
export const openWikiLink = (title: string, page: WikiPageSummary | undefined) =>
  page ? openWikiPage(page.slug) : newWikiPage({ title });

/**
 * The wiki, pushed from Você, as Tarefas and Rotinas: the large title and the search, "+" (Nova página) in the bar
 * and "…" for the rest (who sees it, choosing pages, the trash). Under the search, the wiki's connections as the
 * web's graph draws them (pages and their [[links]], the most linked bigger): it lights up the first time it is seen,
 * a tap lights a page's links and a second tap opens it, "Ver o grafo" opens it whole. Then one list, each page once:
 * Continuar lendo (the last pages opened here), Fixadas, Pastas (with how many pages), Páginas; every row a tile of 52
 * with its text at 80, who changed it last and when. `folder`: the same screen for one folder (its folders and pages).
 */
export function WikiScreen({ folder = "" }: { folder?: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  // Writing in the wiki is `edit_wiki` (ADR 0085; the server checks it again).
  const { org } = useOrg();
  const writes = can(org, "edit_wiki");
  const choosesAudience = writes && can(org, "manage_roles");
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const tree = useWikiTree(orgId);
  const graph = useWikiGraph(orgId, folder === "");
  // A pull asks for the pages again (and the home's graph, which a folder doesn't draw).
  const pull = usePullRefresh(() => Promise.allSettled([tree.refetch(), ...(folder ? [] : [graph.refetch()])]));
  const [picked, setPicked] = useState<string | null>(null);
  // Read again each time the home shows: a page opened from here is first when coming back.
  const [recents, setRecents] = useState(readRecents);
  useFocusEffect(useCallback(() => setRecents(readRecents()), []));
  // Choosing pages to delete them or set their agents at once.
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const bulkDelete = useWikiBulkDelete();
  // Folded like a book (ADR 0212), the choosing bar's buttons keep to the half past the fold, never across it.
  const foldSide = useFoldRoom();
  const stopSelecting = () => {
    setSelecting(false);
    setChosen(new Set());
  };
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const pages = useMemo(() => tree.data ?? [], [tree.data]);
  const home = useMemo(() => wikiHome(pages, folder), [pages, folder]);
  const found = useMemo(
    () => searchWiki(folder ? pages.filter((p) => inFolder(p, folder)) : pages, search),
    [pages, folder, search],
  );
  const map = useMemo(() => (graph.data ? pagesMap(graph.data) : null), [graph.data]);
  // The home's sky keeps the most linked pages (the whole graph is one tap away); it opens on the most linked of
  // all, the heart of the wiki, where its lines start drawing from.
  const sky = useMemo(() => (map ? strongest(map, HOME_STARS) : null), [map]);
  const heart = sky ? mostLinked(sky) : null;
  const star = sky?.stars.find((s) => s.id === (picked ?? heart));
  const when = (iso: string) => relativeTime(t, i18n.language, iso);
  const title = folder ? (folder.split("/").pop() ?? folder) : t("wiki.title");
  // The home and the search's results cross-fade as a search starts and ends, and fade in when they load.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  // Who changed it last and when; a pinned page says what it is about instead.
  const byLine = (p: WikiPageSummary) => `${dir.nameOf(p.updatedBy)} · ${when(p.updatedAt)}`;
  // A page chosen or let go, by its id: one function for every row (the rows are memoized).
  const toggle = useCallback(
    (id: string) =>
      setChosen((was) => {
        const next = new Set(was);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const pageRow = (p: WikiPageSummary, i: number, sub: string, icon?: "pin") => (
    <WikiPageRow
      key={p.id}
      id={p.id}
      slug={p.slug}
      title={p.title}
      sub={sub}
      locked={Boolean(p.locked)}
      pinned={icon === "pin"}
      divider={i > 0}
      selecting={selecting}
      selected={chosen.has(p.id)}
      onToggle={toggle}
    />
  );
  const inThisFolder = folder ? pages.filter((p) => inFolder(p, folder)).length : 0;
  // Each page once: a pinned page is under Fixadas only, a page read lately under Continuar lendo only. Worked out
  // again only when the pages or the reading change, not at each letter typed or page chosen.
  const { reading, loose } = useMemo(() => {
    const pinnedIds = new Set((home?.pinned ?? []).map((p) => p.id));
    const reading = folder
      ? []
      : continueReading(
          pages.filter((p) => !pinnedIds.has(p.id)),
          recents[orgId] ?? [],
        );
    const readingIds = new Set(reading.map((p) => p.id));
    const loose = (home?.pages ?? []).filter((p) => !pinnedIds.has(p.id) && !readingIds.has(p.id));
    return { reading, loose };
  }, [home, folder, pages, recents, orgId]);
  const choosable = search ? found : (home?.pages ?? []);
  // Only with links: a sky of lone dots says nothing.
  const hasMap = Boolean(sky && star && !folder && sky.links.length > 0);
  // "…": what the home no longer shows, each a line of the app's sheet with its icon.
  const menu = [
    ...(choosesAudience
      ? [
          {
            icon: "members" as const,
            sf: "person.2" as const,
            label: folder ? t("wiki.audience") : t("wiki.audienceRootTitle"),
            onPress: () => router.push({ pathname: "/wiki-audience", params: folder ? { folder } : { root: "1" } }),
          },
        ]
      : []),
    ...(writes && pages.length > 0
      ? [
          {
            icon: "checkc" as const,
            sf: "checkmark.circle" as const,
            label: t("wiki.bulk.select"),
            onPress: () => setSelecting(true),
          },
        ]
      : []),
    ...(!folder && writes
      ? [{ icon: "trash" as const, sf: "trash" as const, label: t("wiki.trash.title"), onPress: openWikiTrash }]
      : []),
    ...(folder && writes
      ? [
          {
            icon: "trash" as const,
            sf: "trash" as const,
            label: t("wiki.bulk.deleteFolder", { folder }),
            destructive: true,
            onPress: () =>
              bulkDelete.ask(
                { folder },
                inThisFolder,
                t("wiki.bulk.deleteFolderTitle", { folder, count: inThisFolder }),
                goBack,
              ),
          },
        ]
      : []),
  ];
  // Choosing pages: the bar of what to do with them stays at the screen's foot, over the list.
  const pickBar = selecting ? (
    <View
      style={[
        styles.pickBar,
        { paddingBottom: insets.bottom + 12, backgroundColor: c.bg, borderColor: c.line },
        foldSide && padPastFold(foldSide, 16),
      ]}
    >
      {choosesAudience ? (
        <Button
          variant="secondary"
          label={t("wiki.bulk.agents")}
          disabled={chosen.size === 0}
          onPress={() => {
            openWikiAgents([...chosen]);
            stopSelecting();
          }}
        />
      ) : null}
      <View style={styles.grow}>
        <Button
          variant="primary"
          wide
          label={chosen.size ? t("wiki.bulk.deleteGo", { count: chosen.size }) : t("wiki.bulk.delete")}
          loading={bulkDelete.pending}
          disabled={chosen.size === 0 || bulkDelete.pending}
          onPress={() =>
            bulkDelete.ask(
              { ids: [...chosen] },
              chosen.size,
              t("wiki.bulk.deleteTitle", { count: chosen.size }),
              stopSelecting,
            )
          }
        />
      </View>
    </View>
  ) : null;
  return (
    // The large title's scroll view is the screen's own first view (the system folds the title as it scrolls): the bar
    // of a selection goes in its dock, never in a view around it.
    <PushedLargeTitle
      title={title}
      bottomInset={selecting ? 96 : 24}
      dock={pickBar}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      // Choosing pages, the bar's word ends the choice; otherwise the system's own "+" and "…" (its menu on iOS).
      {...(selecting
        ? { action: { label: t("common.cancel"), onPress: stopSelecting } }
        : {
            actions: [
              ...(writes
                ? [
                    {
                      icon: "plus" as const,
                      sf: "plus" as const,
                      label: t("wiki.newPage"),
                      onPress: () => newWikiPage(folder ? { folder } : {}),
                    },
                  ]
                : []),
              ...(menu.length > 0
                ? [
                    {
                      icon: "more" as const,
                      sf: "ellipsis" as const,
                      label: t("mobile.wiki.more"),
                      disabled: bulkDelete.pending,
                      onPress: () => chooseAction(title, menu, t("common.cancel")),
                      menu,
                    },
                  ]
                : []),
            ],
          })}
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("wiki.searchPlaceholder")}
          accessibilityLabel={t("wiki.searchPlaceholder")}
          returnKeyType="search"
        />
      </View>
      {/* Loading: the rows' own shape; failed: what happened and the way to ask again. */}
      {tree.isLoading ? <SkeletonList rows={5} /> : null}
      {tree.isError && !tree.data ? <LoadFailed onRetry={() => void tree.refetch()} /> : null}
      {tree.isSuccess && pages.length === 0 ? (
        <FirstUse
          place="wiki"
          size="panel"
          acts={writes}
          label={t("wiki.newPage")}
          onPress={() => newWikiPage(folder ? { folder } : {})}
        />
      ) : null}
      {selecting ? (
        <>
          <SectionHeader
            title={chosen.size ? t("wiki.bulk.selected", { count: chosen.size }) : t("wiki.bulk.select")}
            count={choosable.length}
          />
          <Locked when={bulkDelete.pending}>{choosable.map((p, i) => pageRow(p, i, p.folder || byLine(p)))}</Locked>
        </>
      ) : search ? (
        found.length === 0 ? (
          pages.length > 0 ? (
            <EmptyState
              size="inline"
              title={t("wiki.noMatch")}
              action={
                <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              }
            />
          ) : null
        ) : (
          <Animated.View key="found" {...fade}>
            <SectionHeader title={t("wiki.results", { count: found.length })} />
            {found.map((p, i) => pageRow(p, i, p.folder || byLine(p)))}
          </Animated.View>
        )
      ) : home ? (
        <Animated.View key="home" {...fade}>
          {hasMap && map && sky && star ? (
            <>
              <SectionHeader
                title={t("mobile.wiki.graph")}
                count={map.links.length}
                action={{ label: t("wiki.openGraph"), onPress: openWikiMap, chevron: true }}
              />
              <StarCard
                accessibilityLabel={t("mobile.wiki.map")}
                map={sky}
                selected={star.id}
                height={GRAPH_HEIGHT}
                explore={false}
                assemble={`wiki:${orgId}`}
                // A first tap lights the page's links; a tap on the lit page opens it.
                onSelect={(id) => (id === star.id ? openWikiPage(id) : setPicked(id))}
                title={star.title}
                subtitle={[star.folder, t("mobile.wiki.links", { count: linkCount(map, star.id) })]
                  .filter(Boolean)
                  .join(" · ")}
                onOpen={() => openWikiPage(star.id)}
                style={styles.graphCard}
              />
            </>
          ) : null}
          {reading.length > 0 ? (
            <>
              <SectionHeader title={t("mobile.wiki.continue")} />
              {reading.map((p, i) => pageRow(p, i, byLine(p)))}
            </>
          ) : null}
          {home.pinned.length > 0 ? (
            <>
              <SectionHeader title={t("wiki.pinnedPages")} count={home.pinned.length} />
              {home.pinned.map((p, i) => pageRow(p, i, p.excerpt || byLine(p), "pin"))}
            </>
          ) : null}
          {home.folders.length > 0 ? (
            <>
              <SectionHeader title={t("wiki.folders")} count={home.folders.length} />
              {home.folders.map((f, i) => (
                <ListRow
                  key={f.path}
                  divider={i > 0}
                  leading={<Tile icon="archive" size={ROW_TILE} />}
                  title={f.name}
                  sub={t("wiki.pageCount", { count: f.count })}
                  subLines={1}
                  onPress={() => router.push({ pathname: "/wiki", params: { folder: f.path } })}
                />
              ))}
            </>
          ) : null}
          {loose.length > 0 ? (
            <>
              <SectionHeader title={t("wiki.tree")} count={loose.length} />
              {loose.map((p, i) => pageRow(p, i, byLine(p)))}
            </>
          ) : null}
        </Animated.View>
      ) : tree.isSuccess && pages.length > 0 ? (
        <EmptyState size="panel" icon="archive" title={t("mobile.wiki.folderGone")} />
      ) : null}
    </PushedLargeTitle>
  );
}

/** The rows' tile, in the 52 column of a list row (the text at 80). */
const ROW_TILE = 52;
/** The home's graph: tall enough to read a cluster, short enough that the list starts above the fold. */
const GRAPH_HEIGHT = 220;
/** How many pages the home's graph draws: past this, names collide and stars crowd the card. */
const HOME_STARS = 24;
/** A page's small sky of itself and its neighbours. */
const AROUND_HEIGHT = 168;
/**
 * Where a page's heading starts under the bar (the band's 8 + 96, the page's 16 above its words) and how far it runs
 * (its title's line; a folder's line and its 4 above the title): the bar's title fades in over that span, as the
 * heading leaves.
 */
const TITLE_IN_BAR_FROM = 8 + 96 + 16;
const TITLE_IN_BAR_SPAN = 36;
const FOLDER_LINE = 22;

const inFolder = (p: WikiPageSummary, folder: string) => p.folder === folder || p.folder.startsWith(`${folder}/`);

/**
 * A page in the wiki's lists: its tile, its title and its line; choosing pages, the check on the right and a tap
 * chooses it, else a tap opens it. Drawn again only when what it shows changes.
 */
const WikiPageRow = memo(function WikiPageRow({
  id,
  slug,
  title,
  sub,
  locked,
  pinned,
  divider,
  selecting,
  selected,
  onToggle,
}: {
  id: string;
  slug: string;
  title: string;
  sub: string;
  locked: boolean;
  pinned: boolean;
  divider: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const c = useColors();
  return (
    <ListRow
      divider={divider}
      leading={<PageTile page={{ locked }} icon={pinned ? "pin" : undefined} />}
      title={title}
      sub={sub}
      subLines={1}
      {...(selecting
        ? {
            trailing: <Icon name={selected ? "checkc" : "circle"} size={22} color={selected ? c.ink : c.faint} />,
            accessibilityState: { selected },
            onPress: () => onToggle(id),
          }
        : { onPress: () => openWikiPage(slug) })}
    />
  );
});

/** A page's tile: a lock when only admins edit it, a pin under Fixadas. */
function PageTile({ page, icon }: { page: Pick<WikiPageSummary, "locked">; icon?: "pin" | undefined }) {
  return <Tile icon={page.locked ? "lock" : (icon ?? "file")} size={ROW_TILE} />;
}

/** One choice of a page's "…": our icon (Android's list) and its SF Symbol (iOS's own menu). */
interface MenuItem {
  key: string;
  icon: IconName;
  sf: SFSymbolName;
  label: string;
  danger?: boolean;
  run: () => void;
}

/**
 * A page: its own sky band with who wrote it, its folder, the title once, who wrote it (and at whose request) and
 * when, the text (links open or create; tasks check with a tap for whoever may edit), then its connections: the page
 * and its neighbours as a small sky (a tapped neighbour lights its lines, then opens), "Liga para", "Mencionada em",
 * the agents that use it and the history. The bar: "Editar" (the writing screen) and "…" (Copiar link, Renomear ou
 * mover, Fixar, Trancar, Histórico, Apagar), the system's own buttons and menu on iOS.
 */
export function WikiPageScreen({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  // Writing is `edit_wiki`; a locked page, and locking, only for who configures the workspace (ADR 0085).
  const page = useWikiPage(orgId, slug);
  const writes = can(org, "edit_wiki") && page.data?.canEdit !== false;
  const look = useEmptyLook();
  const admin = can(org, "configure");
  // Who sees a page: anyone who edits it (the server checks the same); agents and editors, who manages roles too.
  const choosesAudience = writes;
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
  const bulkDelete = useWikiBulkDelete();
  const graph = useWikiGraph(orgId, true);
  // A pull reads the page again, with the links around it.
  const pull = usePullRefresh(() => Promise.allSettled([page.refetch(), graph.refetch()]));
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const p = page.data;
  const editable = p ? writes && (!p.locked || admin) : false;
  const pages = useMemo(() => tree.data ?? [], [tree.data]);
  const readers = useMemo(() => p?.reads?.agents ?? [], [p?.reads?.agents]);
  // The page and the pages it touches, as the home's sky: drawn when it has two neighbours or more (one line alone
  // says less than the rows under it).
  const around = useMemo(() => {
    if (!graph.data || !p) return null;
    const near = aroundStar(pagesMap(graph.data), p.slug);
    return near.stars.length > 2 ? near : null;
  }, [graph.data, p]);
  const linksOut = useMemo(() => {
    if (!graph.data || !p) return [];
    const bySlug = new Map(pages.map((x) => [x.slug, x]));
    return linksOutOf(graph.data, p.slug).flatMap((slug) => bySlug.get(slug) ?? []);
  }, [graph.data, p, pages]);
  const body = useMemo(() => (p ? withoutTitleHeading(p.body, p.title) : ""), [p]);
  // A neighbour tapped in the small sky: its lines light, then it opens; back here, the page is the heart again.
  const [neighbour, setNeighbour] = useState<string | null>(null);
  useFocusEffect(useCallback(() => setNeighbour(null), []));
  const reducedMotion = useReducedMotion();
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (opening.current) clearTimeout(opening.current);
    },
    [],
  );
  // Opened: first under the wiki home's Continuar lendo.
  const opened = p?.slug;
  useEffect(() => {
    if (opened) writeValueSync(STORED.wikiRecent, JSON.stringify(withRecent(readRecents(), orgId, opened)));
  }, [opened, orgId]);

  const toggle = (line: number) => {
    if (!p) return;
    const body = toggleTask(p.body, line);
    if (body === p.body) return;
    action.mutate(
      { type: "update", slug: p.slug, input: { body, baseVersion: p.version } },
      {
        onError: (e) => {
          if ((e as { code?: string }).code === "version_conflict") {
            void page.refetch();
            toast({ title: t("mobile.wiki.taskConflict"), icon: "x" });
          } else failed(e);
        },
      },
    );
  };

  const remove = () => {
    if (!p) return;
    Alert.alert(t("wiki.deleteTitle", { title: p.title }), t("wiki.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("wiki.delete"),
        style: "destructive",
        onPress: () =>
          void api.wiki
            .remove(orgId, p.slug)
            .then(() => {
              successHaptic();
              void qc.invalidateQueries({ queryKey: keys.wiki(orgId) });
              toast({ title: t("wiki.deleted", { title: p.title }) });
              goBack();
            })
            .catch(failed),
      },
    ]);
  };

  // The page's "…": iOS's own menu from the bar button; Android lists the same choices in the app's sheet.
  const items: MenuItem[] = [];
  if (p) {
    items.push({
      key: "copy",
      icon: "copy",
      sf: "link",
      label: t("wiki.copyLink"),
      run: () =>
        void copyText(`[[${p.title}]]`).then((ok) =>
          toast(
            ok ? { title: t("wiki.linkCopied", { title: p.title }) } : { title: t("mobile.app.failed"), icon: "x" },
          ),
        ),
    });
    if (editable)
      items.push({
        key: "move",
        icon: "archive",
        sf: "folder",
        label: t("wiki.renameOrMove"),
        run: () => router.push({ pathname: "/wiki-move", params: { slug: p.slug } }),
      });
    if (writes)
      items.push({
        key: "pin",
        icon: "pin",
        sf: p.pinned ? "pin.slash" : "pin",
        label: p.pinned ? t("wiki.unpin") : t("wiki.pin"),
        run: () =>
          action.mutate(
            { type: "pin", slug: p.slug, pinned: !p.pinned },
            { onSuccess: (x) => toast({ title: x.pinned ? t("wiki.pinned") : t("wiki.unpinned") }), onError: failed },
          ),
      });
    if (writes)
      items.push({
        key: "context",
        icon: "agent",
        sf: "sparkles",
        label: p.agentContext ? t("wiki.context.off") : t("wiki.context.on"),
        run: () =>
          action.mutate(
            { type: "context", slug: p.slug, on: !p.agentContext },
            {
              onSuccess: (x) => toast({ title: x.agentContext ? t("wiki.context.added") : t("wiki.context.removed") }),
              onError: failed,
            },
          ),
      });
    if (choosesAudience)
      items.push({
        key: "audience",
        icon: "eye",
        sf: "eye",
        label: t("wiki.audience"),
        run: () => router.push({ pathname: "/who-sees", params: { slug: p.slug } }),
      });
    if (admin)
      items.push({
        key: "lock",
        icon: "lock",
        sf: p.locked ? "lock.open" : "lock",
        label: p.locked ? t("wiki.unlock") : t("wiki.lock"),
        run: () =>
          action.mutate(
            { type: "lock", slug: p.slug, locked: !p.locked },
            {
              onSuccess: (x) => toast({ title: x.locked ? t("wiki.lockedDone") : t("wiki.unlockedDone") }),
              onError: failed,
            },
          ),
      });
    items.push({
      key: "history",
      icon: "clock",
      sf: "clock",
      label: t("wiki.history"),
      run: () => router.push({ pathname: "/wiki-history", params: { slug: p.slug } }),
    });
    if (editable)
      items.push({ key: "delete", icon: "trash", sf: "trash", label: t("wiki.delete"), danger: true, run: remove });
    const imported = writes ? wikiImportOf(pages, p) : null;
    if (imported)
      items.push({
        key: "delete-import",
        icon: "trash",
        sf: "trash",
        label: t("wiki.bulk.deleteImport", { name: imported.name, count: imported.pages.length }),
        danger: true,
        run: () =>
          bulkDelete.ask(
            imported.target,
            imported.pages.length,
            t("wiki.bulk.deleteImportTitle", { name: imported.name, count: imported.pages.length }),
            goBack,
          ),
      });
  }
  // "Editar" as the bar's own button, then "…".
  const barActions: HeaderAction[] = p
    ? [
        ...(editable
          ? [
              {
                icon: "pen" as const,
                sf: "square.and.pencil" as const,
                label: t("wiki.edit"),
                onPress: () => writeWikiPage({ slug: p.slug }),
              },
            ]
          : []),
        {
          icon: "more",
          sf: "ellipsis",
          label: t("wiki.more"),
          onPress: () =>
            chooseAction(
              p.title,
              items.map((i) => ({
                label: i.label,
                icon: i.icon,
                ...(i.danger ? { destructive: true } : {}),
                onPress: i.run,
              })),
              t("common.cancel"),
            ),
          menu: items.map((i) => ({
            label: i.label,
            icon: i.icon,
            sf: i.sf,
            ...(i.danger ? { destructive: true } : {}),
            onPress: i.run,
          })),
        },
      ]
    : [];

  const person = p?.updatedBy.onBehalfOf ? dir.memberById.get(p.updatedBy.onBehalfOf)?.name : undefined;
  // "Theo a pedido de Ana · 3 de nov.": the version lives in Histórico, under the page.
  // A writer that no longer exists (a deleted agent) leaves just when.
  const writer = p ? dir.nameOf(p.updatedBy) : "";
  const by = p
    ? [
        writer && person ? `${writer} ${t("wiki.atRequestOf")} ${person}` : writer,
        relativeTime(t, i18n.language, p.updatedAt),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  // The band takes the writer's sky: an agent's color, the app's sky for a person.
  const bandColor = p?.updatedBy.type === "agent" ? agentLook(dir.anyAgent(p.updatedBy.id)).color : ("sky" as const);
  // Read from where the content rests under the bar (iOS insets it by the bar's height).
  const scroll = useLargeTitleScroll(Platform.OS === "ios" ? headerHeight : 0, { snap: false });
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      {/* The page's title comes into the bar as its own heading scrolls under it, so a long page keeps its name. */}
      <PushedHeader
        solid={false}
        {...(p
          ? {
              title: (
                <FadingHeaderTitle
                  y={scroll.y}
                  from={TITLE_IN_BAR_FROM}
                  to={TITLE_IN_BAR_FROM + (p.folder ? TITLE_IN_BAR_SPAN + FOLDER_LINE : TITLE_IN_BAR_SPAN)}
                  text={p.title}
                />
              ),
            }
          : {})}
        actions={barActions}
      />
      <Animated.ScrollView
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        {/* Loading: the page's own shape (its band, its title, its lines), never a spinner. */}
        {page.isLoading ? <PageSkeleton /> : null}
        {page.isError && !p ? (
          (page.error as { code?: string } | null)?.code === "wiki.no_access" ? (
            <EmptyState icon="lock" title={t("wiki.noAccessTitle")} subtitle={t("wiki.noAccessText")} />
          ) : (page.error as { status?: number } | null)?.status === 404 ? (
            <EmptyState
              size="panel"
              agent={look}
              title={t("wiki.missingTitle")}
              subtitle={t(writes ? "wiki.missingText" : "wiki.missingViewer")}
              {...(writes
                ? {
                    action: (
                      <Button
                        variant="primary"
                        size="sm"
                        icon="plus"
                        label={t("wiki.createPage")}
                        onPress={() => newWikiPage({ title: capitalize(titleOfSlug(slug), i18n.language) })}
                      />
                    ),
                  }
                : {})}
            />
          ) : (
            <LoadFailed onRetry={() => void page.refetch()} />
          )
        ) : null}
        {p ? (
          <>
            {/* The page's own sky, its writer's face framed on the horizon, low and to the left. */}
            <View style={styles.band} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Sky color={bandColor} fade={0.45} style={StyleSheet.absoluteFill} />
              <View style={styles.bandFace}>
                <Face who={p.updatedBy} size={36} framed live={false} />
              </View>
            </View>
            <View style={styles.page}>
              {p.folder ? (
                <Text variant="footnote" tone="faint" numberOfLines={1} ellipsizeMode="middle">
                  {p.folder}
                </Text>
              ) : null}
              <Text variant="display2" accessibilityRole="header" style={styles.title}>
                {p.title}
              </Text>
              <Text variant="footnote" tone="muted" style={styles.byline}>
                {by}
              </Text>
              {p.audience || p.agentIds ? (
                <View style={styles.note}>
                  <Note icon="eye">{p.audience ? t("wiki.restrictedHint") : t("wiki.audienceAgentsOnlyHint")}</Note>
                </View>
              ) : null}
              {p.canEdit === false ? (
                <View style={styles.note}>
                  <Note icon="eye">{t("wiki.readOnlyHint")}</Note>
                </View>
              ) : null}
              {p.locked ? (
                <View style={styles.note}>
                  <Note icon="lock">{t("wiki.lockedHint")}</Note>
                </View>
              ) : null}
              <View style={styles.body}>
                {body.trim() ? (
                  <WikiDoc
                    body={body}
                    pages={pages}
                    onOpenLink={openWikiLink}
                    onToggleTask={editable ? toggle : undefined}
                  />
                ) : (
                  <Text variant="body" tone="faint">
                    {t("mobile.wiki.blank")}
                  </Text>
                )}
              </View>
            </View>
            {around ? (
              <>
                <SectionHeader title={t("mobile.wiki.graph")} />
                <View style={styles.around}>
                  <Constellation
                    map={around}
                    selected={neighbour ?? p.slug}
                    height={AROUND_HEIGHT}
                    explore={false}
                    onSelect={(id) => {
                      if (id === p.slug || neighbour) return;
                      setNeighbour(id);
                      // Its lines draw bright (240 ms), then the page opens on them; at once with reduced motion.
                      opening.current = setTimeout(() => openWikiPage(id), reducedMotion ? 0 : 260);
                    }}
                  />
                </View>
              </>
            ) : null}
            {linksOut.length > 0 ? (
              <>
                <SectionHeader title={t("mobile.wiki.linksOut")} count={linksOut.length} />
                {linksOut.map((x, i) => (
                  <ListRow
                    key={x.id}
                    divider={i > 0}
                    leading={<PageTile page={x} />}
                    title={x.title}
                    sub={x.folder || t("wiki.root")}
                    subLines={1}
                    chevron
                    onPress={() => openWikiPage(x.slug)}
                  />
                ))}
              </>
            ) : null}
            <SectionHeader title={t("wiki.backlinks")} count={p.backlinks.length} />
            {p.backlinks.length === 0 ? (
              <Text variant="footnote" tone="faint" style={styles.lead}>
                {t("wiki.noBacklinksHint", { title: p.title })}
              </Text>
            ) : (
              p.backlinks.map((b, i) => <BacklinkRow key={backlinkKey(b)} link={b} divider={i > 0} />)
            )}
            {readers.length > 0 ? (
              <>
                <SectionHeader title={t("mobile.wiki.usedBy")} />
                <ListRow
                  leading={
                    <Face who={{ type: "agent", id: readers[0]?.agentId ?? null }} size={ROW_TILE} live={false} />
                  }
                  title={readers.map((r) => dir.nameOf({ type: "agent", id: r.agentId })).join(", ")}
                  sub={t("mobile.wiki.readsWeek", { count: p.reads?.total ?? 0 })}
                  subLines={1}
                />
              </>
            ) : null}
            <SectionHeader title={t("wiki.history")} />
            <ListRow
              leading={<Tile icon="clock" size={ROW_TILE} />}
              title={t("wiki.allVersions", { count: p.version })}
              sub={t("wiki.historyText")}
              subLines={2}
              chevron
              onPress={() => router.push({ pathname: "/wiki-history", params: { slug: p.slug } })}
            />
          </>
        ) : null}
      </Animated.ScrollView>
    </View>
  );
}

/** The widths of the text lines a page's skeleton draws (a paragraph's ragged edge). */
const SKELETON_LINES = [92, 86, 95, 64] as const;

/** A page while it loads: its band, its title and the start of its text, pulsing together, where they will be. */
function PageSkeleton() {
  const { t } = useTranslation();
  const c = useColors();
  const pulse = usePulse();
  const bone = { backgroundColor: c.sunken };
  return (
    <Animated.View
      style={pulse}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("common.loadingPage")}
    >
      <View style={[styles.band, bone]} />
      <View style={[styles.page, styles.bones]}>
        <View style={[styles.boneTitle, bone]} />
        <View style={[styles.boneLine, styles.boneBy, bone]} />
        {SKELETON_LINES.map((w) => (
          <View key={w} style={[styles.boneLine, bone, { width: `${w}%` }]} />
        ))}
      </View>
    </Animated.View>
  );
}

const backlinkKey = (b: WikiBacklink) =>
  b.kind === "page" ? `page:${b.slug}` : b.kind === "message" ? `message:${b.messageId}` : `issue:${b.number}`;

/** Where a page is mentioned: another page, a conversation (opens there) or a task; the list's 52 rows. */
function BacklinkRow({ link: b, divider }: { link: WikiBacklink; divider: boolean }) {
  switch (b.kind) {
    case "page":
      return (
        <ListRow
          divider={divider}
          leading={<Tile icon="file" size={ROW_TILE} />}
          title={b.title}
          {...(b.excerpt ? { sub: b.excerpt, subLines: 2 } : {})}
          chevron
          onPress={() => openWikiPage(b.slug)}
        />
      );
    case "message":
      return (
        <ListRow
          divider={divider}
          leading={<Tile icon="chat" size={ROW_TILE} />}
          title={`#${b.channelName}`}
          sub={b.excerpt}
          subLines={2}
          chevron
          onPress={() => router.push(chatHref(b.channelId))}
        />
      );
    default:
      return (
        <ListRow
          divider={divider}
          leading={<Tile icon="checkc" size={ROW_TILE} />}
          title={b.title}
          sub={`#${b.number}`}
          subLines={1}
          chevron
          onPress={() => router.push(`/issues/${b.number}`)}
        />
      );
  }
}

/**
 * The page's history (the web's dialog as a screen): every version with who made it, at whose request and
 * what changed; a version opens what it changed from the one before.
 */
export function WikiHistoryScreen({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const api = useApi();
  const failed = useFailed();
  const page = useWikiPage(orgId, slug);
  const history = useWikiHistory(orgId, slug, true);
  const pull = usePullRefresh(() => Promise.allSettled([history.refetch(), page.refetch()]));
  const [open, setOpen] = useState<{ version: number; lines: DiffLine[] } | null>(null);
  // The version whose change is on its way: its row says so (its wheel in the time's place) until it opens.
  const [reading, setReading] = useState<number | null>(null);
  const show = async (version: number) => {
    if (open?.version === version) {
      setOpen(null);
      return;
    }
    if (reading !== null) return;
    setReading(version);
    try {
      const after = await api.wiki.version(orgId, slug, version);
      const before = version > 1 ? await api.wiki.version(orgId, slug, version - 1) : { body: "" };
      setOpen({ version, lines: diffLines(before.body.split("\n"), after.body.split("\n")) });
    } catch (e) {
      failed(e);
    } finally {
      setReading(null);
    }
  };
  const reduced = useReducedMotion();
  const noteOf = (v: WikiVersion) =>
    v.noteCode ? t(`wiki.note.${v.noteCode}`, v.noteParams ?? {}) : (v.note ?? undefined);
  return (
    <PushedLargeTitle
      title={t("wiki.history")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {/* Under "Histórico", whose page it is (never "Histórico de …" again under the same word). */}
      {page.data ? (
        <Text variant="subhead" tone="muted" numberOfLines={2} style={styles.lead}>
          {page.data.title}
        </Text>
      ) : null}
      {/* Loading: the rows' own shape; failed: what happened and the way to ask again. */}
      {history.isLoading ? <SkeletonList rows={4} /> : null}
      {history.isError && !history.data ? <LoadFailed onRetry={() => void history.refetch()} /> : null}
      {(history.data ?? []).map((v, i) => {
        const person = v.author.onBehalfOf ? dir.memberById.get(v.author.onBehalfOf)?.name : undefined;
        const who = person ? t("wiki.byFor", { name: dir.nameOf(v.author), person }) : dir.nameOf(v.author);
        const note = noteOf(v);
        return (
          <View key={v.version}>
            <Row
              divider={i > 0}
              leading={<Face who={v.author} size={36} />}
              title={`v${v.version} · ${who}`}
              {...(note ? { subtitle: note, subtitleLines: 2 } : {})}
              meta={
                reading === v.version ? (
                  <ActivityIndicator size="small" color={c.muted} />
                ) : (
                  <Text variant="subhead" tone="faint">
                    {relativeTime(t, i18n.language, v.at)}
                  </Text>
                )
              }
              onPress={() => void show(v.version)}
            />
            {open?.version === v.version ? (
              <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={styles.diffWrap}>
                <Text variant="footnote" tone="faint">
                  {t("wiki.versionDiff", { version: v.version })}
                </Text>
                <DiffView lines={open.lines} />
              </Animated.View>
            ) : null}
          </View>
        );
      })}
    </PushedLargeTitle>
  );
}

/**
 * "Renomear ou mover": the title (links to it follow) and the folder, with the folders in use as shortcuts and
 * "Raiz". Salvar renames and moves, then shows the page at its new address.
 */
export function WikiMoveScreen({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const page = useWikiPage(orgId, slug);
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
  const p = page.data;
  const [title, setTitle] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nextTitle = (title ?? p?.title ?? "").trim();
  const nextFolder = cleanFolder(folder ?? p?.folder ?? "");
  const folders = foldersIn(tree.data ?? []);
  const save = async () => {
    if (!p || saving) return;
    if (!nextTitle) {
      toast({ title: t("wiki.form.required"), icon: "x" });
      return;
    }
    setSaving(true);
    try {
      let current = p;
      if (nextFolder !== p.folder)
        current = await action.mutateAsync({ type: "move", slug: p.slug, folder: nextFolder });
      if (nextTitle !== p.title)
        current = await action.mutateAsync({ type: "rename", slug: current.slug, title: nextTitle });
      successHaptic();
      toast({ title: nextTitle !== p.title ? t("wiki.renamed") : t("wiki.saved") });
      router.dismissTo(`/wiki/${encodeURIComponent(current.slug)}`);
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
    }
  };
  const words = useFieldText("body");
  const input = [styles.input, words, { color: c.ink }];
  const dirty = Boolean(p) && (nextTitle !== p?.title || nextFolder !== p?.folder);
  return (
    // A settings form: the fields in a group on the grouped gray, Salvar in the bar.
    <SettingsPage
      title={t("wiki.renameOrMove")}
      action={{ label: t("common.save"), onPress: () => void save(), disabled: saving || !p || !dirty }}
      busy={saving}
    >
      <GroupedList>
        <GroupedField label={t("wiki.form.title")}>
          <TextInput
            value={title ?? p?.title ?? ""}
            onChangeText={setTitle}
            placeholder={t("wiki.form.titlePlaceholder")}
            placeholderTextColor={c.faint}
            {...NEXT_FIELD}
            style={input}
          />
        </GroupedField>
        <GroupedField label={t("wiki.form.folder")}>
          <TextInput
            value={folder ?? p?.folder ?? ""}
            onChangeText={setFolder}
            placeholder={t("wiki.form.folderPlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={input}
          />
        </GroupedField>
      </GroupedList>
      <GroupedFooter>{t("wiki.renameHelp")}</GroupedFooter>
      {folders.length > 0 ? (
        <>
          <GroupedHeader>{t("wiki.folders")}</GroupedHeader>
          <FolderChips folders={folders} value={nextFolder} onPick={setFolder} />
        </>
      ) : null}
      <GroupedFooter>{t("wiki.form.folderHelp")}</GroupedFooter>
    </SettingsPage>
  );
}

/** A folder as typed: no slashes at its ends. */
export const cleanFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, "");

/**
 * The folders in use as one-tap choices, "Raiz" first: the app's filter pills, on one line that scrolls sideways
 * from the screen's edge (they bleed out of the form's padding, as every row of pills does).
 */
export function FolderChips({
  folders,
  value,
  onPick,
}: {
  folders: string[];
  value: string;
  onPick: (folder: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.bleed}>
      {/* "Raiz" is the empty folder: its key is "" (a folder's own path never is). */}
      <Filters
        items={[{ key: "", label: t("wiki.root") }, ...folders.map((f) => ({ key: f, label: f }))]}
        value={value}
        onChange={onPick}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  lead: { paddingHorizontal: SCREEN_X, marginTop: -4 },
  // Right under the large title, as Drive's.
  search: { paddingHorizontal: SCREEN_X, paddingBottom: 10 },
  // Folder 4 over the title, the title 8 over who wrote it (the 8 rhythm, tighter inside one heading group).
  title: { marginTop: 4 },
  byline: { marginTop: 8 },
  band: { height: 96, marginHorizontal: 16, marginTop: 8, borderRadius: 20, overflow: "hidden" },
  bandFace: { position: "absolute", left: 16, bottom: 12 },
  around: { marginHorizontal: 16, borderRadius: 20, overflow: "hidden" },
  graphCard: { marginTop: 0 },
  pickBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  page: { paddingHorizontal: SCREEN_X, paddingTop: 16 },
  note: { paddingTop: 8 },
  body: { paddingTop: 24 },
  diffWrap: { paddingHorizontal: SCREEN_X, paddingBottom: 12, gap: 8 },
  // A page's skeleton: the title's 28-point line, the byline's, then the text's lines on the body's rhythm.
  bones: { gap: 12 },
  boneTitle: { height: 28, width: "70%", borderRadius: 8, marginTop: 4 },
  boneLine: { height: 14, borderRadius: 6 },
  boneBy: { width: "40%", marginBottom: 12 },
  // A form field's input in its row (the label's column beside it).
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  // Pills run from the screen's edge, out of the form's 16 padding.
  bleed: { marginHorizontal: -16 },
});
