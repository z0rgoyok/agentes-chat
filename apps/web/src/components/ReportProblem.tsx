import { type ProblemReportPlace, useHealth, useProblemReportPreview, useSendProblemReport } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  browserFamily,
  problemReportCopy,
  problemReportError,
  replyAddressOk,
} from "@agenteschat/client/lib/problem-report";
import {
  Button,
  codeAndBold,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Skeleton,
  Textarea,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useTextLimit } from "@/hooks/useTextLimit";
import { copyText } from "@/lib/context-menu";
import "./report-problem.css";

/** As the server takes it (`PROBLEM_NOTE_MAX`). */
const NOTE_MAX = 2000;

export interface ReportProblemProps {
  place: ProblemReportPlace;
  code?: string | null;
  step?: string | null;
  context?: { machineId?: string; agentId?: string; runId?: string };
  timings?: Record<string, number>;
  /** What the screen measured (a card's state, its attempt). */
  facts?: Record<string, string | number | boolean>;
  className?: string;
}

/** Whether "Send a report" shows here: only on a self-hosted server. */
export const useProblemReports = () => useHealth().data?.edition === "selfhost";

/**
 * "Send a report" on a self-hosted server: a quiet text button after the place's own way out. Its dialog shows
 * everything that's sent before the person sends it to the agentes.chat team, or copies it. Nothing on agentes.chat
 * itself, where the team reads it all already.
 */
export function ReportProblem(props: ReportProblemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!useProblemReports()) return null;
  return (
    <>
      <Button variant="link" className={props.className} onClick={() => setOpen(true)}>
        {t("problemReport.button")}
      </Button>
      {open && <ReportProblemDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ReportProblemDialog({
  place,
  code,
  step,
  context,
  timings,
  facts,
  onClose,
}: ReportProblemProps & { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [input] = useState(() => ({
    orgId: org.id,
    place,
    code,
    step,
    context,
    timings,
    facts,
    client: { browser: browserFamily(navigator.userAgent), locale: i18n.language },
  }));
  const preview = useProblemReportPreview(input, true);
  const send = useSendProblemReport();
  const [note, setNote] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [copied, setCopied] = useState<"report" | "code" | null>(null);
  const noteLimit = useTextLimit(NOTE_MAX);
  const data = preview.data;
  const busy = send.isPending;
  const emailBad = !replyAddressOk(replyTo);
  const off = data?.send === "off";
  const copy = (what: "report" | "code", text: string) => void copyText(text, () => setCopied(what));
  const sent = send.data?.id;
  const failure = send.error ? problemReportError(send.error) : null;

  if (sent) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t("problemReport.title")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogBody className="report-problem">
          <p className="report-problem__sent">{t("problemReport.sentTitle", { id: sent })}</p>
          <p className="report-problem__lead">
            {replyTo.trim() ? t("problemReport.sentTextReply", { email: replyTo.trim() }) : t("problemReport.sentText")}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => copy("code", sent)}>
            {copied === "code" ? t("problemReport.copied") : t("problemReport.copyCode")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("problemReport.done")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  const notes = [
    data?.missing.runnerLog === "no_answer" &&
      t("problemReport.noLogComputer", { computer: data.missing.computer ?? "" }),
    data?.missing.runnerLog === "old_app" && t("problemReport.oldRunner", { computer: data.missing.computer ?? "" }),
    data?.missing.serverLines && t("problemReport.noServerLines"),
    off && t("problemReport.off"),
  ].filter((n): n is string => Boolean(n));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t("problemReport.title")}
      description={t("problemReport.lead")}
      closeLabel={t("common.close")}
      width={600}
      unsaved={note.trim() !== "" || replyTo.trim() !== ""}
    >
      <DialogBody className="report-problem">
        {preview.isPending ? (
          <div className="report-problem__loading" aria-busy="true">
            <Skeleton width="70%" />
            <Skeleton width="45%" />
            <span className="ac-visually-hidden">{t("problemReport.loading")}</span>
          </div>
        ) : preview.error ? (
          <p className="report-problem__error" role="alert">
            {t("problemReport.errorPreview", { reason: errorText(t, preview.error) })}{" "}
            <Button variant="link" onClick={() => void preview.refetch()}>
              {t("common.retry")}
            </Button>
          </p>
        ) : (
          notes.length > 0 && (
            <ul className="report-problem__notes">
              {notes.map((n) => (
                <li key={n}>{off && n === t("problemReport.off") ? codeAndBold(n, "off") : n}</li>
              ))}
            </ul>
          )
        )}
        <Field label={t("problemReport.noteLabel")}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("problemReport.notePlaceholder")}
            rows={3}
            limit={noteLimit}
            disabled={busy}
          />
        </Field>
        <Field
          label={t("problemReport.emailLabel")}
          example={emailBad ? undefined : t("problemReport.emailHelp")}
          error={emailBad ? t("problemReport.emailInvalid") : undefined}
        >
          <Input
            type="email"
            autoComplete="off"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            disabled={busy}
          />
        </Field>
        {data && (
          <details className="report-problem__all">
            <summary>
              <Icon name="chevronRight" size={14} />
              {t("problemReport.showAll")}
            </summary>
            <pre className="report-problem__text">{problemReportCopy(data.text, note, replyTo)}</pre>
          </details>
        )}
      </DialogBody>
      <DialogFooter
        note={
          failure ? (
            <span className="report-problem__error" role="alert">
              {t(failure.key as "problemReport.errorUnreachable", failure.params)}
            </span>
          ) : undefined
        }
      >
        <Button onClick={onClose} disabled={busy}>
          {t("problemReport.cancel")}
        </Button>
        <Button
          variant={off ? "primary" : "default"}
          disabled={!data || busy}
          onClick={() => data && copy("report", problemReportCopy(data.text, note, replyTo))}
        >
          {copied === "report" ? t("problemReport.copied") : t("problemReport.copy")}
        </Button>
        {!off && (
          <Button
            variant="primary"
            disabled={!data || busy || emailBad || note.trim().length > NOTE_MAX}
            loading={busy}
            onClick={() =>
              data &&
              send.mutate({
                orgId: org.id,
                report: data.report,
                note: note.trim() || null,
                replyTo: replyTo.trim() || null,
              })
            }
          >
            {busy ? t("problemReport.sending") : t("problemReport.send")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
