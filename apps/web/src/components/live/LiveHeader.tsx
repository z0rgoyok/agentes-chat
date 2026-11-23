import type { Artifact, LiveKind } from "@agenteschat/client";
import { useDuplicateLiveFile, useRenameLiveFile } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { artifactPlace } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime, whenAt } from "@agenteschat/client/lib/format";
import type { Peer } from "@agenteschat/live/awareness";
import { Button, cx, Icon, Menu, MenuItem, MenuSeparator, MenuSub, Skeleton, useDelayed } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useArtifactDownload } from "@/components/artifacts/ArtifactActions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { contextMenuHandler, type MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { forgetJustCreated, wasJustCreated } from "./just-created";
import { PresenceStack } from "./peers";
import { MadeFromWords, useMadeFrom } from "./TalkBits";
import type { useLiveRoomWeb } from "./useLiveRoomWeb";
import "@/pages/wiki.css";

/** "Salvando…" only once a change has waited this long: a burst of keys never blinks it. */
const SAVING_AFTER_MS = 400;

/** Kinds whose page carries its own title and meta row, Wiki style (a document, ADR 0200): only the top row here. */
const TITLED_ON_THE_PAGE: ReadonlySet<string> = new Set(["document"]);

/**
 * The live file's header (ADR 0196 §9, ADR 0199), the Wiki's top over a task's title: where the file lives
 * ("Drive / #eng") on the left and, on the right, how it's saved, who is here, Compartilhar, Apresentar (slides), the
 * conversation's toggle and ⋯, always the last one (narrow, Compartilhar goes into it and the rest keep that order);
 * then the kind's icon and the title to rename; then who made it and where, when it was edited (the versions) and who
 * sees it (the sharing). A document shows the top row alone.
 */
export function LiveHeader({
  artifact,
  kind,
  live,
  previewing,
  compact,
  peers,
  followId,
  onFollow,
  talk,
  onShare,
  onCopyLink,
  onPresent,
  onVersions,
  onSave,
  onShortcuts,
  onDelete,
}: {
  artifact: Artifact | null;
  kind: LiveKind | null;
  live: ReturnType<typeof useLiveRoomWeb>;
  previewing: boolean;
  compact: boolean;
  peers: Peer[];
  followId: number | null;
  onFollow: (peer: Peer | null) => void;
  /** The conversation's toggle ("Conversa 4"). */
  talk: ReactNode;
  onShare: () => void;
  onCopyLink: () => void;
  onPresent: () => void;
  onVersions: () => void;
  onSave: () => void;
  onShortcuts: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const downloads = useArtifactDownload();
  const duplicate = useDuplicateLiveFile(org.id, artifact?.id ?? "");
  const rename = useRenameLiveFile(org.id, artifact?.id ?? "");
  const readOnly = live.loaded && live.mode === "view";
  const status = useStatusWords(live, previewing);
  const toDrive = () => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } });
  const copy = () => {
    if (!artifact) return;
    duplicate.mutate(t("live.shell.copyTitle", { title: artifact.title }), {
      onSuccess: (made) =>
        toast.show(t("live.shell.duplicated", { title: made.title }), "success", {
          label: t("live.shell.open"),
          run: () =>
            void navigate({ to: "/org/$orgId/drive/$fileId", params: { orgId: org.id, fileId: made.id }, search: {} }),
        }),
      onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
    });
  };
  const formats = kind ? downloads.formats(kind) : [];
  const shares = artifact?.inDrive !== false;
  // The header's right click (the desktop app's own menu when the person chose it): the file's actions, as ⋯ has them.
  const menu = (): MenuEntry[] =>
    artifact
      ? [
          { kind: "header", label: artifact.title },
          ...(shares
            ? ([
                { kind: "item", id: "share", label: t("share.button"), icon: "personAdd", run: onShare },
                { kind: "item", id: "link", label: t("live.shell.menu.copyLink"), icon: "link", run: onCopyLink },
              ] as const)
            : []),
          { kind: "item", id: "versions", label: t("live.shell.menu.versions"), icon: "clock", run: onVersions },
          {
            kind: "item",
            id: "save-version",
            label: t("live.shell.menu.saveVersion"),
            icon: "flag",
            disabled: readOnly || previewing,
            run: onSave,
          },
          { kind: "item", id: "duplicate", label: t("live.shell.menu.duplicate"), icon: "copy", run: copy },
          { kind: "item", id: "drive", label: t("live.shell.menu.showInDrive"), icon: "drive", run: toDrive },
          { kind: "item", id: "shortcuts", label: t("live.shell.menu.shortcuts"), icon: "keyboard", run: onShortcuts },
          ...(artifact.canDelete
            ? ([
                { kind: "separator" },
                {
                  kind: "item",
                  id: "trash",
                  label: t("live.shell.menu.trash"),
                  icon: "trash",
                  danger: true,
                  run: onDelete,
                },
              ] as const)
            : []),
        ]
      : [];
  const titled = !kind || !TITLED_ON_THE_PAGE.has(kind);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click only; every action is also in ⋯ and the buttons
    <header className="lf-head" data-kind={kind ?? undefined} onContextMenu={contextMenuHandler(menu)}>
      <div className="lf-top">
        <LiveCrumbs artifact={artifact} />
        <div className="lf-top__acts">
          {status && (
            <span className={cx("lf-top__status", status.tone === "warn" && "is-offline")} role="status">
              {status.text}
            </span>
          )}
          {artifact && (
            <>
              <PresenceStack room={live.room} peers={peers} followingId={followId} onFollow={onFollow} />
              {!compact && shares && (
                <Button size="sm" icon="personAdd" onClick={onShare}>
                  {t("share.button")}
                </Button>
              )}
              {kind === "slides" &&
                (compact ? (
                  <Button
                    size="sm"
                    variant="primary"
                    iconOnly
                    icon="present"
                    aria-label={t("live.shell.present")}
                    title={t("live.shell.present")}
                    onClick={onPresent}
                  />
                ) : (
                  <Button size="sm" variant="primary" icon="present" onClick={onPresent}>
                    {t("live.shell.present")}
                  </Button>
                ))}
              {talk}
              <Menu
                align="end"
                label={t("live.shell.more")}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="more"
                    aria-label={t("live.shell.more")}
                    title={t("live.shell.more")}
                  />
                }
              >
                {compact && shares && (
                  <>
                    <MenuItem icon="personAdd" onSelect={onShare}>
                      {t("share.button")}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                {formats.length > 0 && (
                  <MenuSub icon="download" label={t("live.shell.download")}>
                    {formats.map((f) => (
                      <MenuItem key={f.key} icon={f.icon} onSelect={() => void downloads.save(artifact, f.format)}>
                        {f.label}
                      </MenuItem>
                    ))}
                  </MenuSub>
                )}
                <MenuItem icon="clock" onSelect={onVersions}>
                  {t("live.shell.menu.versions")}
                </MenuItem>
                <MenuItem icon="flag" disabled={readOnly || previewing} onSelect={onSave}>
                  {t("live.shell.menu.saveVersion")}
                </MenuItem>
                {shares && (
                  <MenuItem icon="link" onSelect={onCopyLink}>
                    {t("live.shell.menu.copyLink")}
                  </MenuItem>
                )}
                <MenuItem icon="copy" disabled={duplicate.isPending} onSelect={copy}>
                  {t("live.shell.menu.duplicate")}
                </MenuItem>
                <MenuItem icon="drive" onSelect={toDrive}>
                  {t("live.shell.menu.showInDrive")}
                </MenuItem>
                <MenuItem icon="keyboard" onSelect={onShortcuts}>
                  {t("live.shell.menu.shortcuts")}
                </MenuItem>
                {artifact.canDelete && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon="trash" danger onSelect={onDelete}>
                      {t("live.shell.menu.trash")}
                    </MenuItem>
                  </>
                )}
              </Menu>
            </>
          )}
        </div>
      </div>
      {titled && (
        <>
          <div className="lf-titleline ac-iconline">
            <Icon name={kind ? KIND_ICON[kind] : "file"} className="lf-kind" />
            {artifact ? (
              <TitleField
                key={artifact.id}
                value={artifact.title}
                canRename={!readOnly && !previewing}
                fileId={artifact.id}
                onRename={(title) =>
                  rename.mutate(title, {
                    onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
                  })
                }
              />
            ) : (
              <Skeleton width={240} height={26} />
            )}
          </div>
          {artifact ? <LiveMeta artifact={artifact} onVersions={onVersions} /> : null}
        </>
      )}
    </header>
  );
}

/** "Drive / #eng": the Drive, then the conversation the file lives in (the Drive's grouping), each a way back. */
function LiveCrumbs({ artifact }: { artifact: Artifact | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const place = artifact ? artifactPlace({ ...artifact, threadId: null }) : null;
  let folder: string | null = null;
  if (artifact) {
    const aud = artifact.audience;
    if (!artifact.channelId) folder = t("drive.noChannel");
    else if (aud.kind === "channel") folder = `#${aud.name}`;
    else if (aud.kind === "dm")
      folder = aud.between
        ? t("drive.dmBetween", { names: joinNames(aud.between.map(dir.authorName), t) })
        : aud.with
          ? t("drive.dmWith", { name: dir.authorName(aud.with) })
          : t("drive.dm");
    else folder = t("drive.noChannel");
  }
  return (
    <nav className="wiki-crumbs lf-crumbs" aria-label={t("live.shell.crumbs")}>
      <Link to="/org/$orgId/drive" params={{ orgId: org.id }}>
        {t("shell.drive")}
      </Link>
      {folder && (
        <>
          <span aria-hidden="true">/</span>
          {place ? (
            <Link
              to={place.to as never}
              params={{ orgId: org.id, ...("params" in place ? place.params : {}) } as never}
              className="lf-crumbs__folder"
              title={folder}
            >
              {folder}
            </Link>
          ) : (
            <span className="lf-crumbs__folder" title={folder}>
              {folder}
            </span>
          )}
        </>
      )}
    </nav>
  );
}

/**
 * The line under the title (the Wiki's `wiki-meta`): who made it and where ("Atlas criou a partir da conversa com
 * Ana") and "editado agora" (the versions). Who sees it is the header's "Share" alone, one way to the sharing. A
 * document's page shows it under its own title.
 */
export function LiveMeta({ artifact, onVersions }: { artifact: Artifact; onVersions: () => void }) {
  const { t, i18n } = useTranslation();
  const made = useMadeFrom(artifact);
  return (
    <div className="wiki-meta lf-meta">
      {made && (
        <>
          <span className="wiki-by">
            <ActorAvatar actor={made.by} name={made.name} size="xs" />
            <span>
              <MadeFromWords made={made} />
            </span>
          </span>
          <span className="wiki-meta__dot" aria-hidden="true" />
        </>
      )}
      <button
        type="button"
        className="wiki-meta__when"
        title={whenAt(t, i18n.language, artifact.updatedAt)}
        onClick={onVersions}
      >
        {t("live.shell.meta.edited", { when: relativeTime(t, i18n.language, artifact.updatedAt) })}
      </button>
    </div>
  );
}

/** "Salvo" / "Salvando…" / offline / read-only, in quiet words before the faces (the Wiki's status). */
function useStatusWords(
  live: ReturnType<typeof useLiveRoomWeb>,
  previewing: boolean,
): { text: string; tone: "quiet" | "warn" } | null {
  const { t } = useTranslation();
  const { org } = useOrg();
  const saving = useDelayed(live.unsent, SAVING_AFTER_MS);
  if (previewing) return null;
  if (live.status === "offline") return { text: t("live.shell.status.offline"), tone: "warn" };
  if (!live.loaded) return live.status === "closed" ? null : { text: t("live.shell.status.connecting"), tone: "quiet" };
  if (live.mode === "view") {
    return { text: org.deletion ? t("live.shell.status.closing") : t("live.shell.status.readOnly"), tone: "quiet" };
  }
  return { text: saving ? t("live.shell.status.saving") : t("live.shell.status.saved"), tone: "quiet" };
}

/**
 * The title (26/650, a task's), renamed where it is: it reads as the page's title on one line (an ellipsis when it's
 * longer than the page) and turns into its field on a click or Tab, wrapping as it is written; Enter or leaving it
 * renames, Esc puts it back. A new file opens with it selected, ready to be named.
 */
function TitleField({
  fileId,
  value,
  canRename,
  onRename,
}: {
  fileId: string;
  value: string;
  canRename: boolean;
  onRename: (title: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Renamed elsewhere (another person, an agent) while not editing: the new name.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // A file just made from "New": its title selected, ready to be named (once; kept a moment for a remount).
  useEffect(() => {
    if (!canRename || !wasJustCreated(fileId)) return;
    field.current?.focus();
    field.current?.select();
    const id = setTimeout(() => forgetJustCreated(fileId), 1000);
    return () => clearTimeout(id);
  }, [canRename, fileId]);
  if (!canRename) {
    return (
      <h1 className="lf-title lf-title--still" title={value}>
        {value}
      </h1>
    );
  }
  const commit = () => {
    const next = draft.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (next && next !== value) onRename(next);
    else setDraft(value);
  };
  return (
    <h1 className={cx("lf-title", editing && "is-editing")} title={editing ? undefined : value}>
      <span className="lf-title__mirror" aria-hidden="true">
        {`${draft || " "} `}
      </span>
      <textarea
        ref={field}
        className="lf-title__field"
        aria-label={t("live.shell.title")}
        value={draft}
        rows={1}
        maxLength={200}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(value);
            setEditing(false);
            // Blurring now would rename with the old draft: put it back first, then leave.
            requestAnimationFrame(() => field.current?.blur());
          }
        }}
      />
    </h1>
  );
}
