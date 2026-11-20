import { type InvitationPreview, useApi } from "@agenteschat/client";
import { emailTypoFix, isEmail } from "@agenteschat/client/lib/text";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { firstName } from "@/features/shared/logic";
import { Button, haptics, Locked } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { Quiet } from "./AuthFlow";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, failureText } from "./human-check";
import { inviteStepHref, sendJoinCode } from "./InviteSteps";
import { rememberInvite } from "./invite";
import { endInviteFlow, setInviteFlow, updateLinkInvite, useInviteFlow } from "./invite-flow";
import { CloseIfFirst, DidYouMean, ErrorLine, InviteCrew, InviteTerms } from "./invite-parts";
import { type Asked, askAction, askProgress } from "./invite-steps";

/**
 * Asking through a link, signed out, where email goes out (ADR 0090 §1): three screens. The email here, with who called
 * you as the title; the code from it, alone, on a screen pushed over this one; then you (name, a password and an
 * optional word for whoever approves) under one button, "Ask to join", in the code's place (`InviteSteps.tsx`). No
 * account exists until an admin approves; the ask answers the key that signs in then, and the phone keeps it
 * (`onAsked`): this screen becomes the wait.
 */
export function LinkSteps({
  token,
  preview,
  onAsked,
}: {
  token: string;
  preview: InvitationPreview;
  onAsked: (asked: Asked) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const human = useHumanCheck(askAction("email"));
  const typed = email.trim();
  const key = typed.toLowerCase();
  const org = preview.orgName;
  const by = preview.invitedBy ? firstName(preview.invitedBy) : null;

  // What the steps pushed over this screen share with it, under the invitation's token, while it is open.
  const latest = useRef(onAsked);
  latest.current = onAsked;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per invitation; the address goes over as it's sent on
  useEffect(() => {
    setInviteFlow(token, {
      kind: "link",
      preview,
      email: "",
      proof: null,
      sent: null,
      capped: null,
      emailError: null,
      onAsked: (asked) => latest.current(asked),
    });
    return () => endInviteFlow(token);
  }, [token]);
  const flow = useInviteFlow(token);
  const shared = flow?.kind === "link" ? flow : null;
  const capped = shared?.capped ?? null;
  // A step over this one sent the person back here, with why (the proof ran out: a new code, from the email).
  const shownError = error ?? shared?.emailError ?? null;

  /** The email's Continue: a code to it, unless it's proven already or one went out a moment ago. */
  const toCode = async () => {
    updateLinkInvite(token, { email: typed, emailError: null });
    if (shared?.proof?.email === key) return router.push(inviteStepHref(token, "you"));
    if (shared?.sent?.to === key && Date.now() < shared.sent.resendAt)
      return router.push(inviteStepHref(token, "code"));
    setSending(true);
    setError(null);
    try {
      if (await sendJoinCode(api, token, typed, human.check)) router.push(inviteStepHref(token, "code"));
    } catch (e) {
      if (!(e instanceof CheckCancelled)) {
        haptics.warning();
        setError(failureText(t, e));
      }
    } finally {
      setSending(false);
    }
  };

  const ready = isEmail(email) && capped !== key;
  const submit = () => {
    if (!ready || sending) return;
    void toCode();
  };

  const fix = emailTypoFix(email);
  const { n, total } = askProgress("email");
  const progress = t("mobile.invite.ask.stepOf", { n, total, name: t("mobile.invite.ask.step.email") });

  return (
    <AuthScaffold
      // A personal workspace's words (ADR 0159): never its name ("Personal"), who invited instead.
      title={
        isPersonal(preview)
          ? by
            ? t("invite.calledYouPersonal", { name: by })
            : t("invite.ask.helloPersonal")
          : by
            ? t("mobile.invite.ask.called", { name: by, org })
            : t("mobile.invite.ask.calledNoName", { org })
      }
      subtitle={isPersonal(preview) ? t("invite.ask.leadNoName") : t("mobile.invite.ask.approves", { org })}
      progress={progress}
      // One sky for the three steps, the lower one the "you" step's fields need: a sky that changed height between
      // them jumped from one screen to the next.
      sky="low"
      agentMode={sending ? "run" : "idle"}
      overlay={human.view}
      footer={<InviteTerms />}
      // The team you're asking to join, on the sky, on the first step; the code and "you" keep the app's agent.
      hero={(preview.agents?.length ?? 0) > 0 ? <InviteCrew agents={preview.agents ?? []} /> : undefined}
    >
      <Locked when={sending} keepKeyboard style={{ gap: 8 }}>
        <AuthField
          value={email}
          onChangeText={(value) => {
            setEmail(value);
            setError(null);
            if (shared?.emailError) updateLinkInvite(token, { emailError: null });
          }}
          placeholder={t("auth.flow.emailPlaceholder")}
          accessibilityLabel={t("invite.ask.email")}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          // The keyboard's blue key is the action: "continuar", gray until something is typed.
          returnKeyType="go"
          enablesReturnKeyAutomatically
          onSubmitEditing={submit}
          autoFocus
        />
        {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
      </Locked>
      <ErrorLine error={shownError ?? (capped === key ? t("errors.code.limit") : null)} />
      <Button
        variant="primary"
        wide
        label={t("auth.flow.continue")}
        loading={sending}
        disabled={!ready || sending}
        onPress={submit}
      />
      <Locked when={sending} keepKeyboard>
        <Quiet
          label={t("mobile.invite.ask.haveAccount")}
          onPress={() => {
            rememberInvite(token, "link");
            // The address typed here goes along, so the sign-in starts at the password.
            router.push({ pathname: "/sign-in", params: isEmail(email) ? { email: typed } : {} });
          }}
        />
      </Locked>
      {sending ? null : <CloseIfFirst />}
    </AuthScaffold>
  );
}
