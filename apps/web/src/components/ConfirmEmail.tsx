import { meQuery } from "@agenteschat/client";
import { webmailOf } from "@agenteschat/client/lib/text";
import { Button, Icon } from "@agenteschat/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { useOrg } from "@/components/org-context";
import { ClosedScreen, SignOutButton } from "@/components/Standing";
import { useSignOut } from "@/hooks/useSignOut";
import { sendNewLink } from "@/lib/email-confirmation";
import { lazyDialog } from "@/lib/lazy-dialog";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";

const EmailDialog = lazyDialog(() => import("./AccountSettings").then((m) => m.EmailDialog));

/** How often the screen asks whether the link was opened, maybe in another tab or on another device. */
const OPENED_POLL_MS = 3000;
/** How long before the screen says where else the email may be (ui-polish: help shows inline after a wait). */
const SPAM_HINT_MS = 30_000;

/** A new link to `email`, said in a toast; its button stays disabled meanwhile. */
function useResend(email: string) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  return useMutation({ mutationFn: () => sendNewLink({ auth, t, show: toast.show }, email) });
}

/**
 * "Check your inbox", in place of the onboarding for an account whose address was never confirmed and that is in no
 * workspace yet (`emailConfirmation` `required`, ADR 0006, addendum 2026-11-22): it makes none until the link is
 * opened. Its mail app, a new link, a new address (the account's own dialog, kept in the address as `?account=email`
 * so a sign-in again comes back to it), and Sair. It moves on by itself once `/me` says the address is confirmed.
 */
export function ConfirmEmailScreen({ email }: { email: string }) {
  const { t } = useTranslation();
  const leave = useSignOut();
  const resend = useResend(email);
  const [account, setAccount] = useOpenParam("account");
  useQuery({ ...meQuery(useApi()), refetchInterval: OPENED_POLL_MS });
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), SPAM_HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const mail = webmailOf(email);
  const busy = resend.isPending || leave.pending;
  return (
    <ClosedScreen
      title={t("auth.confirm.title")}
      lead={t("auth.confirm.lead", { email })}
      foot={<SignOutButton leave={leave} disabled={busy} />}
    >
      <div className="auth__step">
        {mail && (
          <Button asChild variant="primary" size="lg" block>
            <a href={mail.url} target="_blank" rel="noopener noreferrer">
              {t("auth.flow.openMail", { app: mail.name })}
            </a>
          </Button>
        )}
        <Button
          size="lg"
          block
          variant={mail ? "default" : "primary"}
          loading={resend.isPending}
          disabled={busy}
          onClick={() => resend.mutate()}
        >
          {t("auth.sendNewLink")}
        </Button>
        <button type="button" className="auth__quiet" disabled={busy} onClick={() => setAccount("email")}>
          {t("auth.confirm.wrongAddress")}
        </button>
        {late && (
          <p className="auth__fine" role="status">
            {t("auth.flow.sentLead")}
          </p>
        )}
      </div>
      <Suspense fallback={null}>
        {account === "email" && <EmailDialog open onClose={() => setAccount(null)} />}
      </Suspense>
    </ClosedScreen>
  );
}

/**
 * The line on top of the work area for an account in a workspace whose address was never confirmed (`reminder`): the
 * workspace keeps working, and the address the link went to is a click from changing (the shell's own dialog, by
 * `?account=email`).
 */
export function ConfirmEmailBanner() {
  const { t } = useTranslation();
  const { me } = useOrg();
  const resend = useResend(me.user.email);
  const [, setAccount] = useOpenParam("account");
  if (me.user.emailConfirmation !== "reminder") return null;
  return (
    <section className="outages" aria-label={t("auth.confirm.banner")}>
      <div className="outage hold-banner" role="status">
        <Icon name="mail" size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{t("auth.confirm.banner")}</b>
          <span>{t("auth.confirm.bannerSub", { email: me.user.email })}</span>
        </span>
        <span className="outage__acts">
          <Button size="sm" disabled={resend.isPending} onClick={() => setAccount("email")}>
            {t("auth.confirm.change")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={resend.isPending}
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            {t("auth.sendNewLink")}
          </Button>
        </span>
      </div>
    </section>
  );
}
