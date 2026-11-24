import type { Issue, IssueActivity } from "@agenteschat/client";
import { useArtifact, useIssueAction } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { whenAt } from "@agenteschat/client/lib/format";
import { Button, EmptyState, Icon, pastedFiles, Segmented, Spinner } from "@agenteschat/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { useArtifactDownload } from "@/components/artifacts/ArtifactActions";
import { useArtifactViewer } from "@/components/artifacts/viewer-context";
import { DrivePreview } from "@/components/drive/DrivePreview";
import { useOrg } from "@/components/org-context";
import { type PendingFile, useComposerFiles } from "@/hooks/useComposerFiles";
import { useFileDrop } from "@/hooks/useFileDrop";
import { useToast } from "@/lib/toast";

/** A file of the task and where it came from ("Na criação · ontem às 17:40", "Comentário de Ana · …"). */
export interface IssueFileEntry {
  id: string;
  title: string;
  origin: string;
}

/**
 * Every file of a task, in the order they came: the ones it was created with, each comment's, the ones an agent
 * attached, then the ones linked later (sent in its conversation, an agent's report). Only what is still linked: one
 * taken off (Desfazer) or in the trash isn't.
 */
export function useIssueFileEntries(issue: Issue, activity: IssueActivity[]): IssueFileEntry[] {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const linked = new Set(issue.artifacts.map((f) => f.id));
  const seen = new Set<string>();
  const out: IssueFileEntry[] = [];
  for (const a of activity) {
    const when = whenAt(t, i18n.language, a.createdAt);
    for (const f of a.attachments ?? []) {
      if (seen.has(f.id) || !linked.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        id: f.id,
        title: f.title,
        origin:
          a.kind === "comment"
            ? t("issues.files.fromComment", { name: actors.name(a.author), when })
            : a.event === "artifact_linked"
              ? t("issues.files.linked", { name: actors.name(a.author) })
              : t("issues.files.fromCreation", { when }),
      });
    }
  }
  for (const f of issue.artifacts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, title: f.title, origin: t("issues.files.linked", { name: actors.name(f.createdBy) }) });
  }
  return out;
}

/**
 * Files added to a task that already exists ("Adicionar arquivos", a drop, a paste anywhere in it): each goes to the
 * Drive right away and, once all are there, they go as one comment of their own (no text), so the discussion and the
 * history show who attached what. `onSent` runs after (the details' "Ver anexos" when that tab isn't open).
 */
export function useIssueFileAdd(issue: Issue, onSent?: (count: number) => void) {
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const adding = useComposerFiles(issue.channelId);
  const sending = useRef(false);
  const sentNow = useRef(onSent);
  sentNow.current = onSent;
  const doneIds = !adding.uploading && adding.attached.length > 0 ? adding.attached.map((f) => f.id).join(",") : "";
  // Once every picked file is in the Drive, they go as one comment (no text): the box empties after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires when the uploaded set settles, not on each render
  useEffect(() => {
    if (!doneIds || sending.current) return;
    sending.current = true;
    const sent = adding.items.map((f) => f.key);
    const ids = doneIds.split(",");
    action.mutate(
      { type: "comment", id: issue.id, text: "", attachmentIds: ids },
      {
        // Only what was in the box as it went: a file added meanwhile stays, and goes as the next comment. Refused,
        // they all stay (the failed write has its toast): the next file added sends them again, × takes one out.
        onSuccess: () => {
          for (const key of sent) adding.remove(key);
          sentNow.current?.(ids.length);
        },
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  }, [doneIds]);
  return adding;
}

/**
 * A file pasted anywhere in the task (its description being edited, the Anexos tab, a click on the page) joins its
 * attachments, as in the chat. `root` is the task's details: a paste in something beside them (the conversation
 * panel, a dialog over them) isn't theirs, one on the page around them (nothing focused) is. A field that takes
 * files itself (a comment's box) takes them first.
 */
export function useIssueFilePaste(root: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void) {
  const filesNow = useRef(onFiles);
  filesNow.current = onFiles;
  useEffect(() => {
    const paste = (e: globalThis.ClipboardEvent) => {
      const target = e.target;
      const box = root.current;
      if (e.defaultPrevented || !box || !(target instanceof Node)) return;
      if (!box.contains(target) && !target.contains(box)) return;
      const pasted = pastedFiles(e.clipboardData);
      if (pasted.length === 0) return;
      e.preventDefault();
      filesNow.current(pasted);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [root]);
}

/**
 * "Anexos": every file of the task in a grid (the real preview, as in the Drive) or a list, with where each one
 * came from; × takes one off the task (it stays in the Drive). "Adicionar arquivos", a drop or a paste adds through
 * `adding` (`useIssueFileAdd`, kept by the details so a paste on any tab lands here). Empty, one way in: the kit's
 * empty state with its one button (a drop and a paste still work anywhere on it), which also says files sent in the
 * task's conversation land here.
 */
export function IssueFiles({
  issue,
  activity,
  adding,
}: {
  issue: Issue;
  activity: IssueActivity[];
  adding: ReturnType<typeof useIssueFileAdd>;
}) {
  const { t } = useTranslation();
  const entries = useIssueFileEntries(issue, activity);
  const [view, setView] = useState<"grid" | "list">("grid");
  const picker = useRef<HTMLInputElement>(null);
  const drop = useFileDrop(adding.onFiles, true);
  const remove = useIssueFileRemove(issue);
  const pick = () => picker.current?.click();
  const empty = entries.length === 0 && adding.items.length === 0;
  return (
    <section
      className="issue-files"
      aria-label={t("issues.files.title")}
      data-over={drop.over || undefined}
      {...drop.props}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-label={t("issues.files.add")}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (list.length > 0) adding.onFiles(list);
        }}
      />
      {empty ? (
        <EmptyState
          size="panel"
          icon="upload"
          title={t("issues.files.emptyTitle")}
          actions={
            <Button variant="primary" icon="upload" onClick={pick} loading={adding.uploading}>
              {t("issues.files.add")}
            </Button>
          }
        >
          {t("issues.files.empty")}
        </EmptyState>
      ) : (
        <>
          <div className="issue-files__bar">
            <Segmented
              size="sm"
              label={t("issues.view")}
              value={view}
              onValueChange={setView}
              options={[
                {
                  value: "grid",
                  label: (
                    <>
                      <Icon name="grid" size={16} />
                      {t("issues.files.grid")}
                    </>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <>
                      <Icon name="list" size={16} />
                      {t("issues.list")}
                    </>
                  ),
                },
              ]}
            />
            <span className="issue-files__grow" />
            <Button size="sm" icon="upload" onClick={pick} loading={adding.uploading}>
              {t("issues.files.add")}
            </Button>
          </div>
          {view === "grid" ? (
            <div className="issue-files__grid">
              {entries.map((e) => (
                <IssueFileTile key={e.id} entry={e} onRemove={() => remove(e)} />
              ))}
              {adding.items.map((f) => (
                <PendingTile key={f.key} file={f} onRemove={() => adding.remove(f.key)} />
              ))}
            </div>
          ) : (
            <ul className="issue-files__list">
              {entries.map((e) => (
                <IssueFileRow key={e.id} entry={e} onRemove={() => remove(e)} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/**
 * × on a file of the task: takes it off the task (an `artifact_unlinked` in the history), never out of the Drive;
 * the toast says where it still is.
 */
function useIssueFileRemove(issue: Issue) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const toast = useToast();
  return (entry: IssueFileEntry) =>
    action.mutate(
      { type: "update", id: issue.id, patch: { removeFiles: [entry.id] } },
      { onSuccess: () => toast.show(t("issues.files.removed", { name: entry.title }), "info") },
    );
}

/** A saved file in the grid: its real preview, name and where it came from; a click opens the viewer, × takes it off. */
function IssueFileTile({ entry, onRemove }: { entry: IssueFileEntry; onRemove: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const a = useArtifact(org.id, entry.id).data;
  return (
    <div className="issue-file issue-file--saved">
      <button
        type="button"
        className="issue-file__main"
        onClick={() => viewer.open(entry.id)}
        aria-label={t("artifacts.open", { title: entry.title })}
      >
        <span className="issue-file__thumb">{a ? <DrivePreview artifact={a} /> : <Icon name="file" />}</span>
        <span className="issue-file__text">
          <span className="issue-file__name" title={entry.title}>
            {entry.title}
          </span>
          <span className="issue-file__meta">{entry.origin}</span>
        </span>
      </button>
      <button
        type="button"
        className="issue-file__remove"
        aria-label={t("issues.files.remove", { name: entry.title })}
        title={t("issues.files.removeShort")}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** A saved file in the list: small preview and name (opens it), where it came from, size, download, ×. */
function IssueFileRow({ entry, onRemove }: { entry: IssueFileEntry; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const download = useArtifactDownload();
  const a = useArtifact(org.id, entry.id).data;
  const size = a?.content.kind === "file" ? formatBytes(i18n.language, a.content.size) : "";
  return (
    <li className="issue-files__row">
      <button
        type="button"
        className="issue-files__open"
        onClick={() => viewer.open(entry.id)}
        aria-label={t("artifacts.open", { title: entry.title })}
      >
        {a ? <DrivePreview artifact={a} size="sm" /> : <span className="issue-files__noprev" />}
        <span className="issue-files__name" title={entry.title}>
          {entry.title}
        </span>
      </button>
      <span className="issue-files__from small muted">{entry.origin}</span>
      <span className="issue-files__size small muted tabular">{size}</span>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="download"
        aria-label={t("artifacts.download")}
        title={t("artifacts.download")}
        disabled={!a}
        onClick={() => a && void download.save(a, undefined, a.shownVersion, a.content)}
      />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="close"
        aria-label={t("issues.files.remove", { name: entry.title })}
        title={t("issues.files.removeShort")}
        onClick={onRemove}
      />
    </li>
  );
}

/** A file on its way to the Drive (the new-task form, "Adicionar arquivos"): thumbnail or type, name, ✕. */
export function PendingTile({ file: f, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="issue-file" data-status={f.status}>
      <span className="issue-file__thumb">
        {f.preview ? <img src={f.preview} alt="" /> : <Icon name={f.icon} />}
        {f.status === "uploading" && <Spinner size={24} className="issue-file__state" />}
      </span>
      <span className="issue-file__text">
        <span className="issue-file__name" title={f.name}>
          {f.name}
        </span>
        <span className="issue-file__meta">
          {f.status === "uploading"
            ? t("channel.uploading")
            : f.status === "failed"
              ? t("channel.uploadFailed")
              : formatBytes(i18n.language, f.size)}
        </span>
      </span>
      <button
        type="button"
        className="issue-file__remove"
        aria-label={t("channel.removeFile", { name: f.name })}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
