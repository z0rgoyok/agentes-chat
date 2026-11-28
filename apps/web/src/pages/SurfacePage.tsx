import {
  type SurfacePage as Page,
  useDecideSurfacePage,
  useEmailSurfacePin,
  useSurfacePage,
} from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { PIN_SHAPE, pinChosen, pinMismatch } from "@agenteschat/client/lib/surface-links";
import { Button, Icon, Locked } from "@agenteschat/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { PinFields } from "@/components/PinFields";

/**
 * A page the outside chat surface linked to (ADR 0226): one action the person confirms with their PIN, in the sign-in
 * screen's calm style. Opened by posting its token (a chat app's preview only loads the page), it stays this
 * browser's for an hour. With no PIN yet, the link alone can't choose one: signed in here, the approval chooses it
 * (typed twice); otherwise the page says to set it first, in the app or by an emailed link, and reads itself again
 * when the person comes back.
 */
export function SurfacePage({ token }: { token?: string }) {
  const { t } = useTranslation();
  const page = useSurfacePage(token);
  const view = page.data;
  const shown = view?.approval ?? null;
  const ended = !token || page.isError || (view && (!shown || view.kind !== "confirm"));

  if (!view && !ended) {
    return (
      <AuthShell>
        <div className="auth__form">
          <header className="auth__ask">
            <AgentAvatar name="agentes.chat" size="lg" state="writing" />
            <div className="auth__bubble" aria-live="polite">
              <h1 className="auth__title">{t("surface.page.opening")}</h1>
            </div>
          </header>
        </div>
      </AuthShell>
    );
  }
  if (!view || !shown || ended) {
    const lead = page.isError ? errorText(t, page.error) : t("errors.surface.pageGone");
    return <Said title={t("surface.page.gone")} lead={lead} />;
  }
  const title = approvalTitle(t, { tool: shown.tool, title: shown.title, params: shown.params, email: null });
  if (shown.status !== "pending") {
    const decided =
      shown.status === "approved"
        ? t("surface.page.approved")
        : shown.status === "refused"
          ? t("surface.page.refused")
          : t("surface.page.expired");
    return (
      <Said
        title={decided}
        lead={t("surface.page.back", { surface: view.surface })}
        happy={shown.status === "approved"}
      />
    );
  }
  if (!shown.canDecide) {
    const lead = shown.approverLabel
      ? t("surface.page.notYours", { who: shown.approverLabel })
      : t("surface.page.notYoursSomeone");
    return <Said title={title} lead={lead} />;
  }
  if (!view.pin.set && !view.pin.canChoose) return <SetFirst token={token ?? ""} view={view} />;
  return <Confirm token={token ?? ""} view={view} title={title} onUnset={() => void page.refetch()} />;
}

/** No PIN yet and nobody signed in here: the app, or an emailed link, chooses it. Refusing still needs none. */
function SetFirst({ token, view }: { token: string; view: Page }) {
  const { t } = useTranslation();
  const decide = useDecideSurfacePage(token);
  const email = useEmailSurfacePin(token);
  const busy = decide.isPending || email.isPending;
  const failed = decide.isError ? decide.error : email.isError ? email.error : null;
  const lead = view.pin.resetByEmail ? "surface.page.setFirstLeadEmail" : "surface.page.setFirstLead";
  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state={busy ? "writing" : undefined} />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{t("surface.page.setFirst")}</h1>
            <p className="auth__lead">{t(lead, { surface: view.surface })}</p>
          </div>
        </header>
        <div className="auth__step">
          <Locked when={busy}>
            {failed !== null && (
              <p className="auth__error ac-iconline" role="alert">
                <Icon name="alert" size={14} />
                {errorText(t, failed)}
              </p>
            )}
            {email.isSuccess && (
              <p className="auth__lead" role="status">
                {t("surface.page.emailed")}
              </p>
            )}
            <Button asChild variant="primary" size="lg" block>
              <a href={`/org/${view.orgId}/settings/notifications?pin=1`} target="_blank" rel="noreferrer">
                {t("surface.page.openApp")}
              </a>
            </Button>
            {view.pin.resetByEmail && !email.isSuccess && (
              <Button type="button" size="lg" block loading={email.isPending} onClick={() => email.mutate()}>
                {t("surface.page.emailMe")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="lg"
              block
              loading={decide.isPending}
              onClick={() => decide.mutate({ decision: "refuse" })}
            >
              {t("surface.page.refuse")}
            </Button>
          </Locked>
        </div>
      </div>
    </AuthShell>
  );
}

function Said({ title, lead, happy }: { title: string; lead: string; happy?: boolean }) {
  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" expression={happy ? "happy" : undefined} />
          <div className="auth__bubble" key={title} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">{lead}</p>
          </div>
        </header>
      </div>
    </AuthShell>
  );
}

/** The PIN, or (signed in here, none set yet) choosing it, typed twice; then Approve. */
function Confirm({ token, view, title, onUnset }: { token: string; view: Page; title: string; onUnset: () => void }) {
  const { t } = useTranslation();
  const decide = useDecideSurfacePage(token);
  const forgot = useEmailSurfacePin(token);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [focus, setFocus] = useState(false);
  const choosing = !view.pin.set;
  const mismatch = choosing && pinMismatch(pin, again);
  const locked = view.pin.lockedUntil !== null || errorCode(decide.error) === "surface.pin_locked";
  const ready = (choosing ? pinChosen(pin, again) : PIN_SHAPE.test(pin)) && !locked;
  const busy = decide.isPending || forgot.isPending;
  const approve = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !busy)
      decide.mutate(
        { decision: "approve", pin },
        {
          onError: (e) => {
            setPin("");
            // Signed out meanwhile: the page asks for the PIN to be set first.
            if (errorCode(e) === "surface.pin_unset") onUnset();
          },
        },
      );
  };
  const error = mismatch
    ? t("surface.page.mismatch")
    : locked
      ? t("errors.surface.pinLocked")
      : decide.isError
        ? errorText(t, decide.error)
        : forgot.isError
          ? errorText(t, forgot.error)
          : null;

  return (
    <AuthShell>
      <form className="auth__form" onSubmit={approve} noValidate>
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={busy ? "writing" : undefined}
            expression={focus ? "closed" : undefined}
          />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            <p className="auth__lead">
              {choosing ? t("surface.page.leadFirst", { surface: view.surface }) : t("surface.page.lead")}
            </p>
            {view.approval?.why && <p className="auth__lead">{view.approval.why}</p>}
          </div>
        </header>
        <div className="auth__step">
          <Locked when={busy}>
            <PinFields
              big
              pin={pin}
              again={again}
              onPin={setPin}
              onAgain={setAgain}
              choosing={choosing}
              disabled={locked}
              autoFocus
              onFocus={() => setFocus(true)}
              onBlur={() => setFocus(false)}
            />
            {error && (
              <p className="auth__error ac-iconline" role="alert">
                <Icon name="alert" size={14} />
                {error}
              </p>
            )}
            {forgot.isSuccess && (
              <p className="auth__lead" role="status">
                {t("surface.page.emailed")}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              kbd={["↵"]}
              loading={decide.isPending}
              disabled={!ready}
            >
              {t("surface.page.approve")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="lg"
              block
              onClick={() => decide.mutate({ decision: "refuse" })}
            >
              {t("surface.page.refuse")}
            </Button>
            {!choosing && view.pin.resetByEmail && !forgot.isSuccess && (
              <Button type="button" variant="ghost" size="sm" onClick={() => forgot.mutate()}>
                {t("surface.page.forgot")}
              </Button>
            )}
          </Locked>
        </div>
      </form>
    </AuthShell>
  );
}
