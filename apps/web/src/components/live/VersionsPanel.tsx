import type { Artifact, ArtifactVersion, LiveRoom } from "@agenteschat/client";
import { useArtifactVersions } from "@agenteschat/client";
import { dayLabel, formatTime } from "@agenteschat/client/lib/format";
import {
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  GroupHeading,
  Input,
  SkeletonGroup,
  SkeletonRow,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthorName } from "@/components/artifacts/viewer-context";
import { useOrg } from "@/components/org-context";
import { PeerFace } from "./peers";

/**
 * The file's history beside it (ADR 0196 §7), a column that never covers the editor's controls: the current file on
 * top, then the saved versions by day, newest first (who made each, its name in bold when it has one, its time on the
 * right edge). Picking one shows it read-only in place of the file; "Salvar versão" names the file as it is now. The
 * list refreshes when a version is written (`live.versions`).
 */
export function VersionsPanel({
  artifact,
  room,
  shown,
  onShow,
  onSave,
  canSave = true,
  onClose,
}: {
  artifact: Artifact;
  room: LiveRoom | null;
  /** The version on screen; undefined: the file as it is now. */
  shown: number | undefined;
  onShow: (version: number | undefined) => void;
  onSave: () => void;
  /** The file can change now (not read-only): "Salvar versão" shows. */
  canSave?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const versions = useArtifactVersions(org.id, artifact.id);
  const refetch = versions.refetch;
  useEffect(() => room?.onVersions(() => void refetch()), [room, refetch]);
  const list = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);
  const groups: { day: string; items: ArtifactVersion[] }[] = [];
  for (const v of list) {
    const day = dayLabel(t, i18n.language, v.createdAt);
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(v);
    else groups.push({ day, items: [v] });
  }
  return (
    <aside className="lf-versions" aria-label={t("live.shell.versions.title")}>
      <header className="lf-versions__head">
        <h2 className="lf-versions__title">{t("live.shell.versions.title")}</h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          aria-label={t("live.shell.versions.close")}
          onClick={onClose}
        />
      </header>
      <div className="lf-versions__body">
        <button
          type="button"
          className={cx("lf-version", shown === undefined && "is-current")}
          aria-current={shown === undefined ? "true" : undefined}
          onClick={() => onShow(undefined)}
        >
          <span className="lf-version__words">
            <b className="lf-version__name">{t("live.shell.versions.current")}</b>
          </span>
        </button>
        {versions.isPending && (
          <SkeletonGroup label={t("live.shell.versions.title")}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </SkeletonGroup>
        )}
        {versions.isError && (
          <div className="lf-versions__note">
            <p className="small muted">{t("live.shell.versions.failed")}</p>
            <Button size="sm" onClick={() => void refetch()}>
              {t("live.shell.versions.retry")}
            </Button>
          </div>
        )}
        {versions.isSuccess && list.length === 0 && (
          <p className="lf-versions__note small muted">{t("live.shell.versions.empty")}</p>
        )}
        {groups.map((g) => (
          <section key={g.day} className="lf-versions__day" aria-label={g.day}>
            <GroupHeading level={3} title={g.day} />
            <ol className="lf-versions__list">
              {g.items.map((v) => (
                <li key={v.version}>
                  <VersionRow version={v} current={shown === v.version} onPick={() => onShow(v.version)} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {canSave && (
        <footer className="lf-versions__foot">
          <Button block onClick={onSave}>
            {t("live.shell.versions.save")}
          </Button>
        </footer>
      )}
    </aside>
  );
}

function VersionRow({ version, current, onPick }: { version: ArtifactVersion; current: boolean; onPick: () => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(version.author);
  const who = version.author.type === "agent" ? t("live.shell.versions.byAgent", { name }) : name;
  return (
    <button
      type="button"
      className={cx("lf-version ac-iconline", current && "is-current")}
      aria-current={current ? "true" : undefined}
      onClick={onPick}
    >
      <PeerFace user={{ kind: version.author.type, id: version.author.id }} name={name} size="xs" />
      <span className="lf-version__words">
        {version.note ? <b className="lf-version__name">{version.note}</b> : null}
        <span className={version.note ? "lf-version__who small muted" : "lf-version__name"}>{who}</span>
      </span>
      <time className="lf-version__time small muted tabular" dateTime={version.createdAt}>
        {formatTime(i18n.language, version.createdAt)}
      </time>
    </button>
  );
}

/** "Salvar uma versão": its name (optional), then the version is written for everyone's history. */
export function SaveVersionDialog({
  open,
  busy,
  onSave,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("live.shell.versions.saveTitle")}
      description={t("live.shell.versions.saveHint")}
      closeLabel={t("common.close")}
      width={440}
      initialFocus={field}
    >
      <form
        className="ac-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name.trim());
        }}
      >
        <DialogBody>
          <Field label={t("live.shell.versions.name")} id="lf-version-name">
            <Input
              ref={field}
              value={name}
              maxLength={500}
              placeholder={t("live.shell.versions.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy}>
            {t("live.shell.versions.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
