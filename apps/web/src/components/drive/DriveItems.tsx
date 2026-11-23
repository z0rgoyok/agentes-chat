import type { Artifact, ArtifactKind } from "@agenteschat/client";
import { isLiveFileKind } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import type { DriveDrag } from "@agenteschat/client/lib/drive";
import { fileIcon } from "@agenteschat/client/lib/files";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Checkbox, cx, Icon, type IconName } from "@agenteschat/ui";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu, useArtifactEntries } from "@/components/artifacts/ArtifactActions";
import { useAuthorName } from "@/components/artifacts/ArtifactViewer";
import type { MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { dragOut } from "./DriveFolders";
import { DrivePreview } from "./DrivePreview";

/** Shift on a checkbox picks the range from the last pick, as Shift on a title does. */
const shiftRange = (e: MouseEvent<HTMLButtonElement>, a: Artifact, onPick: ItemProps["onPick"]) => {
  if (!e.shiftKey) return;
  e.preventDefault();
  onPick(a, e);
};

/** The kind's icon; uploaded files by their name (the list has no content type). */
export const itemIcon = (a: Pick<Artifact, "kind" | "title">): IconName =>
  a.kind === "file" ? fileIcon(a.title) : (KIND_ICON[a.kind as ArtifactKind] ?? "file");

export interface ItemProps {
  artifact: Artifact;
  selected: boolean;
  /** Where it came from: "#eng", "DM com Theo", "sem canal". */
  channelName: (a: Artifact) => string;
  /** A click: the file opens, or selection with Shift / ⌘ / while selecting. Shift on a checkbox comes here too. */
  onPick: (a: Artifact, e: MouseEvent) => void;
  onToggle: (a: Artifact) => void;
  /** The viewer, from the menu's "Abrir". */
  onOpen: (a: Artifact) => void;
  /** "Renomear" and "Mover para…", and dragging it into a folder: absent for who can't arrange the Drive. */
  onRename?: (a: Artifact) => void;
  onMove?: (a: Artifact) => void;
  /** What dragging it carries: the selection when it is in it, else itself. */
  dragging?: (a: Artifact) => DriveDrag;
  /** The selection's menu when it is part of one (null: its own). */
  selectionMenu?: (kind: "folder" | "file", id: string) => MenuEntry[] | null;
}

/**
 * A grid card: the real preview, the kind (and version, but for a live file, whose versions are checkpoints behind it:
 * ADR 0196 §7) on glass, the title,
 * who made it, where and when. The title's button stretches over the card;
 * the checkbox sits above it.
 */
export function DriveCard({
  artifact: a,
  selected,
  channelName,
  onPick,
  onToggle,
  onOpen,
  onDelete,
  onRename,
  onMove,
  dragging,
  selectionMenu,
}: ItemProps & { onDelete: (a: Artifact) => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  const menu = useItemMenu(a, { onOpen, onDelete, onRename, onMove }, selectionMenu);
  return (
    <>
      <article
        className={cx("drive-card", selected && "drive-card--selected")}
        data-kind={a.kind}
        {...menu.props}
        {...(dragging ? dragOut(() => dragging(a)) : {})}
      >
        <DrivePreview artifact={a} />
        <span className="drive-card__kind">
          <Icon name={itemIcon(a)} size={14} />
          <span>
            {t(`artifacts.kind.${a.kind}`)}
            {a.version > 1 && !isLiveFileKind(a.kind) && ` · ${t("artifacts.version", { version: a.version })}`}
          </span>
        </span>
        <div className="drive-card__body">
          <button
            type="button"
            className="drive-card__title drive-hit"
            // A live file opens its own page, the rest the viewer (a dialog).
            aria-haspopup={isLiveFileKind(a.kind) ? undefined : "dialog"}
            onClick={(e) => onPick(a, e)}
          >
            {a.title}
          </button>
          <span className="drive-card__meta">
            <ActorAvatar size="xs" actor={a.createdBy} name={name} />
            <span className="drive-card__name">{name}</span>
            <span className="drive-card__where">{channelName(a)}</span>
            <time className="drive-card__when tabular" dateTime={a.updatedAt}>
              {relativeTime(t, i18n.language, a.updatedAt)}
            </time>
          </span>
        </div>
        <Checkbox
          className="drive-check"
          checked={selected}
          onCheckedChange={() => onToggle(a)}
          onClick={(e) => shiftRange(e, a, onPick)}
          aria-label={t("drive.select", { title: a.title })}
        />
      </article>
      {menu.dialog}
    </>
  );
}

/**
 * A card's or row's right click and menu key: the same actions as its "…", with open and download first. `dialog`
 * (its share dialog) goes beside the item, so the dialog's keys never reach the item's own.
 */
function useItemMenu(
  a: Artifact,
  handlers: Pick<ItemProps, "onOpen" | "onRename" | "onMove"> & { onDelete: (a: Artifact) => void },
  selectionMenu: ItemProps["selectionMenu"],
) {
  const entries = useArtifactEntries();
  const props = entityMenu(
    () =>
      selectionMenu?.("file", a.id) ?? [
        { kind: "header", label: a.title },
        ...entries(a, { ...menuOptions(a, handlers), download: true }),
      ],
  );
  return { props, dialog: entries.dialog };
}

/** The item's handlers as the file menu takes them. */
const menuOptions = (
  a: Artifact,
  h: Pick<ItemProps, "onOpen" | "onRename" | "onMove"> & { onDelete: (a: Artifact) => void },
) => ({
  onOpen: () => h.onOpen(a),
  onDelete: () => h.onDelete(a),
  ...(h.onRename ? { onRename: () => h.onRename?.(a) } : {}),
  ...(h.onMove ? { onMove: () => h.onMove?.(a) } : {}),
});

/** A list row: checkbox, the kind's icon and the title (a folder row's columns), who, where, when, "…". */
export function DriveRow({
  artifact: a,
  selected,
  channelName,
  onPick,
  onToggle,
  onOpen,
  onDelete,
  onRename,
  onMove,
  dragging,
  selectionMenu,
}: ItemProps & { onDelete: (a: Artifact) => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  const when = relativeTime(t, i18n.language, a.updatedAt);
  const menu = useItemMenu(a, { onOpen, onDelete, onRename, onMove }, selectionMenu);
  return (
    <>
      <li
        className={cx("drive-row", selected && "drive-row--selected")}
        data-kind={a.kind}
        {...menu.props}
        {...(dragging ? dragOut(() => dragging(a)) : {})}
      >
        <Checkbox
          className="drive-check"
          checked={selected}
          onCheckedChange={() => onToggle(a)}
          onClick={(e) => shiftRange(e, a, onPick)}
          aria-label={t("drive.select", { title: a.title })}
        />
        <span className="drive-row__name ac-iconline">
          <span className="drive-row__icon" aria-hidden="true">
            <Icon name={itemIcon(a)} size={20} />
          </span>
          <span className="drive-row__text">
            <button
              type="button"
              className="drive-row__title drive-hit"
              aria-haspopup={isLiveFileKind(a.kind) ? undefined : "dialog"}
              onClick={(e) => onPick(a, e)}
            >
              {a.title}
            </button>
            <span className="drive-row__sub">
              <span className="drive-row__subtext">
                {t(`artifacts.kind.${a.kind}`)}
                {a.version > 1 && !isLiveFileKind(a.kind) && ` · ${t("artifacts.version", { version: a.version })}`}
                <span className="drive-row__mobile">{` · ${name} · ${when}`}</span>
              </span>
            </span>
          </span>
        </span>
        <span className="drive-row__who">
          <ActorAvatar size="xs" actor={a.createdBy} name={name} />
          <span>{name}</span>
        </span>
        <span className="drive-row__where">{channelName(a)}</span>
        <time className="drive-row__when tabular" dateTime={a.updatedAt}>
          {when}
        </time>
        <span className="drive-row__more">
          <ArtifactMoreMenu artifact={a} {...menuOptions(a, { onOpen, onDelete, onRename, onMove })} />
        </span>
      </li>
      {menu.dialog}
    </>
  );
}
