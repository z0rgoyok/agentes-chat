import type { Agent, AgentBrain, AgentBrainInput } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useApi,
  useCredentials,
  useModels,
  usePlatformKey,
  useSetTeamWeekPrefs,
  useSettings,
  useTeamWeekPrefs,
  useUpdateAgent,
  useUpdateSettings,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { accountAbout, accountChoices, accountTitle } from "@agenteschat/client/lib/ai-accounts";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { modelInput, modelRows } from "@agenteschat/client/lib/brain-picker";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { handleAfterRename } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { brainPlan } from "@agenteschat/client/lib/plans";
import { AUTO, modelChoices } from "@agenteschat/client/lib/providers";
import { mineStatus, RIGHT_HAND_POWERS, rightHandNoComputer } from "@agenteschat/client/lib/right-hand";
import {
  type LodiPrefs,
  type LodiPrefsPatch,
  type LodiSwitch,
  type TeamWeekPeriod,
  teamWeekOn,
} from "@agenteschat/client/lib/right-hand-prefs";
import {
  AffixInput,
  BrainLogo,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  GroupHeading,
  Icon,
  Input,
  ProviderLogo,
  Switch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LookRows, modelOptions } from "@/components/AgentFields";
import { RightHandApprovalsCard } from "@/components/ApprovalCover";
import { PlanHold, usePlanHold } from "@/components/ai/ConnectAiSteps";
import type { HaveItem } from "@/components/arrival/ConnectHave";
import { useConnectAi } from "@/components/ConnectAi";
import { useAgentComputer } from "@/components/computer/facts";
import { useOpenComputer } from "@/components/computer/open";
import { LoadingLine } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { RightHandBrainDialog, type RightHandLink, type RightHandModel } from "@/components/RightHandBrainDialog";
import { TeamWeekSchedule } from "@/components/TeamWeekSchedule";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { fullLook, lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * The right hand's page (ADR 0137): what it is (its computer when it has one, what only it does), then its settings in
 * three groups. "Só para você": the AI the viewer's own conversation thinks with, and what it creates and adjusts for
 * them without asking. What it does by itself, each with its switch. "Para todo o workspace", only for who manages
 * agents: its name and look, the AI of people with no plan of their own, and who may use it. Its instructions are the
 * product's.
 */
export function RightHandSettingsSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <div className="ac-groups">
      <Card>
        <div className="settings-rows">
          <RightHandComputerRow agent={agent} />
          <RightHandPowersRow />
        </div>
      </Card>
      <section className="rh-group" aria-labelledby="rh-group-mine">
        <GroupHeading id="rh-group-mine" title={t("rightHand.settings.groupMine")} />
        <Card>
          <div className="settings-rows">
            <RightHandMineRow agent={agent} />
          </div>
        </Card>
        <RightHandApprovalsCard />
      </section>
      <RightHandOwn name={agent.name} />
      {can(org, "manage_agents") && (
        <section className="rh-group" aria-labelledby="rh-group-workspace">
          <GroupHeading
            id="rh-group-workspace"
            title={t("rightHand.settings.groupWorkspace")}
            note={`· ${t("rightHand.settings.groupAdmins")}`}
          />
          <RightHandForm agent={agent} />
        </section>
      )}
    </div>
  );
}

/** A plan's maker, its account's name ("Plano Claude") and whose it is, to anyone but its owner: a row's value line. */
function PlanLine({ kind, label, owner, model }: { kind: PlanKind; label?: string; owner?: string; model?: string }) {
  const { t } = useTranslation();
  return (
    <span className="rh-value ac-iconline">
      <BrainLogo kind={kind} size="xs" />
      <span>
        <b>{t("rightHand.settings.planName", { name: label ?? t(`aiAccounts.connect.${kind}`) })}</b>
        {owner && ` · ${t("rightHand.settings.planOwner", { owner })}`}
        {model && ` · ${model}`}
      </span>
    </span>
  );
}

/**
 * A plan's model as the dialog's "Modelo" line and the list it opens: the account and its model are one choice, as in
 * an agent's "Quem pensa". Every model the plan in use offers, Automático first.
 */
function planModelOf(t: TFunction, view: AgentBrain, onChange: (input: AgentBrainInput) => void): RightHandModel {
  const rows = modelRows(t, view, brainPlan(view));
  const chosen = rows.find((r) => r.checked);
  const value = chosen?.value ?? AUTO;
  return {
    label: chosen?.label ?? t("brain.auto.label"),
    lead: value === AUTO ? <Icon name="bulb" size={16} /> : undefined,
    value,
    options: rows.map((r) => ({ value: r.value, label: r.label, description: r.sub, hint: r.note })),
    onPick: (next) => onChange(modelInput(next, view)),
  };
}

/** The model a plan's view runs, by its name (Automático included). */
const usePlanModelLabel = (view: AgentBrain | undefined) => {
  const { t } = useTranslation();
  return view && view.brain !== "model" ? modelRows(t, view, brainPlan(view)).find((r) => r.checked)?.label : undefined;
};

type PlanKind = "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
const planKind = (kind: string | undefined): PlanKind | null => (kind && kind !== "model" ? (kind as PlanKind) : null);

/**
 * "Sua IA" (ADR 0137 §11): one line that opens, with what answers the viewer in their own DM with the right hand under
 * its name (the maker's mark, its name, what it is to them: Claude · seu plano), or that nothing does yet. Its dialog
 * holds the choice: their own plan (connecting one, or another) or the workspace's AI. Everyone has this line, in the
 * DM's side panel and on the right hand's page.
 */
export function RightHandMineRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const view = useAgentBrain(org.id, agent.id).data;
  const platform = usePlatformKey(org.id).data === true;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = mineStatus(view, me.user.id, platform, agent.brain?.maker);
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0] ?? "";
  const model = usePlanModelLabel(view);
  if (!status) return null;
  const setMine = (input: AgentBrainInput, done?: () => void) => {
    setBusy(true);
    void api.agents
      .setBrain(org.id, agent.id, { scope: "mine", ...input })
      .then(() =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) }),
          qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) }),
        ]),
      )
      .then(done)
      .catch((e) => toast.show(errorText(t, e), "error"))
      .finally(() => setBusy(false));
  };
  const back = () => setMine({ brain: "model" }, () => setOpen(false));
  // Connecting is a dialog of its own: this one closes for it.
  const connectMine = connect
    ? () => {
        setOpen(false);
        connect.open({ agentId: agent.id });
      }
    : null;
  let face: ReactNode = null;
  let name: string;
  let what: string | null = null;
  if (status.kind === "own") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="xs" />;
    name = status.label ?? (kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.mine"));
    what = status.ownerId
      ? t("rightHand.settings.mineOf", { owner: first(status.ownerId) })
      : t("rightHand.settings.mineYours");
  } else if (status.kind === "key") {
    face = status.provider ? <ProviderLogo id={status.provider} size="xs" /> : <Icon name="key" size={14} />;
    name = status.label ?? t("rightHand.settings.mineKeyName");
    what = t("rightHand.settings.mineKey");
  } else if (status.kind === "plan") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="xs" />;
    name = kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.mineKeyName");
    what = t("rightHand.settings.minePlan");
  } else {
    name = t("rightHand.settings.mineNobody");
  }
  const own = status.kind === "own";
  const value = (
    <span className={face ? "rh-value ac-iconline" : "rh-value"}>
      {face}
      <span>
        <b>{name}</b>
        {what && ` · ${what}`}
        {own && model && ` · ${model}`}
      </span>
    </span>
  );
  const g = agentGrammar(agent.name);
  const account = view?.accounts.find((a) => a.id === view.account);
  const planOf = status.kind === "own" || status.kind === "plan" ? planKind(status.brain) : null;
  const logoId = planOf
    ? ((own ? account?.provider : undefined) ?? planOf)
    : status.kind === "key"
      ? status.provider
      : null;
  const current: HaveItem | null =
    status.kind === "nobody"
      ? null
      : {
          id: "current",
          title: name,
          about: what ?? undefined,
          whose: what ?? "",
          group: { key: "current", label: "" },
          mark: logoId ? (
            <ProviderLogo id={logoId} size="xs" />
          ) : (
            <Icon name="key" size={16} className="arrival-have__mark" />
          ),
          usage: own ? (account?.usage ?? null) : null,
        };
  // On a billing hold nothing connects before the plan, whose one way in is the hold's banner (ADR 0162).
  const links: RightHandLink[] = [];
  if (connectMine && !held)
    links.push({
      icon: "plus",
      label: own
        ? t("connectAi.chat.other")
        : t(status.kind === "nobody" ? "rightHand.settings.connectMine" : "rightHand.settings.useMine"),
      onClick: connectMine,
    });
  if (own) links.push({ icon: "undo", label: t("rightHand.settings.useWorkspace"), onClick: back });
  // The AI's mark beside the right hand under the sky: its maker's, a key's, or none while nothing answers.
  let mineMark: ReactNode;
  if (logoId) mineMark = <ProviderLogo id={logoId} size="tile" />;
  else if (current) mineMark = <Icon name="key" />;
  return (
    <>
      <PrefRow
        id="rh-mine"
        icon="person"
        label={t("rightHand.settings.mine")}
        status={value}
        onOpen={() => setOpen(true)}
      />
      <RightHandBrainDialog
        agent={agent}
        open={open}
        onClose={() => setOpen(false)}
        title={t("rightHand.settings.mineTitle", g)}
        note={t("rightHand.settings.mineOnly", g)}
        mark={mineMark}
        current={current}
        empty={t(held ? "agentSetup.firstRun.afterPlan" : "rightHand.settings.mineNobody")}
        model={own && view ? planModelOf(t, view, (input) => setMine(input)) : null}
        links={links}
        busy={busy}
      />
    </>
  );
}

/**
 * "Computador": the row opens the computer every agent's page opens, which for the right hand is the viewer's own
 * seat on the workspace's computer and nobody else's. Where it has none for anyone (the workspace has no computer of
 * its own, or one that can't keep people apart) the row stays and says why, with nothing to open.
 */
function RightHandComputerRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const view = useAgentComputer(agent);
  const openComputer = useOpenComputer();
  if (!view.ready || view.forbidden || !view.facts) return null;
  const none = rightHandNoComputer(view.desktop?.reason);
  if (none) return <PrefRow id="rh-computer" icon="computer" label={t("agentComputer.button")} status={t(none)} />;
  return (
    <PrefRow
      id="rh-computer"
      icon="computer"
      label={t("agentComputer.button")}
      status={t("rightHand.computerYours")}
      onOpen={() => openComputer(agent.id)}
    />
  );
}

/** "Poderes do workspace": one row that opens what only the right hand does, in words (`RIGHT_HAND_POWERS`). */
function RightHandPowersRow() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PrefRow id="rh-powers" icon="bolt" label={t("rightHand.powers.title")} onOpen={() => setOpen(true)} />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("rightHand.powers.title")}
        description={t("rightHand.powers.help")}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <ul className="rh-powers">
            {RIGHT_HAND_POWERS.map((p) => (
              <li key={p.id} className="ac-iconline">
                <Icon name="check" size={16} />
                <span>{t(`rightHand.powers.${p.id}`)}</span>
              </li>
            ))}
          </ul>
        </DialogBody>
      </Dialog>
    </>
  );
}

/** "Sua IA"'s explanation, the ⓘ of the section the status stands in. */
export function useRightHandMineHint(agent: Agent) {
  const { t } = useTranslation();
  return {
    name: t("common.about", { label: t("rightHand.settings.mine") }),
    text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),
  };
}

function RightHandForm({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const usesApi = useWorkspaceUsesApi(org.id);
  const { solo } = usePersonalView();
  const [name, setName] = useState(agent.name);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const [looking, setLooking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [look, setLook] = useState(() => fullLook(lookOf(agent)));
  const g = agentGrammar(agent.name);
  const label = t("rightHand.label");
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const hold = usePlanHold();
  const connect = useConnectAi();
  // The workspace's AI (ADR 0137 §11): what every DM thinks with while its person has no plan of their own.
  const kind = planKind(agent.brain?.kind);
  const view = useAgentBrain(org.id, agent.id, true, false, "workspace").data;
  const planModel = usePlanModelLabel(view);
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const key = view?.workspaceAi?.key;
  const ownerId = signIn?.ownerId;
  const firstOf = (id: string | null | undefined) => (id ? dir.memberById.get(id)?.name.split(" ")[0] : undefined);
  const save = (patch: Parameters<typeof update.mutate>[0], onSuccess?: () => void) =>
    update.mutate(patch, { onSuccess, onError: (e) => toast.show(errorText(t, e), "error") });
  const setWorkspace = (input: AgentBrainInput) => {
    setBusy(true);
    void api.agents
      .setBrain(org.id, agent.id, { scope: "workspace", ...input })
      .then(() =>
        Promise.all(
          [keys.agentBrain(org.id, agent.id), keys.agents(org.id), keys.aiStatus(org.id)].map((queryKey) =>
            qc.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch((e) => toast.show(errorText(t, e), "error"))
      .finally(() => setBusy(false));
  };
  const rename = () => {
    const next = name.trim();
    if (!next || next === agent.name) return setName(agent.name);
    save({ name: next, handle: handleAfterRename(agent, next) });
  };
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      return toast.show(t("agent.budgetInvalid"), "error");
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  const list = modelOptions(
    t,
    i18n.language,
    modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
  );
  // Plans it may think with for everyone: the admin's own, and everyone's that serve the whole workspace.
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  const theirs = (id: string | null | undefined) => (id && id !== me.user.id ? firstOf(id) : undefined);
  // The choice in the dialog: each plan once (its logins grouped, as any agent's accounts are), by owner, then the API
  // key. A plan in use that is no longer active stays listed, so the choice never shows empty.
  const KEY = "key";
  const listed = signIn && !plans.some((p) => p.id === signIn.id) ? [signIn, ...plans] : plans;
  const mineGroup = { key: "mine", label: t("connectAi.chat.mine") };
  const keysGroup = { key: "keys", label: t("connectAi.chat.keys") };
  const keyItem: HaveItem = {
    id: KEY,
    title: key?.label ?? t("rightHand.settings.mineKeyName"),
    whose: keysGroup.label,
    group: keysGroup,
    mark: key ? (
      <ProviderLogo id={key.provider} size="xs" />
    ) : (
      <Icon name="key" size={16} className="arrival-have__mark" />
    ),
    usage: null,
    isKey: true,
  };
  const planItems = accountChoices(listed, [view?.account]).map((c): HaveItem => {
    const a = c.login;
    const owner = theirs(a.ownerId);
    const whose = owner ? t("agentPage.work.brain.accountOf", { name: owner }) : t("connectAi.chat.yours");
    return {
      id: a.id,
      title: accountTitle(a),
      about: accountAbout(t, c, agent.name),
      whose,
      group: owner ? { key: `owner:${a.ownerId}`, label: whose } : mineGroup,
      mark: <ProviderLogo id={a.provider ?? a.kind} size="xs" />,
      usage: a.usage ?? null,
    };
  });
  const current = kind ? (planItems.find((i) => i.id === view?.account) ?? null) : keyItem;
  const others = [...planItems.filter((i) => i.id !== current?.id), ...(kind ? [keyItem] : [])];
  const pick = (id: string) => {
    if (id === KEY) return void (kind && setWorkspace({ brain: "model" }));
    const plan = listed.find((p) => p.id === id);
    if (plan && plan.id !== view?.account) setWorkspace({ brain: plan.kind, account: plan.id });
  };
  // Another AI: the Connect dialog, with every provider to pick from, over this one. On a billing hold nothing connects
  // before the plan (ADR 0162).
  const connectOther: RightHandLink | null =
    connect && !hold
      ? {
          icon: "plus",
          label: t("connectAi.chat.other"),
          onClick: () => {
            setChoosing(false);
            connect.open({ agentId: agent.id });
          },
        }
      : null;
  // The key's model: every model the workspace's keys reach, Automático first, the one in use kept on the list.
  const keyModels = [
    { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
    ...(agent.model === AUTO || list.some((o) => o.value === agent.model)
      ? []
      : [{ value: agent.model, label: agent.model }]),
    ...list,
  ];
  const model: RightHandModel | null =
    kind && view
      ? planModelOf(t, view, setWorkspace)
      : {
          label: keyModels.find((o) => o.value === agent.model)?.label ?? agent.model,
          lead: agent.model === AUTO ? <Icon name="bulb" size={16} /> : undefined,
          value: agent.model,
          options: keyModels,
          search: t("models.search"),
          onPick: (next) => next !== agent.model && save({ model: next }),
        };
  return (
    <>
      {hold && (
        <Card className="ai-panel">
          <PlanHold hold={hold} />
        </Card>
      )}
      <Card>
        <div className="settings-rows">
          <PrefRow
            id="rh-name"
            icon="agent"
            label={t("rightHand.settings.name")}
            hint={t("rightHand.settings.nameHelp", { ...g, label })}
            control={
              <span className="rh-set__name">
                <button
                  type="button"
                  className="rh-set__face-edit"
                  aria-label={t("rightHand.settings.lookEdit", g)}
                  title={t("rightHand.settings.lookEdit", g)}
                  onClick={() => setLooking(true)}
                >
                  <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
                </button>
                <Input
                  aria-label={t("rightHand.settings.name")}
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </span>
            }
          />
          <PrefRow
            id="rh-ai"
            icon="members"
            label={t("rightHand.settings.workspace")}
            status={
              kind ? (
                <PlanLine kind={kind} label={signIn?.label} owner={theirs(ownerId)} model={planModel} />
              ) : (
                <span className="rh-value ac-iconline">
                  {key ? <ProviderLogo id={key.provider} size="xs" /> : <Icon name="key" size={14} />}
                  <span>
                    <b>{key?.label ?? t("rightHand.settings.mineKeyName")}</b>
                    {` · ${agent.model === AUTO ? t("brain.auto.label") : (list.find((o) => o.value === agent.model)?.label ?? agent.model)}`}
                  </span>
                </span>
              )
            }
            onOpen={() => setChoosing(true)}
          />
          {usesApi && (
            <PrefRow
              id="rh-budget"
              icon="wallet"
              label={t("rightHand.settings.budget")}
              hint={t("rightHand.settings.budgetHelp", g)}
              control={
                <span className="rh-set__budget">
                  <AffixInput
                    aria-label={t("rightHand.settings.budget")}
                    prefix="US$"
                    inputMode="decimal"
                    value={budget}
                    placeholder={t("rightHand.value.budgetDefault")}
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={saveBudget}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
                  <span className="muted">{t("rightHand.settings.perMonth")}</span>
                </span>
              }
            />
          )}
        </div>
        <CardFooter icon="lock">
          {t("rightHand.settings.lock", g)}{" "}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            search={{ agent: agent.id }}
          >
            {t("rightHand.settings.audit", g)}
          </Link>
        </CardFooter>
      </Card>
      {!solo && (
        <Card aria-labelledby="rh-audience">
          <CardHeader
            id="rh-audience"
            icon="audiencePeople"
            title={t("rightHand.settings.audience")}
            subtitle={t("rightHand.settings.audienceHelp", g)}
          />
          <AudienceChoice
            value={audienceOf(agent)}
            onChange={(next) => save({ audience: audiencePatch(next) })}
            ownerUserId={agent.ownerUserId}
            agentName={agent.name}
            idPrefix="rh-audience"
          />
        </Card>
      )}
      <RightHandBrainDialog
        agent={agent}
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t("rightHand.settings.workspaceTitle", g)}
        note={t("rightHand.settings.workspaceOnly")}
        mark={
          kind ? (
            <ProviderLogo id={signIn?.provider ?? kind} size="tile" />
          ) : key ? (
            <ProviderLogo id={key.provider} size="tile" />
          ) : (
            <Icon name="key" />
          )
        }
        current={current}
        model={model}
        accounts={{
          items: others,
          onPick: pick,
          empty: t("rightHand.settings.noPlans", g),
          ...(connectOther ? { more: connectOther } : {}),
        }}
        links={connectOther ? [connectOther] : []}
        // On a billing hold nothing changes before the plan (ADR 0162).
        busy={busy || update.isPending}
        locked={!!hold}
      />
      <Dialog
        open={looking}
        onOpenChange={setLooking}
        title={t("rightHand.settings.changeLook")}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <span className="rh-set__face">
            <AgentAvatar name={agent.name} appearance={look} size="lg" />
          </span>
          <LookRows look={look} onChange={setLook} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setLooking(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => save({ appearance: look }, () => setLooking(false))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * What the right hand does without being asked, each a row with its switch (ADR 0177): the daily card with its hour
 * for everyone, the weekly card with its day and hour for admins (the selects beside the name while the card is on),
 * then the switches of whatever else this server has built. The person's own come first. The workspace's, for who
 * configures it, say before their switch that they are for everyone.
 */
function RightHandOwn({ name }: { name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const prefs = useTeamWeekPrefs(org.id).data;
  return (
    <section className="rh-group" aria-labelledby="rh-group-own">
      <GroupHeading id="rh-group-own" title={t("rightHand.settings.own.title", agentGrammar(name))} />
      {/* The group keeps its place while the person's choice loads: nothing below it jumps. */}
      <Card>{prefs ? <OwnRows name={name} prefs={prefs} /> : <LoadingLine width={320} />}</Card>
    </section>
  );
}

function OwnRows({ name, prefs }: { name: string; prefs: LodiPrefs }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "administrator");
  const configures = can(org, "configure");
  const set = useSetTeamWeekPrefs(org.id);
  const settings = useSettings(org.id).data;
  const setSettings = useUpdateSettings(org.id);
  const toast = useToast();
  const g = agentGrammar(name);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const save = (patch: LodiPrefsPatch) => set.mutate(patch, { onError: failed });
  const shows = (s: LodiSwitch) => prefs.switches.includes(s);
  // One of the two cards: its row's switch stops and starts it, and while it is on its day and hour stand beside its
  // name. A group by the card's name: the two rows hold the same selects, told apart by it when read aloud.
  const card = (period: TeamWeekPeriod, id: string, icon: "clock" | "calendar", label: string, hint: string) => {
    const on = teamWeekOn(prefs, period, admin);
    return (
      <PrefRow
        id={id}
        icon={icon}
        label={label}
        hint={hint}
        value={
          on && (
            // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a settings row, not a fieldset
            <span className="rh-set__week" role="group" aria-label={label}>
              <TeamWeekSchedule
                period={period}
                prefs={prefs}
                admin={admin}
                locale={i18n.language}
                stop={false}
                busy={set.isPending}
                onChange={save}
              />
            </span>
          )
        }
        control={
          <Switch
            aria-label={label}
            checked={on}
            disabled={set.isPending}
            onCheckedChange={(next) => save(period === "week" ? { weekOff: !next } : { dayOff: !next })}
          />
        }
      />
    );
  };
  const mine = (id: "digest" | "reminders", icon: "shield" | "bell", off: "digestOff" | "remindOff") =>
    shows(id) && (
      <PrefRow
        id={`rh-own-${id}`}
        icon={icon}
        label={t(`rightHand.settings.own.${id}`)}
        hint={t(`rightHand.settings.own.${id}Help`, g)}
        control={
          <Switch
            aria-label={t(`rightHand.settings.own.${id}`)}
            checked={!prefs[off]}
            disabled={set.isPending}
            onCheckedChange={(on) => save({ [off]: !on })}
          />
        }
      />
    );
  const everyones = (id: "teamWatch" | "welcomePeople", icon: "eye" | "personAdd", words: "teamWatch" | "welcome") =>
    configures &&
    settings &&
    shows(id) && (
      <PrefRow
        id={`rh-own-${id}`}
        icon={icon}
        label={t(`rightHand.settings.own.${words}`)}
        hint={t(`rightHand.settings.own.${words}Help`, g)}
        value={t("rightHand.settings.groupWorkspace")}
        control={
          <Switch
            aria-label={t(`rightHand.settings.own.${words}`)}
            checked={settings[id] !== false}
            disabled={setSettings.isPending}
            onCheckedChange={(on) => setSettings.mutate({ [id]: on }, { onError: failed })}
          />
        }
      />
    );
  return (
    <div className="settings-rows">
      {card("day", "rh-day", "clock", t("teamWeek.settings.dayLabel"), t("teamWeek.settings.dayHelp", g))}
      {admin && card("week", "rh-team-week", "calendar", t("teamWeek.settings.label"), t("teamWeek.settings.help", g))}
      {mine("digest", "shield", "digestOff")}
      {mine("reminders", "bell", "remindOff")}
      {everyones("teamWatch", "eye", "teamWatch")}
      {everyones("welcomePeople", "personAdd", "welcome")}
    </div>
  );
}
