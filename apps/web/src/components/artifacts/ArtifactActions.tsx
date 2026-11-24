import type { Artifact, ArtifactContent, ArtifactKind } from "@agenteschat/client";
import { ApiError, isLiveFileKind, keys } from "@agenteschat/client";
import { fileName } from "@agenteschat/client/lib/artifacts";
import { artifactPlace } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogFooter, type IconName, Menu } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { MenuEntries } from "@/components/DesktopMenus";
import { goToTarget } from "@/components/NotificationOpen";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { fileSaver } from "./fileSaver";
import { useFileShare } from "./ShareDialog";

type Target = Pick<Artifact, "id" | "title">;

/**
 * "Mover para a lixeira": a confirmation naming the file (it goes to the trash for
 * 30 days; messages that cite it show "Arquivo removido"), then a toast with
 * "Desfazer", which restores it. Several at once (the Drive's selection): one
 * confirmation and one toast for all of them.
 */
export function useDeleteArtifact(onDeleted?: (ids: string[]) => void) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [targets, setTargets] = useState<Target[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.artifacts(org.id) });
    // A task lists only its files outside the trash: one moved there (or back) leaves (or returns to) its "Anexos".
    void qc.invalidateQueries({ queryKey: keys.issues(org.id) });
  };
  const restore = async (ids: string | string[]) => {
    const list = typeof ids === "string" ? [ids] : ids;
    let failed: unknown = null;
    for (const id of list) {
      try {
        await api.artifacts.restore(org.id, id);
      } catch (err) {
        failed = err;
      }
    }
    if (failed) {
      toast.show(
        failed instanceof ApiError && failed.status === 409 ? t("artifacts.purged") : errorText(t, failed),
        "error",
      );
    } else {
      toast.show(list.length > 1 ? t("artifacts.restoredMany", { count: list.length }) : t("artifacts.restored"));
    }
    refresh();
  };
  const confirm = async () => {
    if (targets.length === 0) return;
    setBusy(true);
    const removed: string[] = [];
    let failed: unknown = null;
    for (const target of targets) {
      try {
        await api.artifacts.remove(org.id, target.id);
        removed.push(target.id);
      } catch (err) {
        failed = err;
      }
    }
    setBusy(false);
    setTargets([]);
    if (removed.length > 0) {
      onDeleted?.(removed);
      refresh();
      toast.show(
        removed.length > 1 ? t("artifacts.deletedMany", { count: removed.length }) : t("artifacts.deleted"),
        "info",
        { label: t("artifacts.undo"), run: () => void restore(removed) },
      );
    }
    if (failed) {
      toast.show(
        failed instanceof ApiError && failed.status === 403 ? t("artifacts.deleteForbidden") : errorText(t, failed),
        "error",
      );
    }
  };
  const one = targets.length === 1 ? targets[0] : undefined;
  const dialog = (
    <Dialog
      open={targets.length > 0}
      onOpenChange={(o) => !o && setTargets([])}
      title={
        one
          ? t("artifacts.deleteTitle", { title: one.title })
          : t("artifacts.deleteManyTitle", { count: targets.length })
      }
      description={t("artifacts.deleteBody")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={() => setTargets([])}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={busy} disabled={busy} onClick={() => void confirm()}>
          {t("artifacts.deleteConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
  const ask = (target: Target | Target[]) => setTargets(Array.isArray(target) ? target : [target]);
  return { ask, dialog, restore };
}

export type DownloadFormat = "pdf" | "docx" | "csv" | "xlsx" | "pptx" | "md";
type Downloadable = Pick<Artifact, "id" | "kind" | "title">;

/**
 * Baixar: the original (uploads as they were sent; the rest as stored: .md,
 * .csv, .patch, .mmd, .html) or a copy the server converts (documents → PDF
 * or Word, tables → CSV). `content`, when at hand, names the file exactly; a
 * Drive row without it goes by its title.
 */
export function useArtifactDownload() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const original = async (a: Downloadable, version?: number, content?: ArtifactContent) => {
    // A live file's version holds its document: what it downloads as is written by the server (ADR 0198).
    if (isLiveFileKind(a.kind)) {
      const url = api.artifacts.fileUrl(org.id, a.id, version ? { version } : {});
      fileSaver.save(url, fileName(a.title, { kind: a.kind }));
      return;
    }
    if (a.kind === "file") {
      const name = content?.kind === "file" ? content.name : a.title;
      fileSaver.save(api.artifacts.fileUrl(org.id, a.id, version ? { version } : {}), name);
      return;
    }
    const { url } = await api.artifacts.download(org.id, a.id, version);
    fileSaver.save(url, fileName(a.title, content ?? { kind: a.kind }));
  };
  const save = async (a: Downloadable, format?: DownloadFormat, version?: number, content?: ArtifactContent) => {
    if (!format) return original(a, version, content);
    fileSaver.save(
      api.artifacts.fileUrl(org.id, a.id, { version, format }),
      fileName(a.title, content ?? { kind: a.kind }).replace(/\.[a-z0-9]+$/i, `.${format}`),
    );
  };
  /** What a kind can be saved as ("Original" for all but tables, whose original is the CSV). */
  const formats = (kind: ArtifactKind): { key: string; format?: DownloadFormat; icon: IconName; label: string }[] => [
    // A document (a live file, ADR 0200): Word, its Markdown, or a PDF.
    ...(kind === "document"
      ? [
          { key: "docx", format: "docx" as const, icon: "page" as const, label: t("live.shell.formats.docx") },
          { key: "md", format: "md" as const, icon: "document" as const, label: t("live.shell.formats.md") },
          { key: "pdf", format: "pdf" as const, icon: "document" as const, label: t("live.shell.formats.pdf") },
        ]
      : []),
    ...(kind === "table"
      ? [{ key: "csv", format: "csv" as const, icon: "table" as const, label: t("artifacts.formatCsv") }]
      : []),
    // Live files (ADR 0198): a spreadsheet as Excel or CSV, a presentation as PowerPoint or PDF, a canvas as JSON.
    ...(kind === "spreadsheet"
      ? [
          { key: "xlsx", format: "xlsx" as const, icon: "spreadsheet" as const, label: t("live.shell.formats.xlsx") },
          { key: "csv", format: "csv" as const, icon: "table" as const, label: t("live.shell.formats.csv") },
        ]
      : []),
    ...(kind === "slides"
      ? [
          { key: "pptx", format: "pptx" as const, icon: "slides" as const, label: t("live.shell.formats.pptx") },
          { key: "pdf", format: "pdf" as const, icon: "document" as const, label: t("live.shell.formats.pdf") },
        ]
      : []),
    ...(kind === "canvas" ? [{ key: "json", icon: "code" as const, label: t("live.shell.formats.json") }] : []),
    ...(kind !== "table" && !isLiveFileKind(kind)
      ? [{ key: "original", icon: "download" as const, label: t("artifacts.formatOriginal") }]
      : []),
  ];
  return { save, formats };
}

/**
 * A file's actions, for its "…" (viewer header, Drive rows) and its right click (Drive cards and rows): open and
 * download when given, Compartilhar, its link (through the share dialog while only its conversation sees it), its
 * conversation, versions, move to the trash. The caller renders `dialog`.
 */
export function useArtifactEntries() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const downloads = useArtifactDownload();
  const share = useFileShare();
  const placeEntry = (artifact: Artifact): MenuEntry[] => {
    const place = artifactPlace(artifact);
    if (!place) return [];
    const dm = artifact.audience.kind === "dm";
    return [
      {
        kind: "item",
        id: "conversation",
        label: t(dm ? "artifacts.openInDm" : "artifacts.openInChannel"),
        icon: dm ? "message" : place.to.includes("threads") ? "thread" : "channel",
        run: () => goToTarget(navigate, org.id, place),
      },
    ];
  };
  const build = (
    artifact: Artifact,
    { onOpen, onVersions, onDelete, download, onRename, onMove }: ArtifactMenuOptions,
  ): MenuEntry[] => [
    ...(onOpen
      ? ([
          { kind: "item", id: "open", label: t("artifacts.openFile"), icon: "external", run: () => onOpen() },
        ] satisfies MenuEntry[])
      : []),
    ...(download
      ? ([
          {
            kind: "item",
            id: "download",
            label: t("artifacts.download"),
            icon: "download",
            run: () => void downloads.save(artifact),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(artifact.inDrive !== false
      ? ([
          { kind: "item", id: "share", label: t("share.button"), icon: "personAdd", run: () => share.open(artifact) },
        ] satisfies MenuEntry[])
      : []),
    {
      kind: "item",
      id: "copy-link",
      label: t("artifacts.copyLink"),
      icon: "link",
      run: () => share.copyLink(artifact),
    },
    ...placeEntry(artifact),
    ...(onRename
      ? ([{ kind: "item", id: "rename", label: t("drive.rename"), icon: "edit", run: onRename }] satisfies MenuEntry[])
      : []),
    ...(onMove
      ? ([{ kind: "item", id: "move", label: t("drive.moveToMenu"), icon: "move", run: onMove }] satisfies MenuEntry[])
      : []),
    ...(onVersions
      ? ([
          { kind: "item", id: "versions", label: t("artifacts.seeVersions"), icon: "waiting", run: onVersions },
        ] satisfies MenuEntry[])
      : []),
    ...(artifact.canDelete
      ? ([
          { kind: "separator" },
          { kind: "item", id: "delete", label: t("artifacts.delete"), icon: "trash", danger: true, run: onDelete },
        ] satisfies MenuEntry[])
      : []),
  ];
  return Object.assign(build, { dialog: share.dialog });
}

export interface ArtifactMenuOptions {
  /** "Abrir" (Drive). */
  onOpen?: () => void;
  onVersions?: () => void;
  onDelete: () => void;
  /** "Baixar" the original (Drive's right click; the details and the viewer have their own button). */
  download?: boolean;
  /** The Drive's own: "Renomear" and "Mover para…" (who adds to the Drive). */
  onRename?: () => void;
  onMove?: () => void;
}

/** "…" on a file (viewer header, Drive rows, the details): its actions (`useArtifactEntries`). */
export function ArtifactMoreMenu({
  artifact,
  plain,
  ...options
}: {
  artifact: Artifact;
  /** A full-size bordered button, matching the plain buttons it sits beside (the details' actions). */
  plain?: boolean;
} & ArtifactMenuOptions) {
  const { t } = useTranslation();
  const entries = useArtifactEntries();
  const label = t("artifacts.more", { title: artifact.title });
  return (
    <>
      <Menu
        align="end"
        label={label}
        trigger={
          plain ? (
            <Button iconOnly icon="more" aria-label={label} title={t("artifacts.moreShort")} />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="more"
              aria-label={label}
              title={t("artifacts.moreShort")}
            />
          )
        }
      >
        <MenuEntries entries={entries(artifact, options)} />
      </Menu>
      {entries.dialog}
    </>
  );
}
