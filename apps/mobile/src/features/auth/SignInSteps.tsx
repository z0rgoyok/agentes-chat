import { useAuthConfig } from "@agenteschat/client";
import { type HumanAction, humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { emailTypoFix, isEmail, nameIsPassword, passwordState, webmailOf } from "@agenteschat/client/lib/text";
import { useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, type TextInput, View } from "react-native";
import { authClient } from "@/lib/auth";
import { writeValue } from "@/lib/storage";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { Shake } from "@/ui/auth/Shake";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { haptics } from "@/ui/haptics";
import { Locked } from "@/ui/Locked";
import { goBack, router } from "@/ui/navigation";
import { LAST_EMAIL, NameHint, Quiet, useSignInPurpose } from "./AuthFlow";
import { rememberConfirmationSent } from "./confirmation";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, earlyAccessRequests, refusalOf, refusalText, signUpClosed } from "./human-check";
import { DidYouMean, ErrorLine, InviteTerms } from "./invite-parts";
import { type SignInStep, signInStepHref, stepDepth, useSignInStepFlow } from "./sign-in-flow";

/*
 * The steps after the sign-in's e-mail (`AuthFlow`), each a screen of its own pushed over the one before
 * (`app/(auth)/(pages)/sign-in/*`): the system's back goes one step back, and "Use another email" straight down to the
 * e-mail. What the e-mail found out comes from the flow it pushed them with (`sign-in-flow.ts`).
 */

/** What every step shares: its flow, how it moves on, its bot check (ADR 0075), and the words for a refusal. */
function useStep(action: HumanAction | null) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ flow?: string; depth?: string; from?: string }>();
  const id = typeof params.flow === "string" ? params.flow : "";
  const { flow, opened } = useSignInStepFlow(id);
  const depth = stepDepth(params.depth);
  const human = useHumanCheck(action);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened without the e-mail's screen under it (its address on its own): the sign-in starts at the e-mail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once, as the step opens
  useEffect(() => {
    if (!opened) goBack("/sign-in");
  }, []);
  return {
    flow,
    depth,
    from: typeof params.from === "string" ? params.from : undefined,
    human,
    pending,
    setPending,
    error,
    setError,
    /** The next step, pushed over this one; `from` says which step asked for it. */
    push: (step: SignInStep, from?: SignInStep) => router.push(signInStepHref(step, id, depth + 1, from) as never),
    /** The next step in this one's place: back from it goes where back from this one went. */
    replace: (step: SignInStep) => router.replace(signInStepHref(step, id, depth) as never),
    /** "Use another email": back down to the e-mail's screen, past every step over it. */
    toEmail: () => router.dismiss(depth),
    /** Better Auth's refusal → the sentence to show (never the server's raw text). */
    failed: (refusal: { status: number; code?: string; retryIn?: number }) =>
      setError(refusal.status ? refusalText(t, refusal) : t("mobile.auth.errors.network")),
    /**
     * What a throw means: only a request that never got an answer (fetch's "Network request failed") is "No
     * connection"; anything else in the app (the Keychain, a bug) reads as the generic failure. A bot check closed with
     * Cancel says nothing: the button is there to press again.
     */
    thrown: (e: unknown) => {
      if (e instanceof CheckCancelled) return;
      const network = e instanceof TypeError && /network|fetch/i.test(e.message);
      if (!network) console.warn("[auth]", e);
      setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
    },
  };
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

/** The account has a password: it is typed here. "Forgot password" asks for a new one on a screen of its own. */
export function PasswordStep() {
  const { t } = useTranslation();
  const step = useStep("sign-in");
  const { flow, pending, setPending, error, setError } = step;
  const canReset = useAuthConfig().data?.passwordReset === true;
  const purpose = useSignInPurpose();
  const { face, setSecret, wink } = useFace();
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const email = flow?.email ?? "";

  // The e-mail's lookup passed the bot check: its pass stands for this one (ADR 0075), so nobody meets Cloudflare
  // twice in one sign-in. The widget is asked only when the server no longer takes the pass.
  const signIn = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(
        step.human.check,
        async (token) =>
          refusalOf(
            await authClient().signIn.email({
              email,
              password,
              fetchOptions: { headers: humanCheckHeaders(token) },
            }),
          ),
        flow?.options?.pass,
      );
      if (refused) {
        haptics.warning();
        if (refused.status === 401) {
          setWrong(true);
          // The wrong password goes, so the next try starts on an empty field.
          setPassword("");
        } else step.failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email);
    } catch (e) {
      step.thrown(e);
    } finally {
      setPending(false);
    }
  };

  const ready = password.length > 0;
  const submit = () => {
    if (!ready || pending) return;
    void signIn();
  };
  // The e-mail as the subtitle: in ink, one line (a 40-character address is cut in the middle, never wrapped).
  const lead = wrong ? email : (purpose ?? email);
  return (
    <AuthScaffold
      title={wrong ? t("auth.flow.wrong") : t("auth.flow.password")}
      subtitle={lead}
      subtitleStrong={lead === email && email !== ""}
      agentMode={pending ? "run" : "idle"}
      expression={wrong ? "cross" : face}
      overlay={step.human.view}
    >
      <Locked when={pending} keepKeyboard>
        {/* Wrong: the title changes, the field shakes, the haptic warns, all in the same instant. */}
        <Shake when={wrong}>
          <PasswordField
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              setWrong(false);
            }}
            onSecretChange={setSecret}
            onShow={wink}
            onSubmitEditing={submit}
            label={t("auth.password")}
          />
        </Shake>
      </Locked>
      <ErrorLine error={error} />
      <Button variant="primary" wide label={t("auth.signIn")} loading={pending} disabled={!ready} onPress={submit} />
      {canReset ? (
        <Locked when={pending} keepKeyboard>
          <Quiet label={t("auth.forgotPassword")} onPress={() => step.push("forgot", "password")} />
        </Locked>
      ) : null}
    </AuthScaffold>
  );
}

/** The account signs in with a provider this server has: its buttons, and a password made by email instead. */
export function SocialStep() {
  const { t } = useTranslation();
  const step = useStep(null);
  const canReset = useAuthConfig().data?.passwordReset === true;
  const linked = useSocialProviders(step.flow?.options?.providers);
  const providers = linked.map((p) => t(`auth.provider.${p}`)).join(" · ");
  return (
    <AuthScaffold title={t("auth.flow.social", { providers })} subtitle={t("auth.flow.socialLead")}>
      <ErrorLine error={step.error} />
      <SocialButtons providers={linked} divider={false} onError={step.setError} />
      {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={() => step.push("forgot", "social")} /> : null}
    </AuthScaffold>
  );
}

/**
 * The account has no password and no provider this server signs in with (the owner's account made by the desktop
 * app): where one is added, another e-mail, or a password made by email.
 */
export function NoPasswordStep() {
  const { t } = useTranslation();
  const step = useStep(null);
  const canReset = useAuthConfig().data?.passwordReset === true;
  return (
    <AuthScaffold title={t("auth.flow.noPassword")} subtitle={t("auth.flow.noPasswordLead")}>
      <Button variant="secondary" wide label={t("auth.flow.otherEmail")} onPress={step.toEmail} />
      {canReset ? (
        <Quiet label={t("auth.flow.createPassword")} onPress={() => step.push("forgot", "noPassword")} />
      ) : null}
    </AuthScaffold>
  );
}

/** New here: the name and the password on one screen, like the invitation's "Só falta você". */
export function NameStep() {
  const { t } = useTranslation();
  const step = useStep("sign-up");
  const { flow, pending, setPending, error, setError } = step;
  const canReset = useAuthConfig().data?.passwordReset === true;
  const { face, setSecret, wink } = useFace();
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const email = flow?.email ?? "";
  const requests = earlyAccessRequests(flow?.access);

  const signUp = async () => {
    setPending(true);
    setError(null);
    try {
      const refused = await withHumanCheck(
        step.human.check,
        async (token) =>
          refusalOf(
            await authClient().signUp.email({
              name: name.trim(),
              email,
              password,
              fetchOptions: { headers: { ...humanCheckHeaders(token), ...requests.headers } },
            }),
          ),
        flow?.options?.pass,
      );
      if (refused) {
        haptics.warning();
        // Checked by code: the bot check refuses with a 403 too, and that isn't sign-up being closed. Closed takes
        // this step's place, so back from it is the e-mail, where another address may go.
        if (signUpClosed(refused)) step.replace("closed");
        else step.failed(refused);
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, email);
      // A server that sends email sent this address a link to confirm it: the first run says where it went.
      if (canReset) rememberConfirmationSent(email);
    } catch (e) {
      step.thrown(e);
    } finally {
      setPending(false);
    }
  };

  const ready = name.trim().length > 0 && passwordState(password) === "ok";
  const submit = () => {
    if (!ready || pending) return;
    if (nameIsPassword(name, password)) {
      // The name field got the password: no account with a password for a name.
      setPassword("");
      setError(t("auth.flow.nameIsPassword"));
    } else void signUp();
  };

  return (
    <AuthScaffold
      title={t("mobile.auth.flow.signUp")}
      subtitle={email}
      subtitleStrong={email !== ""}
      agentMode={pending ? "run" : "idle"}
      expression={face}
      overlay={step.human.view}
      footer={<InviteTerms />}
    >
      <Locked when={pending} keepKeyboard>
        <View style={{ gap: 8 }}>
          <AuthField
            value={name}
            onChangeText={(value) => {
              setName(value);
              setError(null);
            }}
            placeholder={t("auth.flow.namePlaceholder")}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            // Return hands the keyboard to the password, never closing it.
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordField.current?.focus()}
            accessibilityLabel={t("auth.yourName")}
            autoFocus
          />
          {!error ? <NameHint name={name} /> : null}
          <PasswordField
            ref={passwordField}
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            fresh
            autoFocus={false}
            onSecretChange={setSecret}
            onShow={wink}
            onSubmitEditing={submit}
            label={t("invite.createPassword")}
          />
        </View>
      </Locked>
      <ErrorLine error={error} />
      <Button
        variant="primary"
        wide
        label={t("auth.createAccount")}
        loading={pending}
        disabled={!ready}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

/** No account for this e-mail and none made here: sign-up is closed, or the early-access link that opened it expired. */
export function ClosedStep({ expired = false }: { expired?: boolean }) {
  const { t } = useTranslation();
  const step = useStep(null);
  const support = useAuthConfig().data?.supportEmail;
  return (
    <AuthScaffold
      title={expired ? t("auth.flow.expired") : t("auth.flow.closed")}
      subtitle={
        expired
          ? support
            ? t("auth.flow.expiredLead", { email: support })
            : t("auth.flow.expiredLeadAsk")
          : t("auth.flow.closedLead")
      }
    >
      <Button variant="secondary" wide label={t("auth.flow.otherEmail")} onPress={step.toEmail} />
    </AuthScaffold>
  );
}

/**
 * "Forgot password": a new password's link to the address, which may be changed here. Once it went, the screen says so
 * in its place (the request's result, not another step): the mail app, and back to signing in.
 */
export function ForgotStep() {
  const { t } = useTranslation();
  const step = useStep("password-reset");
  const { flow, pending, setPending, error, setError } = step;
  const [email, setEmail] = useState(flow?.email ?? "");
  const [sent, setSent] = useState(false);
  const fix = emailTypoFix(email);
  const mail = webmailOf(email);

  const sendReset = async () => {
    setPending(true);
    setError(null);
    try {
      // The answer is the same whether or not the account exists. Relative: the server resolves it
      // against its own address, so the link opens its web page whatever address the app reached it at.
      const refused = await withHumanCheck(
        step.human.check,
        async (token) =>
          refusalOf(
            await authClient().requestPasswordReset({
              email: email.trim(),
              redirectTo: "/reset-password",
              fetchOptions: { headers: humanCheckHeaders(token) },
            }),
          ),
        flow?.options?.pass,
      );
      if (refused) return step.failed(refused);
      haptics.success();
      setSent(true);
    } catch (e) {
      step.thrown(e);
    } finally {
      setPending(false);
    }
  };

  const ready = isEmail(email);
  const submit = () => {
    if (!ready || pending) return;
    void sendReset();
  };

  if (sent)
    return (
      <AuthScaffold
        title={t("auth.flow.sent", { email: email.trim() })}
        subtitle={t("auth.flow.sentLead")}
        expression="happy"
      >
        {mail ? (
          <Button
            variant="primary"
            wide
            icon="mail"
            label={t("auth.flow.openMail", { app: mail.name })}
            onPress={() => void Linking.openURL(mail.url)}
          />
        ) : null}
        {/* The password's screen is right under this one; from any other step, signing in starts at the e-mail. */}
        <Button
          variant="secondary"
          wide
          label={t("auth.flow.backToSignIn")}
          onPress={() => (step.from === "password" ? router.back() : step.toEmail())}
        />
      </AuthScaffold>
    );

  return (
    <AuthScaffold
      title={t("auth.flow.forgot")}
      subtitle={t("auth.flow.forgotLead")}
      agentMode={pending ? "run" : "idle"}
      overlay={step.human.view}
    >
      <Locked when={pending} keepKeyboard style={{ gap: 8 }}>
        <AuthField
          value={email}
          onChangeText={(value) => {
            setEmail(value);
            setError(null);
          }}
          placeholder={t("auth.flow.emailPlaceholder")}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          // The keyboard's blue key sends the link; it stays gray until something is typed.
          returnKeyType="send"
          enablesReturnKeyAutomatically
          onSubmitEditing={submit}
          accessibilityLabel={t("auth.email")}
          autoFocus
        />
        {fix ? <DidYouMean fix={fix} onFix={setEmail} /> : null}
      </Locked>
      <ErrorLine error={error} />
      <Button
        variant="primary"
        wide
        label={t("auth.flow.sendLink")}
        loading={pending}
        disabled={!ready}
        onPress={submit}
      />
    </AuthScaffold>
  );
}
