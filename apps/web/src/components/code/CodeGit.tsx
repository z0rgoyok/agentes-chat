import {
  type CodeChange,
  type CodeChangeStatus,
  type CodeCommit,
  type CodeSession,
  useCodeDiff,
  useCodeGitLog,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "@/components/artifacts/views";
import { useOrg } from "@/components/org-context";

/** What the Git tab opened: one change not committed, one commit, or the whole branch since its base. */
export type GitOpened =
  | { kind: "change"; change: CodeChange }
  | { kind: "commit"; commit: CodeCommit }
  | { kind: "all" };

/** The letter `git status` gives each kind of change ("U": new, not tracked yet), in its color. */
const LETTER: Record<CodeChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** A change's letter, its kind in words for whoever doesn't read letters. */
export function ChangeLetter({ status }: { status: CodeChangeStatus }) {
  const { t } = useTranslation();
  const words = t(`codeSessions.gitTab.status.${status}`);
  return (
    <span className="code-vcs__letter" data-status={status} title={words}>
      <span aria-hidden="true">{LETTER[status]}</span>
      <span className="ac-visually-hidden">{words}</span>
    </span>
  );
}

/** "+12 −3", nothing for what isn't known (a binary file). */
function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return null;
  return (
    <span className="code-vcs__n tabular">
      {added !== null && <span className="code-add">+{added}</span>}
      {added !== null && removed !== null && " "}
      {removed !== null && <span className="code-del">−{removed}</span>}
    </span>
  );
}

/** A path as the list shows it: the file's name, then its folder, quieter. */
function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/**
 * The session panel's Git tab (ADR 0215): the branch and its base, the whole change since the base, what isn't
 * committed (as `git status` lists it) and the branch's commits, read in the worktree as its agent and again while it
 * works. Any row opens its diff in a tab beside the conversation (`onOpen`).
 */
export function GitPane({ session, onOpen }: { session: CodeSession; onOpen: (opened: GitOpened) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const ready = session.worktree.state === "ready";
  const log = useCodeGitLog(org.id, session.id, ready, session.work === "working");
  if (!ready) return <p className="code-empty">{t("codeSessions.panel.notReady")}</p>;
  const base = session.baseBranch ?? "main";
  const data = log.data;
  const ahead = data?.commits.length ?? 0;
  return (
    <div className="code-vcs">
      <div className="code-fhead">
        <span className="code-vcs__where">
          <Icon name="gitPull" size={16} />
          <code className="code-vcs__branch" title={session.branch ?? undefined}>
            {session.branch ?? base}
          </code>
          <span className="code-vcs__base" title={t("codeSessions.gitTab.from", { base })}>
            {t("codeSessions.gitTab.from", { base })}
            {ahead > 0 && ` · ${t("codeSessions.gitTab.ahead", { count: ahead, more: data?.more ? "+" : "" })}`}
          </span>
        </span>
        <span className="code-fhead__r">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            iconOnly
            aria-label={t("codeSessions.gitTab.refresh")}
            title={t("codeSessions.gitTab.refresh")}
            loading={log.isFetching}
            onClick={() => void log.refetch()}
          />
        </span>
      </div>
      <div className="code-dscroll code-vcs__scroll">
        {log.isPending ? (
          <p className="code-empty">{t("codeSessions.gitTab.reading")}</p>
        ) : log.error ? (
          <p className="code-empty">{errorText(t, log.error)}</p>
        ) : data ? (
          <>
            <button type="button" className="code-vcs__row code-vcs__row--all" onClick={() => onOpen({ kind: "all" })}>
              <Icon name="layers" size={16} />
              <span className="code-vcs__name">{t("codeSessions.gitTab.all", { base })}</span>
              {session.stat.at && <Counts added={session.stat.added} removed={session.stat.removed} />}
              <Icon name="chevronRight" size={14} className="code-vcs__go" />
            </button>

            <h3 className="code-vcs__h">
              {t("codeSessions.gitTab.uncommitted")}
              {data.changes.length > 0 && <span className="code-vcs__count tabular">{data.changes.length}</span>}
            </h3>
            {data.changes.length === 0 ? (
              <p className="code-vcs__none">{t("codeSessions.gitTab.clean")}</p>
            ) : (
              <ul className="code-vcs__list">
                {data.changes.map((c) => {
                  const { name, dir } = splitPath(c.path);
                  return (
                    <li key={c.path}>
                      <button
                        type="button"
                        className="code-vcs__row"
                        title={c.from ? `${c.from} → ${c.path}` : c.path}
                        onClick={() => onOpen({ kind: "change", change: c })}
                      >
                        <ChangeLetter status={c.status} />
                        <span className="code-vcs__name" data-status={c.status}>
                          {name}
                        </span>
                        {dir && <span className="code-vcs__dir">{dir}</span>}
                        <Counts added={c.added} removed={c.removed} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.changesMore && <p className="code-vcs__none">{t("codeSessions.gitTab.changesMore")}</p>}

            <h3 className="code-vcs__h">
              {t("codeSessions.gitTab.commits")}
              {data.commits.length > 0 && (
                <span className="code-vcs__count tabular">
                  {data.commits.length}
                  {data.more ? "+" : ""}
                </span>
              )}
            </h3>
            {data.commits.length === 0 ? (
              <p className="code-vcs__none">{t("codeSessions.gitTab.noCommits", { base })}</p>
            ) : (
              <ol className="code-vcs__list code-vcs__graph">
                {data.commits.map((c) => (
                  <li key={c.sha}>
                    <button
                      type="button"
                      className="code-vcs__row code-vcs__row--commit"
                      title={`${c.subject}\n${c.short} · ${c.author}`}
                      onClick={() => onOpen({ kind: "commit", commit: c })}
                    >
                      <span className="code-vcs__node" aria-hidden="true" />
                      <span className="code-vcs__name">{c.subject}</span>
                      <code className="code-vcs__sha">{c.short}</code>
                      <time className="code-vcs__when" dateTime={c.at}>
                        {relativeTime(t, i18n.language, c.at)}
                      </time>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {data.more && <p className="code-vcs__none">{t("codeSessions.gitTab.more")}</p>}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a row of the Git tab opened, in a tab beside the conversation: one uncommitted file's diff, a commit's
 * (`git show`), or everything since the base. Unified or side by side from its own head; a file's diff opens the file
 * itself, to edit it (`onOpenFile`).
 */
export function GitDiff({
  session,
  opened,
  onOpenFile,
}: {
  session: CodeSession;
  opened: GitOpened;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [split, setSplit] = useState(false);
  const scope = opened.kind === "commit" ? "commit" : opened.kind === "all" ? "base" : "uncommitted";
  const diff = useCodeDiff(org.id, session.id, scope, true, opened.kind === "commit" ? opened.commit.sha : undefined);
  const base = session.baseBranch ?? "main";
  const files =
    opened.kind === "change"
      ? (diff.data?.files.filter((f) => f.path === opened.change.path) ?? [])
      : (diff.data?.files ?? []);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const title =
    opened.kind === "change" ? (
      <span className="code-vcs__title" title={opened.change.path}>
        <ChangeLetter status={opened.change.status} />
        <code>{opened.change.path}</code>
      </span>
    ) : opened.kind === "commit" ? (
      <span className="code-vcs__title" title={opened.commit.subject}>
        <code className="code-vcs__sha">{opened.commit.short}</code>
        <span className="code-vcs__subject">{opened.commit.subject}</span>
      </span>
    ) : (
      <span className="code-vcs__title">
        <span className="code-vcs__subject">{t("codeSessions.gitTab.all", { base })}</span>
      </span>
    );
  return (
    <div className="code-vcs">
      <div className="code-fhead">
        {title}
        {diff.data && <Counts added={added} removed={removed} />}
        <span className="code-fhead__r">
          {opened.kind === "change" && opened.change.status !== "deleted" && (
            <Button size="sm" variant="ghost" icon="file" onClick={() => onOpenFile(opened.change.path)}>
              {t("codeSessions.gitTab.openFile")}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-pressed={split} onClick={() => setSplit((s) => !s)}>
            {t("codeSessions.gitTab.split")}
          </Button>
        </span>
      </div>
      <div className="code-dscroll">
        {diff.isPending ? (
          <p className="code-empty">{t("codeSessions.gitTab.reading")}</p>
        ) : diff.error ? (
          <p className="code-empty">{errorText(t, diff.error)}</p>
        ) : files.length === 0 ? (
          <p className="code-empty">{t("codeSessions.gitTab.none")}</p>
        ) : diff.data?.truncated ? (
          <ul className="code-files">
            <li className="code-empty">{t("codeSessions.gitTab.tooLarge")}</li>
            {files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> <Counts added={f.added} removed={f.removed} />
              </li>
            ))}
          </ul>
        ) : (
          <DiffView
            files={files.map((f) => ({ path: f.path, patch: f.patch }))}
            mode={split ? "split" : "unified"}
            heads={opened.kind !== "change"}
          />
        )}
      </div>
    </div>
  );
}
