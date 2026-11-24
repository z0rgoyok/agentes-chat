import { Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { type CSSProperties, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeHomeSky } from "./CodeSky";

const SEEN_KEY = "code:betaSeen";
const ADDED = ["worktree", "anyAi", "beside"] as const;
const REMOVED = ["paste", "watch"] as const;

function seen() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // No storage to remember it in: never in the way twice in one visit, and not at all without it.
    return true;
  }
}

/**
 * The Code page's beta notice (ADR 0215), once per browser, the first time a person opens the page: the title's block
 * drops on the sky, and what the mode is reads as a diff, the lines it adds and the ones it takes away. Every way out
 * goes on: there is nothing to refuse.
 */
export function CodeBetaDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => !seen());
  const go = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  const close = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {}
    setOpen(false);
  };
  const step = (n: number) => ({ "--step": n }) as CSSProperties;
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && close()}
      title={t("codeSessions.beta.title")}
      closeLabel={t("common.close")}
      width={480}
      bare
      initialFocus={go}
      className="code-beta"
    >
      <div className="code-beta__hero">
        <div className="code-stage" aria-hidden="true">
          <CodeHomeSky />
        </div>
        <span className="code-title">
          <span className="code-block code-block--add">
            <span className="code-block__sig" aria-hidden="true">
              +
            </span>
            <span className="code-mid__t code-mid__t--brand">{t("codeSessions.home.mode")}</span>
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="code-beta__close"
          aria-label={t("common.close")}
          onClick={close}
        />
      </div>
      {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
      <div className="code-beta__lede">
        <p className="code-beta__title" style={step(0)} aria-hidden="true">
          {t("codeSessions.beta.title")}
        </p>
        <p className="code-beta__text" style={step(1)}>
          {t("codeSessions.beta.text")}
        </p>
      </div>
      <DialogBody>
        <ul className="code-beta__diff">
          {ADDED.map((key, n) => (
            <li key={key} data-kind="add" style={step(2 + n)}>
              <span aria-hidden="true">+</span>
              {t(`codeSessions.beta.added.${key}`)}
            </li>
          ))}
          {REMOVED.map((key, n) => (
            <li key={key} data-kind="del" style={step(2 + ADDED.length + n)}>
              <span aria-hidden="true">−</span>
              {t(`codeSessions.beta.removed.${key}`)}
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter
        note={
          <span className="code-beta__count tabular" aria-hidden="true">
            <b data-kind="add">+{ADDED.length}</b> <b data-kind="del">−{REMOVED.length}</b>
          </span>
        }
      >
        <Button ref={go} variant="primary" kbd={["↵"]} onClick={close}>
          {t("codeSessions.beta.go")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
