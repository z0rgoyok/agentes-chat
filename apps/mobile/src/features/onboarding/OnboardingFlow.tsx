import { addDm, keys, meQuery, useApi, useAuthConfig, useTeamTemplates } from "@agenteschat/client";
import { firstName } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { settingUp } from "@agenteschat/client/lib/guards";
import { landingOf, type RailStep, railState } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { finishOnboarding, isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { aboutOf, type BusinessType, templateFor } from "@agenteschat/client/lib/team-plan";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Platform, Pressable, StyleSheet, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { signOut } from "@/features/account";
import { agentLook } from "@/features/shared/logic";
import { authClient } from "@/lib/auth";
import { paysHere } from "@/lib/store";
import { useOrgGate } from "@/providers/org";
import { Button, LineIcon, Locked, OptionTile, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { goBack, router } from "@/ui/navigation";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { InviteCrew } from "../auth/invite-parts";
import { isStill, STILL_PARAM, stillHref } from "../links/landing";
import { chatHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ZoneSheet } from "../me/AccountPage";
import { chooseAction } from "../settings/parts";
import { usePersonPhoto } from "../shared/photo";
import {
  endOnboarding,
  isRootPage,
  nextStep,
  onboardingNow,
  type PushedStep,
  stepHref,
  stepsBetween,
  updateOnboarding,
  useOnboardingDraft,
} from "./draft";
import { orgNameFromEmail, PURPOSES, phoneTimezone, stepFailedText, workspaceAnswer, zoneLabel } from "./logic";
import { PurposeScene } from "./PurposeScene";
import { BusinessStep, PlanStep, TeamStep } from "./steps";

/**
 * The first run on the phone, signed in with no workspace to open yet (ADR 0162), the web's steps on the sign-in's own
 * sky, each step a screen of its own pushed over the one before (the system's back, its button and the edge swipe,
 * goes to the step before). First what the workspace is for (ADR 0159), two cards and Continue: "For me" makes a
 * personal workspace at once, named in the person's language with the phone's time zone, and opens it in its right
 * hand's DM, where its card holds the rest. A company or team goes on: the workspace's name (its time zone from the
 * phone, said in one line; its logo later, in Configurações), the keyboard's return key as the action; what it does;
 * its team, made from a template; and, on agentes.chat Cloud, the plan it waits for, in words only. Its right hand
 * stands on the sky and says one line per step, the team joining it there once picked. Where a visit stands is read
 * from the workspace's data, so one left at any step (here or on the web) resumes there, never a second one, with the
 * steps before it under it. It opens in #general, or in the right hand's DM when the plan was left for the web, and its
 * screens leave with it.
 * Nothing destructive lives here: leaving the account is a quiet line, deleting it stays on the website. The root
 * layout pushes the first page (`/onboarding`) and starts the answers the steps share (`draft.ts`): opened from
 * Add workspace (ADR 0154) the first page's back goes back there, and the workspace the person is still in is
 * named on it; as the app's start it has nothing under it to go back to.
 */
export function OnboardingPage({ step: pushed }: { step?: PushedStep | null }) {
  const first = pushed === undefined;
  const params = useLocalSearchParams();
  // A visit picked up again pushes its earlier steps in place (no slide), several at once: each drops that mark once it
  // is the step on screen (the params set are the focused screen's), so going back from it slides as from any step.
  const still = isStill(params);
  useFocusEffect(
    useCallback(() => {
      if (!still) return;
      const frame = requestAnimationFrame(() => router.setParams({ [STILL_PARAM]: undefined }));
      return () => cancelAnimationFrame(frame);
    }, [still]),
  );
  const root = first && isRootPage(params);
  // Opened with no first run under way (its address on its own, or a step the phone doesn't have): nothing to answer.
  const [orphan] = useState(() => onboardingNow() === null || pushed === null);
  useEffect(() => {
    if (orphan) goBack();
  }, [orphan]);
  // The first page ends the answers as it leaves the stack: the workspace opening takes it down, or the system's back
  // goes where the first run was opened from (Add workspace), which is told it was left.
  const flow = useRef(first ? onboardingNow()?.id : undefined);
  useEffect(
    () => () => {
      if (flow.current === undefined) return;
      const ended = endOnboarding(flow.current);
      if (ended && !ended.finishing) ended.leave?.();
    },
    [],
  );
  // Android's back on the app's start leaves the app, as on any first screen: there is nothing under it to show.
  useFocusEffect(
    useCallback(() => {
      if (!root || Platform.OS !== "android") return;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        BackHandler.exitApp();
        return true;
      });
      return () => sub.remove();
    }, [root]),
  );
  if (orphan) return null;
  return <FirstRunStep pushed={pushed ?? undefined} />;
}

function FirstRunStep({ pushed }: { pushed: PushedStep | undefined }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const draft = useOnboardingDraft();
  // Only the step on screen opens the workspace or pushes the steps a visit left off at; one under it (or under an
  // invitation's screen) waits.
  const focused = useIsFocused();
  const first = pushed === undefined;
  // Asked again whenever the app comes back: a plan paid on the website meanwhile opens the workspace.
  const me = useQuery({ ...meQuery(api), refetchOnWindowFocus: "always" });
  const authConfig = useAuthConfig().data;
  // The first question's cards, side by side: each half of the row, less the gap between them.
  const [cardsWidth, setCardsWidth] = useState(0);
  const cardWidth = cardsWidth > 0 ? (cardsWidth - CARD_GAP) / 2 : 0;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingZone, setPickingZone] = useState(false);
  // What the steps share (`draft.ts`): a step pushed again finds the answers where the person left them.
  const created = draft?.created ?? null;
  const purpose = draft?.purpose ?? null;
  const name = draft?.name ?? "";
  const suggested = draft?.suggested ?? null;
  // The zone the person picked on the name's step, if they did; said in one line with Trocar beside it.
  const pickedZone = draft?.zone ?? null;
  // What the business step picked in this visit, and the template picked on the team's: it starts on the business's.
  const business = draft?.business ?? null;
  const template = draft?.template ?? null;
  // The workspace the person is still in meanwhile (Add workspace).
  const another = draft?.another ?? null;
  const setName = (value: string) => updateOnboarding({ name: value });
  const setZone = (zone: string) => updateOnboarding({ zone });
  const setTemplate = (id: string | null) => updateOnboarding({ template: id });
  const setBusiness = (picked: BusinessType | null) => updateOnboarding({ business: picked });
  const orgName = name.trim();

  const unfinished = me.data?.organizations.find(settingUp);
  // Made here; else the one this person is setting up (a visit cut short, here or on the web), which resumes.
  const target =
    created ??
    (unfinished?.onboarding
      ? { orgId: unfinished.id, generalChannelId: unfinished.onboarding.generalChannelId }
      : null);
  const orgId = target?.orgId ?? null;
  const mine = me.data?.organizations.find((o) => o.id === orgId);
  // Asked again as the app comes back too: a step answered on the web meanwhile moves this one on, so its button never
  // makes a second team.
  const settings = useQuery({
    queryKey: keys.settings(orgId ?? ""),
    queryFn: () => api.orgs.settings(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const agents = useQuery({
    queryKey: keys.agents(orgId ?? ""),
    queryFn: () => api.agents.list(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const lodi = agents.data?.find(isRightHand);
  // In the order they were made (the server's), a template's team in its template's order: as every screen lists it.
  const team = (agents.data ?? []).filter((a) => !isRightHand(a));
  const context = settings.data?.context?.trim() ?? "";
  // Made here as "For me", or one being set up that is.
  const personal = isPersonal(mine) || (created !== null && purpose === "personal");
  const { steps, at } = railState({
    orgId,
    standing: mine?.standing,
    billingUrl: authConfig?.billingUrl,
    context,
    team: team.length,
    picked: null,
    personal,
    funnel: null,
  });
  // Read once is enough: a refetch that fails later keeps the step on screen with what it read.
  const known = orgId === null || (settings.data !== undefined && agents.data !== undefined && mine !== undefined);
  // What this page asks: a pushed step its own; the first page, what the workspace is for while it doesn't exist yet,
  // else the rail's first step (a visit picked up again). Decided once, so the page never turns into another.
  const [decided, setDecided] = useState<"purpose" | "name" | null>(null);
  const firstShown = decided ?? (me.data && known ? (orgId === null ? "purpose" : "name") : null);
  if (first && decided === null && firstShown !== null) setDecided(firstShown);
  const shown = pushed ?? firstShown;
  // The first question, before the workspace exists.
  const asking = shown === "purpose";
  const step: RailStep = shown === null || shown === "purpose" ? "name" : shown;
  // Back on step 1, the workspace's own zone (saved on another visit, maybe on the web), never the phone's.
  const zone = pickedZone ?? settings.data?.timezone ?? phoneTimezone();
  const kind = business ?? aboutOf(t, context).business;
  const templates = useTeamTemplates(
    orgId ?? "",
    i18n.language,
    orgId !== null && (step === "business" || step === "team"),
  );
  const chosen = templateFor(templates.data ?? [], template, kind);
  // The right hand works while anything saves, the steps' own requests included.
  const mutating = useIsMutating();
  const working = pending || mutating > 0;

  // The address this sign-up was emailed a link to confirm (features/auth/confirmation.ts): the step says where it
  // went, until `me` says it's confirmed.
  const email = me.data?.user.email ?? "";
  // You, in the first question's drawings: the account's photo (Google's), else the initial of your name.
  const youName = me.data?.user.name || email;
  const photo = usePersonPhoto(me.data?.user.image);
  // A work address names its company: the name's field starts with it, selected, so typing replaces it.
  useEffect(() => {
    if (!draft || another || orgId || name !== "" || suggested !== null || !email) return;
    const guess = orgNameFromEmail(email);
    updateOnboarding({ suggested: guess ?? "", ...(guess ? { name: guess } : {}) });
  }, [draft, another, orgId, name, suggested, email]);
  // A workspace being set up shows its own name on its name's step, to keep or to change.
  const named = useRef(false);
  useEffect(() => {
    if (named.current || asking || step !== "name" || !mine) return;
    named.current = true;
    if (name === "") setName(mine.name);
  });
  const unconfirmed =
    email !== "" && confirmationSentTo() === email.toLowerCase() && me.data?.user.emailVerified !== true;

  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(stepFailedText(t, e, i18n.language));
    } finally {
      setPending(false);
    }
  };

  /**
   * Finishes it and opens it where the app starts, the first run's screens leaving with it: #general, the right hand's
   * DM when the plan was left for the website, or the workspace's import.
   */
  const open = (how: "done" | "skipped" | "import") =>
    run(async () => {
      if (!target || onboardingNow()?.finishing) return;
      // From here the workspace takes the screens down: none of them is a way back to where the first run was opened.
      updateOnboarding({ finishing: true });
      try {
        const { orgId: id, generalChannelId } = target;
        const done = await finishOnboarding(api, id);
        const landing = how === "import" ? null : landingOf(how, personal);
        const dm =
          landing === "rightHand" && done.agentId
            ? await api.dms.open(id, { agentId: done.agentId }).catch(() => null)
            : null;
        forgetConfirmationSent();
        // The answer that finished it says who the person is now: nothing is asked again.
        if (done.me) qc.setQueryData(keys.me, done.me);
        else await qc.invalidateQueries({ queryKey: keys.me });
        gate.choose(id);
        // The conversation finds its DM in the lists for its header, from the open's own answer. An older self-hosted
        // server doesn't send it: the list is read again, without waiting for it.
        if (dm?.dm) addDm(qc, id, dm.dm);
        else if (dm) void qc.invalidateQueries({ queryKey: keys.dms(id) });
        // The whole first run leaves at once, down to where the app starts, and the workspace opens over it.
        router.dismissTo("/");
        if (how === "import") router.push("/settings/import");
        else router.push(chatHref(dm?.channelId ?? generalChannelId));
      } catch (e) {
        updateOnboarding({ finishing: false });
        throw e;
      }
    });

  /** The step after this one, pushed over it (the system's back comes back here). */
  const advance = () => {
    const next = nextStep(steps, step);
    if (next) router.push(stepHref(next));
  };

  /** Makes the workspace (or renames it, back on its name's step later), then `then`. */
  const save = (then?: () => void) =>
    run(async () => {
      if (!orgId) {
        // "For me" asks no name: the word for it in the person's language; a company or team, the name typed.
        // Its zone, the owner's own too, in the same call.
        const res = await api.orgs.create({
          ...workspaceAnswer(t, purpose ?? "team", orgName),
          ...(zone ? { timezone: zone, memberTimezone: zone } : {}),
        });
        const id = res.organization.id;
        // The next step's data first, then the workspace among mine: it shows at once, with no wait between.
        await Promise.all([
          qc.prefetchQuery({ queryKey: keys.settings(id), queryFn: () => api.orgs.settings(id) }),
          qc.prefetchQuery({ queryKey: keys.agents(id), queryFn: () => api.agents.list(id) }),
        ]);
        if (res.me) qc.setQueryData(keys.me, res.me);
        else await qc.invalidateQueries({ queryKey: keys.me });
        updateOnboarding({ created: { orgId: id, generalChannelId: res.generalChannelId } });
      } else {
        await api.orgs.updateSettings(orgId, { name: orgName, ...(pickedZone ? { timezone: pickedZone } : {}) });
        await qc.invalidateQueries({ queryKey: keys.me });
      }
      then?.();
    });

  // Everything answered and no plan to wait for (a server of one's own, or paid on the website meanwhile): it opens.
  useEffect(() => {
    if (!focused || !known || at !== "open" || !draft || draft.autoOpened || draft.finishing) return;
    updateOnboarding({ autoOpened: true });
    void open("done");
  });

  // A visit picked up at a later step: the steps before it go under it, in place, so the system's back walks them as
  // it does on a first visit.
  useEffect(() => {
    if (!first || firstShown !== "name" || !focused || !draft || draft.resumed) return;
    updateOnboarding({ resumed: true });
    for (const later of stepsBetween(steps, "name", at)) router.push(stillHref(stepHref(later)));
  });

  const loadFailed = settings.error ?? agents.error;
  const lodiName = lodi?.name ?? RIGHT_HAND_DEFAULT.name;
  const lodiLook = { ...agentLook(lodi ?? RIGHT_HAND_DEFAULT), id: lodi?.id ?? "right-hand" };
  // Nothing destroys on screen: until a workspace is set up these are the only screens, so the way out of the account
  // is one quiet "Sair", which offers Sair and, in red, Apagar conta in the system's list (a person must always reach
  // deleting their account, App Store 5.1.1(v); the web's first run takes it from there).
  const leaveAccount = (
    <AuthLink
      label={t("mobile.org.signOut")}
      onPress={() =>
        chooseAction(
          email,
          [
            { icon: "out", label: t("mobile.org.signOut"), onPress: () => void signOut() },
            {
              icon: "trash",
              label: t("deleteAccount.menu"),
              destructive: true,
              onPress: () => openWebPath("/onboarding?account=delete"),
            },
          ],
          t("mobile.common.cancel"),
        )
      }
    />
  );
  // Reading where a visit left off (or a visit that only has to open now): the steps' own sky with the right hand at
  // work on it and the question still being read, never a bare screen between the launch splash and the sky. While a
  // step opens it, that step stays on screen with its button working; a failure to open says so here, with the way to
  // try again and the way out.
  if (!me.data || !known || shown === null || (at === "open" && (error || (first && firstShown === "name")))) {
    const failed = error ?? (loadFailed ? stepFailedText(t, loadFailed, i18n.language) : null);
    return (
      <AuthScaffold
        sky="low"
        {...(failed ? { title: failed } : {})}
        agent={lodiLook}
        agentMode={failed ? "idle" : "run"}
        {...(failed && me.data ? { footer: leaveAccount } : {})}
      >
        {failed ? (
          <Button
            variant="secondary"
            wide
            label={t("mobile.common.retry")}
            onPress={() => {
              updateOnboarding({ autoOpened: false });
              setError(null);
              if (settings.isError) void settings.refetch();
              if (agents.isError) void agents.refetch();
            }}
          />
        ) : null}
      </AuthScaffold>
    );
  }

  const submit = () => {
    if (orgName && !pending) void save(advance);
  };
  // Back on the first question once the workspace exists, its answer stands: the cards keep it, Continue goes on.
  const answered = orgId !== null;
  // Continue on the first question: "For me" makes the workspace now; a company or team names it first, a step on.
  const next = () => {
    if (!purpose || pending) return;
    if (purpose === "team" || answered) router.push(stepHref("name"));
    else void save();
  };

  const say = t(`onboarding.flow.lodi.${step}`, { first: firstName(me.data.user.name), ...agentGrammar(lodiName) });
  const workspace = (mine?.name ?? orgName).trim();
  // Where this step stands on the rail ("2 de 4 · Sobre"): a step a payment took off the rail meanwhile counts last.
  const at0 = steps.indexOf(step);
  const n = at0 >= 0 ? at0 + 1 : steps.length + 1;
  const total = Math.max(steps.length, n);
  // The team joins the right hand on the sky once it is picked, and sleeps there until its plan.
  const crew =
    step === "team" || step === "plan"
      ? [
          { id: lodiLook.id, appearance: lodiLook, ...(working ? { mode: "run" as const } : {}) },
          ...(team.length > 0 ? team : (chosen?.team.agents ?? [])).map((a) => ({
            id: a.handle,
            appearance: a.appearance,
            ...(step === "plan" ? { mode: "sleep" as const } : {}),
          })),
        ]
      : null;
  const failedLine = error ? (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {error}
    </Text>
  ) : null;

  return (
    // Each step is a screen of its own: the push is its motion, so the question doesn't fade in again over it.
    <LayoutAnimationConfig skipEntering>
      <AuthScaffold
        sky="low"
        progress={
          asking ? undefined : `${t("onboarding.flow.stepOf", { n, total })} · ${t(`onboarding.flow.steps.${step}`)}`
        }
        title={
          asking
            ? another
              ? t("mobile.onb.anotherPurpose")
              : t("onboarding.purpose.title")
            : step === "name"
              ? another
                ? t("mobile.onb.anotherTitle")
                : t("onboarding.workspace.title")
              : step === "business"
                ? t("agentSetup.firstRun.about.title", { org: workspace })
                : step === "team"
                  ? t("onboarding.flow.team.title")
                  : t("onboarding.flow.plan.title")
        }
        // The right hand's line for the step; the name's step says first what the e-mail suggested, or where this
        // workspace goes beside the one the person is in.
        subtitle={
          asking
            ? another
              ? t("mobile.onb.anotherLead", { org: another })
              : t("onboarding.purpose.lead")
            : step !== "name"
              ? say
              : another
                ? t("mobile.onb.anotherLead", { org: another })
                : suggested && name === suggested
                  ? t("mobile.onb.suggested", { domain: email.split("@")[1] ?? "", org: suggested })
                  : say
        }
        stepKey={asking ? "purpose" : step}
        agent={lodiLook}
        agentMode={working ? "run" : "idle"}
        {...(crew ? { hero: <InviteCrew agents={crew} /> } : {})}
        footer={pending ? null : leaveAccount}
      >
        {asking ? (
          // The first question (ADR 0159): two cards side by side, as the web's, the picked one sunk with its check: on
          // top who would be there (you amid your agents, or a small org chart), the words under it; then Continue.
          <>
            <Locked when={pending} style={styles.purposes}>
              <Locked when={answered} readable>
                <View style={styles.cards} onLayout={(e) => setCardsWidth(e.nativeEvent.layout.width)}>
                  {PURPOSES.map((mode) => {
                    const on = purpose === mode;
                    const title = t(`onboarding.purpose.${mode}`);
                    const text = t(`onboarding.purpose.${mode}Text`);
                    return (
                      <OptionTile
                        key={mode}
                        pressed={on}
                        label={`${title}. ${text}`}
                        style={styles.card}
                        onPress={() => {
                          updateOnboarding({ purpose: mode });
                          setError(null);
                        }}
                      >
                        {cardWidth > 0 ? (
                          <PurposeScene kind={mode} chosen={on} width={cardWidth} you={{ name: youName, photo }} />
                        ) : null}
                        <View style={styles.words}>
                          <Text variant="subhead" tone="ink" style={styles.bold}>
                            {title}
                          </Text>
                          <Text variant="small" tone="muted">
                            {text}
                          </Text>
                          <Text variant="caption" tone="faint" style={styles.examples}>
                            {t(`onboarding.purpose.${mode}Examples`)}
                          </Text>
                        </View>
                      </OptionTile>
                    );
                  })}
                </View>
              </Locked>
              <Button
                variant="primary"
                wide
                label={t("onboarding.actions.continue")}
                loading={pending}
                disabled={!purpose}
                onPress={next}
              />
            </Locked>
            {failedLine}
            {unconfirmed ? <ConfirmationNote email={email} /> : null}
          </>
        ) : step === "name" ? (
          <>
            <Locked when={pending} keepKeyboard style={{ gap: 8 }}>
              <AuthField
                // Mounted again once the suggestion lands, so its focus selects it (`selectTextOnFocus`).
                key={suggested ? "suggested" : "empty"}
                value={name}
                onChangeText={(value) => {
                  setName(value);
                  setError(null);
                }}
                placeholder={t("onboarding.workspace.namePlaceholder")}
                accessibilityLabel={t("onboarding.workspace.name")}
                autoCapitalize="words"
                autoCorrect={false}
                // The keyboard's blue key is the action ("continuar"); gray until a name is typed.
                returnKeyType="go"
                enablesReturnKeyAutomatically
                onSubmitEditing={submit}
                // The suggested name comes selected: one keystroke replaces it, the blue key keeps it.
                selectTextOnFocus={Boolean(suggested)}
                autoFocus
              />
            </Locked>
            {failedLine}
            {/* The keyboard's blue key is the only action, as on the sign-in; the agent above works while it saves. */}
            {zone ? (
              <Pressable
                onPress={() => setPickingZone(true)}
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel={`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })}. ${t("mobile.onb.zoneChange")}`}
                hitSlop={12}
                style={({ pressed }) => [styles.zone, pressed && styles.pressed]}
              >
                <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
                  {`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })} · `}
                </Text>
                <Text variant="footnote" tone="ink2" style={styles.bold}>
                  {t("mobile.onb.zoneChange")}
                </Text>
              </Pressable>
            ) : null}
            {/* The zones come in the app's sheet, over the step: the app's zone screens are the workspace's, under
                the first run's screens until a workspace opens. */}
            <ZoneSheet
              open={pickingZone}
              onClose={() => setPickingZone(false)}
              title={t("mobile.onb.zoneTitle")}
              value={zone}
              onPick={(picked) => {
                setZone(picked);
                setPickingZone(false);
              }}
            />
            {unconfirmed ? <ConfirmationNote email={email} /> : null}
          </>
        ) : step === "business" && orgId ? (
          <BusinessStep
            orgId={orgId}
            context={context}
            business={kind}
            onDone={(picked) => {
              // Another business starts the team step on its own template again; the same keeps the one picked.
              if (picked !== kind) setTemplate(null);
              setBusiness(picked);
              advance();
            }}
          />
        ) : step === "team" && orgId ? (
          <>
            <TeamStep
              orgId={orgId}
              team={team}
              templates={templates.data ?? []}
              chosen={chosen}
              listFailed={templates.isError}
              onRetryList={() => void templates.refetch()}
              reviewer={lodiName}
              onPick={setTemplate}
              // With no plan to wait for, the workspace opens once its team shows (the effect above).
              onCreated={advance}
              onContinue={advance}
              onImport={() => void open("import")}
              leaving={pending}
            />
            {failedLine}
          </>
        ) : step === "plan" && orgId ? (
          <>
            <PlanStep
              orgId={orgId}
              team={team}
              mayPay={paysHere(can(mine, "manage_billing"))}
              leaving={pending}
              onEnter={() => void open("skipped")}
            />
            {failedLine}
          </>
        ) : null}
      </AuthScaffold>
    </LayoutAnimationConfig>
  );
}

/**
 * The note that the sign-up's confirmation link went to the person's address, with a new link a tap away; gone once
 * `me` says the address is confirmed.
 */
function ConfirmationNote({ email }: { email: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [sent, setSent] = useState<"no" | "sending" | "sent" | "failed">("no");
  const resend = async () => {
    setSent("sending");
    const res = await authClient()
      .sendVerificationEmail({ email })
      .catch(() => null);
    setSent(res && !res.error ? "sent" : "failed");
  };
  return (
    <View style={styles.note} accessibilityLiveRegion="polite">
      <LineIcon name="mail" size={15} color={c.faint} variant="small" />
      <View style={styles.grow}>
        <Text variant="small" tone="muted">
          {sent === "sent" ? t("auth.newLinkSent", { email }) : t("onboarding.confirmation.sent", { email })}
        </Text>
        {sent === "sent" ? null : (
          <Pressable
            onPress={() => void resend()}
            disabled={sent === "sending"}
            accessibilityRole="button"
            // A 20-point line: 12 of slop around it reaches the 44-point target.
            hitSlop={12}
            style={({ pressed }) => [styles.linkButton, pressed ? styles.pressed : null]}
          >
            <Text variant="small" style={styles.bold}>
              {t("auth.sendNewLink")}
            </Text>
          </Pressable>
        )}
        {sent === "failed" ? (
          <Text variant="small" tone="danger">
            {t("mobile.app.failed")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Between the first question's two cards. */
const CARD_GAP = 10;

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  // The first question's cards, then Continue under them on the same rhythm.
  purposes: { gap: 12 },
  cards: { flexDirection: "row", gap: CARD_GAP, alignItems: "stretch" },
  // Edge to edge for the drawing; the words keep the card's own padding.
  card: { flex: 1, padding: 0, overflow: "hidden" },
  words: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 2 },
  examples: { marginTop: 6 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 8 },
  zone: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingTop: 8, maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
  pressed: { opacity: 0.6 },
});
