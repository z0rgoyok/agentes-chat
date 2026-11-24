import { type Artifact, type DriveFolder, keys, useApi, useDriveArrange, useDriveFolders } from "@agenteschat/client";
import {
  DRIVE_DRAG_TYPE,
  type DriveDrag,
  folderAndInside,
  folderOutline,
  parseDriveDrag,
} from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  Button,
  Checkbox,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  OptionList,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type DragEvent, type MouseEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useAuthorName } from "@/components/artifacts/viewer-context";
import { MenuEntries } from "@/components/DesktopMenus";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { useToast } from "@/lib/toast";

/** The top level, in the move dialog's list (an OptionList value can't be null). */
const TOP = "top";
/** The server's folder name limit. */
const NAME_MAX = 120;

/** What a drag of Drive items starts with: makes the element draggable and says what it carries. */
export const dragOut = (what: () => DriveDrag) => ({
  draggable: true,
  onDragStart: (e: DragEvent) => {
    e.dataTransfer.setData(DRIVE_DRAG_TYPE, JSON.stringify(what()));
    e.dataTransfer.effectAllowed = "move";
  },
});

/** A folder (or the top level) that takes Drive items dropped on it; `over` while one is held above it. */
export function useDropTarget(onDrop: (drag: DriveDrag) => void) {
  const [depth, setDepth] = useState(0);
  const ours = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(DRIVE_DRAG_TYPE);
  return {
    over: depth > 0,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!ours(e)) return;
        e.preventDefault();
        setDepth((d) => d + 1);
      },
      onDragOver: (e: DragEvent) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (e: DragEvent) => {
        if (ours(e)) setDepth((d) => Math.max(0, d - 1));
      },
      onDrop: (e: DragEvent) => {
        if (!ours(e)) return;
        e.preventDefault();
        // The page's own drop (an upload) never sees a move.
        e.stopPropagation();
        setDepth(0);
        const drag = parseDriveDrag(e.dataTransfer.getData(DRIVE_DRAG_TYPE));
        if (drag) onDrop(drag);
      },
    },
  };
}

/** A name, in a small dialog: "Nova pasta", "Renomear". */
function NameDialog({
  open,
  title,
  label,
  initial,
  submitLabel,
  maxLength,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  maxLength: number;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const empty = !name.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} closeLabel={t("common.close")} width={420}>
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (empty || busy) return;
          if (name.trim() === initial.trim()) return onClose();
          setBusy(true);
          void onSubmit(name.trim()).finally(() => setBusy(false));
        }}
      >
        <Locked when={busy}>
          <DialogBody>
            <Field label={label} id="drive-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                maxLength={maxLength}
                autoComplete="off"
                autoFocus
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={empty} loading={busy}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Mover para…": the folders as a tree, the top level first; never into a folder being moved or one inside it. */
function MoveDialog({
  drag,
  from,
  folders,
  onClose,
  onMove,
}: {
  drag: DriveDrag | null;
  /** Where the items are now, when they are all in one place. */
  from: string | null | undefined;
  folders: DriveFolder[];
  onClose: () => void;
  onMove: (folderId: string | null) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [dest, setDest] = useState(TOP);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!drag) return;
    setDest(from ? from : TOP);
    setQ("");
  }, [drag, from]);
  const blocked = new Set((drag?.folders ?? []).flatMap((id) => [...folderAndInside(folders, id)]));
  const needle = q.trim().toLocaleLowerCase();
  const outline = folderOutline(folders).filter(({ folder }) => !blocked.has(folder.id));
  const shown = needle ? outline.filter(({ folder }) => folder.name.toLocaleLowerCase().includes(needle)) : outline;
  const here = from === undefined ? undefined : (from ?? TOP);
  const options = [
    ...(needle ? [] : [{ value: TOP, depth: 0, name: t("drive.title") }]),
    ...shown.map(({ folder, depth }) => ({ value: folder.id, depth: needle ? 0 : depth + 1, name: folder.name })),
  ];
  const destName = dest === TOP ? t("drive.title") : (folders.find((f) => f.id === dest)?.name ?? "");
  const count = (drag?.files.length ?? 0) + (drag?.folders.length ?? 0);
  return (
    <Dialog
      open={drag !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("drive.moveTitle", { count })}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || dest === here) return;
          setBusy(true);
          void onMove(dest === TOP ? null : dest).finally(() => setBusy(false));
        }}
      >
        <Locked when={busy}>
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel={t("drive.moveSearch")}
            searchPlaceholder={t("drive.moveSearch")}
            search={folders.length > 8}
            isEmpty={options.length === 0}
            emptyText={t("drive.moveEmpty", { q: q.trim() })}
          >
            <OptionList
              layout="list"
              aria-label={t("drive.moveTo")}
              value={dest}
              onValueChange={setDest}
              options={options.map((o) => ({
                value: o.value,
                title: o.name,
                tag: o.value === here ? t("drive.moveHere") : undefined,
                depth: o.depth,
                leading: <Icon name="drive" size={16} />,
              }))}
            />
          </DialogSearchList>
        </Locked>
        <DialogFooter bar>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={dest === here} loading={busy}>
            {t("drive.moveToName", { name: destName })}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** What a delete asks about: one folder (its own words), or a selection of folders and files. */
interface Deleting {
  folders: DriveFolder[];
  files: Artifact[];
  done?: () => void;
}

type Naming =
  | { kind: "new"; parentId: string | null }
  | { kind: "folder"; folder: DriveFolder }
  | { kind: "file"; file: Artifact };

/**
 * Everything the Drive does with folders: make, rename, move (dialog or drop), delete with what's inside, and rename
 * and move files. `dialogs` go on the page once.
 */
export function useFolderActions() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const folders = useDriveFolders(org.id);
  const arrange = useDriveArrange(org.id);
  const all = folders.data ?? [];
  const [naming, setNaming] = useState<Naming | null>(null);
  const [moving, setMoving] = useState<{ drag: DriveDrag; from: string | null | undefined } | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [removing, setRemoving] = useState(false);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const nameOf = (id: string | null) => (id ? (all.find((f) => f.id === id)?.name ?? "") : t("drive.title"));

  /** Moves files and folders into `target`; a folder into itself or its own is left where it is. */
  const move = async (drag: DriveDrag, target: string | null) => {
    try {
      const folderMoves = drag.folders.filter((id) => !(target && folderAndInside(all, id).has(target)));
      if (drag.files.length > 0) await arrange.move.mutateAsync({ ids: drag.files, folderId: target });
      for (const id of folderMoves) await arrange.updateFolder.mutateAsync({ id, parentId: target });
      const count = drag.files.length + folderMoves.length;
      if (count > 0) toast.show(t("drive.moved", { count, name: nameOf(target) }));
      return true;
    } catch {
      // Only mutations above: a refusal puts things back and says so once, from the app's own handler.
      return false;
    }
  };

  const one = deleting && deleting.folders.length === 1 && deleting.files.length === 0 ? deleting.folders[0] : null;
  const deleteCount = (deleting?.folders.length ?? 0) + (deleting?.files.length ?? 0);
  /** Folders with what's inside (as the server decides), then files to the trash; one toast for all. */
  const remove = async () => {
    if (!deleting) return;
    const target = deleting;
    // Folders leave their lists at once (`useDriveArrange`): with only folders the dialog closes now and the toast
    // comes with the server's count. Files go to the trash one call at a time, so the dialog waits for those.
    const atOnce = target.files.length === 0;
    if (atOnce) {
      target.done?.();
      setDeleting(null);
    } else setRemoving(true);
    let trashed = 0;
    let kept = 0;
    let gone = 0;
    let stage: "folders" | "files" = "folders";
    try {
      for (const f of target.folders) {
        const r = await arrange.deleteFolder.mutateAsync(f.id);
        trashed += r.trashed;
        kept += r.kept;
        gone += 1;
      }
      stage = "files";
      for (const a of target.files) {
        await api.artifacts.remove(org.id, a.id);
        gone += 1;
      }
      toast.show(
        !one
          ? t("drive.itemsDeleted", { count: gone })
          : kept > 0
            ? t("drive.folderDeletedKept", { count: kept })
            : trashed > 0
              ? t("drive.folderDeleted", { count: trashed })
              : t("drive.folderDeletedEmpty"),
      );
      if (!atOnce) {
        target.done?.();
        setDeleting(null);
      }
    } catch (e) {
      // A folder's refusal was said by the app's own handler (a mutation); a file's is said here.
      if (stage === "files") failed(e);
    } finally {
      setRemoving(false);
      if (target.files.length > 0) void qc.invalidateQueries({ queryKey: keys.artifacts(org.id) });
    }
  };

  const nameDialog = naming && (
    <NameDialog
      open
      title={
        naming.kind === "new"
          ? t("drive.newFolder")
          : naming.kind === "folder"
            ? t("drive.renameFolder")
            : t("drive.renameFile")
      }
      label={t("drive.name")}
      initial={naming.kind === "new" ? "" : naming.kind === "folder" ? naming.folder.name : naming.file.title}
      submitLabel={naming.kind === "new" ? t("drive.create") : t("drive.rename")}
      maxLength={naming.kind === "file" ? 200 : NAME_MAX}
      onClose={() => setNaming(null)}
      onSubmit={async (name) => {
        // A rename shows at once (`useDriveArrange`), so the dialog closes with it; a refusal puts the name back and
        // says so once, from the app's own handler. A new folder waits for the server, which makes its id.
        if (naming.kind === "folder") {
          setNaming(null);
          void arrange.updateFolder.mutateAsync({ id: naming.folder.id, name }).catch(() => undefined);
          return;
        }
        if (naming.kind === "file") {
          setNaming(null);
          void arrange.rename.mutateAsync({ id: naming.file.id, title: name }).catch(() => undefined);
          return;
        }
        try {
          await arrange.createFolder.mutateAsync({ name, parentId: naming.parentId });
          setNaming(null);
        } catch {
          // The app's own handler said why; the dialog stays with what was typed.
        }
      }}
    />
  );

  const dialogs = (
    <>
      {nameDialog}
      <MoveDialog
        drag={moving?.drag ?? null}
        from={moving?.from}
        folders={all}
        onClose={() => setMoving(null)}
        // Moves show at once (`useDriveArrange`): the dialog closes with them, and the toast says where they went.
        onMove={async (target) => {
          if (!moving) return;
          const drag = moving.drag;
          setMoving(null);
          await move(drag, target);
        }}
      />
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && !removing && setDeleting(null)}
        title={
          one ? t("drive.deleteFolderTitle", { name: one.name }) : t("drive.deleteItemsTitle", { count: deleteCount })
        }
        description={t(one ? "drive.deleteFolderBody" : "drive.deleteItemsBody")}
        closeLabel={t("common.close")}
        width={460}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(null)} disabled={removing}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" loading={removing} onClick={() => void remove()}>
            {one ? t("drive.deleteFolder") : t("drive.delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );

  return {
    folders: all,
    loaded: folders.isSuccess,
    dialogs,
    move,
    newFolder: (parentId: string | null) => setNaming({ kind: "new", parentId }),
    renameFolder: (folder: DriveFolder) => setNaming({ kind: "folder", folder }),
    renameFile: (file: Artifact) => setNaming({ kind: "file", file }),
    askMove: (drag: DriveDrag, from: string | null | undefined) => setMoving({ drag, from }),
    askDelete: (folder: DriveFolder) => setDeleting({ folders: [folder], files: [] }),
    /** A selection with folders in it: one confirmation; `done` once they're gone. */
    askDeleteMany: (folders: DriveFolder[], files: Artifact[], done?: () => void) =>
      setDeleting({ folders, files, ...(done ? { done } : {}) }),
  };
}

export type FolderActions = ReturnType<typeof useFolderActions>;

/** A folder's menu: open, rename, move, delete. */
function folderEntries(
  t: TFunction,
  folder: DriveFolder,
  actions: FolderActions,
  onOpen: () => void,
  may: boolean,
): MenuEntry[] {
  return [
    { kind: "item", id: "open", label: t("drive.openFolder"), icon: "drive", run: onOpen },
    ...(may
      ? ([
          {
            kind: "item",
            id: "rename",
            label: t("drive.rename"),
            icon: "edit",
            run: () => actions.renameFolder(folder),
          },
          {
            kind: "item",
            id: "move",
            label: t("drive.moveToMenu"),
            icon: "move",
            run: () => actions.askMove({ files: [], folders: [folder.id] }, folder.parentId),
          },
          { kind: "separator" },
          {
            kind: "item",
            id: "delete",
            label: t("drive.deleteFolder"),
            icon: "trash",
            danger: true,
            run: () => actions.askDelete(folder),
          },
        ] satisfies MenuEntry[])
      : []),
  ];
}

export interface FolderItemProps {
  folder: DriveFolder;
  actions: FolderActions;
  /** The viewer adds to the Drive: may rename, move and delete. */
  may: boolean;
  onOpen: (id: string) => void;
  /** Items dropped on it go into it. */
  onDrop: (drag: DriveDrag, folderId: string) => void;
  selected: boolean;
  onToggle: (f: DriveFolder) => void;
  /** A click on its name: opens it, or selects with ⌘ / Ctrl or while selecting. */
  onPick: (f: DriveFolder, e: MouseEvent) => void;
  /** The selection's menu when it is part of one (null: its own). */
  selectionMenu: (kind: "folder" | "file", id: string) => MenuEntry[] | null;
  /** What dragging it carries: the selection when it is in it, else itself. */
  dragging: (kind: "folder" | "file", id: string) => DriveDrag;
}

/** Its right click and menu key: the selection's menu when it is in one, else its own. */
const folderMenu = (t: TFunction, p: FolderItemProps) =>
  entityMenu(
    () =>
      p.selectionMenu("folder", p.folder.id) ?? [
        { kind: "header", label: p.folder.name },
        ...folderEntries(t, p.folder, p.actions, () => p.onOpen(p.folder.id), p.may),
      ],
  );

function FolderCheck({ folder, selected, onToggle }: Pick<FolderItemProps, "folder" | "selected" | "onToggle">) {
  const { t } = useTranslation();
  return (
    <Checkbox
      className="drive-check"
      checked={selected}
      onCheckedChange={() => onToggle(folder)}
      aria-label={t("drive.select", { title: folder.name })}
    />
  );
}

function FolderMore({ folder, actions, may, onOpen }: Pick<FolderItemProps, "folder" | "actions" | "may" | "onOpen">) {
  const { t } = useTranslation();
  const label = t("drive.folderMore", { name: folder.name });
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} title={t("artifacts.moreShort")} />
      }
    >
      <MenuEntries entries={folderEntries(t, folder, actions, () => onOpen(folder.id), may)} />
    </Menu>
  );
}

/** A folder in the grid: its icon (the checkbox in its place on hover or while selecting) and name, a drop target. */
export function FolderCard(props: FolderItemProps) {
  const { t } = useTranslation();
  const { folder, actions, may, onOpen, onDrop, selected, onPick } = props;
  const drop = useDropTarget((drag) => onDrop(drag, folder.id));
  return (
    <article
      className={cx("drive-folder", selected && "drive-folder--selected", drop.over && "drive-folder--over")}
      {...drop.props}
      {...(may ? dragOut(() => props.dragging("folder", folder.id)) : {})}
      {...folderMenu(t, props)}
    >
      <span className="drive-folder__lead">
        <span className="drive-row__icon" aria-hidden="true">
          <Icon name="drive" size={20} />
        </span>
        <FolderCheck {...props} />
      </span>
      <button type="button" className="drive-folder__name drive-hit" onClick={(e) => onPick(folder, e)}>
        {folder.name}
      </button>
      <span className="drive-folder__more">
        <FolderMore folder={folder} actions={actions} may={may} onOpen={onOpen} />
      </span>
    </article>
  );
}

/** A folder in the list: the same columns as a file (checkbox, icon, name), its maker and when it changed. */
export function FolderRow(props: FolderItemProps) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const { folder, actions, may, onOpen, onDrop, selected, onPick } = props;
  const drop = useDropTarget((drag) => onDrop(drag, folder.id));
  const name = authorName(folder.createdBy);
  const when = relativeTime(t, i18n.language, folder.updatedAt);
  return (
    <li
      className={cx("drive-row drive-row--folder", selected && "drive-row--selected", drop.over && "drive-row--over")}
      {...drop.props}
      {...(may ? dragOut(() => props.dragging("folder", folder.id)) : {})}
      {...folderMenu(t, props)}
    >
      <FolderCheck {...props} />
      <span className="drive-row__name ac-iconline">
        <span className="drive-row__icon" aria-hidden="true">
          <Icon name="drive" size={20} />
        </span>
        <span className="drive-row__text">
          <button type="button" className="drive-row__title drive-hit" onClick={(e) => onPick(folder, e)}>
            {folder.name}
          </button>
          <span className="drive-row__sub">
            <span className="drive-row__subtext">
              {t("drive.folder")}
              <span className="drive-row__mobile">{` · ${name} · ${when}`}</span>
            </span>
          </span>
        </span>
      </span>
      <span className="drive-row__who">
        <ActorAvatar size="xs" actor={folder.createdBy} name={name} />
        <span>{name}</span>
      </span>
      <span className="drive-row__where" />
      <time className="drive-row__when tabular" dateTime={folder.updatedAt}>
        {when}
      </time>
      <span className="drive-row__more">
        <FolderMore folder={folder} actions={actions} may={may} onOpen={onOpen} />
      </span>
    </li>
  );
}

/** One step of the path: a button to that folder that also takes items dropped on it. */
function Crumb({
  id,
  name,
  current,
  onOpen,
  onDrop,
}: {
  id: string | null;
  name: string;
  current: boolean;
  onOpen: (id: string | null) => void;
  onDrop: (drag: DriveDrag, id: string | null) => void;
}) {
  const drop = useDropTarget((drag) => onDrop(drag, id));
  return (
    <li className="drive-crumbs__step">
      {current ? (
        <span className="drive-crumbs__here" aria-current="page">
          {name}
        </span>
      ) : (
        <button
          type="button"
          className={cx("drive-crumbs__link", drop.over && "drive-crumbs__link--over")}
          onClick={() => onOpen(id)}
          {...drop.props}
        >
          {name}
        </button>
      )}
    </li>
  );
}

/** "Drive › Reports › 2026": where the person is, each step a way back and a place to drop items. */
export function DriveCrumbs({
  trail,
  onOpen,
  onDrop,
}: {
  trail: DriveFolder[];
  onOpen: (id: string | null) => void;
  onDrop: (drag: DriveDrag, id: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("drive.path")}>
      <ol className="drive-crumbs">
        <Crumb id={null} name={t("drive.title")} current={trail.length === 0} onOpen={onOpen} onDrop={onDrop} />
        {trail.map((f, i) => (
          <Crumb key={f.id} id={f.id} name={f.name} current={i === trail.length - 1} onOpen={onOpen} onDrop={onDrop} />
        ))}
      </ol>
    </nav>
  );
}
