import { ApiError, type AskToJoinResult, keys, useApi, useAuthConfig } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { errorCode, invitedErrorText } from "@agenteschat/client/lib/errors";
import { INVITATION_MAIL_HEADER, INVITATION_TOKEN_HEADER } from "@agenteschat/client/lib/guards";
import { humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { CODE_LENGTH, JOIN_NAME_MAX, JOIN_NOTE_MAX, typedCode } from "@agenteschat/client/lib/join-requests";
import { nameIsPassword, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Linking, type TextInput, View } from "react-native";
import { useNow } from "@/features/shared/hooks";
import { firstName } from "@/features/shared/logic";
import { authClient } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { writeValue } from "@/lib/storage";
import { useSession } from "@/providers/session";
import { Button, haptics, LineIcon, Locked, Text } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { rememberSignIn } from "@/ui/auth/SocialButtons";
import { goBack, router } from "@/ui/navigation";
import { useTheme } from "@/ui/theme";
import { LAST_EMAIL, NameHint, Quiet } from "./AuthFlow";
import { rememberConfirmationSent } from "./confirmation";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, failureText, refusalOf, refusalText, signUpClosed } from "./human-check";
import { forgetInvite, rememberInvite } from "./invite";
import { updateEmailInvite, updateLinkInvite, useInviteStepFlow } from "./invite-flow";
import { ErrorLine, InviteTerms, LeaveButton, LockedEmail } from "./invite-parts";
import { type AskStep, askAction, askProgress } from "./invite-steps";

/*
 * An invitation's steps after its first screen (`EmailSteps`, `LinkSteps`), each pushed over the one before
 * (`app/invite/[token]/*`): the system's back goes one step back. What they share comes from the first screen
 * (`invite-flow.ts`), which also does what ends them there: joining once signed in, or waiting for the answer.
 */

/** A step's address: the invitation's token, and its step. */
export const inviteStepHref = (token: string, step: "new-password" | "forgot" | "code" | "you") =>
  ({ pathname: `/invite/[token]/${step}`, params: { token } }) as never;

/** The token in a step's address. */
function useToken() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return typeof token === "string" ? token : "";
}

/** Opened without its invitation's first screen under it (its address on its own): that screen is the way in. */
function useOpenedFromInvite(token: string, opened: boolean) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once, as the step opens
  useEffect(() => {
    if (!opened) goBack(`/invite/${token}` as never);
  }, []);
}

/** One press at a time; the screen stays until the request ends. A bot check closed with Cancel says nothing. */
function useRun(setError: (error: string | null) => void) {
  const { t } = useTranslation();
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (e instanceof CheckCancelled) return;
      const network = e instanceof TypeError && /network|fetch/i.test(e.message);
      setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return { run, pending };
}

/** The agent's face over a password: eyes shut while it's hidden, a wink when it's shown. */
function useFace() {
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  return {
    face: wink ? ("wink" as const) : secret ? ("closed" as const) : undefined,
    setSecret,
    wink: () => {
      setWink(true);
      setTimeout(() => setWink(false), 900);
    },
  };
}

/**
 * An email invitation's new address, after its name: the password, then the account. A new address made here with
 * the token and its email's proof gets no "confirm your email", and accepting confirms it (ADR 0090 §6); opened from a
 * copied link there's no proof, and the message goes as for anyone. Signed in, it goes back to the first screen, which
 * joins. A password typed as the name goes back to the name, which says so.
 */
export function InviteNewPassword() {
  const { t } = useTranslation();
  const token = useToken();
  const session = useSession();
  const canReset = useAuthConfig().data?.passwordReset === true;
  const { flow, opened } = useInviteStepFlow(token, "email");
  useOpenedFromInvite(token, opened);
  const human = useHumanCheck("sign-up");
  const { face, setSecret, wink } = useFace();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useRun(setError);
  if (!flow) return null;
  const { preview, mail, name } = flow;
  const invited = preview.email;
  const org = preview.orgName;
  const first = firstName(name);

  const signUp = () =>
    run(async () => {
      // The invitation's screen stays up while the session arrives, and accepts by itself: a remembered copy of the
      // invitation would race it for the same acceptance in the root layout.
      forgetInvite();
      flow.onSigningIn();
      const proved = mail ? { [INVITATION_TOKEN_HEADER]: token, [INVITATION_MAIL_HEADER]: mail } : {};
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().signUp.email({
            name: name.trim(),
            email: invited,
            password,
            fetchOptions: { headers: { ...humanCheckHeaders(check), ...proved } },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        // Checked by code: the bot check refuses with a 403 too, and that isn't sign-up being closed.
        setError(
          signUpClosed(refused)
            ? t("auth.flow.closedLead")
            : refused.status
              ? refusalText(t, refused)
              : t("mobile.auth.errors.network"),
        );
        return;
      }
      haptics.success();
      // A server that sends email sent this address a link to confirm it: the first run says where it went.
      if (canReset && !mail) rememberConfirmationSent(invited);
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, invited);
      await session.refresh().catch(() => {});
      // The first screen joins once it is on top again: joining from here would leave it under the workspace.
      updateEmailInvite(token, { joinOnSession: true });
      router.back();
    });

  const ready = passwordState(password) === "ok";
  const submit = () => {
    if (!ready || pending) return;
    if (nameIsPassword(name, password)) {
      // The name step got the password: no account with a password for a name. Back on the name, which says so.
      setPassword("");
      updateEmailInvite(token, { nameError: t("auth.flow.nameIsPassword") });
      router.back();
    } else void signUp();
  };

  return (
    <AuthScaffold
      title={first ? t("auth.flow.newPasswordNamed", { name: first }) : t("auth.flow.newPassword")}
      subtitle={t(modeKey(preview, "invite.newPasswordLead"), { org })}
      agentMode={pending ? "run" : "idle"}
      expression={face}
      overlay={human.view}
      footer={<InviteTerms />}
    >
      <LockedEmail email={invited} />
      <Locked when={pending} keepKeyboard>
        <PasswordField
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setError(null);
          }}
          fresh
          onSecretChange={setSecret}
          onShow={wink}
          onSubmitEditing={submit}
          label={t("invite.createPassword")}
        />
      </Locked>
      <ErrorLine error={error} />
      <Button
        variant="primary"
        wide
        label={t(modeKey(preview, "invite.enter"), { org })}
        loading={pending}
        disabled={!ready || pending}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

/**
 * An email invitation's "Forgot password": the app's reset, the address locked. The reset's link lands on the
 * sign-in: the invitation waits there, and is accepted once the person is in. Once it went, the screen says so in its
 * place (the request's result, not another step): the mail app, and back to the invitation's first screen.
 */
export function InviteForgot() {
  const { t } = useTranslation();
  const token = useToken();
  const { flow, opened } = useInviteStepFlow(token, "email");
  useOpenedFromInvite(token, opened);
  const human = useHumanCheck("password-reset");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { run, pending } = useRun(setError);
  if (!flow) return null;
  const invited = flow.preview.email;
  const mailApp = webmailOf(invited);

  const sendReset = () =>
    run(async () => {
      rememberInvite(token, "email", flow.mail);
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().requestPasswordReset({
            email: invited,
            redirectTo: "/reset-password",
            fetchOptions: { headers: humanCheckHeaders(check) },
          }),
        ),
      );
      if (refused) return setError(refused.status ? refusalText(t, refused) : t("mobile.auth.errors.network"));
      haptics.success();
      setSent(true);
    });

  if (sent)
    return (
      <AuthScaffold
        title={t("auth.flow.sent", { email: invited })}
        subtitle={t("auth.flow.sentLead")}
        expression="happy"
      >
        {mailApp ? (
          <Button
            variant="primary"
            wide
            icon="mail"
            label={t("auth.flow.openMail", { app: mailApp.name })}
            onPress={() => void Linking.openURL(mailApp.url)}
          />
        ) : null}
        <Button variant="secondary" wide label={t("auth.flow.backToSignIn")} onPress={() => router.back()} />
      </AuthScaffold>
    );

  return (
    <AuthScaffold
      title={t("auth.flow.forgot")}
      subtitle={t("auth.flow.forgotLead")}
      agentMode={pending ? "run" : "idle"}
      overlay={human.view}
    >
      <LockedEmail email={invited} />
      <ErrorLine error={error} />
      <Button
        variant="primary"
        wide
        label={t("auth.flow.sendLink")}
        loading={pending}
        onPress={() => void sendReset()}
      />
    </AuthScaffold>
  );
}

/** "1 de 3 · Seu e-mail": where an ask's step stands. */
function useAskProgress(step: AskStep) {
  const { t } = useTranslation();
  const { n, total } = askProgress(step);
  return t("mobile.invite.ask.stepOf", { n, total, name: t(`mobile.invite.ask.step.${step}`) });
}

/**
 * The code a link's ask sent to the address, alone: it goes by itself once its six digits are in. Proven, "you" takes
 * this screen's place, so back from it is the e-mail (a proven address doesn't type its code again).
 */
export function InviteCode() {
  const { t } = useTranslation();
  const api = useApi();
  const token = useToken();
  const { flow, opened } = useInviteStepFlow(token, "link");
  useOpenedFromInvite(token, opened);
  const human = useHumanCheck(askAction("code"));
  const progress = useAskProgress("code");
  const codeField = useRef<ComponentRef<typeof TextInput>>(null);
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  if (!flow) return null;
  const typed = flow.email.trim();
  const key = typed.toLowerCase();
  const resendAt = flow.sent?.to === key ? flow.sent.resendAt : 0;
  const mail = webmailOf(typed);

  const resend = async () => {
    setSending(true);
    setError(null);
    try {
      if (await sendJoinCode(api, token, typed, human.check)) {
        setCode("");
        codeField.current?.focus();
      }
    } catch (e) {
      if (!(e instanceof CheckCancelled)) {
        haptics.warning();
        setError(failureText(t, e));
      }
    } finally {
      setSending(false);
    }
  };

  const checkCode = async (value: string) => {
    setChecking(true);
    try {
      await api.invites.checkCode(token, { email: typed, code: value });
      haptics.success();
      AccessibilityInfo.announceForAccessibility(t("invite.ask.verified"));
      updateLinkInvite(token, { proof: { email: key, code: value } });
      router.replace(inviteStepHref(token, "you"));
    } catch (e) {
      haptics.warning();
      setCode("");
      setWrong(true);
      setError(failureText(t, e));
      codeField.current?.focus();
    } finally {
      setChecking(false);
    }
  };
  const typedIn = (value: string) => {
    if (checking) return;
    const digits = typedCode(value);
    setCode(digits);
    setError(null);
    setWrong(false);
    if (digits.length === CODE_LENGTH) void checkCode(digits);
  };

  return (
    <AuthScaffold
      title={t("invite.ask.codeTitle", { email: typed })}
      subtitle={t("invite.ask.codeLead")}
      progress={progress}
      // One sky for the three steps, the lower one the "you" step's fields need.
      sky="low"
      agentMode={sending || checking ? "run" : "idle"}
      expression={wrong ? "cross" : undefined}
      overlay={human.view}
    >
      <Locked when={checking} keepKeyboard>
        <AuthField
          ref={codeField}
          code
          value={code}
          onChangeText={typedIn}
          placeholder={t("invite.ask.code")}
          accessibilityLabel={t("invite.ask.code")}
          accessibilityState={{ busy: checking }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          returnKeyType="done"
          onSubmitEditing={() => {
            if (code.length === CODE_LENGTH && !checking) void checkCode(code);
          }}
          autoFocus
        />
      </Locked>
      <ErrorLine error={error} />
      {mail ? (
        <Button
          variant="secondary"
          wide
          label={t("auth.flow.openMail", { app: mail.name })}
          onPress={() => void Linking.openURL(mail.url)}
        />
      ) : null}
      <ResendLine resendAt={resendAt} hidden={flow.capped === key || sending} onResend={() => void resend()} />
    </AuthScaffold>
  );
}

/**
 * A code to the address of a link's ask: true once one is out, or one from a moment ago still stands. What went (and
 * an address past its cap) goes to the screens' shared flow. Throws what the e-mail's or the code's screen says.
 */
export async function sendJoinCode(
  api: ReturnType<typeof useApi>,
  token: string,
  typed: string,
  check: Parameters<typeof withHumanCheck>[0],
): Promise<boolean> {
  const to = typed.toLowerCase();
  try {
    const result = await withHumanCheck(check, (humanCheck) =>
      api.invites.sendCode(token, { email: typed }, humanCheck),
    );
    updateLinkInvite(token, { sent: { to, resendAt: Date.now() + result.resendIn * 1000 } });
    return true;
  } catch (e) {
    if (e instanceof CheckCancelled) return false;
    // A code went out a moment ago (another try, another device): that one is still good.
    const retryIn = e instanceof ApiError && e.code === "join.code_wait" ? Number(e.params?.retryIn) : 0;
    if (retryIn > 0) {
      updateLinkInvite(token, { sent: { to, resendAt: Date.now() + retryIn * 1000 } });
      return true;
    }
    if (errorCode(e) === "join.code_limit") updateLinkInvite(token, { capped: to });
    throw e;
  }
}

/**
 * The person, under one button: name, a password and an optional word for whoever approves. No account exists until
 * an admin approves; the ask answers the key that signs in then, and the invitation's first screen becomes the wait.
 * An answer with no key (an ask the server keeps no password for) says only where the answer goes, here.
 */
export function InviteYou() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const token = useToken();
  const { flow, opened } = useInviteStepFlow(token, "link");
  useOpenedFromInvite(token, opened);
  const progress = useAskProgress("you");
  const { face, setSecret, wink } = useFace();
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const noteField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Asked, and the server answered no key to wait with.
  const [answered, setAnswered] = useState<AskToJoinResult | null>(null);
  if (!flow) return null;
  const typed = flow.email.trim();
  const key = typed.toLowerCase();
  const org = flow.preview.orgName;

  /** Back to the e-mail with what to do there: a new code, from the email. */
  const backToEmail = (text: string) => {
    updateLinkInvite(token, { proof: null, sent: null, emailError: text });
    router.back();
  };

  /** The ask, with the word for whoever approves or without. */
  const ask = async () => {
    // No proof for this address: its e-mail's screen, under this one, sends a code.
    const proof = flow.proof?.email === key ? flow.proof : null;
    if (!proof) return router.back();
    if (asking) return;
    const words = note.trim();
    setAsking(true);
    setError(null);
    try {
      const result = await api.invites.ask(token, {
        name: name.trim(),
        email: typed,
        ...(words ? { note: words } : {}),
        code: proof.code,
        password,
      });
      haptics.success();
      if (result.key) {
        // The first screen becomes the wait, right under this one.
        router.back();
        flow.onAsked({
          token,
          key: result.key,
          name: name.trim(),
          email: result.email || key,
          org,
          server: serverUrl(),
        });
      } else {
        setAsking(false);
        setAnswered(result);
      }
    } catch (e) {
      setAsking(false);
      haptics.warning();
      const text = (e instanceof ApiError ? invitedErrorText(t, e) : null) ?? failureText(t, e);
      // A link turned off meanwhile then shows as its own state.
      void qc.invalidateQueries({ queryKey: keys.invitation(token) });
      // The proof ran out (30 minutes) or was used: a new code, from the email.
      if (errorCode(e)?.startsWith("join.code_")) backToEmail(text);
      else setError(text);
    }
  };

  const ready = name.trim() !== "" && passwordState(password) === "ok";
  const submit = () => {
    if (!ready || asking) return;
    if (nameIsPassword(name, password)) {
      setPassword("");
      setError(t("auth.flow.nameIsPassword"));
    } else void ask();
  };

  if (answered)
    return (
      <AuthScaffold
        title={t("invite.ask.sentTitle")}
        subtitle={
          answered.emailed ? t("invite.ask.sentEmail", { org, email: answered.email }) : t("invite.ask.sentNoEmail")
        }
        sky="low"
        expression="happy"
      >
        <LeaveButton />
      </AuthScaffold>
    );

  return (
    <AuthScaffold
      title={t("mobile.invite.ask.youTitle")}
      progress={progress}
      sky="low"
      toolbar
      agentMode={asking ? "run" : "idle"}
      expression={face ?? "happy"}
      footer={<InviteTerms />}
    >
      {/* The e-mail is settled: one quiet line with a check, where a subtitle would be. */}
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: -16 }}
        accessibilityLabel={`${t("invite.ask.verified")}: ${typed}`}
      >
        <LineIcon name="check" size={16} color={colors.ok} variant="subhead" />
        <Text variant="subhead" tone="ok" style={{ fontWeight: "600" }}>
          {t("mobile.invite.ask.emailConfirmed")}
        </Text>
      </View>
      <Locked when={asking} keepKeyboard style={{ gap: 8 }}>
        <AuthField
          value={name}
          onChangeText={setName}
          placeholder={t("auth.flow.namePlaceholder")}
          accessibilityLabel={t("invite.ask.name")}
          maxLength={JOIN_NAME_MAX}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          // Return moves to the next field; the keyboard stays and the screen doesn't move.
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordField.current?.focus()}
          autoFocus
        />
        <NameHint name={name} />
        <PasswordField
          ref={passwordField}
          value={password}
          onChangeText={setPassword}
          fresh
          autoFocus={false}
          keepFocus
          onSecretChange={setSecret}
          onShow={wink}
          onSubmitEditing={() => noteField.current?.focus()}
          label={t("invite.createPassword")}
        />
        <AuthField
          ref={noteField}
          value={note}
          onChangeText={setNote}
          placeholder={t("mobile.invite.ask.notePlaceholder")}
          accessibilityLabel={t("invite.ask.noteField")}
          maxLength={JOIN_NOTE_MAX}
          returnKeyType="send"
          onSubmitEditing={submit}
        />
      </Locked>
      <ErrorLine error={error} />
      <Button
        variant="primary"
        wide
        label={t("invite.ask.send")}
        loading={asking}
        disabled={!ready || asking}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

/**
 * Under the code: how long until another may go, then "Resend code" (unless `hidden`). Its own clock, so only this
 * line repaints each second while it counts down, never the step's field.
 */
function ResendLine({ resendAt, hidden, onResend }: { resendAt: number; hidden: boolean; onResend: () => void }) {
  const { t } = useTranslation();
  const left = Math.max(0, resendAt - Date.now());
  // A repaint every second while it counts down; the time itself is read just above.
  useNow(left > 0 ? 1000 : 60_000);
  if (left > 0)
    return (
      <Text
        variant="subhead"
        tone="muted"
        accessibilityLabel={t("invite.ask.resendIn", { count: Math.ceil(left / 1000) })}
        style={[CENTER, { fontVariant: ["tabular-nums"] }]}
      >
        {formatTimeLeft(left)}
      </Text>
    );
  return hidden ? null : <Quiet label={t("invite.ask.resendCode")} onPress={onResend} />;
}
