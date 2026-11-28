import type { AgentBrain, AgentBrainInput, BrainKind, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { useAgents, useAiChoice, useAiStatus, useApi, useSetComputerTarget, useUpdateAgent } from "@agenteschat/client";
import { CLI_OF_BRAIN } from "@agenteschat/client/lib/activity";
import type { BrainScreen } from "@agenteschat/client/lib/agent-edit";
import { accountInLine } from "@agenteschat/client/lib/ai-accounts";
import type { AiChoiceRow, AiChoice as AiChoiceValue } from "@agenteschat/client/lib/ai-choice";
import { EVERYONE_AUDIENCE } from "@agenteschat/client/lib/audience";

import { type Advanced, advancedDefaults } from "@agenteschat/client/lib/brain-advanced";
import { contextSize } from "@agenteschat/client/lib/context-limits";
import { keyRefusal } from "@agenteschat/client/lib/errors";
import { heldWhole, namesText } from "@agenteschat/client/lib/format";
import { brainTool, cliCommandWayOut, installableCli } from "@agenteschat/client/lib/machines";
import {
  type AiChoice,
  kindOf,
  PLAN_CHOICES,
  type PlanChoice,
  planLabel,
  planMark,
  planOfAccount,
} from "@agenteschat/client/lib/no-ai";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import { usageWhen } from "@agenteschat/client/lib/plan-usage";
import { geminiPersonal, isPlanId, signInProviderOf } from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, modelOnKey } from "@agenteschat/client/lib/providers";
import {
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  ProviderLogo,
  planState,
  SettingNote,
} from "@agenteschat/ui";

import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NO_COMPUTER } from "@/components/AgentComputer";
import { DEFAULT_KEY } from "@/components/AgentFields";
import { AddAccount, OpenPage } from "@/components/ai/AddAccountFlow";
import { type AiChoiceExtra, AiChoiceFields } from "@/components/ai/AiChoice";
import { CliFetchLine } from "@/components/ai/CliFetchLine";
import { CliMissing } from "@/components/ai/CliMissing";
import { PlanHold } from "@/components/ai/plan-hold";
import { UseOnAgentsDialog } from "@/components/ai/UseOnAgents";
import { TeamScene, useDawn } from "@/components/arrival/TeamScene";
import { useConnectAi } from "@/components/connect-ai-context";
import { ToolOffWayOut } from "@/components/devices/ToolOneClick";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { ToolsOffHereNote, useIsThisMac } from "@/components/ThisMac";
import { useAdminsLock } from "@/hooks/usePersonalView";
import { modelLimitText } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "../context";
import { BrainLine, ContextField, Fold, PickList, PinAccount, SpeedField, useGlide } from "./pieces";
import { type BrainRow, useBrainState } from "./state";
import { useRefresh, useWork } from "./work";
import "./brain-dialog.css";

/*
 * "Quem pensa" (ADR 0032 §5, addendum 2026-11-10): the same dialog as Connect from a conversation (ADR 0160,
 * addendum). The sky with the agent awake and the AI's mark at the trail's end, the title, one thing in the middle and
 * a footer that is always the same: a note at its start, one button at its end. Its first screen holds the account,
 * the model and "Mais opções", one line each. Picking another account switches at once: a note under it says so with
 * "Desfazer", and offers the other agents still on the account it left ("Trocar também"). An account signed out, at its
 * limit or none at all is said there too, the footer's button being the way out. "Adicionar conta" (the account list's
 * foot) opens a screen of its own in the same dialog: one line per AI, then that AI's sign-in on the agent's computer,
 * after which the agent thinks with the new account. Where it can't sign in there (no computer, nobody to sign in, its
 * CLI missing) and for an API key, Connect takes over, its Back leading here again. Screens slide in from the side they
 * come from, and the dialog's height glides between them.
 */

type Screen = "glance" | "more" | "computer" | "add" | "signin";

/** What this agent thought with before a switch, for "Desfazer". */
interface Before {
  brain: BrainKind;
  account: string | null;
  model: string | null;
  machineId: string;
  key: string | undefined;
  apiModel: string;
  onlyOwner: boolean;
}

/** A switch made here: to what, what each agent had, and what to say. */
interface Switched {
  row: BrainRow;
  before: Before;
  others: { id: string; name: string; brain: BrainKind; account: string | null; model: string | null }[];
  /** What it thinks with now, in a sentence: the account ("ana@acme.com"), else the plan or the key. */
  said: string;
  line: string;
  missed: string[];
  /** "Atende outras pessoas" off after it, as the server put it. */
  onlyOwnerAfter: boolean;
  /** A sign-in here just brought the account. */
  added: boolean;
  /** The others of the person's agents still on the account it left, for "Trocar também". */
  team: { id: string; name: string }[];
  /** The account it left, in a sentence. */
  from: string;
}

/**
 * A sign-in on the agent's computer: a new account of a plan (`choice`), or an account listed here signed in again
 * (`again`) or for this agent too (`also`).
 */
interface Adding {
  choice?: PlanChoice;
  row?: BrainRow;
  again?: MachineAccount;
  also?: MachineAccount;
}

/** "Adicionar conta": the three most used AIs first, the other plans folded under one line, an API key last. */
const ADD_FIRST: readonly PlanChoice[] = ["claude", "chatgpt", "gemini"];
const ADD_MORE = PLAN_CHOICES.filter((c) => !ADD_FIRST.includes(c));
/** The accounts that sign in on their maker's page in the browser (a key's plan takes the key pasted instead). */
const BROWSER_SIGN_IN: readonly MachineAccountKind[] = [
  "claude_code",
  "codex",
  "antigravity",
  "cursor",
  "grok",
  "devin",
];

/**
 * `at`: a screen to open on (a link's): "Mais opções" or "Adicionar conta" past the first one, which "back" leads to;
 * `switch` opens the first one with its account list shown; `model` the first one. One this person can't change opens
 * the first screen.
 */
export function BrainDialog({
  onClose,
  at,
  onReopen,
}: {
  onClose: () => void;
  at?: BrainScreen;
  /** Opens it again on `at`: Connect, which it closes for, comes back to it by its Back. */
  onReopen?: (at?: BrainScreen) => void;
}) {
  const work = useWork();
  // Every screen starts from what is saved: the dialog mounts once it is loaded.
  if (!work.brain.data || !work.computer.data) return null;
  return <BrainFlow view={work.brain.data} onClose={onClose} at={at} onReopen={onReopen} />;
}

function BrainFlow({
  view,
  onClose,
  at,
  onReopen,
}: {
  view: AgentBrain;
  onClose: () => void;
  at?: BrainScreen;
  onReopen?: ((at?: BrainScreen) => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const adminsOnly = useAdminsLock();
  const { agent, g, saved, can, ownerFirst } = useAgentEdit();
  const work = useWork();
  const update = useUpdateAgent(org.id, agent.id);
  const setTarget = useSetComputerTarget(org.id);
  const connect = useConnectAi();
  const asks = useWidenAsk(agent);
  const hasOthers = (useAgents(org.id).data ?? []).some((a) => a.id !== agent.id);
  const aiState = useAiStatus(org.id).data?.agents.find((a) => a.agentId === agent.id);
  // Accounts a sign-in here just brought, before the next fetch has them.
  const [added, setAdded] = useState<MachineAccount[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const s = useBrainState(view, { added, signingIn });

  // ── adding an account ──
  // A plan signs in on the agent's computer by its owner (or whoever connected that computer, ADR 0059 §1); a key is
  // the workspace's, which only who manages keys adds. Anything else goes through Connect, which says what is missing.
  const signs = view.canManageAccounts && !s.hold && view.computer !== null && view.accountsSupported;
  const plansAdd = view.canUsePlans && !s.hold && (!!connect || signs);
  const keysAdd = canDo(org, "manage_credentials") && !s.hold && !!connect;
  const mayAdd = can("brain") && (plansAdd || keysAdd);
  const signsHere = (c: PlanChoice) =>
    signs &&
    (isPlanId(c)
      ? s.homeOf(c)?.machineId === work.machineId
      : view.options.some((o) => o.kind === kindOf(c) && o.available));
  /** The viewer's accounts of a plan on the agent's computer. */
  const mineOf = (c: PlanChoice) => s.listed.filter((a) => a.mine && planOfAccount(a) === c);

  // The way through the screens: back pops one, a save lands on the first again.
  const [trail, setTrail] = useState<Screen[]>(() =>
    at === "more" ? ["glance", "more"] : at === "add" && mayAdd ? ["glance", "add"] : ["glance"],
  );
  const screen: Screen = trail[trail.length - 1] ?? "glance";
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const choice = useAiChoice(org.id, { kind: "agent", agentId: agent.id });
  const [adding, setAdding] = useState<Adding>();
  const [othersOpen, setOthersOpen] = useState(false);
  const [arrived, setArrived] = useState<MachineAccount | null>(null);
  const [more, setMore] = useState<Advanced | null>(null);
  const [fold, setFold] = useState<"effort" | "speed" | "context" | null>(null);
  const [machinePick, setMachinePick] = useState<string>();
  const [copying, setCopying] = useState(false);
  const [switched, setSwitched] = useState<Switched | null>(null);
  const [busy, setBusy] = useState(false);

  /** On to another screen: what the first one said about the last change stays behind. */
  const go = (next: Screen) => {
    setDir("fwd");
    setSwitched(null);
    setArrived(null);
    setTrail((tr) => [...tr, next]);
  };
  const back = () => {
    setDir("back");
    setTrail((tr) => (tr.length > 1 ? tr.slice(0, -1) : tr));
  };
  const home = () => {
    setDir("back");
    setTrail(["glance"]);
  };

  // A link to the account list opens it once, on the first screen's first showing.
  const listAsked = useRef(at === "switch" && can("brain"));
  useEffect(() => {
    if (screen !== "glance") listAsked.current = false;
  }, [screen]);

  // Opening it is looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);

  // A new screen takes the focus where it starts (never on the first opening, which the dialog's own focus has).
  const screenRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new screen takes the focus
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    screenRef.current?.focus({ preventScroll: true });
  }, [screen, trail.length]);
  const glide = useGlide<HTMLDivElement>(`${screen}:${trail.length}`);

  const failed = (e: unknown) => {
    toast.show(keyRefusal(t, e)?.text ?? t("agentPage.work.failed"), "error");
    refresh();
  };

  // ── switching ──
  /** This agent onto `row`, in the right order: its computer, then who thinks. */
  const saveRow = async (row: BrainRow): Promise<AgentBrain | null> => {
    if (row.kind === "key") {
      const result = view.brain !== "model" ? await api.agents.setBrain(org.id, agent.id, { brain: "model" }) : null;
      if (row.keyId !== undefined) {
        const key = row.keyId === DEFAULT_KEY ? null : row.keyId;
        if (key !== (saved.key ?? null)) {
          // A key kept earlier may have run out of credit: "now thinks with it" has to be true. Whoever may not try
          // keys gets no answer here, and the run says it if it fails.
          if (key)
            await api.agents.checkCredential(org.id, key).catch((e) => {
              if (keyRefusal(t, e)) throw e;
            });
          const cred = s.credentials.find((c) => c.id === key);
          // The agent's model where the key runs it, else one the key does (an endpoint's own for an endpoint key).
          await update.mutateAsync({
            credentialId: key,
            ...(cred ? modelOnKey(cred, saved.model, s.models) : {}),
          });
        }
      }
      return result;
    }
    if (row.moves) await setTarget.mutateAsync({ agentId: agent.id, machineId: row.moves.machineId });
    // Another plan has other models: it starts on its own default, and an agent on Automático stays automatic.
    const auto = view.brain === "model" ? isAuto(view.effort) : isAuto(view.effectiveModel);
    return api.agents.setBrain(org.id, agent.id, {
      brain: row.brain,
      ...(row.choice !== s.savedCard ? { model: auto ? AUTO : null } : {}),
      ...(row.kind === "account" && row.account
        ? { account: row.account.id, ...(row.act === "move" ? { moveAccount: true } : {}) }
        : row.kind === "own"
          ? { account: null }
          : {}),
    });
  };

  /**
   * This agent alone onto `row`: the note under the account says so, with "Desfazer", and offers the others of the
   * person's agents still on the account it left (when the new one thinks for all of them).
   */
  const switchTo = async (row: BrainRow, fresh = false) => {
    const team = s.takesTeam(row) ? s.team.map((a) => ({ id: a.id, name: a.name })) : [];
    const from = s.currentAccount ? accountInLine(t, s.currentAccount) : (s.currentRow?.title ?? "");
    setBusy(true);
    try {
      const before: Before = {
        brain: view.brain,
        account: view.account,
        model: view.model,
        machineId: work.machineId,
        key: saved.key,
        apiModel: saved.model,
        onlyOwner: view.onlyOwner,
      };
      const result = await saveRow(row);
      refresh();
      // Moved onto a plan it answers only its owner from now on (ADR 0059 §5): said, with that owner's name to anyone
      // else. Another account of the same plan changes nobody it answers.
      const owner =
        row.brain !== "model" && row.brain !== view.brain && result?.onlyOwner === true && !view.onlyOwner
          ? view.canUsePlans
            ? t("common.you")
            : ownerFirst
          : null;
      const movedTo = row.moves ? s.nameOf(row.moves.name) : null;
      // In the sentence an unnamed account goes by its maker ("Claude"), never "Unnamed account".
      const said = row.account ? accountInLine(t, row.account) : row.title;
      const line = t(
        owner
          ? movedTo
            ? "agentPage.work.saved.brainMovedOwner"
            : "agentPage.work.saved.brainOwner"
          : movedTo
            ? "agentPage.work.saved.brainMoved"
            : "agentPage.work.saved.brain",
        { ...g, brain: said, computer: movedTo ?? "", owner: owner ?? "" },
      );
      setArrived(null);
      setSwitched({
        row,
        before,
        others: [],
        said,
        line,
        missed: [],
        onlyOwnerAfter: result?.onlyOwner ?? view.onlyOwner,
        added: fresh,
        team,
        from,
      });
      home();
      // Off the plan it still answers only its owner: one click lets back in whoever it answered before. "Só algumas
      // pessoas ou cargos" with nobody picked has no one to let back in: no action.
      if (row.kind === "key" && view.brain !== "model" && view.onlyOwner) {
        const people = (agent.audience?.userIds?.length ?? 0) + (agent.audience?.roleIds?.length ?? 0);
        toast.show(
          t("aiAccounts.share.backOnApi", g),
          "info",
          agent.audience?.mode === "people" && people === 0
            ? undefined
            : {
                label: people ? t("aiAccounts.share.letPeople", g) : t("aiAccounts.share.letEveryone", g),
                run: () =>
                  void api.agents.setBrain(org.id, agent.id, { onlyOwner: false }).then(
                    () => refresh(),
                    () => toast.show(t("agentPage.work.failed"), "error"),
                  ),
              },
        );
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** "Trocar também": the others left on the old account onto the new one, each by the server's own rules. */
  const switchTeam = async () => {
    if (!switched || switched.team.length === 0) return;
    const { row, team } = switched;
    setBusy(true);
    try {
      // What each had, read before anything changes ("Desfazer" puts it back).
      const theirs = await Promise.all(
        team.map((a) =>
          api.agents.brain(org.id, a.id).then(
            (b) => ({ id: a.id, name: a.name, brain: b.brain, account: b.account, model: b.model }),
            () => null,
          ),
        ),
      );
      const others = [...switched.others];
      const missed: string[] = [];
      for (const [i, a] of team.entries()) {
        const was = theirs[i];
        // One the server refuses keeps what it had, said by name.
        const ok =
          was &&
          (await api.agents
            .setBrain(org.id, a.id, {
              brain: row.brain,
              account: row.kind === "account" ? (row.account?.id ?? null) : null,
            })
            .then(
              () => true,
              () => false,
            ));
        if (ok && was) others.push(was);
        else missed.push(a.name);
      }
      refresh(team.map((a) => a.id));
      const names = [agent.name, ...others.map((o) => o.name)];
      setSwitched({
        ...switched,
        others,
        missed,
        team: [],
        line:
          names.length > 1
            ? t("connectAi.doneAll", { names: namesText(t, names, 2), label: switched.said })
            : switched.line,
      });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** "Desfazer": each agent the switch changed back to what it had, this one's computer and key too. */
  const undo = async () => {
    if (!switched) return;
    const { row, before: b, others } = switched;
    setBusy(true);
    try {
      if (row.moves)
        await setTarget.mutateAsync({ agentId: agent.id, machineId: b.machineId === NO_COMPUTER ? null : b.machineId });
      // Only a key picked by name changed the key (and maybe the model): those go back.
      if (row.kind === "key" && row.keyId !== undefined)
        await update.mutateAsync({ credentialId: b.key ?? null, model: b.apiModel });
      const share = b.onlyOwner !== switched.onlyOwnerAfter ? { onlyOwner: b.onlyOwner } : {};
      // From one key to another the brain never changed: only the key and the model go back.
      if (b.brain !== "model" || row.brain !== "model")
        await api.agents.setBrain(
          org.id,
          agent.id,
          b.brain === "model"
            ? { brain: "model", ...share }
            : { brain: b.brain, account: b.account, model: b.model, ...share },
        );
      for (const o of others)
        await api.agents
          .setBrain(org.id, o.id, { brain: o.brain, account: o.account, model: o.model })
          .catch(() => undefined);
      refresh(others.map((o) => o.id));
      setSwitched(null);
      toast.show(t("agentPage.work.brain.v2.undone"));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  /** A row picked to switch to: its sign-in first where it needs one, else at once. */
  const confirm = (row: BrainRow) => {
    if (row.act === "also" || row.act === "again") {
      // A sign-in happens on the agent's computer: with none there is nothing to sign in on.
      if (!row.account || !view.computer) return;
      setAdding(row.act === "also" ? { row, also: row.account } : { row, again: row.account });
      return go("signin");
    }
    void switchTo(row);
  };

  /** The rows of "Quem pensa" an account of the Conta list stands for: by any of its logins. */
  const matches = (row: AiChoiceRow) => (a: MachineAccount | undefined) =>
    !!a && (a.id === row.account?.id || (!!a.sameAs && a.sameAs === row.account?.sameAs));

  /** An account picked in the "Conta" select: the way a switch goes here (signing in, undo, the others on it). */
  const pickAccount = (row: AiChoiceRow) => {
    const match = s.rows.find((r) =>
      row.type === "plan"
        ? r.kind === "account" && matches(row)(r.account)
        : row.type === "key" &&
          r.kind === "key" &&
          (r.keyId === row.apiKey?.id ||
            (row.apiKey?.isDefault === true && (r.keyId === undefined || r.keyId === DEFAULT_KEY))),
    );
    if (match?.current) return;
    if (match) return confirm(match);
    setBusy(true);
    choice
      .save(choice.choose(row))
      .then(
        () => refresh(),
        (e: unknown) => failed(e),
      )
      .finally(() => setBusy(false));
  };

  /** One of the viewer's signed-out accounts picked in the list: its sign-in again, the one in use's too. */
  const againFrom = (row: AiChoiceRow) => {
    const hit = matches(row);
    if (s.signInAgain && s.currentRow && hit(s.currentAccount) && s.currentAccount) {
      setAdding({ row: s.currentRow, again: s.currentAccount });
      return go("signin");
    }
    const match = s.rows.find((r) => r.kind === "account" && hit(r.account));
    if (match) confirm(match);
  };

  /** Connect on one AI's steps, for what can't sign in here and for a key: its Back opens "Adicionar conta" again. */
  const connectOn = (start: AiChoice) => {
    if (!connect) return;
    onClose();
    connect.open({ agentId: agent.id, chat: true, start, ...(onReopen ? { onBack: () => onReopen("add") } : {}) });
  };
  const addPlan = (c: PlanChoice) => {
    if (!signsHere(c)) return connectOn(c);
    setAdding({ choice: c });
    go("signin");
  };
  // What the accounts don't list, from "Quem pensa"'s own rows: its computer's own sign-ins, a plan that would move it to
  // another computer. Drawn in the same list, each picked the way a switch goes here; one whose program doesn't run
  // there isn't a way to think at all, so it isn't listed.
  const extra: AiChoiceExtra[] = s.rows
    .filter((r) => (r.kind === "own" || r.kind === "plan") && !r.off)
    .map((r) => ({
      key: r.id,
      group: view.canUsePlans || r.free ? "yours" : "others",
      name: r.title,
      ...(r.about ? { meta: r.about } : {}),
      mark: r.mark,
      usage: r.usage,
      onPick: () => confirm(r),
    }));
  /** "Gerenciar contas": every account in Settings (Contas de IA). */
  const manage = () => {
    onClose();
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } });
  };

  // What a chosen model needs from its plan's account, with where to give it.
  const needs = s.planModels.find((m) => m.value === s.shownModel)?.needs;

  // ── how it thinks ──
  // "Só esta conta" where its account could move on, or where it is on: a right hand's own plan never moves.
  const pinShown = !view.scope && (s.moves || view.accountPinned === true);
  const moreNow: Advanced = {
    effort: s.effort,
    speed: s.speedOn ? view.speed : "standard",
    contextTokens: s.savedContext,
    onlyOwner: view.onlyOwner,
    ...(pinShown ? { accountPinned: view.accountPinned === true } : {}),
  };
  const m = more ?? moreNow;
  const openMore = () => {
    setMore(moreNow);
    setFold(null);
    go("more");
  };
  const saveMore = async () => {
    const input: AgentBrainInput = {};
    // A fixed model takes the ramp's level, on a key too; "Automático" picks its own. On a key none is the provider's
    // default, saved as `auto` ("Voltar ao padrão", which clears a level kept under "Automático" too).
    const was = s.kind !== "model" && isAuto(view.effort) ? AUTO : s.effort;
    if ((!isAuto(s.modelNow) || m.effort === null) && m.effort !== was) input.effort = m.effort ?? AUTO;
    if (s.kind !== "model") {
      if (s.speedOn && m.speed !== view.speed) input.speed = m.speed;
      if (m.onlyOwner !== view.onlyOwner) input.onlyOwner = m.onlyOwner;
      if (m.accountPinned !== undefined && m.accountPinned !== (view.accountPinned === true))
        input.accountPinned = m.accountPinned;
    }
    if (m.contextTokens !== s.savedContext) input.contextTokens = m.contextTokens;
    if (Object.keys(input).length === 0) return home();
    // Letting more people in on someone else's plan asks first: it spends their plan.
    if (input.onlyOwner === false && !(await asks.ask(EVERYONE_AUDIENCE)([]))) return;
    setBusy(true);
    try {
      const result = await api.agents.setBrain(org.id, agent.id, { brain: s.kind, ...input });
      refresh();
      if (input.onlyOwner !== undefined)
        toast.show(
          !m.onlyOwner && result.onlyOwner
            ? t("aiAccounts.share.pickPeople", g)
            : !m.onlyOwner
              ? t("aiAccounts.share.savedEveryone", g)
              : view.canUsePlans
                ? t("aiAccounts.share.savedOwner", g)
                : t("aiAccounts.share.savedOwnerOf", { ...g, owner: ownerFirst ?? "" }),
          !m.onlyOwner && result.onlyOwner ? "info" : undefined,
        );
      setMore(null);
      home();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const machineValue = machinePick ?? work.machineId;
  const machineChosen = s.runsOn.find((x) => x.machineId === machineValue);
  const saveMachine = async () => {
    if (!machineChosen) return;
    setBusy(true);
    try {
      await setTarget.mutateAsync({ agentId: agent.id, machineId: machineChosen.machineId });
      refresh();
      toast.show(t("agentPage.work.saved.computer", { ...g, computer: s.nameOf(machineChosen.name) }));
      setMachinePick(undefined);
      home();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // ── "Usar em outros agentes" (ADR 0094): what is saved, each agent taking it by its own rules ──
  const where = s.homeOf(s.savedCard);
  const copyFrom: AiChoiceValue | null =
    s.kind === "model"
      ? {
          brain: "model",
          model: saved.model,
          // The workspace's default key is the picker's placeholder, not a key id: it goes as null.
          key: saved.key === DEFAULT_KEY ? null : (saved.key ?? null),
        }
      : where
        ? {
            brain: s.kind,
            machineId: where.machineId,
            account: view.accountsSupported && view.computer ? view.account : null,
            model: view.effectiveModel === s.option?.defaultModel ? null : view.effectiveModel,
            effort: isAuto(view.effectiveModel) ? AUTO : s.effort,
          }
        : null;
  // It thinks with nothing yet (a plan with no sign-in there): nothing to take elsewhere.
  const thinksWithNothing =
    s.kind !== "model" && s.currentRow?.kind === "plan" && view.accountsSupported && view.computer !== null;
  const copyOn = copyFrom !== null && hasOthers && !thinksWithNothing;

  // ── what the screens say ──
  const toolOffHere =
    useIsThisMac(org.id, view.computer?.machineId ?? "") && view.options.some((o) => o.reason === "tool_off");
  const modelLimit = modelLimitText(t, i18n.language, s.usage, s.savedCard, s.shownModel);
  // Where its plan would think, when that says something the row in use doesn't (offline, no computer has it). With
  // no computer for it, why not and what to do (its panel's words) come before the bare "no computer has it".
  const savedSide =
    s.currentRow?.kind === "plan" || s.savedCard === "key"
      ? null
      : s.homeOf(s.savedCard)
        ? s.side(s.savedCard)
        : { icon: "block" as IconName, text: s.reason(s.savedCard) ?? s.side(s.savedCard)?.text ?? "" };
  // Its CLI off on its computer: the row in use says so, its way out goes under it (ADR 0036 §8).
  const offBrain =
    view.brain !== "model" && view.options.find((o) => o.kind === view.brain)?.reason === "tool_off"
      ? view.brain
      : null;
  const offOn = work.machines.data?.find((x) => x.id === view.computer?.machineId) ?? null;
  const offTool = offBrain && offOn && offOn.kind !== "managed" ? brainTool(offBrain) : null;
  // Its CLI not on its computer, there and failing to start, or too old: installed (or updated) from here, or looked
  // for again.
  const missingReason = view.brain !== "model" ? view.options.find((o) => o.kind === view.brain)?.reason : undefined;
  const missingCli =
    view.brain !== "model" &&
    (missingReason === "not_installed" || missingReason === "cant_start" || missingReason === "cli_outdated") &&
    offOn &&
    offOn.kind !== "managed" &&
    (installableCli(view.brain) || cliCommandWayOut(t, view.brain, offOn, missingReason, offOn.name))
      ? { kind: view.brain, reason: missingReason, machine: offOn }
      : null;
  const pairer = work.machines.data?.find((x) => x.id === view.computer?.machineId)?.pairedBy?.name.split(" ")[0];
  // On someone else's computer only whoever connected it adds a sign-in: "Adicionar conta" says so over the AIs.
  const lockedHere = view.canUsePlans && !view.canManageAccounts && view.computer !== null;
  // No AI to think with at all (nothing signed in, no key): the first screen offers to add one.
  const empty =
    !switched &&
    aiState?.state === "no_ai" &&
    (aiState.reason === "no_key" || (aiState.reason === "not_signed_in" && !s.currentAccount));
  const signedOut = !switched && s.signedOut && s.currentAccount != null && s.savedCard !== "key";
  const atLimit = !switched && s.waitsAtLimit;
  // While it can't think (at its limit, signed out, with nothing), the agent sleeps under the night, through the
  // whole flow; another account brings the day.
  const asleep = atLimit || signedOut || empty;
  const day = useDawn(!asleep);
  const acc = adding?.again ?? adding?.also;
  const addPlanOf = adding?.choice ?? (adding?.row && adding.row.choice !== "key" ? adding.row.choice : undefined);
  const addKind: MachineAccountKind = acc?.kind ?? (addPlanOf ? kindOf(addPlanOf) : "claude_code");
  const addCoding = addPlanOf && isPlanId(addPlanOf) ? addPlanOf : undefined;
  // Whose page the sign-in is on: Gemini's is Google's.
  const brand = addKind === "antigravity" ? "Google" : t(`aiAccounts.connect.${addKind}`);
  // The sky's mark: the AI it thinks with, the one signing in, or an empty place while one is being chosen.
  const markOf: AiChoice | "slot" | undefined =
    screen === "add" || (screen === "glance" && empty)
      ? "slot"
      : screen === "signin"
        ? addPlanOf
        : (switched?.row.choice ?? s.savedCard);
  const title =
    screen === "more"
      ? t("agentPage.work.brain.v2.moreTitle", g)
      : screen === "computer"
        ? t("agentPage.work.computer.title", g)
        : screen === "add"
          ? t("agentPage.work.brain.add.pickTitle")
          : screen === "signin"
            ? adding?.again
              ? addCoding
                ? t("aiAccounts.page.newKey")
                : t("agentPage.work.brain.add.againTitle", { brand })
              : addCoding
                ? t("agentPage.work.brain.add.titlePlan", { plan: planLabel(t, addCoding) })
                : t(`agentPage.work.brain.add.title.${addKind}`)
            : t("agentPage.work.brain.v2.title", g);

  /** What the account in use and the last change say, under the account. */
  const accountNotes = (): ReactNode => {
    const until = s.usage ? planState(s.usage).until : null;
    const inUse = s.currentAccount ? accountInLine(t, s.currentAccount) : (s.currentRow?.title ?? "");
    return (
      <>
        {switched && (
          <SettingNote icon="check" live>
            {switched.added && switched.others.length === 0
              ? t("agentPage.work.brain.v2.added", { ...g, account: switched.said })
              : switched.line}
            {/* "e-mail" whole: the line never breaks at its hyphen. */}
            {switched.row.lends && ` ${heldWhole(t("connectAi.chat.told", { name: switched.row.ownerName ?? "" }))}`}{" "}
            <Button variant="link" disabled={busy} onClick={() => void undo()}>
              {t("agentPage.work.brain.v2.undo")}
            </Button>
          </SettingNote>
        )}
        {switched && switched.missed.length > 0 && (
          <SettingNote icon="alert" live>
            {t("agentPage.work.brain.v2.missed", {
              count: switched.missed.length,
              names: namesText(t, switched.missed, 2),
            })}
          </SettingNote>
        )}
        {switched && switched.team.length > 0 && (
          <SettingNote icon="layers" live>
            {t("agentPage.work.brain.v2.alsoUses", {
              count: switched.team.length,
              names: namesText(
                t,
                switched.team.map((a) => a.name),
                2,
              ),
              account: switched.from,
            })}{" "}
            <Button variant="link" disabled={busy} onClick={() => void switchTeam()}>
              {t("agentPage.work.brain.v2.alsoSwitch")}
            </Button>
          </SettingNote>
        )}
        {arrived && (
          <SettingNote icon="check" live>
            {t("agentPage.work.brain.add.done", { account: accountInLine(t, arrived), computer: s.computerName })}
          </SettingNote>
        )}
        {empty && <SettingNote icon="info">{t("agentPage.work.brain.v2.empty", g)}</SettingNote>}
        {signedOut && s.savedCard !== "key" && (
          <SettingNote icon="alert">
            {t("agentPage.work.brain.v2.signedOut", { ...g, account: inUse, brand: planLabel(t, s.savedCard) })}
          </SettingNote>
        )}
        {atLimit && (
          <SettingNote icon="clock">
            {until
              ? t("agentPage.work.brain.v2.limitBack", { account: inUse, when: usageWhen(t, i18n.language, until) })
              : t("agentPage.work.brain.v2.limitSoon", { account: inUse })}
            {s.offers.length > 0 ? `. ${t("agentPage.work.brain.v2.limitHelp", g)}` : "."}
          </SettingNote>
        )}
        {s.kind !== "model" && !view.canUsePlans && ownerFirst && (
          <SettingNote icon="info">{t("agentPage.work.brain.accountWho", { ...g, owner: ownerFirst })}</SettingNote>
        )}
        {missingCli ? (
          <CliMissing
            machine={missingCli.machine}
            kind={missingCli.kind}
            computer={missingCli.machine.name}
            reason={missingCli.reason}
          />
        ) : (
          savedSide?.text && <SettingNote icon={savedSide.icon}>{savedSide.text}</SettingNote>
        )}
        {s.savedCard === "gemini" && geminiPersonal(s.currentAccount) && (
          <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>
        )}
        {offTool && offOn ? <ToolOffWayOut machine={offOn} tool={offTool} /> : toolOffHere && <ToolsOffHereNote />}
      </>
    );
  };

  const body = (): ReactNode => {
    if (screen === "glance")
      return (
        <>
          {s.hold && <PlanHold hold={s.hold} />}
          {s.hold && s.savedCard === "key" && can("brain") && (
            <SettingNote icon="clock">{t("connectAi.key.closed")}</SettingNote>
          )}
          <AiChoiceFields
            state={choice}
            parts={["account"]}
            onAccount={pickAccount}
            extra={extra}
            {...(mayAdd ? { onAdd: () => go("add") } : {})}
            {...(signs ? { onAgain: againFrom } : {})}
            onManage={manage}
            open={listAsked.current}
            disabled={busy || !can("brain")}
          />
          {accountNotes()}
          {offOn && view.brain !== "model" && <CliFetchLine machine={offOn} cli={CLI_OF_BRAIN[view.brain]} />}
          {!empty && <AiChoiceFields state={choice} parts={["model", "effort"]} disabled={busy || !can("brain")} />}
          {modelLimit && (
            <SettingNote icon="alert" live>
              {modelLimit}
            </SettingNote>
          )}
          {needs && s.plan && (
            <SettingNote icon="info" live>
              {t(`brain.modelHow.${needs}`)}
              <span style={{ display: "block", marginTop: 8 }}>
                <OpenPage href={s.plan.site}>
                  {t("aiAccounts.add.openKeys", { site: new URL(s.plan.site).host })}
                </OpenPage>
              </span>
            </SettingNote>
          )}
          {!empty && (
            <div className="bd-lines">
              <BrainLine
                label={t("agentPage.work.brain.v2.more")}
                value={s.speedOn ? t("aiHub.moreSpeed") : t("agentPage.work.brain.advanced.contents.model")}
                onOpen={openMore}
              />
            </div>
          )}
          {s.kind === "model" && !can("model") && <SettingNote icon="lock">{adminsOnly}</SettingNote>}
        </>
      );
    if (screen === "add") {
      const line = (c: PlanChoice, inner = false) => {
        const n = mineOf(c).length;
        return (
          <BrainLine
            key={c}
            label={planLabel(t, c)}
            mark={<ProviderLogo id={planMark(c)} size="xs" />}
            inner={inner}
            value={n > 0 ? t("agentPage.work.brain.add.have", { count: n }) : undefined}
            disabled={busy || (!signsHere(c) && !connect)}
            onOpen={() => addPlan(c)}
          />
        );
      };
      return (
        <>
          {plansAdd && lockedHere && (
            <SettingNote icon="lock">
              {t("connectAi.accountsLocked", { name: pairer ?? "", computer: s.computerName })}
            </SettingNote>
          )}
          <div className="bd-lines bd-lines--add">
            {plansAdd && ADD_FIRST.map((c) => line(c))}
            {plansAdd && (
              <BrainLine
                label={t("agentPage.work.brain.add.others")}
                mark={<Icon name="grid" size={16} />}
                value={
                  othersOpen
                    ? undefined
                    : namesText(
                        t,
                        ADD_MORE.map((c) => planLabel(t, c)),
                        2,
                      )
                }
                folds
                open={othersOpen}
                controls="bd-add-more"
                onOpen={() => setOthersOpen(!othersOpen)}
              />
            )}
            {plansAdd && (
              <div id="bd-add-more" className="bd-lines__group">
                {othersOpen && ADD_MORE.map((c) => line(c, true))}
              </div>
            )}
            {keysAdd && (
              <BrainLine
                label={t("agentPage.work.brain.add.key")}
                mark={<Icon name="key" size={16} />}
                value={t("agentPage.work.brain.add.keyLine")}
                opensDialog
                disabled={busy}
                onOpen={() => connectOn("key")}
              />
            )}
          </div>
        </>
      );
    }
    if (screen === "signin" && adding && view.computer) {
      const provider = addCoding ?? (acc ? signInProviderOf(acc.provider) : undefined);
      // Another account of a plan the person already signed in here: the browser would sign in as that one again.
      const have = acc || !addPlanOf || addCoding ? [] : mineOf(addPlanOf);
      const signedIn = (a: MachineAccount) => {
        setAdded((list) => [...list.filter((x) => x.id !== a.id), a]);
        // The account in use signed in again: nothing to switch, it thinks again.
        if (a.id === view.account) {
          setSwitched(null);
          setArrived(a);
          refresh();
          home();
          return;
        }
        const base: Omit<BrainRow, "id" | "kind" | "choice" | "brain" | "act" | "current"> = adding.row ?? {
          title: accountInLine(t, a),
          whose: t("connectAi.chat.yours"),
          group: { key: "mine", label: t("connectAi.chat.mine") },
          mark: <ProviderLogo id={a.provider ?? a.kind} size="xs" />,
          usage: a.usage ?? null,
          lends: false,
          moves: null,
        };
        void switchTo(
          {
            ...base,
            id: `account:${a.id}`,
            kind: "account",
            choice: planOfAccount(a),
            brain: a.kind,
            account: a,
            act: "use",
            current: false,
            moves: null,
          },
          !adding.again && !adding.also,
        );
      };
      return (
        <div className="arrival-main__steps">
          {have.length > 0 && BROWSER_SIGN_IN.includes(addKind) && (
            <SettingNote icon="info">
              {t("agentPage.work.brain.add.haveNote", {
                accounts: namesText(
                  t,
                  have.map((a) => accountInLine(t, a)),
                  2,
                ),
                brand,
              })}
            </SettingNote>
          )}
          {adding.again && !addCoding && (
            <SettingNote icon="info">
              {t("agentPage.work.brain.add.againNote", { ...g, account: accountInLine(t, adding.again) })}
            </SettingNote>
          )}
          <AddAccount
            key={acc?.id ?? addPlanOf}
            machineId={view.computer.machineId}
            kind={addKind}
            computer={s.computerName}
            again={adding.again?.id}
            fresh
            {...(provider ? { provider } : {})}
            email={acc?.email}
            local={view.ownSignIn}
            onAdded={signedIn}
            onUse={signedIn}
            onSigningIn={setSigningIn}
          />
        </div>
      );
    }
    if (screen === "more") {
      const shownContext =
        m.contextTokens !== null && s.contextOptions.includes(m.contextTokens) ? m.contextTokens : null;
      const line = (key: "speed" | "context", label: string, value: string, content: ReactNode) => (
        <>
          <BrainLine
            label={label}
            value={value}
            folds
            open={fold === key}
            controls={`bd-fold-${key}`}
            onOpen={() => setFold(fold === key ? null : key)}
          />
          <Fold id={`bd-fold-${key}`} open={fold === key}>
            {content}
          </Fold>
        </>
      );
      return (
        <div className="bd-lines">
          {s.speedOn &&
            line(
              "speed",
              t("agentPage.work.brain.speed"),
              t(`agentPage.work.brain.speeds.${m.speed}`),
              <SpeedField value={m.speed} onChange={(v) => setMore({ ...m, speed: v })} />,
            )}
          {line(
            "context",
            t("agentPage.work.brain.context"),
            shownContext ? contextSize(shownContext) : t("brain.auto.label"),
            <ContextField
              value={m.contextTokens}
              options={s.contextOptions}
              kind={s.kind}
              onChange={(n) => setMore({ ...m, contextTokens: n })}
            />,
          )}
          {m.accountPinned !== undefined && (
            <div className="bd-row">
              <PinAccount on={m.accountPinned} onChange={(on) => setMore({ ...m, accountPinned: on })} />
            </div>
          )}
          {s.runsOn.length > 1 && can("machine") && (
            <BrainLine
              label={t("agentPage.work.brain.v2.computer")}
              value={s.computerName}
              onOpen={() => {
                setMachinePick(undefined);
                go("computer");
              }}
            />
          )}
          {copyOn && (
            <BrainLine
              label={t("agentPage.work.brain.copy.row")}
              value={t("agentPage.work.brain.copy.rowLine")}
              opensDialog
              onOpen={() => setCopying(true)}
            />
          )}
        </div>
      );
    }
    if (screen === "computer")
      return (
        <PickList
          options={s.runsOn.map((x) => ({
            value: x.machineId,
            label: s.nameOf(x.name),
            description: x.online ? t("agentPage.work.computer.online") : t("agentPage.work.computer.offline"),
          }))}
          value={machineValue}
          onChange={setMachinePick}
          label={title}
        />
      );
    return null;
  };

  /** A row in a button or a sentence: an unnamed account by its maker ("Usar Claude"), else its title. */
  const rowSaid = (r: BrainRow) => (r.account ? accountInLine(t, r.account) : r.title);
  /** The footer, always the same: a quiet note at its start, the main action at its end. */
  const footer = (o: { note?: ReactNode; icon?: IconName; second?: ReactNode; main?: ReactNode }) => {
    const note = o.note ? (
      <span className="ac-iconline">
        <Icon name={o.icon ?? "info"} />
        <span>{o.note}</span>
      </span>
    ) : null;
    return (
      <DialogFooter
        key={screen}
        className={cx("bd-foot", note && o.second && o.main ? "bd-foot--two" : null)}
        {...(note ? { note } : {})}
      >
        {o.second}
        {o.main}
      </DialogFooter>
    );
  };
  const cancel = (
    <Button variant="ghost" disabled={busy} onClick={back}>
      {t("common.cancel")}
    </Button>
  );
  const finish = (
    <Button variant="primary" onClick={onClose}>
      {t("agentPage.work.brain.v2.finish")}
    </Button>
  );
  const foot = (): ReactNode => {
    if (screen === "glance") {
      const signIn =
        !switched && s.signInAgain && s.currentRow && s.currentAccount && view.computer
          ? { row: s.currentRow, again: s.currentAccount }
          : null;
      // At its limit, its owner's account with the most room, one click away.
      const best = atLimit && can("brain") ? s.offers[0] : undefined;
      return footer({
        note: t("agentPage.work.brain.v2.only", g),
        main: signIn ? (
          <Button
            variant="primary"
            onClick={() => {
              setAdding(signIn);
              go("signin");
            }}
          >
            {t(isPlanId(s.savedCard) ? "aiAccounts.page.newKey" : "agentPage.work.brain.signInAgain")}
          </Button>
        ) : empty && mayAdd ? (
          <Button variant="primary" onClick={() => go("add")}>
            {t("aiHub.choice.add")}
          </Button>
        ) : best ? (
          <Button variant="primary" disabled={busy} loading={busy} onClick={() => confirm(best)}>
            {t("connectAi.use", { label: rowSaid(best) })}
          </Button>
        ) : (
          finish
        ),
      });
    }
    if (screen === "add") return footer({ icon: "lock", note: t("agentPage.work.brain.add.pickFoot"), main: cancel });
    if (screen === "signin")
      return footer({
        icon: "lock",
        note:
          addCoding || addKind === "opencode"
            ? t("agentPage.work.brain.add.footKey", { computer: s.computerName })
            : t("agentPage.work.brain.add.footSignIn", { brand }),
        main: cancel,
      });
    if (screen === "more") {
      const now: Advanced = {
        effort: m.effort,
        speed: m.speed,
        contextTokens: m.contextTokens,
        onlyOwner: m.onlyOwner,
        ...(m.accountPinned !== undefined ? { accountPinned: m.accountPinned } : {}),
      };
      // The effort is the first screen's and whom it answers the account's: only what this screen holds goes back.
      const reset: Advanced = { ...m, ...advancedDefaults(s.kind, now), effort: m.effort, onlyOwner: m.onlyOwner };
      return footer({
        second: (
          <Button
            disabled={
              (reset.speed === m.speed &&
                reset.contextTokens === m.contextTokens &&
                reset.accountPinned === m.accountPinned) ||
              busy
            }
            onClick={() => setMore(reset)}
          >
            {t("agentPage.work.brain.advanced.defaults")}
          </Button>
        ),
        main: (
          <Button variant="primary" disabled={busy} loading={busy} onClick={() => void saveMore()}>
            {t("agentPage.work.brain.v2.finish")}
          </Button>
        ),
      });
    }
    if (screen === "computer")
      return footer({
        second: cancel,
        main: (
          <Button
            variant="primary"
            disabled={!machineChosen || machineValue === work.machineId || busy}
            loading={busy}
            onClick={() => void saveMachine()}
          >
            {t("agentPage.work.computer.useMachine", { computer: machineChosen ? s.nameOf(machineChosen.name) : "" })}
          </Button>
        ),
      });
    return null;
  };

  const hasBack = trail.length > 1;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="arrival arrival-chat bd"
    >
      <div className="arrival-hero">
        <TeamScene
          agents={[agent]}
          lead={agent.id}
          asleep={asleep}
          day={day}
          expression={switched || arrived ? "happy" : undefined}
        >
          {markOf && (
            <>
              <span
                // A switch done lights the trail anew, one pixel after the other.
                key={switched ? "lit" : "still"}
                className="team-scene__trail"
                data-state={busy ? "walk" : asleep ? undefined : "done"}
                data-lit={switched ? true : undefined}
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <i key={n} style={{ "--n": n } as CSSProperties} />
                ))}
              </span>
              {/* Another account's mark comes in where the last one stood; while one is chosen, an empty place. */}
              <span key={markOf} className={cx("team-scene__mark", markOf === "slot" && "team-scene__mark--slot")}>
                {markOf === "slot" ? (
                  <Icon name="plus" />
                ) : markOf === "key" ? (
                  <Icon name="key" />
                ) : (
                  <ProviderLogo id={planMark(markOf)} size="tile" />
                )}
              </span>
            </>
          )}
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="bd-glide" ref={glide}>
        {/* The screen takes the focus as it comes: named by its title, so a screen reader says where it is (the drawn
            title is hidden from it, and a dialog's own name isn't read again on a move inside). */}
        {/* biome-ignore lint/a11y/useSemanticElements: a screen of the dialog, not a group of form fields */}
        <div
          key={`${screen}:${trail.length}`}
          ref={screenRef}
          className="bd-screen"
          data-dir={dir}
          tabIndex={-1}
          role="group"
          aria-label={title}
        >
          {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
          <div className="arrival-lede arrival-lede--row">
            {hasBack && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="chevronLeft"
                aria-label={t("common.back")}
                disabled={busy}
                onClick={back}
              />
            )}
            <p className="arrival-lede__title" aria-hidden="true">
              {title}
            </p>
          </div>
          <DialogBody>{body()}</DialogBody>
        </div>
        {foot()}
      </div>
      {copying && copyFrom && (
        <UseOnAgentsDialog
          initial={copyFrom}
          extra={{ contextTokens: s.shownContext, ...(s.speedOn ? { speed: view.speed } : {}) }}
          exclude={agent.id}
          autonomy={view.autonomy}
          onClose={() => {
            setCopying(false);
            refresh();
          }}
        />
      )}
      {asks.dialog}
    </Dialog>
  );
}
