import { type CodeSession, useCodeFile, useSaveCodeFile } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { Button, isApple } from "@agenteschat/ui";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import type { CodeEditorHandle } from "./CodeEditor";

/** The editor comes with the first file opened, not with the page. */
const CodeEditor = lazy(() => import("./CodeEditor"));

/**
 * One file of the session's worktree, in a tab beside the conversation (ADR 0215): an editor whoever is in the session
 * saves from (the button, ⌘S), as the agent on its computer. While nothing is unsaved the file follows the computer
 * (the agent may be writing it); with something unsaved, a file that changed there asks which one stays. A file the
 * session can't show says why; one too long to come whole is read-only.
 */
export function CodeFileTab({
  session,
  path,
  active,
  asking,
  onDirty,
  onClose,
  onStay,
}: {
  session: CodeSession;
  path: string;
  /** On screen: only then is it read again. */
  active: boolean;
  /** Its tab was asked to close with something unsaved. */
  asking: boolean;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  /** The close was taken back. */
  onStay: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const file = useCodeFile(org.id, session.id, path, active && session.work === "working");
  const save = useSaveCodeFile(org.id, session.id);
  const editor = useRef<CodeEditorHandle>(null);
  const [dirty, setDirty] = useState(false);
  // What the editor started from: the file as first read, then as each save or reload left it.
  const [base, setBase] = useState<{ rev: string; content: string } | null>(null);
  const data = file.data;
  const ok = data?.state === "ok";
  useEffect(() => {
    if (data?.state !== "ok") return;
    if (!base) setBase({ rev: data.rev, content: data.content });
    else if (data.rev !== base.rev && !dirty) {
      editor.current?.reset(data.content);
      setBase({ rev: data.rev, content: data.content });
    }
  }, [data, base, dirty]);
  const moved = ok && base !== null && data.rev !== base.rev && dirty;
  const mark = (now: boolean) => {
    setDirty(now);
    onDirty(now);
  };
  const run = (overwrite: boolean, then?: () => void) => {
    if (!base || save.isPending) return;
    save.mutate(
      {
        path,
        content: editor.current?.text() ?? "",
        rev: overwrite && data?.state === "ok" ? data.rev : base.rev,
        overwrite,
      },
      {
        onSuccess: (saved) => {
          setBase({ rev: saved.rev, content: saved.content });
          editor.current?.reset(saved.content);
          then?.();
        },
        onError: (error) => {
          // Changed on the computer meanwhile: read it, and the bar asks which one stays.
          if (errorCode(error) === "code_session.file_changed") void file.refetch();
          else toast.show(errorText(t, error), "error");
        },
      },
    );
  };
  const reload = () => {
    if (data?.state !== "ok") return;
    editor.current?.reset(data.content);
    setBase({ rev: data.rev, content: data.content });
  };
  const key = `${isApple() ? "⌘" : "Ctrl+"}S`;
  return (
    <div className="code-ftab">
      {file.isPending ? (
        <p className="code-empty">{t("codeSessions.files.opening")}</p>
      ) : file.error && !base ? (
        <p className="code-empty">{errorText(t, file.error)}</p>
      ) : data && data.state !== "ok" && !base ? (
        <p className="code-empty">{t(`codeSessions.files.state.${data.state}`)}</p>
      ) : base ? (
        <>
          {(moved || asking) && (
            <div className="code-ftab__ask" role="alert">
              <span className="code-ftab__askt">
                {moved ? t("codeSessions.files.moved") : t("codeSessions.files.unsavedAsk")}
              </span>
              {moved ? (
                <>
                  <Button size="sm" variant="ghost" onClick={reload}>
                    {t("codeSessions.files.reload")}
                  </Button>
                  <Button size="sm" loading={save.isPending} onClick={() => run(true)}>
                    {t("codeSessions.files.overwrite")}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={onStay}>
                    {t("codeSessions.files.keepEditing")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onClose}>
                    {t("codeSessions.files.discard")}
                  </Button>
                  <Button size="sm" loading={save.isPending} onClick={() => run(false, onClose)}>
                    {t("codeSessions.files.save")}
                  </Button>
                </>
              )}
            </div>
          )}
          <Suspense fallback={<p className="code-empty">{t("codeSessions.files.opening")}</p>}>
            <CodeEditor
              handle={editor}
              path={path}
              initial={base.content}
              readOnly={data?.truncated === true}
              label={path}
              onDirty={mark}
              onSave={() => run(false)}
            />
          </Suspense>
          <footer className="code-ftab__foot">
            <code className="code-ftab__path" title={path}>
              {path}
            </code>
            {ok && <span className="code-ftab__n tabular">{formatBytes(i18n.language, data.size)}</span>}
            <span className="code-ftab__r">
              {data?.truncated ? (
                <span className="code-ftab__note">{t("codeSessions.files.tooLong")}</span>
              ) : (
                <>
                  {dirty && <span className="code-ftab__note">{t("codeSessions.files.unsaved")}</span>}
                  <Button
                    size="sm"
                    disabled={!dirty}
                    loading={save.isPending}
                    title={`${t("codeSessions.files.save")} (${key})`}
                    onClick={() => run(false)}
                  >
                    {t("codeSessions.files.save")}
                  </Button>
                </>
              )}
            </span>
          </footer>
        </>
      ) : null}
    </div>
  );
}
