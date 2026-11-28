import { ApiError, usePinFromEmail, useUndoSurfaceLink } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { pinChosen, pinMismatch } from "@agenteschat/client/lib/surface-links";
import { formatPhone } from "@agenteschat/i18n/format";
import { Button, Icon, Locked } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { PinFields } from "@/components/PinFields";

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

/**
 * The undo in the email that says a chat app was linked (ADR 0187 §2): only its button unlinks (mail scanners open
 * every link). It works signed out, so the app's name comes with the answer. A link already ended says so.
 */
export function SurfaceUndoPage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const undo = useUndoSurfaceLink();
  const done = undo.data;
  const gone = !token || errorCode(undo.error) === "surface.undo_gone";
  const display = done?.display ? formatPhone(done.display) : t("surface.undo.sender");
  const [title, lead]: [string, string] = done
    ? done.unlinked
      ? [t("surface.undo.done", { surface: done.surface }), t("surface.undo.doneLead", { display })]
      : [t("surface.undo.ended"), t("surface.undo.endedLead", { display, surface: done.surface })]
    : gone
      ? [t("surface.undo.gone"), t("errors.surface.undoGone")]
      : [t("surface.undo.title"), t("surface.undo.lead")];
  const ended = Boolean(done) || gone;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ended && !undo.isPending && token) undo.mutate(token);
  };

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={undo.isPending ? "writing" : undefined}
            expression={done ? "happy" : undefined}
          />
          <div className="auth__bubble" key={title} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
        <div className="auth__step">
          {ended ? (
            <Button asChild variant="primary" size="lg" block>
              <Link to="/login">{t("auth.signIn")}</Link>
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
                {t("surface.undo.button")}
              </Button>
            </Locked>
          )}
        </div>
      </form>
    </AuthShell>
  );
}

/**
 * The link in the "Choose your PIN" email (ADR 0226): the email to the verified address is what lets the PIN be chosen
 * here, typed twice. Only the button spends the link (mail scanners open every link), and a PIN of the wrong shape
 * spends nothing.
 */
export function SurfacePinResetPage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const choose = usePinFromEmail();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const done = choose.data;
  const gone = !token || errorCode(choose.error) === "surface.pin_reset_gone";
  const mismatch = pinMismatch(pin, again);
  const [title, lead]: [string, string] = done
    ? [t("surface.pinReset.done"), t("surface.pinReset.doneLead", { surface: done.surface })]
    : gone
      ? [t("surface.pinReset.gone"), t("errors.surface.pinResetGone")]
      : [t("surface.pinReset.title"), t("surface.pinReset.lead")];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!done && !gone && !choose.isPending && token && pinChosen(pin, again)) choose.mutate({ token, pin });
  };
  const error = mismatch ? t("surface.page.mismatch") : choose.isError ? errorText(t, choose.error) : null;

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={submit} noValidate>
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={choose.isPending ? "writing" : undefined}
            expression={done ? "happy" : undefined}
          />
          <div className="auth__bubble" key={title} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
        {!done && !gone && (
          <div className="auth__step">
            <Locked when={choose.isPending}>
              <PinFields big choosing autoFocus pin={pin} again={again} onPin={setPin} onAgain={setAgain} />
              {error && (
                <p className="auth__error ac-iconline" role="alert">
                  <Icon name="alert" size={14} />
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                kbd={["↵"]}
                loading={choose.isPending}
                disabled={!pinChosen(pin, again)}
              >
                {t("surface.pinReset.button")}
              </Button>
            </Locked>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
