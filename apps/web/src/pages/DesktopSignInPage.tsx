import { type SignInProvider, useAuthConfig } from "@agenteschat/client";
import { signInRefusalText } from "@agenteschat/client/lib/errors";
import { Button } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { OpenAppButton, useBackToApp } from "@/components/BackToApp";
import { APP_FRONT_LINK, BROWSER_SIGN_IN_PATH } from "@/lib/desktop";

/**
 * In the browser, for the Mac app's window (ADR 0036): goes to the provider, and
 * when it comes back (`done`), shows the request's code and asks the person to
 * confirm it matches the code on their computer. The hand-over happens only after
 * that explicit confirmation, so a link that jumps straight here signs no one in.
 * A refusal (`error`, the provider's or the server's) comes back here too: why, and
 * back to the app to try again, never the provider once more.
 * `access`: an early-access link's token the app's window had, for the sign-up this makes.
 * `back`: the app takes its link back (`APP_FRONT_LINK`): once done, the page hands the person back to it.
 */
export function DesktopSignInPage({
  provider,
  request,
  done,
  error,
  access,
  back = false,
}: {
  provider?: SignInProvider;
  request?: string;
  done: boolean;
  error?: string;
  access?: string;
  back?: boolean;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  // A refusal points to a password reset only where this server can mail its link.
  const canReset = useAuthConfig().data?.passwordReset === true;
  const [state, setState] = useState<"opening" | "confirm" | "done" | "expired" | "refused">("opening");
  const [code, setCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (error) {
      setState("refused");
      return;
    }
    if (!provider || !request) {
      setState("expired");
      return;
    }
    if (!done) {
      const keep: Record<string, string> = back ? { back: "1" } : {};
      const after = `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, request, done: "1", ...keep })}`;
      const refused = `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, request, ...keep })}`;
      void auth.signInSocial(provider, after, access, refused).then((r) => {
        if (!r.ok) setState("expired");
      });
      return;
    }
    void auth.desktopRequestCode(request).then((c) => {
      if (!c) setState("expired");
      else {
        setCode(c);
        setState("confirm");
      }
    });
  }, [auth, provider, request, done, error, access, back]);
  const toApp = state === "done" && back;
  useBackToApp(toApp ? APP_FRONT_LINK : null);

  const confirm = async () => {
    if (!request || working) return;
    setWorking(true);
    const r = await auth.desktopHandoff(request).catch(() => ({ ok: false }));
    setState(r.ok ? "done" : "expired");
  };

  const name = provider ? t(`auth.provider.${provider}`) : "";
  const [title, lead] =
    state === "done"
      ? [t("auth.desktop.done"), t(toApp ? "auth.desktop.back" : "auth.desktop.doneLead")]
      : state === "confirm"
        ? [t("auth.desktop.confirm"), t("auth.desktop.confirmLead")]
        : state === "expired"
          ? [t("auth.desktop.expired"), t("auth.desktop.expiredLead", { provider: name })]
          : state === "refused" && error
            ? [t("auth.desktop.refused"), `${signInRefusalText(t, error, canReset)} ${t("auth.desktop.refusedLead")}`]
            : [t("auth.desktop.opening", { provider: name }), ""];

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={state === "opening" || working ? "writing" : undefined}
            expression={state === "done" ? "happy" : undefined}
          />
          <div className="auth__bubble" key={state} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            {lead && <p className="auth__lead">{lead}</p>}
          </div>
        </header>
        {state === "confirm" && code && (
          <div className="auth__step">
            <div className="auth__code">
              <span className="auth__codeValue">{code}</span>
            </div>
            <Button type="button" size="lg" block onClick={() => void confirm()} disabled={working}>
              {t("auth.desktop.confirmYes")}
            </Button>
            <button type="button" className="auth__quiet" onClick={() => setState("expired")} disabled={working}>
              {t("auth.desktop.confirmNo")}
            </button>
          </div>
        )}
        {/* Done: back to the app on its own, this the way by hand. Expired or refused: the way back to try again. */}
        {back && (state === "done" || state === "expired" || state === "refused") && (
          <div className="auth__step">
            <OpenAppButton link={APP_FRONT_LINK} />
          </div>
        )}
      </div>
    </AuthShell>
  );
}
