import { ApiError } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { Button, Icon, Locked } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";

/**
 * “This wasn't me” (ADR 0088 §2, addendum 2026-11-13): where the notice to an account's old address lands, in the
 * sign-in screen's calm style. Only its button acts (mail scanners open every link): the address comes back and every
 * session ends, this browser's too, so the way on is to sign in. No token: the link is broken, as a used one.
 */
export function EmailUndoPage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: () => api.account.undoEmailChange(token ?? ""),
    meta: { silent: true },
    // Signed out everywhere: nothing cached from a session may answer for the sign-in that follows.
    onSuccess: () => qc.clear(),
  });
  const why = errorCode(undo.error);
  const back = undo.data?.email;
  const gone = !token || why === "email.undo_gone";
  const taken = why === "email.undo_taken" && undo.error instanceof ApiError ? String(undo.error.params?.email) : null;
  const [title, lead]: [string, string] = back
    ? [t("emailUndo.done"), t("emailUndo.doneLead", { email: back })]
    : gone
      ? [t("emailUndo.gone"), t("emailUndo.goneLead")]
      : taken
        ? [t("emailUndo.taken"), t("emailUndo.takenLead", { email: taken })]
        : [t("emailUndo.title"), t("emailUndo.lead")];
  const ended = Boolean(back) || gone || taken !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ended && !undo.isPending) undo.mutate();
  };

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={undo.isPending ? "writing" : undefined}
            expression={back ? "happy" : undefined}
          />
          <div className="auth__bubble" key={title} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
        <div className="auth__step">
          {ended ? (
            <Button asChild variant="primary" size="lg" block>
              <Link to="/login" search={back ? { email: back } : {}}>
                {t("auth.signIn")}
              </Link>
            </Button>
          ) : (
            <Locked when={undo.isPending}>
              {undo.isError && (
                <p className="auth__error ac-iconline" role="alert">
                  <Icon name="alert" size={14} />
                  {errorText(t, undo.error)}
                </p>
              )}
              <Button type="submit" variant="primary" size="lg" block kbd={["↵"]} loading={undo.isPending}>
                {t("emailUndo.button")}
              </Button>
            </Locked>
          )}
        </div>
      </form>
    </AuthShell>
  );
}
