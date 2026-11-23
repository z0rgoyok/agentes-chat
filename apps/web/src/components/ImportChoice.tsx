import type { BundleRoutine, ImportItemKind, ImportItemResult, ImportSkipReason } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { joinNames, toYmd } from "@agenteschat/client/lib/format";
import { cronRule } from "@agenteschat/client/lib/routine-view";
import { Alert, Button, Checkbox, DialogFooter, Icon, type IconName, normalizeAppearance } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { failedOffline } from "@/chat/offline";
import { AgentAvatar } from "@/components/AgentAvatar";
import type { ImportFlowState } from "@/components/ImportFlow";
import type { FlowStep, ImportWorkflow } from "@/lib/import";
import { blockedItems, choosable, importApplyErrorText, itemId, picksOf } from "@/lib/import-flow";
import { fromApiRule, ruleSentence } from "@/lib/recurrence";

/** What comes with the agents, a row each in the second step, in this order. */
const GROUPS = ["routine", "skill", "note", "channel"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_ICON: Record<Group, IconName> = { routine: "routines", skill: "bulb", note: "book", channel: "channel" };
const GROUP_COUNT = { routine: "routines", skill: "skills", note: "notes", channel: "channels" } as const;

type Step = "who" | "with" | "flows";
interface View {
  step: number;
  /** A group's list, or a workflow's steps (by its item's id), pushed over the step. */
  open: { group: Group } | { flow: string } | null;
}
const START: View = { step: 0, open: null };

/** Where the team stands on the crossing at each step: it walks a little with each one. */
const atStep = (step: number, of: number) => (of <= 1 ? 0.45 : 0.15 + (0.6 * step) / (of - 1));

export interface ChoiceSheet {
  title: string;
  body: ReactNode;
  foot: ReactNode;
  /** How far along the crossing the team stands. */
  at: number;
}

/**
 * Choosing what comes, one thing at a time on the sheet (ADR 0055, addendum 2026-11-16): who comes, then what comes
 * with them by kind (a box for each kind, its list a tap away), then the workflows and what each becomes, with what
 * to set up afterwards. Every row is a title and a line under it. Nothing is made before the last step's button. Null
 * until there is a plan to choose from, and once it was applied.
 */
export function useChoiceSheet({
  flow,
  standalone,
  todos,
  apply,
  onClose,
}: {
  flow: ImportFlowState;
  standalone: boolean;
  todos: ReactNode;
  apply: { mutate: () => void; isPending: boolean; isError: boolean; error: unknown };
  onClose: () => void;
}): ChoiceSheet | null {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const planned = flow.planned;
  const [view, setView] = useState<View>(START);
  // A new read starts over at the first step.
  const [of, setOf] = useState(planned);
  if (planned !== of) {
    setOf(planned);
    setView(START);
  }
  const blocked = useMemo(
    () => (planned ? blockedItems(planned.bundle, planned.items, flow.pick) : new Map<string, ImportSkipReason>()),
    [planned, flow.pick],
  );
  if (!planned || flow.report) return null;

  const { bundle, items, workflows, passes } = planned;
  const agentOf = new Map(bundle.agents.map((a) => [a.key, a]));
  const channelOf = new Map(bundle.channels.map((c) => [c.key, c]));
  const routineOf = new Map(bundle.routines.map((r) => [r.key, r]));
  const noteOf = new Map(bundle.notes.map((n) => [n.key, n]));
  const nameOf = (key: string) => agentOf.get(key)?.name ?? key;
  const names = (keys: string[]) => joinNames([...new Set(keys)].map(nameOf), t);
  const fromFlow = new Set(workflows.map((w) => itemId(w.item)));
  const rowsOf = (kind: ImportItemKind) => items.filter((i) => i.kind === kind && !fromFlow.has(itemId(i)));
  const free = (i: ImportItemResult) => choosable(i) && !blocked.has(itemId(i));
  const picks = picksOf(items, flow.pick, blocked);
  const nothing = !items.some(choosable);

  const agents = rowsOf("agent");
  const groups = GROUPS.filter((g) => rowsOf(g).length > 0);
  const files = planned.files.filter((f) => !f.skip);
  const steps: Step[] = [
    "who",
    ...(groups.length > 0 || files.length > 0 ? (["with"] as const) : []),
    ...(workflows.length > 0 ? (["flows"] as const) : []),
  ];
  const step = Math.min(view.step, steps.length - 1);
  const at = atStep(step, steps.length);
  const back = (
    <DialogFooter>
      <Button size="lg" block icon="chevronLeft" onClick={() => setView({ step, open: null })}>
        {t("common.back")}
      </Button>
    </DialogFooter>
  );

  const whenOf = (trigger: BundleRoutine["trigger"]) => {
    if ("webhook" in trigger) return t("onboarding.import.choose.webhook");
    if ("event" in trigger) return t("onboarding.import.choose.pr");
    if ("at" in trigger) {
      const date = new Date(trigger.at);
      return Number.isNaN(date.getTime())
        ? trigger.at
        : new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(date);
    }
    const today = toYmd(new Date());
    if ("rule" in trigger) return ruleSentence(t, lang, fromApiRule(trigger.rule, today), new Date(), false);
    const rule = cronRule(trigger.cron, trigger.timezone ?? "");
    if (rule) return ruleSentence(t, lang, fromApiRule(rule, today), new Date(), false);
    const every = /^\*\/(\d+) \* \* \* \*$/.exec(trigger.cron)?.[1];
    return every ? t("recurrence.s.minutely", { count: Number(every) }) : trigger.cron;
  };

  /** An item's own line in a list: whose it is, when it runs, where it posts. */
  const lineOf = (i: ImportItemResult): string => {
    if (i.kind === "agent") return agentOf.get(i.key)?.role || t("onboarding.import.choose.agentOnly");
    if (i.kind === "routine") {
      const r = routineOf.get(i.key);
      if (!r) return "";
      const channel = r.channel ? channelOf.get(r.channel)?.name : undefined;
      const to = passes[r.key] ?? [];
      return [
        nameOf(r.agent),
        whenOf(r.trigger),
        channel ? `#${channel}` : "",
        to.length ? t("onboarding.import.choose.passes", { names: names(to) }) : "",
        r.paused ? t("onboarding.import.choose.pausedOne") : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    if (i.kind === "skill") {
      const md = bundle.skills.find((s) => s.key === i.key)?.markdown ?? "";
      const about = /^description:\s*["']?(.+?)["']?\s*$/m.exec(md)?.[1];
      const users = bundle.agents.filter((a) => a.skills.includes(i.key)).map((a) => a.key);
      return about || (users.length ? names(users) : t("onboarding.import.choose.library"));
    }
    if (i.kind === "channel") {
      const c = channelOf.get(i.key);
      return (
        c?.topic || (c?.agents.length ? t("onboarding.import.with", { names: names(c.agents.map((m) => m.key)) }) : "")
      );
    }
    const n = noteOf.get(i.key);
    return n?.agent
      ? t("onboarding.import.memoryOf", { name: nameOf(n.agent) })
      : t("onboarding.import.memoryWorkspace");
  };
  const titleOf = (i: ImportItemResult) =>
    i.kind === "channel" ? `#${i.label}` : i.kind === "note" ? i.label.replace(/^(#+|[-*+]|\d+[.)])\s+/, "") : i.label;
  const leadOf = (i: ImportItemResult): ReactNode => {
    const a = i.kind === "agent" ? agentOf.get(i.key) : undefined;
    if (a) return <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />;
    return <Icon name={i.kind === "agent" ? "agent" : GROUP_ICON[i.kind]} size={16} />;
  };
  const row = (i: ImportItemResult) => (
    <PickRow
      key={itemId(i)}
      item={i}
      flow={flow}
      reason={blocked.get(itemId(i))}
      lead={leadOf(i)}
      title={titleOf(i)}
      line={lineOf(i)}
    />
  );

  /** A kind's title: how many come, of how many when not all of them. */
  const groupTitle = (g: Group) => {
    const rows = rowsOf(g);
    const on = rows.filter((i) => free(i) && flow.pick.has(itemId(i))).length;
    const here = rows.filter((i) => i.action === "unchanged").length;
    return on + here === rows.length
      ? t(`onboarding.import.sheet.${GROUP_COUNT[g]}`, { count: rows.length })
      : t(`onboarding.import.choose.of.${g}`, { picked: on, count: rows.length });
  };

  /** A kind's row: its title, and a line that says the most useful thing about them. */
  const group = (g: Group) => {
    const rows = rowsOf(g);
    const can = rows.filter(free);
    const on = can.filter((i) => flow.pick.has(itemId(i)));
    let line = "";
    const here = rows.filter((i) => !choosable(i)).length;
    if (g === "routine") {
      const paused = rows.filter((i) => routineOf.get(i.key)?.paused).length;
      line = paused
        ? t("onboarding.import.choose.paused", { count: paused })
        : names(rows.flatMap((i) => routineOf.get(i.key)?.agent ?? []));
    } else if (g === "skill") {
      const users = bundle.agents.filter((a) => a.skills.some((k) => rows.some((i) => i.key === k))).map((a) => a.key);
      line = here
        ? t("onboarding.import.choose.here", { count: here })
        : users.length
          ? names(users)
          : t("onboarding.import.choose.library");
    } else if (g === "note") {
      const owners = rows.flatMap((i) => noteOf.get(i.key)?.agent ?? []);
      line = owners.length ? names(owners) : t("onboarding.import.memoryWorkspace");
    } else {
      line = joinNames(
        rows.map((i) => `#${i.label}`),
        t,
      );
    }
    return (
      <GroupRow
        key={g}
        icon={GROUP_ICON[g]}
        title={groupTitle(g)}
        line={line}
        checked={
          can.length === 0
            ? rows.every((i) => i.action === "unchanged")
            : on.length === 0
              ? false
              : on.length === can.length
                ? true
                : "indeterminate"
        }
        disabled={can.length === 0}
        onCheckedChange={(next) => flow.toggle(can.map(itemId), next)}
        onOpen={() => setView({ step, open: { group: g } })}
      />
    );
  };

  // A pushed list: one kind's items, each with its box.
  const open = view.open;
  if (open && "group" in open) {
    return {
      title: groupTitle(open.group),
      body: <ul className="imp-rows imp-choice">{rowsOf(open.group).map(row)}</ul>,
      foot: back,
      at,
    };
  }
  const shown = open && "flow" in open ? workflows.find((w) => itemId(w.item) === open.flow) : undefined;
  if (shown) {
    const r = shown.item.kind === "routine" ? routineOf.get(shown.item.key) : undefined;
    const channel = r?.channel ? channelOf.get(r.channel)?.name : undefined;
    return {
      title: shown.title,
      body: (
        <>
          <p className="imp-sheet__text">
            {r
              ? t("onboarding.import.choose.becomesRoutine", { agent: nameOf(shown.agent) })
              : t("onboarding.import.choose.becomesSkill", { agent: nameOf(shown.agent) })}
            {channel && ` ${t("onboarding.import.choose.postsIn", { channel })}`}
          </p>
          <FlowSteps
            workflow={shown}
            when={r ? whenOf(r.trigger) : null}
            nameOf={nameOf}
            agentOf={(key) => agentOf.get(key)}
            channelOf={(key) => channelOf.get(key)?.name}
          />
        </>
      ),
      foot: back,
      at,
    };
  }

  const last = step === steps.length - 1;
  const comingAgents = agents.filter((i) => free(i) && flow.pick.has(itemId(i))).length;
  let title = t("onboarding.import.choose.who");
  let body: ReactNode;
  if (steps[step] === "who") {
    title = nothing ? t("onboarding.import.nothingNew") : t("onboarding.import.choose.who");
    body = <ul className="imp-rows imp-choice">{agents.map(row)}</ul>;
  } else if (steps[step] === "with") {
    title = t("onboarding.import.choose.with");
    body = (
      <ul className="imp-rows imp-choice">
        {groups.map(group)}
        {files.length > 0 && (
          <GroupRow
            icon="drive"
            title={t("onboarding.import.choose.files", { count: files.length })}
            line={t("onboarding.import.sheet.filesSize", {
              size: formatBytes(
                lang,
                files.reduce((sum, f) => sum + f.size, 0),
              ),
            })}
            checked={flow.copyFiles}
            onCheckedChange={flow.setCopyFiles}
          />
        )}
      </ul>
    );
  } else {
    title = t("onboarding.import.choose.flows");
    body = (
      <>
        <p className="imp-sheet__text">{t("onboarding.import.choose.flowsLead")}</p>
        <ul className="imp-rows imp-choice">
          {workflows.map((w) => {
            const item = items.find((i) => itemId(i) === itemId(w.item));
            const r = w.item.kind === "routine" ? routineOf.get(w.item.key) : undefined;
            const line = r
              ? [t("onboarding.import.choose.routine"), nameOf(w.agent), whenOf(r.trigger)]
              : [
                  t("onboarding.import.choose.skill"),
                  nameOf(w.agent),
                  w.was && w.was !== "manual"
                    ? t(`onboarding.import.choose.was.${wasOf(w.was)}`)
                    : t("onboarding.import.choose.asked"),
                ];
            const can = !!item && free(item);
            return (
              <GroupRow
                key={itemId(w.item)}
                icon={r ? "routines" : "bulb"}
                title={w.title}
                line={line.join(" · ")}
                checked={can && flow.pick.has(itemId(w.item))}
                disabled={!can}
                onCheckedChange={(next) => flow.toggle([itemId(w.item)], next)}
                onOpen={() => setView({ step, open: { flow: itemId(w.item) } })}
              />
            );
          })}
        </ul>
      </>
    );
  }
  const messaging = bundle.leftOut.filter((l) => l.kind === "messaging").map((l) => l.label);
  if (last) {
    body = (
      <>
        {body}
        {bundle.todo.length > 0 && (
          <div className="imp-sheet__group">
            <p className="imp-sheet__sub">{t("onboarding.import.sheet.after")}</p>
            {todos}
          </div>
        )}
        {messaging.length > 0 && (
          <p className="imp-note ac-iconline">
            <Icon name="info" size={16} />
            <span>{t("onboarding.import.choose.notComing", { list: joinNames(messaging, t) })}</span>
          </p>
        )}
        {apply.isError && <Alert>{importApplyErrorText(t, apply.error, failedOffline)}</Alert>}
        {flow.progress && (
          <p className="imp-apply__progress" role="status">
            {t("onboarding.import.applying", flow.progress)}
          </p>
        )}
      </>
    );
  }

  const more = picks.length - comingAgents;
  const foot = (
    <DialogFooter>
      {!last ? (
        <Button variant="primary" size="lg" block onClick={() => setView({ step: step + 1, open: null })}>
          {t("common.continue")}
        </Button>
      ) : nothing || !standalone ? (
        <Button variant="primary" size="lg" block onClick={onClose}>
          {nothing ? t("common.close") : t("common.continue")}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="lg"
          block
          disabled={picks.length === 0 || apply.isPending}
          loading={apply.isPending}
          onClick={() => apply.mutate()}
        >
          {comingAgents === 0
            ? t("onboarding.import.go", { count: picks.length })
            : more > 0
              ? t("onboarding.import.choose.bringWith", {
                  count: comingAgents,
                  more: t("onboarding.import.choose.more", { count: more }),
                })
              : t("onboarding.import.sheet.bring", { count: comingAgents })}
        </Button>
      )}
      {step > 0 && (
        <p className="imp-sheet__alt">
          <button
            type="button"
            className="ac-link"
            disabled={apply.isPending}
            onClick={() => setView({ step: step - 1, open: null })}
          >
            {t("common.back")}
          </button>
        </p>
      )}
    </DialogFooter>
  );
  return { title, body, foot, at };
}

/** How a workflow that becomes a skill started there, in words (`onboarding.import.choose.was`). */
const WAS = ["schedule", "webhook", "message", "github", "discord", "telegram", "slack"] as const;
const wasOf = (was: string): (typeof WAS)[number] | "other" => WAS.find((w) => w === was) ?? "other";

/** An item to bring: its box, its face or kind, its title, and one line (why it can't come, when it can't). */
function PickRow({
  item,
  flow,
  reason,
  lead,
  title,
  line,
}: {
  item: ImportItemResult;
  flow: ImportFlowState;
  reason: ImportSkipReason | undefined;
  lead: ReactNode;
  title: string;
  line: string;
}) {
  const { t } = useTranslation();
  const rowId = useId();
  const id = itemId(item);
  const can = choosable(item) && !reason;
  const checked = can ? flow.pick.has(id) : item.action === "unchanged";
  const why = can ? null : item.action === "unchanged" ? t("onboarding.import.choose.same") : whyText(t, item, reason);
  return (
    <li className="imp-row" data-off={!checked || undefined}>
      <Checkbox
        id={rowId}
        checked={checked}
        disabled={!can}
        onCheckedChange={(on) => flow.toggle([id], on)}
        aria-label={t("onboarding.import.bring", { name: title })}
      />
      <span className="imp-row__lead" aria-hidden="true">
        {lead}
      </span>
      <label htmlFor={rowId} className="imp-row__text">
        <span className="imp-row__title">{title}</span>
        <span className="imp-row__line">{why ?? line}</span>
      </label>
    </li>
  );
}

/** Why an item doesn't come, in plain words (an existing skill or channel says which). */
function whyText(t: TFunction, item: ImportItemResult, reason: ImportSkipReason | undefined) {
  const why = reason ?? item.reason;
  if (!why) return "";
  if (why === "exists" && (item.kind === "skill" || item.kind === "channel"))
    return t(`onboarding.import.whyExists.${item.kind}`);
  return t(`onboarding.import.why.${why}`);
}

/**
 * A row that stands for several things, or for one with more to see: its box, then the whole rest a button that opens
 * the list (the arrow at the end of the title's line). Without `onOpen`, the rest is the box's label.
 */
function GroupRow({
  icon,
  title,
  line,
  checked,
  disabled = false,
  onCheckedChange,
  onOpen,
}: {
  icon: IconName;
  title: string;
  line: string;
  checked: boolean | "indeterminate";
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const rowId = useId();
  const text = (
    <>
      <span className="imp-row__lead" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="imp-row__text">
        <span className="imp-row__title">{title}</span>
        <span className="imp-row__line">{line}</span>
      </span>
    </>
  );
  return (
    <li className="imp-row imp-row--opens" data-off={checked === false || undefined}>
      <Checkbox
        id={rowId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={t("onboarding.import.bring", { name: title })}
      />
      {onOpen ? (
        <button type="button" className="imp-row__open" onClick={onOpen}>
          {text}
          <span className="imp-row__go" aria-hidden="true">
            <Icon name="chevronRight" size={16} />
          </span>
        </button>
      ) : (
        <label htmlFor={rowId} className="imp-row__open">
          {text}
        </label>
      )}
    </li>
  );
}

/** A workflow's steps as they arrive: when it runs, who does each one, the condition, the approval, where it posts. */
function FlowSteps({
  workflow,
  when,
  nameOf,
  agentOf,
  channelOf,
}: {
  workflow: ImportWorkflow;
  /** The routine's when in words; null for a skill. */
  when: string | null;
  nameOf: (key: string) => string;
  agentOf: (key: string) => { name: string; appearance: Parameters<typeof normalizeAppearance>[0] } | undefined;
  channelOf: (key: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const line = (s: FlowStep, i: number): ReactNode => {
    const icon = (name: IconName) => <Icon name={name} size={16} />;
    const say = (lead: ReactNode, head: string, rest?: ReactNode, sub?: ReactNode) => (
      <li key={i} className="ac-iconline">
        {lead}
        <span>
          <b>{head}</b>
          {rest ? <> {rest}</> : null}
          {sub}
        </span>
      </li>
    );
    switch (s.kind) {
      case "text":
        return say(icon("note"), t("onboarding.import.choose.step.text"), s.text);
      case "do": {
        const a = agentOf(s.agent);
        const face = a ? (
          <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="xs" />
        ) : (
          icon("agent")
        );
        const by = s.by ? (
          <span className="imp-flow__by"> · {t("onboarding.import.choose.step.by", { name: nameOf(s.by) })}</span>
        ) : null;
        return say(face, nameOf(s.agent), s.task, by);
      }
      case "media":
        return say(icon(s.media), t(`onboarding.import.choose.step.${s.media}`), s.prompt);
      case "if":
        return say(
          icon("bolt"),
          t("onboarding.import.choose.step.if"),
          `${s.rule}${s.rule ? ": " : ""}${s.otherwise.length ? t("onboarding.import.choose.step.else") : t("onboarding.import.choose.step.stop")}`,
          s.otherwise.length > 0 ? <ol className="imp-flow imp-flow--sub">{s.otherwise.map(line)}</ol> : null,
        );
      case "approval":
        return say(icon("approve"), t("onboarding.import.choose.step.approval"), s.question);
      case "post": {
        const channel = s.channel ? channelOf(s.channel) : undefined;
        if (channel) return say(icon("channel"), t("onboarding.import.choose.step.channel", { channel }));
        if (s.to === "file") return say(icon("drive"), t("onboarding.import.choose.step.file"));
        if (s.to === "github") return say(icon("pullRequest"), t("onboarding.import.choose.step.github"), s.action);
        return say(icon("message"), t("onboarding.import.choose.step.notify"));
      }
      case "lost":
        return say(
          icon("info"),
          t(`onboarding.import.choose.step.lost.${s.what}`),
          <span className="imp-flow__by">· {t("onboarding.import.choose.step.notHere")}</span>,
        );
    }
  };
  return (
    <ol className="imp-flow">
      <li className="ac-iconline">
        <Icon name={when ? "routines" : "bulb"} size={16} />
        <span>
          {when ? (
            <>
              <b>{when}</b> · {t("onboarding.import.choose.step.when")}
            </>
          ) : (
            <b>{t("onboarding.import.choose.step.asked")}</b>
          )}
        </span>
      </li>
      {workflow.steps.map(line)}
    </ol>
  );
}
