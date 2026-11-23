import { type InvitationPreview, useAuthConfig } from "@agenteschat/client";
import { INVITATION_MAIL_PARAM } from "@agenteschat/client/lib/guards";
import { humanCheckHeaders, withHumanCheck } from "@agenteschat/client/lib/human-check";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useIsFocused } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { firstName } from "@/features/shared/logic";
import { authClient } from "@/lib/auth";
import { writeValue } from "@/lib/storage";
import { useSession } from "@/providers/session";
import { Button, haptics, Locked } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthScaffold } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { rememberSignIn, SocialButtons, useSocialProviders } from "@/ui/auth/SocialButtons";
import { router } from "@/ui/navigation";
import { LAST_EMAIL, NameHint, Quiet } from "./AuthFlow";
import { useHumanCheck } from "./HumanCheck";
import { CheckCancelled, refusalOf, refusalText } from "./human-check";
import { inviteStepHref } from "./InviteSteps";
import { forgetInvite } from "./invite";
import { endInviteFlow, setInviteFlow, updateEmailInvite, useInviteFlow } from "./invite-flow";
import { CloseIfFirst, ErrorLine, InviteCrew, InviteTerms, LockedEmail, OrgLine, useAgentsLine } from "./invite-parts";
import { EMAIL_ACTIONS, emailStart } from "./invite-steps";

/**
 * An email invitation, signed out (ADR 0090 §6): only what its address is missing, on the invitation's own screens,
 * the address locked. A new one gives a name here, then a password on a screen pushed over this one; one with a
 * password types it ("Forgot password" is the app's reset, on a screen of its own, and the invitation waits for the
 * sign-in after it); one that signs in only with a provider gets that provider. Then `join` accepts with the proof of
 * its email, from this screen, so the workspace opens in its place with no other screen between.
 */
export function EmailSteps({
  token,
  mail,
  preview,
  onSigningIn,
  join,
}: {
  token: string;
  mail?: string;
  preview: InvitationPreview;
  /** A sign-in starts here: the parent keeps these screens up while the session arrives, until `join` ends. */
  onSigningIn: () => void;
  join: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const focused = useIsFocused();
  const config = useAuthConfig().data;
  const invited = preview.email;
  const org = preview.orgName;
  const by = preview.invitedBy ? firstName(preview.invitedBy) : null;
  const account = preview.account;
  const step = emailStart(account);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [wink, setWink] = useState(false);
  const running = useRef(false);
  // A provider's sheet was started here: its session, whenever it comes, ends in `join`.
  const viaProvider = useRef(false);
  const human = useHumanCheck(EMAIL_ACTIONS[step] ?? null);
  const apple = useSocialProviders(["apple"]);
  const linked = useSocialProviders(account?.providers ?? []);
  const canReset = config?.passwordReset === true;
  const crew = useAgentsLine("invite.crew", preview.agents ?? [], preview.moreAgents ?? 0);
  const callbackURL = `/invite/${token}${mail ? `?${INVITATION_MAIL_PARAM}=${mail}` : ""}`;

  // What the steps pushed over this screen share with it, under the invitation's token, while it is open.
  const latest = useRef(onSigningIn);
  latest.current = onSigningIn;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per invitation; the name goes over as it's sent on
  useEffect(() => {
    setInviteFlow(token, {
      kind: "email",
      preview,
      ...(mail ? { mail } : {}),
      name: "",
      nameError: null,
      joinOnSession: false,
      onSigningIn: () => latest.current(),
    });
    return () => endInviteFlow(token);
  }, [token]);
  const flow = useInviteFlow(token);
  const shared = flow?.kind === "email" ? flow : null;
  // The new password's screen found the name typed as the password: said here, back on the name.
  const nameError = shared?.nameError ?? null;

  /** One press at a time; the screens stay until the request ends. */
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

  /**
   * These screens accept by themselves: a remembered copy of the invitation (a provider's sheet closed, a reset)
   * would race them for the same acceptance in the root layout.
   */
  const startSignIn = () => {
    viaProvider.current = false;
    forgetInvite();
    onSigningIn();
  };
  const startProvider = () => {
    viaProvider.current = true;
    forgetInvite();
    onSigningIn();
  };

  /** Better Auth's refusal → the sentence to show (never the server's raw text). */
  const refusal = (refused: { status: number; code?: string; retryIn?: number }) =>
    refused.status ? refusalText(t, refused) : t("mobile.auth.errors.network");

  const signIn = () =>
    run(async () => {
      startSignIn();
      const refused = await withHumanCheck(human.check, async (check) =>
        refusalOf(
          await authClient().signIn.email({
            email: invited,
            password,
            fetchOptions: { headers: humanCheckHeaders(check) },
          }),
        ),
      );
      if (refused) {
        haptics.warning();
        if (refused.status === 401) {
          setWrong(true);
          // The wrong password goes, so the next try starts on an empty field.
          setPassword("");
        } else setError(refusal(refused));
        return;
      }
      haptics.success();
      rememberSignIn("email");
      void writeValue(LAST_EMAIL, invited);
      await session.refresh().catch(() => {});
      await join();
    });

  // A provider's session, or one made on the new password's screen over this one: joining is this screen's, once it
  // is on top again, so the workspace opens in its place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as a session made away from this screen's form arrives
  useEffect(() => {
    if (!session.signedIn || !focused) return;
    if (!viaProvider.current && !shared?.joinOnSession) return;
    viaProvider.current = false;
    updateEmailInvite(token, { joinOnSession: false });
    void run(join);
  }, [session.signedIn, focused, shared?.joinOnSession]);

  const ready = step === "name" ? name.trim() !== "" : step === "password" ? password.length > 0 : false;

  const submit = () => {
    if (!ready || pending) return;
    if (step === "name") {
      updateEmailInvite(token, { name: name.trim(), nameError: null });
      router.push(inviteStepHref(token, "new-password"));
    } else if (step === "password") void signIn();
  };

  // A personal workspace's words (ADR 0159): never its name ("Personal"), who invited instead.
  const calledYou = by
    ? t(modeKey(preview, "invite.calledYou"), { name: by, org })
    : t(modeKey(preview, "invite.calledYouNoName"), { org });
  const providerNames = linked.map((p) => t(`auth.provider.${p}`)).join(" · ");
  const bubble: Record<typeof step, [string, string?]> = {
    name: [
      by ? t(modeKey(preview, "invite.hello"), { name: by, org }) : t(modeKey(preview, "invite.helloNoName"), { org }),
      t(modeKey(preview, "invite.nameLead")),
    ],
    password: wrong ? [t("auth.flow.wrong")] : [calledYou, t("mobile.invite.join.passwordLead")],
    social:
      linked.length > 0
        ? [calledYou, t("invite.socialLead", { providers: providerNames })]
        : [t("auth.flow.noPassword"), t("auth.flow.noPasswordLead")],
  };
  const [title, lead] = bubble[step];
  const expression = wrong ? "cross" : wink ? "wink" : secret ? "closed" : undefined;
  const forgot = () => router.push(inviteStepHref(token, "forgot"));
  const shownError = error ?? nameError;

  let body: ReactNode = null;
  switch (step) {
    case "name":
      body = (
        <>
          <LockedEmail email={invited} />
          <OrgLine
            agent={preview.agents?.[0]}
            strong={
              isPersonal(preview)
                ? preview.invitedBy
                  ? t("invite.personalName", { name: preview.invitedBy })
                  : t("invite.personalNameNoName")
                : preview.invitedBy
                  ? t("invite.from", { name: preview.invitedBy })
                  : org
            }
            text={crew ?? undefined}
          />
          <AuthField
            value={name}
            onChangeText={(value) => {
              setName(value);
              if (nameError) updateEmailInvite(token, { nameError: null });
            }}
            placeholder={t("auth.flow.namePlaceholder")}
            accessibilityLabel={t("auth.yourName")}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="go"
            enablesReturnKeyAutomatically
            onSubmitEditing={submit}
            autoFocus
          />
          {shownError ? <ErrorLine error={shownError} /> : <NameHint name={name} />}
          <Button variant="primary" wide label={t("auth.flow.continue")} disabled={!ready} onPress={submit} />
          {apple.length > 0 ? (
            <View onTouchStart={startProvider}>
              <SocialButtons providers={apple} divider={false} onError={setError} callbackURL={callbackURL} />
            </View>
          ) : null}
        </>
      );
      break;
    case "password":
      body = (
        <>
          <LockedEmail email={invited} />
          <Locked when={pending} keepKeyboard>
            <PasswordField
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setWrong(false);
              }}
              onSecretChange={setSecret}
              onShow={() => {
                setWink(true);
                setTimeout(() => setWink(false), 900);
              }}
              onSubmitEditing={submit}
              label={t("auth.password")}
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
          {canReset ? (
            <Locked when={pending} keepKeyboard>
              <Quiet label={t("auth.forgotPassword")} onPress={forgot} />
            </Locked>
          ) : null}
        </>
      );
      break;
    case "social":
      body = (
        <>
          <LockedEmail email={invited} />
          <ErrorLine error={error} />
          {linked.length > 0 ? (
            <View onTouchStart={startProvider}>
              <SocialButtons providers={linked} divider={false} onError={setError} callbackURL={callbackURL} />
            </View>
          ) : null}
          {canReset ? <Quiet label={t("auth.flow.createPassword")} onPress={forgot} /> : null}
        </>
      );
      break;
  }

  return (
    <AuthScaffold
      title={title}
      subtitle={lead}
      agentMode={pending ? "run" : "idle"}
      expression={expression}
      overlay={human.view}
      footer={step === "name" ? <InviteTerms /> : null}
      // The team you're invited to, on the sky, before any field; the steps after it keep the app's agent.
      hero={(preview.agents?.length ?? 0) > 0 ? <InviteCrew agents={preview.agents ?? []} /> : undefined}
    >
      {body}
      {pending ? null : <CloseIfFirst />}
    </AuthScaffold>
  );
}
