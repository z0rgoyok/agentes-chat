import type { Artifact, ArtifactFilters, ArtifactKind, DriveFolder } from "@agenteschat/client";
import { isLiveFileKind, keys as queryKeys, useApi, useArtifacts, useChannels } from "@agenteschat/client";
import { ARTIFACT_KINDS } from "@agenteschat/client/lib/artifacts";
import {
  type DriveGroup,
  type DriveSection,
  type DriveSort,
  type DriveView,
  type DriveWho,
  driveSections,
  folderChildren,
  folderTrail,
  isDriveView,
  onlyItsConversation,
  PRIVATE_SECTION,
  rangeOf,
} from "@agenteschat/client/lib/drive";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Checkbox,
  cx,
  EmptyState,
  GroupHeading,
  Icon,
  Kbd,
  PageHeader,
  SearchField,
  Toolbar,
  useMatchMedia,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useArtifactDownload, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useFileShare } from "@/components/artifacts/ShareDialog";
import { UploadButton, useDriveUpload, useFilePicker } from "@/components/artifacts/Upload";
import { artifactLink, useArtifactViewer, useAuthorName } from "@/components/artifacts/viewer-context";
import {
  DriveCrumbs,
  FolderCard,
  type FolderItemProps,
  FolderRow,
  useFolderActions,
} from "@/components/drive/DriveFolders";
import { DriveCard, DriveRow, type ItemProps } from "@/components/drive/DriveItems";
import { DriveDisplay, DriveFilters } from "@/components/drive/DriveToolbar";
import { DriveTrash } from "@/components/drive/DriveTrash";
import { DropOverlay, UploadProgress } from "@/components/drive/DriveUploads";
import { useActorFilterOptions } from "@/components/filters";
import { ErrorState, LoadingList } from "@/components/Loading";
import { LivePresenceScope } from "@/components/live/LiveCover";
import { NewFileMenu } from "@/components/live/NewFile";
import { cachedKind, openLivePage } from "@/components/live/open";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SelectionBar } from "@/components/SelectionBar";
import { useFileDrop } from "@/hooks/useFileDrop";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import type { MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import "./drive.css";
import { typingInField } from "@/lib/keys";

/** Authors shown on a channel's group header. */
const STACK_MAX = 5;

/** A menu, listbox or dialog is open: Esc and shortcuts are theirs. */
const layerOpen = () => Boolean(document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]'));

/**
 * Drive: everything the viewer can see, as a
 * grid of real previews (or a list), with quick filters, grouping, a details
 * panel, multi-select with a floating bar, drop to upload and the trash. Folders: the one shown (`folder`, null =
 * the top level) lists its folders and files; a search or a filter looks through the whole Drive.
 */
export function DrivePage({
  open,
  folder = null,
  onFolder = () => undefined,
}: {
  /** `at`: a picture's, a video's or a PDF's comment to open the viewer at (ADR 0208). */
  open?: { id: string; version?: number; at?: string };
  folder?: string | null;
  onFolder?: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const uploads = can(org, "upload_files");
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const toast = useToast();
  const downloads = useArtifactDownload();
  const share = useFileShare();
  const searchRef = useRef<HTMLInputElement>(null);
  const phone = useMatchMedia(COMPACT_QUERY);
  const qc = useQueryClient();
  const api = useApi();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [view, setViewState] = useState<DriveView>(() => {
    const saved = storage.get(STORAGE_KEYS.driveView);
    return isDriveView(saved) ? saved : "grid";
  });
  const setView = (v: DriveView) => {
    setViewState(v);
    storage.set(STORAGE_KEYS.driveView, v);
  };
  const [who, setWho] = useState<DriveWho>("all");
  const [kinds, setKinds] = useState<ArtifactKind[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [group, setGroup] = useState<DriveGroup>("date");
  const [sort, setSort] = useState<DriveSort>("recent");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => new Set());
  const clearSelection = () => {
    setSelected(new Set());
    setSelectedFolders(new Set());
  };
  const anchor = useRef<string | null>(null);
  const [uploadsHidden, setUploadsHidden] = useState(false);

  const search = useDeferredValue(q.trim());
  const filtered = Boolean(search) || kinds.length > 0 || channelIds.length > 0 || authors.length > 0 || who !== "all";
  const arrange = useFolderActions();
  // Every filter and the order go to the server, so each looks at all the files, not the pages loaded.
  const filters = useMemo<ArtifactFilters>(() => {
    const f: ArtifactFilters = {};
    // Browsing shows one folder; a search or a filter looks through the whole Drive, as Google Drive's does.
    if (!filtered) f.folderId = folder;
    if (search) f.q = search;
    if (kinds.length > 0) f.kinds = kinds;
    if (channelIds.length > 0) f.channelIds = channelIds;
    const picked = authors.flatMap((key) => {
      const [type, id] = key.split(":");
      return (type === "agent" || type === "person") && id ? [{ type, id } as const] : [];
    });
    if (picked.length > 0) f.authors = picked;
    if (who !== "all") f.who = who;
    if (sort !== "recent") f.sort = sort;
    return f;
  }, [search, kinds, channelIds, authors, who, sort, filtered, folder]);
  const list = useArtifacts(org.id, filters);

  const remover = useDeleteArtifact((ids) => {
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
  });
  const uploader = useDriveUpload((saved) =>
    toast.show(t("files.uploaded", { name: saved.title }), "info", {
      label: t("artifacts.openFile"),
      run: () => viewer.open(saved.id),
    }),
  );
  const upload = (files: File[]) => {
    setUploadsHidden(false);
    void uploader.upload(files, { folderId: folder });
  };

  // A folder that's gone (deleted, or a stale link): back to the top level.
  const trail = folderTrail(arrange.folders, folder);
  useEffect(() => {
    if (folder && arrange.loaded && trail.length === 0) onFolder(null);
  }, [folder, arrange.loaded, trail.length, onFolder]);
  const here = trail.at(-1) ?? null;
  const needle = search.toLocaleLowerCase();
  const subfolders = filtered
    ? needle && kinds.length === 0 && channelIds.length === 0 && authors.length === 0 && who === "all"
      ? arrange.folders.filter((f) => f.name.toLocaleLowerCase().includes(needle))
      : []
    : (folderChildren(arrange.folders).get(folder ?? "") ?? []);
  const openFolder = (id: string | null) => {
    clearSelection();
    onFolder(id);
  };
  const dropInto = (drag: { files: string[]; folders: string[] }, target: string | null) =>
    void arrange.move(drag, target);
  /** An item dragged while selected takes the whole selection along. */
  const inSelection = (kind: "folder" | "file", id: string) =>
    kind === "folder" ? selectedFolders.has(id) : selected.has(id);
  const selectionDrag = () => ({ files: [...selected], folders: [...selectedFolders] });
  const dragOf = (kind: "folder" | "file", id: string) =>
    inSelection(kind, id)
      ? selectionDrag()
      : kind === "folder"
        ? { files: [], folders: [id] }
        : { files: [id], folders: [] };
  const drop = useFileDrop(upload, !trashOpen);

  // A shared link (`/drive?artifact=…&v=…`) opens the viewer, or a live file's own page in its place (ADR 0196 §9):
  // its kind first, from what this app already loaded or from the server, so the viewer never flashes on the way.
  const openId = open?.id;
  const openVersion = open?.version;
  const openAt = open?.at;
  useEffect(() => {
    if (!openId) return;
    let gone = false;
    const go = (kind: ArtifactKind | null) => {
      if (gone) return;
      if (isLiveFileKind(kind)) openLivePage(navigate, org.id, openId, { version: openVersion, replace: true });
      else viewer.open(openId, openVersion, undefined, openAt ? { at: openAt } : undefined);
    };
    const known = cachedKind(qc, org.id, openId);
    if (known) go(known);
    else
      qc.fetchQuery({
        queryKey: queryKeys.artifact(org.id, openId, openVersion),
        queryFn: () => api.artifacts.get(org.id, openId, openVersion),
      }).then(
        (a) => go(a.kind),
        // Not found or no access: the viewer says so.
        () => go(null),
      );
    return () => {
      gone = true;
    };
  }, [openId, openVersion, openAt, viewer, qc, api, navigate, org.id]);

  const channelLabel = (a: Artifact) =>
    a.audience.kind === "channel"
      ? `#${a.audience.name}`
      : a.audience.kind === "dm"
        ? a.audience.between
          ? t("drive.dmBetween", { names: joinNames(a.audience.between.map(authorName), t) })
          : a.audience.with
            ? t("drive.dmWith", { name: authorName(a.audience.with) })
            : t("drive.dm")
        : t("artifacts.noChannel");

  const rows = list.artifacts ?? [];
  const sections = driveSections(rows, group);
  const shown = sections.flatMap((s) => s.items);
  const counts = new Map(Object.entries(list.counts ?? {}) as [ArtifactKind, number][]);
  // All the files these filters find, beyond the pages loaded (an older server sends no counts).
  const total = list.counts
    ? [...counts].reduce((n, [k, c]) => (kinds.length === 0 || kinds.includes(k) ? n + c : n), 0)
    : rows.length;

  const clearFilters = () => {
    setKinds([]);
    setChannelIds([]);
    setAuthors([]);
    setWho("all");
  };
  const picked = shown.filter((a) => selected.has(a.id));
  const pickedFolders = subfolders.filter((f) => selectedFolders.has(f.id));
  const pickedCount = picked.length + pickedFolders.length;
  const shownCount = shown.length + subfolders.length;
  // Who is in the live files shown, asked once for the page (their cards show the faces).
  const liveIds = shown.filter((a) => isLiveFileKind(a.kind)).map((a) => a.id);
  const selectAll = () => {
    setSelected(new Set(shown.map((a) => a.id)));
    setSelectedFolders(new Set(subfolders.map((f) => f.id)));
  };

  const toggle = (a: Artifact) => {
    anchor.current = a.id;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
  };
  const pick = (a: Artifact, e: MouseEvent) => {
    if (e.shiftKey) {
      const range = rangeOf(
        shown.map((x) => x.id),
        anchor.current,
        a.id,
      );
      anchor.current = a.id;
      setSelected((s) => new Set([...s, ...range]));
      return;
    }
    if (e.metaKey || e.ctrlKey || pickedCount > 0) {
      toggle(a);
      return;
    }
    anchor.current = a.id;
    // Straight to the file: the viewer has its preview, who made it, where it is, its versions and its actions.
    openViewer(a);
  };
  // A spreadsheet, a presentation or a canvas opens on its own page (ADR 0196 §9).
  const openViewer = (a: Artifact) => {
    if (isLiveFileKind(a.kind)) openLivePage(navigate, org.id, a.id);
    else viewer.open(a.id);
  };

  const toggleFolder = (f: DriveFolder) =>
    setSelectedFolders((s) => {
      const next = new Set(s);
      if (next.has(f.id)) next.delete(f.id);
      else next.add(f.id);
      return next;
    });
  const pickFolder = (f: DriveFolder, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || pickedCount > 0) toggleFolder(f);
    else openFolder(f.id);
  };

  // "/" searches, ⌘A selects what's shown, Esc clears the selection.
  const keys = useRef({ shownCount, pickedCount, trashOpen, selectAll, clearSelection });
  keys.current = { shownCount, pickedCount, trashOpen, selectAll, clearSelection };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keys.current;
      if (s.trashOpen || layerOpen()) return;
      const active = document.activeElement;
      if (e.key === "Escape") {
        if (typingInField(active)) return;
        // The viewer closes itself on Esc; here Esc clears the selection.
        if (s.pickedCount > 0) s.clearSelection();
        return;
      }
      if (typingInField(active) || e.altKey) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && s.shownCount > 0) {
        e.preventDefault();
        s.selectAll();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const downloadPicked = async () => {
    // A live file as it is now: its versions are checkpoints behind it (ADR 0196 §7).
    for (const a of picked) await downloads.save(a, undefined, isLiveFileKind(a.kind) ? undefined : a.version);
  };
  const copyLinks = async () => {
    await navigator.clipboard?.writeText(
      picked.map((a) => artifactLink(window.location.origin, org.id, a.id)).join("\n"),
    );
    // The share dialog's rule, for many at once: say which links only their conversation opens, with the way to share.
    const closed = picked.find(onlyItsConversation);
    if (closed) {
      toast.show(t("share.someOnlyHere"), "info", { label: t("share.button"), run: () => share.open(closed) });
    } else toast.show(t("drive.linksCopied", { count: picked.length }));
  };
  const deletable = picked.filter((a) => a.canDelete);
  // Folders go only for who arranges the Drive; their own files the server sorts (trash, or up a level).
  const deletableFolders = uploads ? pickedFolders : [];
  const canDeleteSelection = deletable.length + deletableFolders.length > 0;
  const moveSelection = () => {
    const at = new Set([...picked.map((a) => a.folderId ?? null), ...pickedFolders.map((f) => f.parentId)]);
    arrange.askMove(
      { files: picked.map((a) => a.id), folders: pickedFolders.map((f) => f.id) },
      at.size === 1 ? [...at][0] : undefined,
    );
  };
  const deleteSelection = () => {
    if (deletableFolders.length > 0) arrange.askDeleteMany(deletableFolders, deletable, clearSelection);
    else remover.ask(deletable);
  };
  /** Right click on an item of a selection of several: the menu is for all of them. */
  const selectionMenu = (kind: "folder" | "file", id: string): MenuEntry[] | null =>
    pickedCount > 1 && inSelection(kind, id)
      ? [
          { kind: "header", label: t("drive.selected", { count: pickedCount }) },
          ...(uploads
            ? ([{ kind: "item", id: "move", label: t("drive.moveToMenu"), icon: "move", run: moveSelection }] as const)
            : []),
          ...(canDeleteSelection
            ? ([
                { kind: "separator" },
                {
                  kind: "item",
                  id: "delete",
                  label: deletableFolders.length > 0 ? t("drive.delete") : t("drive.moveToTrash"),
                  icon: "trash",
                  danger: true,
                  run: deleteSelection,
                },
              ] as const)
            : []),
        ]
      : null;
  const newFolderHere = () => arrange.newFolder(folder);
  const filePicker = useFilePicker({ label: t("files.upload"), onFiles: upload, multiple: true });
  /** Right click or the menu key on the Drive's empty space: what makes something here. */
  const pageMenu = entityMenu((): MenuEntry[] =>
    uploads && !trashOpen
      ? [
          {
            kind: "item",
            id: "new-folder",
            label: t("drive.newFolder"),
            icon: "plus",
            run: newFolderHere,
          },
          { kind: "item", id: "upload", label: t("files.upload"), icon: "upload", run: filePicker.open },
        ]
      : [],
  );

  const authorOptions = useActorFilterOptions();
  const itemProps = (a: Artifact): ItemProps => ({
    artifact: a,
    selected: selected.has(a.id),
    channelName: channelLabel,
    onPick: pick,
    onToggle: toggle,
    onOpen: openViewer,
    selectionMenu,
    ...(uploads
      ? {
          onRename: arrange.renameFile,
          onMove: (x: Artifact) => arrange.askMove(dragOf("file", x.id), x.folderId ?? null),
          dragging: (x: Artifact) => dragOf("file", x.id),
        }
      : {}),
  });
  const folderProps = (f: DriveFolder): FolderItemProps => ({
    folder: f,
    actions: arrange,
    may: uploads,
    onOpen: openFolder,
    onDrop: dropInto,
    selected: selectedFolders.has(f.id),
    onToggle: toggleFolder,
    onPick: pickFolder,
    selectionMenu,
    dragging: dragOf,
  });

  const sectionTitle = (s: DriveSection) => {
    if (s.key === PRIVATE_SECTION) return t("drive.private");
    if (group === "date")
      return t(s.key === "today" ? "drive.today" : s.key === "week" ? "drive.thisWeek" : "drive.earlier");
    const first = s.items[0];
    if (group === "channel") return s.key && first ? channelLabel(first) : t("drive.noChannel");
    return first ? authorName(first.createdBy) : "";
  };
  const sectionHead = (s: DriveSection) => {
    if (s.key === PRIVATE_SECTION) {
      return (
        <GroupHeading
          className="drive-group__head"
          title={
            <>
              <Icon name="lock" size={16} />
              {sectionTitle(s)}
            </>
          }
          count={s.items.length}
          aside={<span className="drive-group__hint">{t("drive.privateHint")}</span>}
        />
      );
    }
    if (group === "none") return null;
    const first = s.items[0];
    const people = new Map(s.items.map((a) => [`${a.createdBy.type}:${a.createdBy.id}`, a.createdBy]));
    return (
      <GroupHeading
        className="drive-group__head"
        title={
          <>
            {group === "author" && first && (
              <ActorAvatar size="xs" actor={first.createdBy} name={authorName(first.createdBy)} />
            )}
            {group === "channel" && <Icon name={s.key ? "channel" : "drive"} size={16} />}
            {sectionTitle(s)}
          </>
        }
        count={s.items.length}
        aside={
          group === "channel" && (
            <span className="drive-group__stack" aria-hidden="true">
              {[...people.values()].slice(0, STACK_MAX).map((p) => (
                <ActorAvatar key={`${p.type}:${p.id}`} size="xs" actor={p} name={authorName(p)} />
              ))}
            </span>
          )
        }
      />
    );
  };

  const kindCounts = ARTIFACT_KINDS.filter((k) => (counts.get(k) ?? 0) > 0 || kinds.includes(k)).map((k) => ({
    kind: k,
    count: counts.get(k) ?? 0,
  }));

  return (
    <div className={cx("page drive drive-drop", drop.over && "drive-drop--over")} {...drop.props} {...pageMenu}>
      {drop.over && <DropOverlay />}
      {filePicker.input}
      <div className="drive__main">
        <PageHeader
          title={trashOpen ? t("artifacts.trashTitle") : (here?.name ?? t("drive.title"))}
          meta={trashOpen ? t("artifacts.trashHint") : here ? undefined : t("drive.subtitle")}
          lead={
            trashOpen ? (
              <Button
                variant="ghost"
                iconOnly
                icon="chevronLeft"
                aria-label={t("artifacts.backToDrive")}
                title={t("artifacts.backToDrive")}
                onClick={() => setTrashOpen(false)}
              />
            ) : (
              here && (
                <Button
                  variant="ghost"
                  iconOnly
                  icon="chevronLeft"
                  aria-label={t("drive.up")}
                  title={t("drive.up")}
                  onClick={() => openFolder(here.parentId)}
                />
              )
            )
          }
          actions={
            !trashOpen && (
              <>
                <Button
                  variant="ghost"
                  icon="trash"
                  onClick={() => {
                    setTrashOpen(true);
                    clearSelection();
                  }}
                >
                  {t("artifacts.trash")}
                </Button>
                {uploads && !(list.isSuccess && rows.length === 0 && subfolders.length === 0 && !filtered) && (
                  <>
                    {/* A folder or a live file (ADR 0196 §9); Upload stays the one primary. */}
                    <NewFileMenu iconOnly={phone} onNewFolder={newFolderHere} />
                    <UploadButton
                      size="md"
                      label={t("files.upload")}
                      busy={uploader.busy}
                      multiple
                      onFiles={upload}
                      variant="primary"
                    />
                  </>
                )}
              </>
            )
          }
        >
          {!trashOpen && here && <DriveCrumbs trail={trail} onOpen={openFolder} onDrop={dropInto} />}
        </PageHeader>

        {trashOpen && <DriveTrash />}
        {remover.dialog}
        {share.dialog}
        {arrange.dialogs}

        {!trashOpen && (
          <>
            <Toolbar
              search={
                <SearchField
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && q) {
                      e.stopPropagation();
                      setQ("");
                    }
                  }}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                  placeholder={t("drive.search")}
                  aria-label={t("drive.search")}
                  shortcut={
                    <Kbd title={t("drive.searchHint")} aria-hidden="true">
                      /
                    </Kbd>
                  }
                />
              }
              actions={
                <DriveDisplay
                  view={view}
                  onView={setView}
                  group={group}
                  onGroup={setGroup}
                  sort={sort}
                  onSort={setSort}
                  iconOnly={phone}
                />
              }
            >
              <DriveFilters
                who={who}
                onWho={setWho}
                authors={authors}
                onAuthors={setAuthors}
                actors={authorOptions}
                kinds={kinds}
                onKinds={setKinds}
                kindCounts={kindCounts}
                channelIds={channelIds}
                onChannels={setChannelIds}
                channels={(channels.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
              />
            </Toolbar>

            {filtered && list.isSuccess && rows.length > 0 && (
              <div className="drive-summary">
                <span>{t("drive.count", { count: total })}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    setQ("");
                    clearFilters();
                  }}
                >
                  {t("drive.clear")}
                </Button>
              </div>
            )}

            {list.isLoading && <LoadingList count={5} trailing />}
            {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
            {list.isSuccess && rows.length === 0 && subfolders.length === 0 && !filtered && folder && (
              <EmptyState
                size="panel"
                title={t("drive.folderEmptyTitle")}
                actions={
                  uploads && (
                    <>
                      <UploadButton
                        size="md"
                        label={t("files.upload")}
                        busy={uploader.busy}
                        multiple
                        onFiles={upload}
                      />
                      <NewFileMenu align="start" onNewFolder={newFolderHere} />
                    </>
                  )
                }
              >
                {t(uploads ? "drive.folderEmptyText" : "drive.folderEmptyViewer")}
              </EmptyState>
            )}
            {list.isSuccess && rows.length === 0 && subfolders.length === 0 && !filtered && !folder && (
              <EmptyState
                size="page"
                agent={look}
                title={t("drive.emptyTitle")}
                actions={
                  uploads && (
                    <>
                      <UploadButton
                        size="md"
                        label={t("files.upload")}
                        busy={uploader.busy}
                        multiple
                        onFiles={upload}
                        variant="primary"
                      />
                      <NewFileMenu align="start" onNewFolder={newFolderHere} />
                    </>
                  )
                }
              >
                {t(uploads ? "drive.emptyText" : "drive.emptyViewer")}
              </EmptyState>
            )}
            {list.isSuccess && rows.length === 0 && subfolders.length === 0 && filtered && (
              <EmptyState
                size="panel"
                title={t("drive.noResults")}
                actions={
                  <Button
                    onClick={() => {
                      setQ("");
                      clearFilters();
                    }}
                  >
                    {t("drive.clear")}
                  </Button>
                }
              >
                {t("drive.noResultsHint")}
              </EmptyState>
            )}

            {subfolders.length > 0 && view === "grid" && (
              <section className="drive-group" aria-label={t("drive.folders")}>
                <GroupHeading className="drive-group__head" title={t("drive.folders")} count={subfolders.length} />
                <div className={cx("drive-folders", pickedCount > 0 && "drive--selecting")}>
                  {subfolders.map((f) => (
                    <FolderCard key={f.id} {...folderProps(f)} />
                  ))}
                </div>
              </section>
            )}
            <LivePresenceScope ids={liveIds}>
              {rows.length > 0 && view === "grid" && (
                <div className={cx("ac-groups", pickedCount > 0 && "drive--selecting")}>
                  {sections.map((s) => (
                    <section key={s.key || "all"} className="drive-group">
                      {sectionHead(s)}
                      <div className="drive-grid">
                        {s.items.map((a) => (
                          <DriveCard key={a.id} {...itemProps(a)} onDelete={(x) => remover.ask(x)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
              {(rows.length > 0 || subfolders.length > 0) && view === "list" && (
                <div className={cx("drive-table", pickedCount > 0 && "drive--selecting")}>
                  <div className="drive-table__head">
                    <Checkbox
                      className="drive-check"
                      checked={
                        shownCount > 0 && pickedCount === shownCount ? true : pickedCount > 0 ? "indeterminate" : false
                      }
                      onCheckedChange={(on) => (on ? selectAll() : clearSelection())}
                      aria-label={t("drive.selectAll", { count: shownCount })}
                    />
                    <span aria-hidden="true">{t("drive.name")}</span>
                    <span aria-hidden="true">{t("drive.by")}</span>
                    <span className="drive-row__where" aria-hidden="true">
                      {t("drive.where")}
                    </span>
                    <span aria-hidden="true">{t("drive.when")}</span>
                    <span />
                  </div>
                  {subfolders.length > 0 && (
                    <ul className="drive-list" aria-label={t("drive.folders")}>
                      {subfolders.map((f) => (
                        <FolderRow key={f.id} {...folderProps(f)} />
                      ))}
                    </ul>
                  )}
                  {sections.map((s) => (
                    <section key={s.key || "all"} className="drive-group">
                      {sectionHead(s)}
                      <ul className="drive-list">
                        {s.items.map((a) => (
                          <DriveRow key={a.id} {...itemProps(a)} onDelete={(x) => remover.ask(x)} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </LivePresenceScope>

            {list.hasNextPage && rows.length > 0 && (
              <div className="drive-more">
                <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t("drive.loadMore")}
                </Button>
              </div>
            )}

            {pickedCount > 0 && (
              <SelectionBar label={t("drive.selection")}>
                <span className="drive-selbar__count">{t("drive.selected", { count: pickedCount })}</span>
                {pickedCount < shownCount && (
                  <Button size="sm" variant="ghost" icon="checks" onClick={selectAll}>
                    <span className="drive-selbar__label">{t("drive.selectAll", { count: shownCount })}</span>
                  </Button>
                )}
                {picked.length > 0 && (
                  <>
                    <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadPicked()}>
                      <span className="drive-selbar__label">{t("artifacts.download")}</span>
                    </Button>
                    <Button size="sm" variant="ghost" icon="link" onClick={() => void copyLinks()}>
                      <span className="drive-selbar__label">{t("drive.copyLinks")}</span>
                    </Button>
                  </>
                )}
                {uploads && (
                  <Button size="sm" variant="ghost" icon="move" onClick={moveSelection}>
                    <span className="drive-selbar__label">{t("drive.move")}</span>
                  </Button>
                )}
                {canDeleteSelection && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="drive-selbar__danger"
                    onClick={deleteSelection}
                  >
                    <span className="drive-selbar__label">
                      {deletableFolders.length > 0 ? t("drive.delete") : t("drive.moveToTrash")}
                    </span>
                  </Button>
                )}
                <span className="drive-selbar__sep" aria-hidden="true" />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("drive.clearSelection")}
                  title={t("drive.clearSelection")}
                  onClick={clearSelection}
                />
              </SelectionBar>
            )}
          </>
        )}
      </div>

      {uploader.queue.length > 0 && !uploadsHidden && (
        <UploadProgress queue={uploader.queue} onHide={() => setUploadsHidden(true)} />
      )}
    </div>
  );
}
