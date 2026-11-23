import {
  type Routine,
  useAgentMail,
  useAgentScopes,
  useChannels,
  useCustomServers,
  useMailAccounts,
  useMailFolders,
  useRoutineAction,
  useRoutines,
  useRuleDescribe,
  useRuleParse,
} from "@agenteschat/client";
import { createsRoutinesFor } from "@agenteschat/client/lib/audience";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { upperFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { splitAddresses } from "@agenteschat/client/lib/mail";
import { routineReachWarnings } from "@agenteschat/client/lib/reach";
import {
  blankLeft,
  ownWords,
  type RoutineTemplateOption,
  templateRule,
} from "@agenteschat/client/lib/routine-templates";
import { busyOnComputer, eventWebhook, runsPerDay } from "@agenteschat/client/lib/routine-view";
import {
  connectionReader,
  mailboxReader,
  timezoneName,
  triggerChoices,
  zoneDisplayName,
} from "@agenteschat/client/lib/routines";
import { WEEKDAYS } from "@agenteschat/ui/recurrence";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  OPTION_ROW,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { boldRuns } from "../chat/actions";
import { AllowTalkAction } from "../chat/ReachLines";
import { closeAgentPick, openAgentPick } from "../dashboards/agent-pick";
import { closeOptionPick, openOptionPick, type PickChoice } from "../dashboards/option-pick";
import { MissingScreen } from "../dashboards/parts";
import { routineHref } from "../links/logic";
import { ZoneList } from "../me/AccountPage";
import { SettingsPage, useUnsavedGuard } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useEdition, useMeId, useNamesComputers, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack, successHaptic } from "../shared/parts";
import { overLimit, TextArea } from "../shared/TextArea";
import { EventWebhookSetup } from "./EventWebhookSetup";
import { useFailed, useMyZone, useSay, useTargetLabel } from "./hooks";
import {
  draftChanges,
  draftInput,
  draftOf,
  everyMinutes,
  INBOX,
  inboxOf,
  isDoneOnce,
  isInbox,
  isUtc,
  phraseOf,
  ROUTINE_EVENTS,
  type RoutineDraft,
  ruleOf,
  TARGET_ARTIFACT,
  TARGET_DM,
  TARGET_KEEP,
  type TriggerKind,
  targetChoice,
  targetIcon,
  toastParts,
  wasUtc,
  zoneOf,
} from "./logic";
import { AgentAccessNote } from "./parts";
import {
  COMMON_RULES,
  fromApiRule,
  HALF_HOURS,
  nextDays,
  nextLabel,
  presetOf,
  type RulePreset,
  ruleSentence,
  runLabel,
  toApiRule,
  upcomingLabels,
  withPreset,
} from "./rule";
import { TemplatePicker } from "./TemplatePicker";
import { WebhookCard } from "./WebhookCard";
import { setRoutineZone, useRoutineZone } from "./zone";

const PROMPT_LIMIT = { max: FIELD_LIMITS.routinePrompt };

const close = () => goBack("/routines");

/** What starts a routine, as its tile: the clock, an event, an email, a webhook call (as the list's rows). */
const kindIcon = (kind: TriggerKind): IconName =>
  kind === "event"
    ? "bolt"
    : kind === "email" || kind === "connector"
      ? "mail"
      : kind === "webhook"
        ? "globe"
        : "clock";

/** A zone as the form says it: "Horário de Brasília" (a friendly name) or the city. */
const zoneLabel = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * "Nova rotina" and "Editar rotina" (`?edit=<id>`), a screen pushed over Rotinas with the native bar (back, the
 * title, "Criar" or "Salvar"), the web's form for the phone: a starting point (new only), the agent, where it
 * delivers (a channel, the DM, a Drive document; a routine made in the chat keeps its conversation), what to do, a name, and when: a phrase the server reads ("toda segunda às 9h")
 * shown back as a sentence with the next runs and its time zone (a screen of its own), an event, or an email.
 * Then when it posts and what it may do on its own. Editing saves only what changed. On the settings' form page: a
 * focused field scrolls clear of the keyboard on both systems and the bar over the keyboard walks the fields; leaving
 * after changing anything asks first.
 */
export function RoutineForm({ editId }: { editId: string | null }) {
  const { t } = useTranslation();
  const routines = useRoutines(useOrgId());
  const routine = editId ? routines.data?.find((r) => r.id === editId) : undefined;
  if (editId && !routine)
    return (
      <MissingScreen
        title={t("routines.editTitle")}
        state={routines.isLoading ? "loading" : routines.isError && !routines.data ? "failed" : "gone"}
        onRetry={() => void routines.refetch()}
        gone={t("mobile.notFound.subtitle")}
      />
    );
  return <Form key={routine?.id ?? "new"} routine={routine} />;
}

function Form({ routine }: { routine: Routine | undefined }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const toast = useToast();
  const failed = useFailed();
  const say = useSay();
  const dir = useDirectory();
  const me = useMeId();
  // Whose reach the routine has: its creator (kept on edit), else whoever creates it now.
  const creator = routine?.createdByUserId ?? me;
  const channels = useChannels(orgId);
  const mailboxes = useMailAccounts(orgId);
  const eventConnections = (useCustomServers(orgId).data ?? []).filter((s) =>
    s.events?.includes("millionsend.email.received"),
  );
  const targetLabel = useTargetLabel();
  const action = useRoutineAction(orgId);
  // The agents this person may make a routine for (`createsRoutinesFor`: they set up its routines, who edits each one
  // and "Create routines" where it reaches, and it answers them, since a routine asks it on its creator's behalf; ADR
  // 0085 addendum of 2026-11-17), as the server checks a new routine and a move to another agent. A routine being
  // edited keeps its own agent, which whoever edits it needn't talk to.
  const agents = useMemo(
    () => dir.agents.filter((a) => createsRoutinesFor(a) || a.id === routine?.agentId),
    [dir.agents, routine?.agentId],
  );
  const editing = Boolean(routine);
  const myZone = useMyZone("America/Sao_Paulo");
  const savedZone = zoneOf(routine);
  // A routine still read in UTC (made before time zones) starts in my zone, with a hint to keep UTC.
  const utc = wasUtc(routine);
  const [d, setD] = useState<RoutineDraft>(() => draftOf(routine, utc ? myZone : savedZone || myZone));
  // Anything the person changed (the defaults filled in as lists load are not theirs): a back swipe asks first.
  const [touched, setTouched] = useState(false);
  const leave = useUnsavedGuard(touched);
  const edit = (next: (x: RoutineDraft) => RoutineDraft) => {
    setTouched(true);
    setD(next);
  };
  const set = (patch: Partial<RoutineDraft>) => edit((x) => ({ ...x, ...patch }));
  // What the routine had, to tell whether "when" changed.
  const [savedRule] = useState(() => JSON.stringify(toApiRule(ruleOf(routine, savedZone || myZone))));
  // The agent and the lists to pick from (where it delivers, the mailbox, the folder, a starting point) are screens
  // of their own, pushed over the form: what is picked there comes back through their stores, which end with it.
  useEffect(
    () => () => {
      closeAgentPick();
      closeOptionPick();
    },
    [],
  );
  const pickFrom = (title: string, value: string | null, options: PickChoice[], apply: (key: string) => void) => {
    openOptionPick({ title, value, options, apply });
    router.push("/option-pick");
  };

  // My zone may arrive after the form opens (the people list loads): follow it until a zone is picked.
  const [zoneTouched, setZoneTouched] = useState(false);
  const followsMyZone = !routine || utc;
  const setZone = (zone: string) => {
    setZoneTouched(true);
    edit((x) => ({ ...x, rule: { ...x.rule, timezone: zone } }));
  };
  useEffect(() => {
    if (followsMyZone && !zoneTouched)
      setD((x) => (x.rule.timezone === myZone ? x : { ...x, rule: { ...x.rule, timezone: myZone } }));
  }, [myZone, followsMyZone, zoneTouched]);
  // "Fuso horário" is a screen of its own: the zone picked there comes back through its store.
  const picked = useRoutineZone();
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new pick applies
  useEffect(() => {
    if (picked && picked !== d.rule.timezone) setZone(picked);
  }, [picked]);
  useEffect(() => () => setRoutineZone(null), []);
  const pickZone = () => {
    setRoutineZone(d.rule.timezone);
    router.push("/routines/zone");
  };

  // The first agent and channel until the person picks.
  useEffect(() => {
    const first = agents[0];
    if (!d.agentId && first) setD((x) => ({ ...x, agentId: first.id }));
  }, [d.agentId, agents]);
  useEffect(() => {
    const first = channels.data?.[0];
    if (!d.target && first) setD((x) => ({ ...x, target: first.id }));
  }, [d.target, channels.data]);

  // What the person typed, in any language: the server reads it (never the phone) and it becomes the rule.
  const [phrase, setPhrase] = useState(phraseOf(routine));
  const [phraseTyped, setPhraseTyped] = useState(false);
  const typePhrase = (text: string) => {
    setTouched(true);
    setPhrase(text);
    setPhraseTyped(true);
  };
  const typed = useDeferredValue(phrase.trim());
  // A pick from the rows (Repetição, Dia, Horário) replaces a kept cron and any phrase, as a phrase read would.
  const [rulePicked, setRulePicked] = useState(false);
  // The phrase field: for what the rows don't hold, opened from Repetição's last choice.
  const [writing, setWriting] = useState(false);
  const schedule = d.kind === "schedule";
  const once = d.rule.freq === "once";
  const parsed = useRuleParse(orgId, typed, schedule && phraseTyped && typed.length > 0, d.rule.timezone);
  const parsedRule = parsed.data?.ok ? parsed.data.rule : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply each new parse once
  useEffect(() => {
    if (parsedRule && phraseTyped)
      setD((x) => ({ ...x, rule: { ...fromApiRule(parsedRule, x.rule.start), timezone: x.rule.timezone } }));
  }, [parsedRule]);
  const described = useRuleDescribe(orgId, schedule && !once ? toApiRule(d.rule) : null);
  const info = described.data?.ok ? described.data : null;
  const upcoming = info?.nextRuns.length
    ? info.nextRuns.slice(0, 3).map((iso) => runLabel(i18n.language, iso, d.rule.timezone))
    : upcomingLabels(i18n.language, d.rule);
  const phraseFailed = phraseTyped && typed.length > 0 && parsed.data?.ok === false;
  // Still reading the phrase: saving now would keep the rule from before it.
  const parsing = schedule && phraseTyped && phrase.trim().length > 0 && (phrase.trim() !== typed || parsed.isFetching);
  // A routine kept as a cron (every N minutes) says so until a phrase replaces it.
  // A phrase read into a rule replaces it; one typed and erased doesn't (the form's rule is still a placeholder).
  const ruleTyped = phraseTyped && phrase.trim().length > 0;
  const cron =
    routine?.trigger.type === "schedule" && !routine.trigger.rule && !ruleTyped && !rulePicked ? routine.trigger : null;
  const every = cron ? everyMinutes(cron.cron) : null;
  const sentence = cron
    ? every
      ? t("recurrence.s.minutely", { count: every })
      : cron.description
    : ruleSentence(t, i18n.language, d.rule, new Date(), false);
  const phraseError = (() => {
    if (!phraseFailed || !parsed.data || parsed.data.ok) return null;
    const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    const code = parsed.data.code;
    return code
      ? tt(`routines.form.parseError.${code.replace(/\./g, "_")}`, { defaultValue: parsed.data.error })
      : parsed.data.error;
  })();

  // "Quando" as rows, each value from the system's list: Repetição, then the day it falls on, then the time.
  const preset: RulePreset = cron ? "custom" : presetOf(d.rule);
  const presetWord = (p: RulePreset) =>
    p === "once"
      ? t("recurrence.mode.once")
      : p === "daily"
        ? t("recurrence.s.daily", { count: 1 })
        : p === "business"
          ? t("recurrence.s.businessDays")
          : p === "weekly"
            ? t("recurrence.s.weekly", { count: 1 })
            : p === "monthly"
              ? t("recurrence.s.monthly", { count: 1 })
              : t("mobile.routines.when.custom");
  const pickRule = (next: typeof d.rule) => {
    edit((x) => ({ ...x, rule: next }));
    setRulePicked(true);
    setPhrase("");
    setPhraseTyped(false);
  };
  // Repetição, Dia, Horário and Fuso in the app's picker: the one in use checked, the long lists (days of the month,
  // times, zones) with their search.
  const choose = (title: string, options: { label: string; checked: boolean; onPress: () => void }[]) =>
    void pickOne({
      title,
      value: String(options.findIndex((o) => o.checked)),
      options: options.map((o, i) => ({ key: String(i), label: o.label })),
    }).then((key) => {
      if (key !== null) options[Number(key)]?.onPress();
    });
  const pickPreset = () =>
    choose(t("recurrence.frequency"), [
      ...COMMON_RULES.map((p) => ({
        label: presetWord(p),
        checked: preset === p,
        onPress: () => pickRule(withPreset(d.rule, p)),
      })),
      { label: t("mobile.routines.when.write"), checked: false, onPress: () => setWriting(true) },
    ]);
  const capital = (word: string) => word.charAt(0).toLocaleUpperCase(i18n.language) + word.slice(1);
  const dayWord = (ymd: string) =>
    capital(
      new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric", month: "short" }).format(
        new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))),
      ),
    );
  const monthDayWord = (day: number) =>
    day === -1 ? t("mobile.routines.when.lastDay") : t("mobile.routines.when.monthDay", { day });
  const dayValue =
    preset === "weekly"
      ? capital(t(`recurrence.wd.${d.rule.byWeekday?.[0] ?? "MO"}.long`))
      : preset === "monthly"
        ? monthDayWord(d.rule.byMonthDay?.[0] ?? 1)
        : preset === "once"
          ? dayWord(d.rule.start)
          : null;
  const pickDay = () =>
    choose(
      t("mobile.routines.when.day"),
      preset === "weekly"
        ? WEEKDAYS.map((w) => ({
            label: capital(t(`recurrence.wd.${w}.long`)),
            checked: d.rule.byWeekday?.[0] === w,
            onPress: () => pickRule({ ...d.rule, byWeekday: [w] }),
          }))
        : preset === "monthly"
          ? [...Array.from({ length: 28 }, (_, i) => i + 1), -1].map((day) => ({
              label: monthDayWord(day),
              checked: d.rule.byMonthDay?.[0] === day,
              onPress: () => pickRule({ ...d.rule, byMonthDay: [day] }),
            }))
          : nextDays().map((ymd) => ({
              label: dayWord(ymd),
              checked: d.rule.start === ymd,
              onPress: () => pickRule({ ...d.rule, start: ymd }),
            })),
    );
  const time = d.rule.times[0] ?? "09:00";
  const pickTime = () =>
    choose(
      t("recurrence.times"),
      (HALF_HOURS.includes(time) ? HALF_HOURS : [...HALF_HOURS, time].sort()).map((hhmm) => ({
        label: hhmm,
        checked: hhmm === time,
        onPress: () => pickRule({ ...d.rule, times: [hhmm] }),
      })),
    );
  const showPhrase = writing || cron !== null || preset === "custom";

  // "Quando chegar um email": the first mailbox its agent reads, and its inbox, until the person picks (as the web's,
  // the mailboxes the agent can't read aren't offered: the server refuses them).
  const allMail = mailboxes.data ?? [];
  const hasMail = d.kind === "email" || allMail.length > 0;
  const reads = useAgentMail(orgId, d.agentId, d.kind === "email" && Boolean(d.agentId) && allMail.length > 0);
  const mailPick = triggerChoices(
    allMail,
    d.agentId && reads.data ? mailboxReader(reads.data) : undefined,
    d.email.accountId,
  );
  const mailList = mailPick.options;
  const firstMailbox = d.agentId && allMail.length > 0 && reads.isPending ? undefined : mailList[0]?.id;
  const folders = useMailFolders(orgId, d.kind === "email" && d.email.accountId ? d.email.accountId : null);
  useEffect(() => {
    if (d.kind === "email" && !d.email.accountId && firstMailbox)
      setD((x) => ({ ...x, email: { ...x.email, accountId: firstMailbox, folder: "" } }));
  }, [d.kind, d.email.accountId, firstMailbox]);
  useEffect(() => {
    if (d.email.accountId && !d.email.folder && (folders.data || folders.isError))
      setD((x) => ({ ...x, email: { ...x.email, folder: inboxOf(folders.data) } }));
  }, [d.email.accountId, d.email.folder, folders.data, folders.isError]);
  const folderName = (id: string, name?: string, role?: string) =>
    isInbox(id) || role === "inbox" ? t("mail.routine.inbox") : (name ?? id);
  const folderOptions = folders.data?.length
    ? folders.data.map((f) => ({ id: f.id, label: folderName(f.id, f.name, f.role) }))
    : [{ id: d.email.folder || INBOX, label: folderName(d.email.folder || INBOX) }];
  const folderLabel = folderOptions.find((f) => f.id === d.email.folder)?.label ?? folderName(d.email.folder || INBOX);
  const mailbox = mailList.find((a) => a.id === d.email.accountId);
  // "De": addresses or @domains, typed with commas or spaces; one that isn't keeps the form from saving.
  const [fromText, setFromText] = useState(() => (d.email.filter.from ?? []).join(", "));
  const from = splitAddresses(fromText);
  const setFrom = (text: string) => {
    setFromText(text);
    const { valid } = splitAddresses(text);
    edit((x) => ({ ...x, email: { ...x.email, filter: { ...x.email.filter, from: valid } } }));
  };
  const setFilter = (patch: { subject?: string; text?: string }) =>
    edit((x) => ({ ...x, email: { ...x.email, filter: { ...x.email.filter, ...patch } } }));
  const fromBad = d.kind === "email" && from.invalid.length > 0;
  // "Email no MillionSend" (ADR 0130): the first connection, its inbox's address and the same filters.
  const hasMillionSend = d.kind === "connector" || eventConnections.length > 0;
  const grants = useAgentScopes(orgId, d.agentId, d.kind === "connector" && Boolean(d.agentId));
  const connectionPick = triggerChoices(
    eventConnections,
    d.agentId && grants.data ? connectionReader(grants.data) : undefined,
    d.connector.connectionId,
  );
  const firstConnection = d.agentId && grants.isPending ? undefined : connectionPick.options[0]?.id;
  useEffect(() => {
    if (d.kind === "connector" && !d.connector.connectionId && firstConnection)
      setD((x) => ({ ...x, connector: { ...x.connector, connectionId: firstConnection } }));
  }, [d.kind, d.connector.connectionId, firstConnection]);
  const [msFromText, setMsFromText] = useState(() => (d.connector.filter.from ?? []).join(", "));
  const msFrom = splitAddresses(msFromText);
  const setConnectorFilter = (patch: { to?: string; from?: string[]; subject?: string }) =>
    edit((x) => ({ ...x, connector: { ...x.connector, filter: { ...x.connector.filter, ...patch } } }));
  const msFromBad = d.kind === "connector" && msFrom.invalid.length > 0;

  // What starts it: the clock, an event, an email (a mailbox's, MillionSend's) or a webhook call.
  const kinds: TriggerKind[] = [
    "schedule",
    "event",
    ...(hasMail ? (["email"] as const) : []),
    ...(hasMillionSend ? (["connector"] as const) : []),
    "webhook",
  ];
  const pickKind = () =>
    void pickOne({
      title: t("routines.form.when"),
      value: d.kind,
      options: kinds.map((k) => ({
        key: k,
        label: t(`routines.form.kind.${k}`),
        leading: { kind: "icon" as const, name: kindIcon(k) },
      })),
    }).then((key) => {
      const kind = kinds.find((k) => k === key);
      if (kind) set({ kind });
    });

  // A routine on someone's computer that runs hourly or more often: how often it wakes that computer.
  const brain = dir.agentById.get(d.agentId)?.brain;
  const selfHost = useEdition() === "selfhost";
  const namesComputer = useNamesComputers();
  const busy =
    schedule && !once && brain
      ? busyOnComputer({ kind: brain.kind, machineName: brain.computer ?? null }, runsPerDay(toApiRule(d.rule)), {
          selfHost,
          namesComputer,
        })
      : null;

  const promptHidden = routine !== undefined && routine.prompt === null;
  const scheduleOk =
    d.kind === "event" ||
    d.kind === "webhook" ||
    (d.kind === "connector"
      ? Boolean(d.connector.connectionId) && !msFromBad
      : d.kind === "email"
        ? Boolean(d.email.accountId) && !fromBad
        : !phraseFailed);
  const [template, setTemplate] = useState<RoutineTemplateOption>();
  const unfilled = blankLeft(d.prompt, template);
  const ready =
    !action.isPending &&
    Boolean(d.agentId) &&
    (promptHidden || d.prompt.trim().length > 0) &&
    !overLimit(d.prompt, PROMPT_LIMIT) &&
    !unfilled &&
    scheduleOk &&
    !parsing;

  /** A starting point fills the form; everything in it stays the person's to change. */
  const applyTemplate = (o: RoutineTemplateOption) => {
    const picked = o.template;
    setTemplate(o);
    setPhrase("");
    setPhraseTyped(false);
    edit((x) => ({
      ...x,
      prompt: o.prompt,
      name: o.label,
      report: o.report,
      kind: picked.kind,
      ...(picked.kind === "event" ? { event: picked.event } : {}),
      ...(picked.kind === "schedule" ? { rule: templateRule(picked, x.rule) } : {}),
    }));
  };
  const pickTemplate = (o: RoutineTemplateOption) => {
    if (!ownWords(d.prompt, template)) return applyTemplate(o);
    Alert.alert(t("routines.presets.replaceTitle"), undefined, [
      { text: t("mobile.common.cancel"), style: "cancel" },
      { text: t("routines.presets.replaceConfirm"), style: "destructive", onPress: () => applyTemplate(o) },
    ]);
  };

  /**
   * Saved: a routine that just became a webhook routine opens on its page, where its address is: the page under this
   * form when it was opened from there, else in place of the form.
   */
  const done = (saved: Routine | undefined) => {
    leave();
    if (saved?.trigger.type === "webhook") router.dismissTo(routineHref(saved.id));
    else close();
  };
  const submit = () => {
    if (!ready) return;
    if (routine) {
      const patch = draftChanges(routine, d, savedRule, ruleTyped || rulePicked);
      if (Object.keys(patch).length === 0) {
        leave();
        close();
        return;
      }
      action.mutate(
        { type: "update", id: routine.id, patch },
        {
          onSuccess: (saved) => {
            const next = (saved as Routine | undefined)?.nextRunAt;
            successHaptic();
            toast({
              ...toastParts(
                next
                  ? t("routines.form.saved", { next: t("routines.next", { when: nextLabel(i18n.language, next) }) })
                  : t("routines.form.savedNoNext"),
              ),
              agentId: d.agentId,
            });
            if (routine.trigger.type !== "webhook") done(saved as Routine);
            else {
              leave();
              close();
            }
          },
          onError: failed,
        },
      );
      return;
    }
    action.mutate(
      { type: "create", input: draftInput(d) },
      {
        onSuccess: (created) => {
          successHaptic();
          toast({ title: t("routines.form.created"), agentId: d.agentId });
          done(created as Routine);
        },
        onError: failed,
      },
    );
  };

  const agent = dir.agentById.get(d.agentId);
  /** The agent: the app's agent picker, pushed (the agents whose routines this person sets up, talked to or not). */
  const pickAgent = () => {
    if (agents.length === 0) return;
    openAgentPick({
      agentId: d.agentId || null,
      apply: (agentId) => set({ agentId }),
      title: t("routines.form.agent"),
      note: "",
      everyone: true,
      ids: agents.map((a) => a.id),
    });
    router.push("/agent-pick");
  };
  const targets: (PickChoice & { icon: IconName })[] = [
    // A routine made in the chat (a thread or a DM) keeps its conversation.
    ...(routine && targetChoice(routine.target) === TARGET_KEEP
      ? [{ key: TARGET_KEEP, icon: targetIcon(routine.target), label: targetLabel(routine.target) }]
      : []),
    ...(channels.data ?? []).map((ch) => ({
      key: ch.id,
      icon: ch.visibility === "private" ? ("lock" as const) : ("hash" as const),
      label: `#${ch.name}`,
    })),
    { key: TARGET_DM, icon: "chat", label: t("routines.target.dm"), sub: t("routines.panel.whereHint.dm") },
    {
      key: TARGET_ARTIFACT,
      icon: "doc",
      label: t("routines.target.artifact"),
      sub: t("routines.panel.whereHint.artifact"),
    },
  ];
  const target = targets.find((o) => o.key === d.target);
  const pickTarget = () => pickFrom(t("routines.form.target"), d.target, targets, (key) => set({ target: key }));
  const pickMailbox = () =>
    pickFrom(
      t("mail.routine.mailbox"),
      d.email.accountId,
      mailList.map((a) => ({ key: a.id, icon: "mail", label: a.address })),
      (accountId) => edit((x) => ({ ...x, email: { ...x.email, accountId, folder: "" } })),
    );
  const pickFolder = () =>
    pickFrom(
      t("mail.routine.folder"),
      d.email.folder,
      folderOptions.map((f) => ({ key: f.id, icon: "archive", label: f.label })),
      (folder) => edit((x) => ({ ...x, email: { ...x.email, folder } })),
    );
  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  return (
    <SettingsPage
      title={editing ? t("routines.editTitle") : t("routines.new")}
      action={{ label: editing ? t("common.save") : t("mobile.routines.create"), disabled: !ready, onPress: submit }}
      locked={action.isPending}
      toolbar
    >
      {agents.length === 0 && !dir.loading ? <GroupedFooter>{t("routines.form.noAgents")}</GroupedFooter> : null}
      {!editing ? <TemplatePicker value={template?.value} onPick={pickTemplate} /> : null}

      <GroupedHeader>{t("routines.form.agent")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={agent?.name ?? ""}
          leading={agent ? <AgentFace agentId={agent.id} size={OPTION_ROW.face} live={false} /> : undefined}
          icon={agent ? undefined : "agent"}
          value={agent?.role || undefined}
          chevron={agents.length > 0}
          {...(agents.length > 0 ? { onPress: pickAgent } : {})}
        />
      </GroupedList>

      <GroupedHeader>{t("routines.form.target")}</GroupedHeader>
      <GroupedList>
        <GroupedRow icon={target?.icon ?? "hash"} label={target?.label ?? "#"} chevron onPress={pickTarget} />
      </GroupedList>
      <GroupedHeader>{t("routines.form.what")}</GroupedHeader>
      {promptHidden ? (
        <GroupedFooter>{t("routines.detailsHidden")}</GroupedFooter>
      ) : (
        <TextArea
          value={d.prompt}
          onChangeText={(prompt) => set({ prompt })}
          placeholder={t("routines.form.whatPlaceholder")}
          accessibilityLabel={t("routines.form.what")}
          minHeight={110}
          limit={PROMPT_LIMIT}
        />
      )}
      {unfilled ? <GroupedFooter>{t("routines.presets.fillBlank")}</GroupedFooter> : null}
      <GroupedHeader>{editing ? t("routines.form.title") : t("routines.form.name")}</GroupedHeader>
      <TextArea
        value={d.name}
        onChangeText={(name) => set({ name })}
        accessibilityLabel={editing ? t("routines.form.title") : t("routines.form.name")}
        multiline={false}
        minHeight={50}
        returnKeyType="done"
        maxLength={200}
      />

      <GroupedHeader>{t("routines.form.when")}</GroupedHeader>
      {/* What starts it, picked in the app's picker (up to five kinds: a row of segments ran off a phone). */}
      <GroupedList>
        <GroupedRow icon={kindIcon(d.kind)} label={t(`routines.form.kind.${d.kind}`)} menu onPress={pickKind} />
      </GroupedList>
      {schedule ? (
        <>
          <View style={styles.gap} />
          <GroupedList>
            {/* A routine kept as a cron says so in its own words until a pick or a phrase replaces it. */}
            {cron ? (
              <View style={styles.sentence}>
                <Text variant="body" accessibilityLiveRegion="polite">
                  {sentence}
                </Text>
              </View>
            ) : null}
            <GroupedRow
              key="repeat"
              icon="replay"
              label={t("recurrence.frequency")}
              value={presetWord(preset)}
              menu
              onPress={pickPreset}
            />
            {dayValue !== null ? (
              <GroupedRow
                key="day"
                icon="sun"
                label={t("mobile.routines.when.day")}
                value={dayValue}
                menu
                onPress={pickDay}
              />
            ) : null}
            {preset !== "custom" ? (
              <GroupedRow key="time" icon="clock" label={t("recurrence.times")} value={time} menu onPress={pickTime} />
            ) : null}
            {/* A cron keeps its own zone until a phrase replaces it: nothing here could change it. */}
            {cron ? null : (
              <GroupedField label={t("routines.form.timezone")} onPress={pickZone}>
                <Text variant="callout" numberOfLines={1}>
                  {zoneLabel(d.rule.timezone, i18n.language)}
                </Text>
              </GroupedField>
            )}
          </GroupedList>
          {/* The rows read back as one sentence, with the next runs: what the person checks before saving. */}
          {cron ? null : (
            <GroupedFooter>
              {[sentence, upcoming.length > 0 ? `${t("routines.form.next")}: ${upcoming.join(" · ")}` : null]
                .filter(Boolean)
                .join("\n")}
            </GroupedFooter>
          )}
          {utc && !cron && !isUtc(d.rule.timezone) ? (
            <View style={styles.utc}>
              <Text variant="footnote" tone="faint">
                {t("routines.form.utcHint", { zone: timezoneName(d.rule.timezone, i18n.language) })}
              </Text>
              <Pressable
                onPress={() => setZone("UTC")}
                accessibilityRole="button"
                hitSlop={14}
                style={({ pressed }) => (pressed ? styles.pressed : null)}
              >
                <Text variant="footnote" tone="ink2" style={styles.link}>
                  {t("routines.form.keepUtc")}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {showPhrase ? (
            <>
              {/* Under Repetição, Dia and Horário: "Do seu jeito", what the rows don't hold. */}
              <GroupedHeader>{t("mobile.routines.when.custom")}</GroupedHeader>
              <TextArea
                value={phrase}
                onChangeText={typePhrase}
                placeholder={t("recurrence.phrasePlaceholder")}
                accessibilityLabel={t("routines.form.frequency")}
                multiline={false}
                minHeight={50}
                autoCorrect={false}
                autoFocus={writing && !phrase}
                returnKeyType="done"
                maxLength={300}
              />
            </>
          ) : null}
          {phraseError ? (
            <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
              {phraseError}
            </Text>
          ) : null}
          {busy ? <GroupedFooter>{say(busy)}</GroupedFooter> : null}
        </>
      ) : null}
      {d.kind === "event" ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("routines.form.event") }),
              text: t("routines.form.eventHelp", { org: org?.name ?? "" }),
            }}
          >
            {t("routines.form.event")}
          </GroupedHeader>
          <GroupedList>
            {ROUTINE_EVENTS.map((e) => (
              <GroupedRow
                key={e}
                icon="bolt"
                label={t(`routines.event.${e}`)}
                checked={d.event === e}
                onPress={() => set({ event: e })}
              />
            ))}
          </GroupedList>
          {eventWebhook(d.event) ? <EventWebhookSetup provider={eventWebhook(d.event) ?? "github"} /> : null}
        </>
      ) : null}
      {d.kind === "email" ? (
        mailboxes.isSuccess && allMail.length === 0 ? (
          <View style={styles.noMail}>
            <Text variant="footnote" tone="faint">
              {t("mail.routine.noMailbox")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              icon="bolt"
              label={t("mail.routine.openConnectors")}
              onPress={() => router.push("/connectors")}
            />
          </View>
        ) : (
          <>
            {mailPick.cantRead ? (
              <AgentAccessNote
                agentId={d.agentId}
                words={mailList.length === 0 ? "mail.routine.readsNone" : "mail.routine.cantRead"}
              />
            ) : null}
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow
                icon="mail"
                label={t("mail.routine.mailbox")}
                value={
                  mailbox?.address ??
                  // Someone else's mailbox the routine already watches isn't listed to the viewer: it stays, unnamed.
                  (d.email.accountId ? upperFirst(t("mail.routine.unknownMailbox"), i18n.language) : undefined)
                }
                chevron={mailList.length > 1}
                {...(mailList.length > 1 ? { onPress: pickMailbox } : {})}
              />
              <GroupedRow
                icon="archive"
                label={t("mail.routine.folder")}
                value={folderLabel}
                chevron={folderOptions.length > 1}
                {...(folderOptions.length > 1 ? { onPress: pickFolder } : {})}
              />
            </GroupedList>
            <GroupedHeader>{t("mail.routine.filters")}</GroupedHeader>
            <GroupedList>
              <GroupedField stacked label={t("mail.routine.from")}>
                <TextInput
                  value={fromText}
                  onChangeText={setFrom}
                  placeholder={t("mail.list.placeholder")}
                  placeholderTextColor={c.faint}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={t("mail.routine.from")}
                  style={input}
                />
              </GroupedField>
              <GroupedField stacked label={t("mail.routine.subject")}>
                <TextInput
                  value={d.email.filter.subject ?? ""}
                  onChangeText={(subject) => setFilter({ subject })}
                  accessibilityLabel={t("mail.routine.subject")}
                  style={input}
                />
              </GroupedField>
              <GroupedField stacked label={t("mail.routine.text")}>
                <TextInput
                  value={d.email.filter.text ?? ""}
                  onChangeText={(text) => setFilter({ text })}
                  accessibilityLabel={t("mail.routine.text")}
                  style={input}
                />
              </GroupedField>
            </GroupedList>
            {fromBad ? (
              <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
                {t("mail.list.invalid")}
              </Text>
            ) : (
              <GroupedFooter>{t("mail.routine.fromHelp")}</GroupedFooter>
            )}
          </>
        )
      ) : null}

      {d.kind === "connector" ? (
        <>
          {connectionPick.cantRead ? (
            <AgentAccessNote
              agentId={d.agentId}
              words={
                connectionPick.options.length === 0
                  ? "mail.routine.connectorReadsNone"
                  : "mail.routine.connectorCantRead"
              }
              values={{
                connector:
                  eventConnections.find((s) => s.id === d.connector.connectionId)?.label ??
                  eventConnections[0]?.label ??
                  "",
              }}
            />
          ) : null}
          <View style={styles.gap} />
          <GroupedList>
            <GroupedField stacked label={t("mail.routine.inboxAddress")}>
              <TextInput
                value={d.connector.filter.to ?? ""}
                onChangeText={(to) => setConnectorFilter({ to })}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("mail.routine.inboxAddress")}
                style={input}
              />
            </GroupedField>
          </GroupedList>
          <GroupedFooter>{t("mail.routine.inboxAddressHelp")}</GroupedFooter>
          <GroupedHeader>{t("mail.routine.filters")}</GroupedHeader>
          <GroupedList>
            <GroupedField stacked label={t("mail.routine.from")}>
              <TextInput
                value={msFromText}
                onChangeText={(text) => {
                  setMsFromText(text);
                  setConnectorFilter({ from: splitAddresses(text).valid });
                }}
                placeholder={t("mail.list.placeholder")}
                placeholderTextColor={c.faint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("mail.routine.from")}
                style={input}
              />
            </GroupedField>
            <GroupedField stacked label={t("mail.routine.subject")}>
              <TextInput
                value={d.connector.filter.subject ?? ""}
                onChangeText={(subject) => setConnectorFilter({ subject })}
                accessibilityLabel={t("mail.routine.subject")}
                style={input}
              />
            </GroupedField>
          </GroupedList>
          {msFromBad ? (
            <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
              {t("mail.list.invalid")}
            </Text>
          ) : (
            <GroupedFooter>{t("mail.routine.fromHelp")}</GroupedFooter>
          )}
        </>
      ) : null}

      {d.kind === "webhook" ? (
        routine?.trigger.type === "webhook" ? (
          <WebhookCard routine={routine} runs={routine.recentRuns} />
        ) : (
          <GroupedFooter
            hint={{
              name: t("common.about", { label: t("routines.webhook.address") }),
              text: t("routines.webhook.newNote"),
            }}
          >
            {t("routines.webhook.newShort")}
          </GroupedFooter>
        )
      ) : null}

      <GroupedHeader
        hint={{ name: t("common.about", { label: t("routines.form.report") }), text: t("routines.report.hint") }}
      >
        {t("routines.form.report")}
      </GroupedHeader>
      <GroupedList>
        {(["always", "when_new"] as const).map((v) => (
          <GroupedRow
            key={v}
            label={t(`routines.report.${v}`)}
            checked={d.report === v}
            onPress={() => set({ report: v })}
          />
        ))}
      </GroupedList>
      {routineReachWarnings(d.prompt, dir.agents, {
        agentId: d.agentId || null,
        creatorUserId: creator === me ? null : creator,
        creatorRoleIds: creator ? dir.memberById.get(creator)?.roleIds : undefined,
      }).map((w) => (
        <View key={w.agent.id} style={styles.warning}>
          <Text variant="footnote" tone="ink2" accessibilityLiveRegion="polite">
            {boldRuns(t("routines.reachWarning.blocked", { ...agentGrammar(w.agent.name) }) as string).map((r, i) =>
              r.bold ? (
                <Text key={String(i)} variant="footnote" tone="ink" style={styles.bold}>
                  {r.text}
                </Text>
              ) : (
                r.text
              ),
            )}
          </Text>
          {creator ? <AllowTalkAction agent={w.agent} userId={creator} /> : null}
        </View>
      ))}
      {routine && !isDoneOnce(routine) ? (
        <>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              label={t("routines.form.active")}
              toggle={d.active}
              onPress={() => set({ active: !d.active })}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** "Fuso horário" of the routine form, pushed over it: a pick goes back into the form. */
export function RoutineZonePage() {
  const { t } = useTranslation();
  const zone = useRoutineZone();
  return (
    <ZoneList
      title={t("routines.form.timezone")}
      value={zone}
      onPick={(picked) => {
        if (picked) setRoutineZone(picked);
        goBack();
      }}
    />
  );
}

const styles = StyleSheet.create({
  gap: { height: 10 },
  sentence: { paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 12, gap: 4 },
  // Under its label in a stacked field, on the label's column: the field gives the room around it.
  input: { paddingVertical: 2, paddingHorizontal: 0 },
  utc: { paddingTop: 7, paddingHorizontal: 16, gap: 4 },
  link: { fontWeight: "600", textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
  error: { paddingTop: 7, paddingHorizontal: 16 },
  bold: { fontWeight: "600" },
  warning: { paddingTop: 7, paddingHorizontal: 16, gap: 8, alignItems: "flex-start" },
  noMail: { paddingTop: 10, paddingHorizontal: 16, gap: 10, alignItems: "flex-start" },
});
