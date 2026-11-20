import { invitationQuery, type SignInOptions, type SignInProvider, useApi, useAuthConfig } from "@agenteschat/client";
import { withHumanCheck } from "@agenteschat/client/lib/human-check";
import { emailTypoFix, isEmail, looksLikePassword } from "@agenteschat/client/lib/text";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, Pressable, type TextInput, View } from "react-native";
import { PixelOrbit } from "@/agent/PixelOrbit";
import { useLaunched } from "@/features/launch/launched";
import { readValueSync } from "@/lib/storage";
import { signUpHere } from "@/lib/store";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { socialProvidersOn } from "@/ui/auth/providers-on";
import { AuthFootLine } from "@/ui/auth/ServerLine";
import { LastUsed, lastSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { Button } from "@/ui/Button";
import { LineIcon } from "@/ui/LineIcon";
import { Locked } from "@/ui/Locked";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, earlyAccessRequests, lookUpFailureText, lookUpStep } from "./human-check";
import { pendingInvite } from "./invite";
import { signInPurpose } from "./links";
import { endSignInFlow, newSignInFlowId, type SignInStep, setSignInFlow, signInStepHref } from "./sign-in-flow";

/**
 * Sign in and sign up in one flow (like the web's `AuthPage`): the e-mail first, on this screen, then the one next
 * step the server says it needs (the password, the provider the account signs in with, or the name and a new
 * password), each a screen pushed over it (`SignInSteps.tsx`), the system's back going to the one before. The keyboard
 * comes up here and each step's field takes it as its screen opens; the return key is the action. The agent reacts:
 * eyes shut while a hidden password is typed, a wink when it's shown, a frown and a shake of the field when it's
 * wrong. On success the session gate moves to the app.
 */
/** The e-mail this phone last signed in with: the next sign-in starts with it (kept on signing out). */
export const LAST_EMAIL = "last-email";

/** How often the e-mail's lookup tries again while there is no connection. */
const OFFLINE_RETRY_MS = 5000;
/** The no-connection line: the orbit on the first line of its words. */
const OFFLINE_LINE = { flexDirection: "row", alignItems: "flex-start", justifyContent: "center", gap: 8 } as const;

/** `access`: an early-access link's token, for the sign-up it opens (as the web's `/signup?access=`). */
export function AuthFlow({
  start,
  email: initialEmail,
  access,
}: {
  start: "in" | "up";
  email?: string;
  access?: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAuthConfig();
  // What this screen finds out goes to the steps it pushes under this id, and goes with the screen.
  const [flow] = useState(newSignInFlowId);
  useEffect(() => () => endSignInFlow(flow), [flow]);
  // How this phone signed in last, read once: the e-mail's Continuar carries "Último usado" as a provider's button does.
  const [lastWay] = useState(lastSignIn);
  const [email, setEmail] = useState(initialEmail ?? readValueSync(LAST_EMAIL) ?? "");
  // The e-mail takes the keyboard once the launch splash has left, not under it.
  const launched = useLaunched();
  // Under a step, or under an invitation's screen, it stays out of the way.
  const focused = useIsFocused();
  const emailField = useRef<ComponentRef<typeof TextInput>>(null);
  const [offline, setOffline] = useState(false);
  // The server's last answer: a new password's link asked from here (a provider's unconfirmed account) carries its pass.
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const human = useHumanCheck("email-lookup");
  const allProviders = useSocialProviders();
  const canReset = config.data?.passwordReset === true;
  const requests = earlyAccessRequests(access);
  const purpose = useSignInPurpose();
  const termsUrl = config.data?.termsUrl;
  const privacyUrl = config.data?.privacyUrl;

  /** The next step on a screen of its own, pushed over this one, with what it needs to know. */
  const open = (step: SignInStep, address: string, found: SignInOptions | null) => {
    setError(null);
    setSignInFlow(flow, { start, ...(access ? { access } : {}), email: address, options: found });
    router.push(signInStepHref(step, flow, 1) as never);
  };

  /** Who is this e-mail: the next step follows from the server's answer. */
  // One at a time: the offline retry asks again every few seconds, and a late answer to an earlier ask would push its
  // step a second time.
  const looking = useRef(false);
  const lookUp = async (value = email) => {
    if (!isEmail(value) || looking.current) return;
    looking.current = true;
    setPending(true);
    setError(null);
    try {
      const found = await withHumanCheck(human.check, (token) =>
        api.account.signInOptions(requests.lookUp(value.trim()), token),
      );
      setOffline(false);
      setOptions(found);
      // No password and no provider this server signs in with (the owner's account made by the desktop
      // app): the web's "noPassword" step says where to add one, instead of an empty provider list.
      const on = config.data?.socialProviders as Partial<Record<SignInProvider, boolean>> | undefined;
      const usable = socialProvidersOn(on, Platform.OS, found.providers).length > 0;
      open(lookUpStep(found, usable, signUpHere(config.data?.cloud)), value.trim(), found);
    } catch (e) {
      // No connection: the e-mail stays, a quiet line says so, and the lookup tries again by itself (below).
      if (e instanceof TypeError && /network|fetch/i.test(e.message)) setOffline(true);
      else if (!(e instanceof CheckCancelled)) setError(lookUpFailureText(t, e));
    } finally {
      looking.current = false;
      setPending(false);
    }
  };

  // Offline on the e-mail: one try every few seconds until the server answers, then on to the next step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookUp` reads the e-mail as typed at each try
  useEffect(() => {
    if (!offline || !focused) return;
    const id = setInterval(() => void lookUp(), OFFLINE_RETRY_MS);
    return () => clearInterval(id);
  }, [offline, focused, email]);

  // Came with the e-mail ("Criar conta" from somewhere that knew it): straight to the next step, once the server
  // has said whether a bot check guards it.
  const lookedUp = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the e-mail it came with
  useEffect(() => {
    if (lookedUp.current || config.isPending) return;
    lookedUp.current = true;
    if (initialEmail && isEmail(initialEmail)) void lookUp(initialEmail);
  }, [config.isPending]);

  // Mounted under the launch splash: the keyboard comes up once the splash leaves, and again back from a step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the splash leaves or the screen comes back
  useEffect(() => {
    if (launched && focused && !initialEmail) emailField.current?.focus();
  }, [launched, focused]);

  /** A provider refused: its words, and the address an unconfirmed account's refusal was for, in the field. */
  const socialRefused = (text: string, address?: string) => {
    setError(text);
    if (address && text === t("auth.unconfirmed")) setEmail(address);
  };

  const ready = isEmail(email);
  const submit = () => {
    if (!ready || pending) return;
    void lookUp();
  };

  const fix = emailTypoFix(email);
  const terms = termsUrl && privacyUrl ? <Terms termsUrl={termsUrl} privacyUrl={privacyUrl} /> : null;

  return (
    <AuthScaffold
      title={start === "up" ? t("auth.flow.emailUp") : t("mobile.auth.flow.email")}
      subtitle={start === "up" ? undefined : (purpose ?? t("mobile.auth.flow.emailLead"))}
      agentMode={pending ? "run" : "idle"}
      overlay={human.view}
      footer={
        <>
          {terms}
          {/* Signed in on another server (this one added from Workspaces), its "Voltar para …" leads back there. */}
          <AuthFootLine />
        </>
      }
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
          // The keyboard's blue key is the action, as Continue is; it stays gray until something is typed.
          returnKeyType="go"
          enablesReturnKeyAutomatically
          onSubmitEditing={submit}
          accessibilityLabel={t("auth.email")}
          ref={emailField}
          autoFocus={!initialEmail && launched && focused}
        />
        {fix ? (
          <Pressable
            onPress={() => setEmail(fix)}
            accessibilityRole="button"
            hitSlop={12}
            style={({ pressed }) => ({ alignSelf: "center", opacity: pressed ? 0.6 : 1 })}
          >
            <Text variant="subhead" style={{ fontWeight: "600" }}>
              {t("auth.flow.didYouMean", { email: fix })}
            </Text>
          </Pressable>
        ) : null}
      </Locked>

      {offline ? (
        <View style={OFFLINE_LINE} accessibilityLiveRegion="polite">
          <LineIcon variant="subhead" size={16} mark>
            <PixelOrbit color="sky" size={16} />
          </LineIcon>
          <Text variant="subhead" tone="muted" style={{ flexShrink: 1 }}>
            {t("mobile.auth.errors.offlineRetry")}
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text tone="danger" variant="small" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}

      {/* A provider refused an unconfirmed account: a new password by email, never a new confirmation (ADR 0006). */}
      {canReset && error === t("auth.unconfirmed") && isEmail(email) ? (
        <Quiet label={t("auth.unconfirmedReset")} onPress={() => open("forgot", email.trim(), options)} />
      ) : null}

      {/* Continue is always on screen, gray until the address is whole, beside the keyboard's blue key that does the
          same: a button that showed only once the keyboard had gone left the screen with no way on while typing. */}
      <LastUsed on={lastWay === "email"}>
        <Button
          variant="primary"
          wide
          label={t("auth.flow.continue")}
          loading={pending}
          disabled={!ready}
          onPress={submit}
        />
      </LastUsed>

      <Locked when={pending} keepKeyboard style={{ paddingTop: 8 }}>
        <SocialButtons providers={allProviders} onError={socialRefused} earlyAccess={access} />
      </Locked>
    </AuthScaffold>
  );
}

/**
 * Where this sign-in leads, in place of the general line: the invitation opened before it (its workspace, by its
 * token), as the web's sign-in says it. Null for none.
 */
export function useSignInPurpose(): string | null {
  const { t } = useTranslation();
  const api = useApi();
  const [waiting] = useState(pendingInvite);
  const invitation = useQuery({ ...invitationQuery(api, waiting?.token ?? ""), enabled: waiting !== null });
  const goal = signInPurpose(invitation.data);
  return goal ? t(goal.key, { org: goal.org }) : null;
}

/** Under a name step's field: a soft line, never a block, when what's typed there looks like a password. */
export function NameHint({ name }: { name: string }) {
  const { t } = useTranslation();
  if (!looksLikePassword(name)) return null;
  return (
    <Text variant="small" tone="muted" accessibilityLiveRegion="polite" style={CENTER}>
      {t("auth.flow.nameLooksLikePassword")}
    </Text>
  );
}

/** A quiet text link under the main answer ("Esqueci a senha"). */
export function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ alignItems: "center", marginTop: 4 }}>
      <AuthLink label={label} onPress={onPress} />
    </View>
  );
}

/** "Ao continuar, você aceita os Termos e a Política de privacidade." */
export function Terms({ termsUrl, privacyUrl }: { termsUrl: string; privacyUrl: string }) {
  const { t } = useTranslation();
  const link = (label: string, url: string): ReactNode => (
    <Text
      variant="caption"
      tone="muted"
      style={{ textDecorationLine: "underline" }}
      // In a sheet over the app (Safari's view), not out to Safari: the sign-up stays where it was.
      onPress={() => void openBrowserAsync(url).catch(() => Linking.openURL(url))}
    >
      {label}
    </Text>
  );
  return (
    <Text variant="caption" tone="muted" style={{ textAlign: "center" }}>
      {t("auth.termsBefore")}
      {link(t("auth.terms"), termsUrl)}
      {t("auth.termsMiddle")}
      {link(t("auth.privacy"), privacyUrl)}
      {t("auth.termsAfter")}
    </Text>
  );
}
