import {
  isScreenTool,
  type LiveWork,
  type Run,
  type RunStep,
  type ScreenKind,
  useCatalog,
  useRun,
} from "@agenteschat/client";
import type { Activity, ActivityKind } from "@agenteschat/client/lib/activity";
import {
  type CliLine,
  type CliProgress,
  type CliVerb,
  cliMetaWords,
  cliVerbWord,
} from "@agenteschat/client/lib/cli-tools";
import { lowerFirst, shortTarget } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  appKey,
  callLogo,
  formatDuration,
  formatLineTime,
  oneCall,
  quietLine,
  quietWork,
  replySteps,
  savedOneLine,
  type ToolItem,
  type ToolLine,
  toolApps,
  toolCalls,
  toolItemsLive,
  toolItemsSaved,
  toolLineHint,
  toolNow,
  toolPhrase,
  toolWhy,
  workApps,
  workFromSteps,
  workMeta,
  workSteps,
} from "@agenteschat/client/lib/work";
import { useShowsWork } from "@agenteschat/client/lib/work-context";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentColor,
  Icon,
  type IconName,
  PixelSpinner,
  ToolBlock,
  type ToolBlockItem,
  type ToolBlockLine,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccountSwitchLine } from "@/chat/AccountRef";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { CodePanel, formatBytes, OutputView } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";

/** Our own tools by what they do: their icon in the block (a connector's call shows its logo). */
const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  readingDrive: "drive",
  writingDrive: "drive",
  exportingFile: "drive",
  importingFile: "drive",
  uploadingArtifact: "drive",
  fetchingFile: "file",
  creatingIssue: "issues",
  updatingIssue: "issues",
  readingIssues: "issues",
  startingTask: "issues",
  listingTasks: "issues",
  checkingTask: "issues",
  cancelingTask: "issues",
  searchingMemory: "bulb",
  updatingMemory: "bulb",
  gettingContext: "bulb",
  checkingCalendar: "calendar",
  schedulingEvent: "calendar",
  schedulingReminder: "bell",
  cancelingReminder: "bell",
  listingReminders: "bell",
  followingUp: "clock",
  cancelingFollowUp: "clock",
  creatingRoutine: "routines",
  updatingRoutine: "routines",
  listingRoutines: "routines",
  writingWiki: "book",
  readingWiki: "book",
  linkingWiki: "book",
  askingQuestion: "question",
  reacting: "smile",
  sendingGif: "sticker",
  sendingSticker: "sticker",
  openingSkill: "layers",
  consultingSkill: "layers",
  runningSkillScript: "code",
  runningSkillScriptAny: "code",
  runningCode: "code",
  browsing: "globe",
  pcFiles: "file",
  creatingImage: "image",
  checkingComputer: "computer",
  checkingUsage: "chart",
  findingAgent: "search",
  proposingMission: "flag",
  suggestingCodeSession: "code",
  messagingMission: "flag",
  updatingPlan: "flag",
  reportingProgress: "flag",
  askingDecision: "flag",
  requestingReview: "flag",
  requestingApproval: "approve",
  creatingChannel: "channel",
  offeringConnectAi: "plug",
  offeringConnectApp: "plug",
  offeringInvites: "personAdd",
  findingTools: "search",
  runningCommand: "code",
  runningCommandAny: "code",
  usingScreen: "computer",
  testingOnPhone: "phone",
  waitingForDevice: "waiting",
  cloningRepo: "repo",
  updatingCode: "repo",
  openingPullRequest: "pullRequest",
  handingOff: "routines",
  recordingFindings: "flag",
  deliveringMission: "flag",
  requestingAccess: "key",
  requestingSecret: "lock",
  queryingDatabase: "database",
};

/**
 * A call's logo: its service's mark as the connectors screens draw it (`callLogo`), or the icon of one of our tools.
 * The task manager draws what a task uses now with the same logos.
 */
export function useCallLogo() {
  const catalog = useCatalog();
  return (a: Activity) => {
    const logo = callLogo(a, catalog.data?.connectors ?? []);
    if (logo.kind === "service") return <ConnectorIcon def={logo.def} label={logo.label} image={logo.image} />;
    return (
      <span className="tool-logo" aria-hidden="true">
        <Icon name={logo.kind === "mail" ? "mail" : (KIND_ICON[a.kind] ?? "plug")} size={14} />
      </span>
    );
  };
}

/** A computer brain's own calls in a code session by what they did (ADR 0215): their icon on the line. */
const CLI_ICON: Record<CliVerb, IconName> = {
  read: "file",
  search: "search",
  edit: "edit",
  write: "document",
  run: "code",
  fetch: "globe",
  delegate: "agent",
  skill: "sparkle",
  workflow: "agent",
  other: "plug",
};

/**
 * A computer brain's own call in a code session as its terminal shows it (ADR 0215): its verb, what it worked on in
 * mono, what it came to on the right; it opens on what it gave back (an edit's changed lines).
 */
function cliBlockLine(t: TFunction, locale: string, l: ToolLine, cli: CliLine): ToolBlockLine {
  return {
    key: l.key,
    state: l.state,
    logo: (
      <span className="tool-logo" aria-hidden="true">
        <Icon name={CLI_ICON[cli.verb]} size={14} />
      </span>
    ),
    // While it runs, or stopped during it, as `toolPhrase` says ours: "Running".
    label: cliVerbWord(t, cli.verb, l.state === "run" || l.state === "stop"),
    target: cli.target ?? null,
    hint: cli.about ?? null,
    meta: cliMetaWords(t, cli.meta) ?? undefined,
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    why: null,
    detail: l.result ? (
      <OutputView output={[{ stream: l.state === "fail" ? "stderr" : "stdout", text: l.result }]} />
    ) : undefined,
  };
}

/** The words of a line in the block's closed head: a computer's own call names what it works on too. */
const headText = (line: ToolBlockLine) => (line.target ? `${line.label} ${line.target}` : line.label);

/** A line of the block from the shared model: its phrase, time, open view (code, output, what it got and gave). */
function blockLine(t: TFunction, locale: string, l: ToolLine, logo: ReactNode, personal = false) {
  if (l.cli) return cliBlockLine(t, locale, l, l.cli);
  const lines = l.code ? l.code.source.split("\n").length : 0;
  const output = l.output ?? [];
  const label =
    l.code && l.state === "done"
      ? t("code.ranSummary", {
          count: lines,
          language: l.code.language,
          size: formatBytes(
            locale,
            output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0),
          ),
        })
      : toolPhrase(t, l, locale);
  const why = toolWhy(t, l, personal);
  // What the tool answered, its own words when it failed: only in the open view, never under the line.
  const answered = l.result ?? why ?? l.why;
  const detail = l.code ? (
    <CodePanel code={l.code} output={output} live={l.state === "run"} />
  ) : output.length > 0 ? (
    <OutputView output={output} live={l.state === "run"} />
  ) : l.input || answered ? (
    <div className="ac-tools__io">
      {l.input && (
        <>
          <b>{t("chat.work.gave")}</b>
          <span>{l.input}</span>
        </>
      )}
      {answered && (
        <>
          <b>{l.state === "fail" ? t("chat.work.error") : t("chat.work.answered")}</b>
          <span>{answered}</span>
        </>
      )}
    </div>
  ) : undefined;
  const line: ToolBlockLine = {
    key: l.key,
    state: l.state,
    logo,
    label,
    hint: toolLineHint(t, l),
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    count: l.count > 1 ? t("chat.work.times", { count: l.count }) : undefined,
    why: l.state === "fail" ? why : null,
    detail,
    defaultOpen: l.state === "run" && Boolean(l.code),
  };
  return line;
}

function useBlockItems(items: ToolItem[]): ToolBlockItem[] {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  const personal = isPersonal(useOrg().org);
  return items.flatMap((item): ToolBlockItem[] =>
    item.kind === "call"
      ? [{ kind: "line", line: blockLine(t, i18n.language, item.line, logo(item.line), personal) }]
      : item.kind === "say"
        ? [{ kind: "note", key: item.key, node: item.text }]
        : [],
  );
}

/**
 * The tools of a reply while it works (and kept after, `done`): one line saying what it does now, the apps'
 * logos and the steps, opening into every call; a single call is that call's own line. What it said between calls
 * is inside. A message it read on the way shows nothing here: that message says it ("Ada read it", `MessageReceipts`).
 */
export function LiveTools({
  work,
  agentName,
  color,
  done,
  stopped,
}: {
  work: LiveWork[];
  agentName: string;
  color?: AgentColor;
  /** The reply is done: "Usou 4 ferramentas". */
  done?: boolean;
  /** Stopped by someone: the call running then shows as stopped. */
  stopped?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const items = toolItemsLive(work, stopped || done);
  const blockItems = useBlockItems(items);
  const logo = useCallLogo();
  const calls = toolCalls(items);
  // Done, its tools are the summary the person chose not to see (`showActivity`), but in a code session's
  // conversation, where they are the conversation itself (ADR 0215).
  const shows = useShowsWork(org);
  if (done && !shows) return null;
  // A lone quick read that only fed the answer: no card, as if it called nothing (once done, what it said on the way
  // is in its reply).
  const quiet = quietWork(items);
  const now = quiet ? null : toolNow(items);
  const said = quiet && done ? [] : items.flatMap((i) => (i.kind === "say" ? [i] : []));
  if (!now) {
    // Nothing called yet: what it said, as lines.
    return said.length > 0 ? (
      <div className="live-work-notes">
        {said.map((i) => (
          <p key={i.key} className="live-work__say">
            {i.text}
          </p>
        ))}
      </div>
    ) : null;
  }
  const one = oneCall(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head = done
    ? {
        text: t("chat.work.used", { count: calls }),
        time: total > 0 ? formatDuration(t, total) : undefined,
      }
    : {
        text: headText(blockLine(t, i18n.language, now, null)),
        textKey: `${now.key}-${now.state}`,
        state: now.state,
        count: t("chat.work.steps", { count: calls }),
      };
  return (
    <ToolBlock
      logos={toolApps(items).map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
      head={head}
      // Its own line is closed until clicked, as the block it stands for (code that runs shows when opened).
      items={
        one
          ? blockItems.map((i) => (i.kind === "line" ? { ...i, line: { ...i.line, defaultOpen: false } } : i))
          : blockItems
      }
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
      one={one}
    />
  );
}

/**
 * A task's steps in the task manager's panel (ADR 0128): the same block and lines as a reply's, open, from the task's
 * own steps (`useTaskSteps`). While it works, its last call still waiting for a result is the one running.
 */
export function TaskStepsBlock({
  steps,
  run,
  working,
  agentName,
  color,
}: {
  steps: RunStep[];
  run: Pick<Run, "createdAt" | "finishedAt">;
  working: boolean;
  agentName: string;
  color?: AgentColor;
}) {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  const saved = toolItemsSaved(workFromSteps(steps, run));
  const last = saved.findLastIndex((i) => i.kind === "call");
  const items: ToolItem[] = saved.map((item, i) =>
    working && i === last && item.kind === "call" && item.line.state === "stop"
      ? { ...item, line: { ...item.line, state: "run" as const } }
      : item,
  );
  const blockItems = useBlockItems(items);
  const calls = toolCalls(items);
  if (calls === 0) return null;
  const now = toolNow(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head =
    working && now
      ? {
          text: headText(blockLine(t, i18n.language, now, null)),
          textKey: `${now.key}-${now.state}`,
          state: now.state,
          count: t("chat.work.steps", { count: calls }),
        }
      : { text: t("chat.work.used", { count: calls }), time: total > 0 ? formatDuration(t, total) : undefined };
  return (
    <ToolBlock
      defaultOpen
      logos={toolApps(items).map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
      head={head}
      items={blockItems}
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
    />
  );
}

/**
 * The tools of a saved reply: closed, "Usou 4 ferramentas · 12 s" with the apps' logos from `meta.work`; its
 * steps load from `GET …/runs/{id}` only when opened (one request per opened message). A single call is its own
 * line from `meta.work` ("Criou uma rotina"), opening on what it was given and answered. A run that answered on the
 * way lists under each reply only the work that led to it (`replySteps`).
 */
export function SavedTools({
  runId,
  messageId,
  meta,
  agentName,
  color,
  skipScreens = [],
}: {
  runId: string;
  /** The reply it is under: its own part of the run's steps (none: the whole run). */
  messageId?: string;
  meta: Record<string, unknown> | undefined;
  agentName: string;
  color?: AgentColor;
  /** Screens whose calls have their own card on the message (`BrowserTrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(org.id, open ? runId : null);
  const logo = useCallLogo();
  const shows = useShowsWork(org);
  const compact = workMeta(meta);
  const onCard = (name: unknown) => skipScreens.some((screen) => isScreenTool(String(name ?? ""), screen));
  const mine = run.data ? replySteps(run.data.steps, messageId) : null;
  const work =
    run.data && mine
      ? workFromSteps(
          mine.steps.filter((s) => !(s.kind === "tool_call" && onCard(s.data.name))),
          mine.whole ? run.data.run : undefined,
          { quietChecks: mine.cli },
        )
      : null;
  const items = work ? toolItemsSaved(work) : [];
  const toolItems = useBlockItems(items);
  const switched = run.data?.run?.accountSwitch;
  // It went on with another account: said here, never in the chat.
  const blockItems: ToolBlockItem[] = switched
    ? [{ kind: "note", key: "account", node: <AccountSwitchLine move={switched} /> }, ...toolItems]
    : toolItems;
  // Nothing more to show than the message does: no tools (lookups and reactions aren't counted), or only the ones
  // its own cards show (where it browsed).
  // No `meta.work` (a reply saved before it): a block that loads the run's steps when opened, gone if it called none.
  const shown = compact ? workSteps(compact, onCard) : null;
  if (shown === 0 || !shows) return null;
  const calls = work ? toolCalls(items) : (shown ?? 0);
  const lone = savedOneLine(meta, onCard);
  // Its one call (beside the screens' on their cards) only fed the answer (`quietLine`): the reply says it. Time
  // unknown (saved before the server wrote it): kept, it may have failed.
  if (lone && lone.ms !== null && quietLine(lone)) return null;
  if (lone && (!work || oneCall(items) || !items.some((i) => i.kind === "call"))) {
    const line = blockLine(t, i18n.language, lone, logo(lone), isPersonal(org));
    const wait = run.isError ? (
      t("chat.work.failed")
    ) : !work ? (
      <PixelSpinner size={14} color={color} label={t("common.loading")} />
    ) : undefined;
    return (
      <ToolBlock
        one
        logos={[]}
        head={{ text: line.label }}
        items={work && oneCall(items) ? blockItems : [{ kind: "line", line: { ...line, detail: wait } }]}
        color={color}
        label={t("chat.work.block", agentGrammar(agentName))}
        // Its steps stay once loaded: closing the line doesn't change what it says.
        onToggle={(o) => o && setOpen(true)}
      />
    );
  }
  // Never a block that opens on nothing.
  if (work && calls === 0) return null;
  const durationMs = work?.durationMs ?? compact?.durationMs ?? null;
  const apps = work ? toolApps(items) : workApps((compact?.calls ?? []).filter((c) => !onCard(c.name)));
  const status: ToolBlockItem[] = run.isError
    ? [{ kind: "note", key: "error", node: t("chat.work.failed") }]
    : !work
      ? [
          {
            kind: "note",
            key: "loading",
            node: <PixelSpinner size={14} color={color} label={t("common.loading")} />,
          },
        ]
      : [];
  return (
    <ToolBlock
      logos={apps.map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
      head={{
        text: calls > 0 ? t("chat.work.used", { count: calls }) : t("chat.work.block", agentGrammar(agentName)),
        time: durationMs !== null ? formatDuration(t, durationMs) : undefined,
      }}
      items={[...status, ...blockItems]}
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
      onToggle={setOpen}
    />
  );
}

type ProgressCall = Extract<LiveWork, { kind: "call" }> & { progress: CliProgress };

/** A line's mark for a subagent or a workflow's agent: at work, done, failed, or stopped with the run. */
const progressState = (ended: boolean | undefined, failed: boolean | undefined, stopped: boolean) =>
  failed ? "fail" : ended ? "done" : stopped ? "stop" : "run";

/** What a subagent does now, in words after what it was asked: "lendo todo.js". */
function nowWords(t: TFunction, locale: string, now: CliLine | undefined) {
  if (!now) return null;
  const verb = lowerFirst(cliVerbWord(t, now.verb, true), locale);
  return now.target ? `${verb} ${shortTarget(now.target)}` : verb;
}

/**
 * The subagents and workflows of a computer brain's own while they work (ADR 0215), live in its row: each subagent a
 * line with what it was asked, what it does now and its calls so far; a workflow a block of its agents, open, its
 * head saying how many are done. They stay until the run ends, done ones marked.
 */
export function LiveSubagents({
  work,
  agentName,
  color,
  stopped = false,
}: {
  work: LiveWork[];
  agentName: string;
  color?: AgentColor;
  stopped?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const calls = work.filter((w): w is ProgressCall => w.kind === "call" && w.progress !== undefined);
  if (calls.length === 0) return null;
  const logo = (
    <span className="tool-logo" aria-hidden="true">
      <Icon name="agent" size={14} />
    </span>
  );
  const label = t("cliTools.progress.block", agentGrammar(agentName));
  const agents = calls.filter((c) => c.progress.kind === "agent");
  const workflows = calls.filter((c) => c.progress.kind === "workflow");
  const agentLines: ToolBlockLine[] = agents.map((c) => {
    const p = c.progress;
    const state = progressState(p.ended, p.failed, stopped);
    return {
      key: c.id,
      state,
      logo,
      label: c.cli?.about ?? t("cliTools.progress.subagent"),
      hint: state === "run" ? nowWords(t, i18n.language, p.now) : null,
      ...(p.calls ? { meta: t("chat.work.steps", { count: p.calls }) } : {}),
    };
  });
  const running = agentLines.filter((l) => l.state === "run").length;
  return (
    <>
      {agentLines.length > 0 && (
        <ToolBlock
          className="live-subagents"
          logos={[]}
          head={{
            text: t("cliTools.progress.agents", { count: agentLines.length }),
            state: running > 0 ? "run" : undefined,
            ...(running > 0 && running < agentLines.length
              ? { count: t("cliTools.progress.done", { done: agentLines.length - running, total: agentLines.length }) }
              : {}),
          }}
          items={agentLines.map((line) => ({ kind: "line" as const, line }))}
          color={color}
          label={label}
          one={agentLines.length === 1}
          defaultOpen
        />
      )}
      {workflows.map((c) => {
        const p = c.progress;
        const list = p.agents ?? [];
        const done = list.filter((a) => a.state !== "running").length;
        const over = p.ended === true;
        const lines: ToolBlockItem[] = list.map((a, i) => {
          const state = progressState(a.state !== "running", a.state === "failed", stopped && !over);
          const doing = a.verb && state === "run" ? lowerFirst(cliVerbWord(t, a.verb, true), i18n.language) : null;
          return {
            kind: "line",
            line: {
              key: `${c.id}:${i}`,
              state,
              logo,
              label: a.label,
              hint: [a.phase, doing].filter(Boolean).join(" · ") || null,
              ...(a.calls ? { meta: t("chat.work.steps", { count: a.calls }) } : {}),
            },
          };
        });
        const about = c.cli?.about;
        const verb = cliVerbWord(t, "workflow", !over);
        return (
          <ToolBlock
            key={c.id}
            className="live-subagents"
            logos={[]}
            head={{
              text: about ? `${verb} · ${about}` : verb,
              state: over ? (p.failed ? "fail" : "done") : stopped ? "stop" : "run",
              ...(list.length > 0 ? { count: t("cliTools.progress.done", { done, total: list.length }) } : {}),
            }}
            items={lines}
            color={color}
            label={label}
            defaultOpen
          />
        );
      })}
    </>
  );
}
