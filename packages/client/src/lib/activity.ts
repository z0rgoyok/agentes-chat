import type { TFunction } from "i18next";
import type { AgentStatusLine, ConsultationWait, RunConsultation } from "../api/types";
import type { LiveConsult, LiveConsultStatus } from "../realtime/consults";
import type { LiveRun } from "../realtime/streams";
import type { TypingWho } from "../realtime/typing";
import { durationText, formatLineTime, joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { MAIL_BRANDS } from "./mail";

/**
 * What the typing bar says someone is doing: "Theo está pensando…", "Theo
 * está consultando o GitHub…", "Marina está digitando…", "Marina está gravando
 * áudio…". Agents' verbs come from the tool they are calling (`agent.tool`, see
 * realtime/streams.ts); people only type or record.
 */
export type ActivityKind =
  | "thinking"
  | "typing"
  | "recordingVoice"
  | "writing"
  | "consulting"
  | "creatingIssue"
  | "updatingIssue"
  | "readingIssues"
  | "readingDrive"
  | "writingDrive"
  | "searchingMemory"
  | "updatingMemory"
  | "checkingCalendar"
  | "schedulingEvent"
  | "askingQuestion"
  | "reacting"
  | "sendingGif"
  | "sendingSticker"
  | "openingSkill"
  | "consultingSkill"
  | "runningCode"
  | "browsing"
  | "pcFiles"
  | "creatingImage"
  | "exportingFile"
  | "importingFile"
  | "runningSkillScript"
  | "runningSkillScriptAny"
  | "fetchingFile"
  | "schedulingReminder"
  | "creatingRoutine"
  | "updatingRoutine"
  | "proposingMission"
  | "suggestingCodeSession"
  | "messagingMission"
  | "updatingPlan"
  | "reportingProgress"
  | "askingDecision"
  | "requestingReview"
  | "requestingApproval"
  | "startingTask"
  | "listingTasks"
  | "checkingTask"
  | "cancelingTask"
  | "keepingRunning"
  | "uploadingArtifact"
  | "gettingContext"
  | "cancelingReminder"
  | "followingUp"
  | "cancelingFollowUp"
  | "listingReminders"
  | "listingRoutines"
  | "checkingComputer"
  | "writingWiki"
  | "readingWiki"
  | "linkingWiki"
  | "creatingChannel"
  | "offeringConnectAi"
  | "offeringConnectApp"
  | "offeringSkill"
  | "updatingSkills"
  | "creatingSkill"
  | "offeringInvites"
  | "proposingAgent"
  | "askingAgent"
  | "tellingAgent"
  | "findingTools"
  | "runningCommand"
  | "runningCommandAny"
  | "usingScreen"
  | "cloningRepo"
  | "listingRepos"
  | "updatingCode"
  | "preparingCli"
  | "openingPullRequest"
  | "handingOff"
  | "recordingFindings"
  | "deliveringMission"
  | "requestingAccess"
  | "requestingSecret"
  | "queryingDatabase"
  | "checkingUsage"
  | "findingAgent"
  | "searchingWeb"
  | "readingWeb"
  | "preparingCard"
  | "startingPoll"
  | "askingChoices"
  | "usingVault"
  | "makingPassword"
  | "startingWork"
  | "updatingWork"
  | "withdrawingRequest"
  | "releasingAgent"
  | "schedulingAction"
  | "updatingDashboard"
  | "testingOnPhone"
  | "waitingForDevice"
  | "readingDashboards"
  | "pushingBranch"
  | "deletingBranches"
  | "postingMessage"
  | "sendingDm"
  | "settingStatus"
  | "settingReplyStyle"
  | "settingCommitLine"
  | "sendingFeedback"
  | "offeringFeedback"
  | "deletingRoutine"
  | "runningRoutine"
  | "proposingTeam"
  | "proposingChange"
  | "workingOnWorkspace"
  | "updatingThread"
  | "addingAgent"
  | "settingChannelLead"
  | "readingConversation"
  | "usingTool";

/** The computer's own permission check before a command (`PERMISSION_TOOL` in `@agenteschat/adapters`). */
export const PERMISSION_TOOL = "permission_prompt";

export interface Activity {
  kind: ActivityKind;
  /** The app being consulted ("GitHub", "himetrica"), for `consulting`; the skill name for `openingSkill`. */
  app?: string;
  /**
   * The service the call works in, for its logo: a catalog connector's id (`github`, `drive`), a mailbox's maker
   * with a mark (`gmail`), `mail` for any other mailbox, or `postgres`.
   */
  service?: string;
  /** A server connected by address: its own icon (`/api/app/connector-icons/…`). */
  icon?: string;
  /** `preparingCli` (ADR 0228 §6): the computer its program is being fetched on, and how far (null: unknown yet). */
  computer?: string;
  percent?: number | null;
}

/** The coding CLIs' programs as people read them (`claude`, `codex`… as the server names them). */
export const CLI_PROGRAMS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity",
  devin: "Devin",
  // Git for Windows' portable build: Claude Code's shell on Windows (ADR 0228 §6).
  git: "Git",
};

/** The CLI each computer brain thinks with. */
export const CLI_OF_BRAIN: Readonly<Record<string, string>> = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
  antigravity: "antigravity",
  devin: "devin",
};

/** The tool a run's live line carries while its CLI is fetched on its computer (`<cli>|<computer>|<percent>`). */
export const PREPARE_CLI_TOOL = "prepare_cli";

/** "preparando o Claude Code no MacBook… 45%": the program, the computer and how far, from the line's detail. */
function preparingOf(detail: string | null | undefined): Activity {
  const [cli = "", computer = "", pct = ""] = (detail ?? "").split("|");
  const percent = /^\d{1,3}$/.test(pct) ? Math.min(100, Number(pct)) : null;
  return { kind: "preparingCli", app: CLI_PROGRAMS[cli] ?? cli, computer, percent };
}

/** Where a call works, as `agent.tool` and the saved `tool_call` step say it (the engine's `ToolDefinition`). */
export interface ToolService {
  service?: string | null;
  serviceIcon?: string | null;
}

/** The engine's own tools (packages/engine/src/context, issues, artifacts, calendar). */
const BUILTIN: Record<string, ActivityKind> = {
  create_issue: "creatingIssue",
  update_issue: "updatingIssue",
  comment_issue: "updatingIssue",
  list_issues: "readingIssues",
  get_issue: "readingIssues",
  read_artifact: "readingDrive",
  list_artifacts: "readingDrive",
  create_artifact: "writingDrive",
  update_artifact: "writingDrive",
  // Live files (ADR 0196 §6): the file's own page shows where the agent works; the bar says it is in the Drive.
  read_spreadsheet: "readingDrive",
  read_presentation: "readingDrive",
  read_canvas: "readingDrive",
  read_document: "readingDrive",
  create_spreadsheet: "writingDrive",
  edit_spreadsheet: "writingDrive",
  create_presentation: "writingDrive",
  edit_presentation: "writingDrive",
  create_canvas: "writingDrive",
  edit_canvas: "writingDrive",
  edit_document: "writingDrive",
  // Images onto a canvas through the workspace's image AI (ADR 0197).
  generate_image: "creatingImage",
  search_context: "searchingMemory",
  expand: "searchingMemory",
  get_summary: "searchingMemory",
  remember: "updatingMemory",
  forget: "updatingMemory",
  update_memory: "updatingMemory",
  save_how_to: "updatingMemory",
  propose_instruction_change: "updatingMemory",
  list_events: "checkingCalendar",
  find_free_time: "checkingCalendar",
  propose_event: "schedulingEvent",
  ask_user: "askingQuestion",
  react: "reacting",
  // A GIF or the agent's sticker (ADR 0091): the message itself shows it, the block says it was sent.
  send_gif: "sendingGif",
  send_sticker: "sendingSticker",
  // The agent's PC (sandbox).
  run_code: "runningCode",
  write_file: "pcFiles",
  read_file: "pcFiles",
  review_media: "pcFiles",
  list_files: "pcFiles",
  export_file: "exportingFile",
  upload_file: "exportingFile",
  import_file: "importingFile",
  share_artifact: "fetchingFile",
  // Scheduling from the chat.
  schedule_reminder: "schedulingReminder",
  create_routine: "creatingRoutine",
  update_routine: "updatingRoutine",
  read_skill_file: "consultingSkill",
  update_skill: "consultingSkill",
  // Missions (the agent's tools and the executor's MCP tools).
  propose_mission: "proposingMission",
  // A code session suggested for a change asked in the chat (ADR 0215 §11).
  suggest_code_session: "suggestingCodeSession",
  send_to_mission: "messagingMission",
  update_plan: "updatingPlan",
  report: "reportingProgress",
  ask_decision: "askingDecision",
  request_review: "requestingReview",
  request_approval: "requestingApproval",
  start_task: "startingTask",
  list_tasks: "listingTasks",
  task_status: "checkingTask",
  cancel_task: "cancelingTask",
  keep_running: "keepingRunning",
  upload_artifact: "uploadingArtifact",
  get_context: "gettingContext",
  cancel_reminder: "cancelingReminder",
  list_reminders: "listingReminders",
  list_routines: "listingRoutines",
  // A webhook routine run reads the call that started it.
  read_webhook_call: "listingRoutines",
  computer_status: "checkingComputer",
  wait_for_device: "waitingForDevice",
  create_wiki_page: "writingWiki",
  update_wiki_page: "writingWiki",
  read_wiki_page: "readingWiki",
  search_wiki: "readingWiki",
  link_to_wiki: "linkingWiki",
  // Setting up the workspace.
  create_channel: "creatingChannel",
  offer_connect_ai: "offeringConnectAi",
  offer_connect_app: "offeringConnectApp",
  offer_invites: "offeringInvites",
  offer_install_skill: "offeringSkill",
  update_skill_from_source: "updatingSkills",
  create_skill: "creatingSkill",
  propose_agent: "proposingAgent",
  // Another agent of the team (the consultation card says who and what it answered).
  ask_agent: "askingAgent",
  tell_agent: "tellingAgent",
  // Ours, though their first word reads like an app's name.
  git_clone: "cloningRepo",
  list_repositories: "listingRepos",
  // The checkouts' update that runs beside the turn, waited for inside it.
  wait_for_code: "updatingCode",
  open_pull_request: "openingPullRequest",
  hand_off: "handingOff",
  record_findings: "recordingFindings",
  complete_mission: "deliveringMission",
  request_permission: "requestingAccess",
  request_folder_access: "requestingAccess",
  request_secret: "requestingSecret",
  use_tool: "findingTools",
  follow_up: "followingUp",
  get_my_usage: "checkingUsage",
  ignore_usage_limit: "updatingWork",
  find_agent: "findingAgent",
  read_agent: "findingAgent",
  // The right hand's look at the team: its tasks, open and stuck, and what waits.
  team_status: "listingTasks",
  cancel_follow_up: "cancelingFollowUp",
  web_search: "searchingWeb",
  web_fetch: "readingWeb",
  image_search: "searchingWeb",
  // A picture from the web brought onto the reply (ADR 0217).
  show_image: "fetchingFile",
  read_conversation: "readingConversation",
  // A card of ours in the conversation: the card itself says what it holds.
  show_block: "preparingCard",
  offer_approvals: "preparingCard",
  offer_open_page: "preparingCard",
  offer_voice_setup: "preparingCard",
  set_team_week: "preparingCard",
  start_poll: "startingPoll",
  ask_choices: "askingChoices",
  offer_answers: "askingChoices",
  vault_list: "usingVault",
  vault_save: "usingVault",
  vault_delete: "usingVault",
  vault_make_password: "makingPassword",
  work_in_background: "startingWork",
  steer_work: "updatingWork",
  stop_work: "updatingWork",
  post_update: "updatingWork",
  withdraw_request: "withdrawingRequest",
  release_waiting_agent: "releasingAgent",
  schedule_action: "schedulingAction",
  create_dashboard: "updatingDashboard",
  create_widget: "updatingDashboard",
  update_widget: "updatingDashboard",
  share_dashboard: "updatingDashboard",
  list_dashboards: "readingDashboards",
  request_branch_push: "pushingBranch",
  delete_branches: "deletingBranches",
  post_message: "postingMessage",
  // The line it says before slow work (ADR 0207): a message of its own, never a line of the work (`work.ts`).
  say_now: "postingMessage",
  send_dm: "sendingDm",
  set_status: "settingStatus",
  set_reply_style: "settingReplyStyle",
  commit_co_author: "settingCommitLine",
  send_feedback: "sendingFeedback",
  offer_feedback: "offeringFeedback",
  delete_routine: "deletingRoutine",
  run_routine_now: "runningRoutine",
  propose_team: "proposingTeam",
  propose_settings_change: "proposingChange",
  request_settings_change: "proposingChange",
  propose_member_changes: "proposingChange",
  propose_remove_agents: "proposingChange",
  // The right hand's catalog of what a person can do: a look for the action, the change at once, or its card.
  workspace_action: "workingOnWorkspace",
  update_thread: "updatingThread",
  add_agent_to_channel: "addingAgent",
  set_channel_lead: "settingChannelLead",
};

/** A computer brain's own tools (`agent.step`: Claude Code's, Codex's, OpenCode's, Grok Build's), lower-cased. */
const OWN_TOOLS: Record<string, ActivityKind> = {
  read: "pcFiles",
  write_file: "pcFiles",
  edit_file: "pcFiles",
  search_replace: "pcFiles",
  list_dir: "pcFiles",
  run_terminal_cmd: "runningCommandAny",
  run_terminal_command: "runningCommandAny",
  edit: "pcFiles",
  multiedit: "pcFiles",
  write: "pcFiles",
  glob: "pcFiles",
  grep: "pcFiles",
  ls: "pcFiles",
  file_change: "pcFiles",
  image_generation: "creatingImage",
  bash: "runningCommandAny",
  shell: "runningCommandAny",
  toolsearch: "findingTools",
};

/** Catalog connectors (packages/engine/src/connectors/catalog.ts): tools are exposed as `<id>_<tool>`. */
const CONNECTORS: Record<string, string> = {
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  drive: "Drive",
  slack: "Slack",
  notion: "Notion",
  jira: "Jira",
  stripe: "Stripe",
  // The org's own mailboxes (`mail_<slug>_<verb>`, ADR 0038), labeled "Email" like their tools.
  mail: "Email",
};

const isDrive = (id: string) => id === "drive" || id === "google_drive";
/** A connection's service as its name says it: "Google Drive (ana@acme.com) 2" → "google_drive". */
export const serviceKey = (label: string) =>
  withoutParensAtEnd(withoutNumberAtEnd(label)).trim().toLowerCase().replace(/\s+/g, "_");

// A connection's name is read by index from its end: the patterns `/\s+\d+$/` and `/\s*\([^)]*\)$/` read the rest of
// the name again from each space (or `(`) of a long run, quadratic in its length.

const isSpace = (ch: string) => /\s/.test(ch);
const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** `label` without the number it ends with and the spaces before it ("Google Drive 2"), when there are both. */
function withoutNumberAtEnd(label: string): string {
  let digits = label.length;
  while (digits > 0 && isDigit(label.charAt(digits - 1))) digits--;
  let start = digits;
  while (start > 0 && isSpace(label.charAt(start - 1))) start--;
  return digits < label.length && start < digits ? label.slice(0, start) : label;
}

/**
 * `label` without what it ends with in parentheses and the spaces before it ("Google Drive (ana@acme.com)"): from
 * the first `(` after the `)` before the last one.
 */
function withoutParensAtEnd(label: string): string {
  if (!label.endsWith(")")) return label;
  const open = label.indexOf("(", label.lastIndexOf(")", label.length - 2) + 1);
  if (open < 0) return label;
  let start = open;
  while (start > 0 && isSpace(label.charAt(start - 1))) start--;
  return label.slice(0, start);
}

/** One of the org's mailboxes' tools (`mail_<slug>_<verb>`, ADR 0038), also through the executor's MCP. */
const MAILBOX_TOOL = /^(?:mcp__agentes__)?mail_[a-z0-9]+_[a-z]+$/;

/**
 * The friendly activity of a tool call. `connector` is the app label when the
 * event carries it; without it, only a catalog connector's prefix names an app.
 * `where`: the service the call names, for its logo. A mailbox goes by its maker's
 * name when the app draws its mark ("Consultou o Gmail"), else by "Email".
 */
export function toolActivity(
  tool: string | null | undefined,
  connector?: string | null,
  detail?: string | null,
  where?: ToolService | null,
): Activity {
  const a = activityOf(tool, connector, detail);
  const service = where?.service?.trim() || undefined;
  if (a.kind === "consulting" && MAILBOX_TOOL.test((tool ?? "").trim().toLowerCase())) {
    const brand = service ? MAIL_BRANDS[service] : undefined;
    return brand ? { kind: "consulting", app: brand.name, service } : { ...a, service: "mail" };
  }
  return { ...a, ...(service ? { service } : {}), ...(where?.serviceIcon ? { icon: where.serviceIcon } : {}) };
}

function activityOf(tool: string | null | undefined, connector?: string | null, detail?: string | null): Activity {
  let name = (tool ?? "").trim().toLowerCase();
  if (!name) return { kind: "thinking" };
  // An executor's MCP tool (`mcp__agentes__update_plan`): ours by its own name; another server's is that app.
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", rest = ""] = mcp;
    if (server !== "agentes" && !BUILTIN[rest]) return { kind: "consulting", app: CONNECTORS[server] ?? server };
    name = rest;
  }
  // "Theo está abrindo a skill Revisão de PR…", or "consultando uma skill" without the name.
  if (name === "run_skill_script") {
    return detail?.trim() ? { kind: "runningSkillScript", app: detail.trim() } : { kind: "runningSkillScriptAny" };
  }
  if (name === "load_skill")
    return detail?.trim() ? { kind: "openingSkill", app: detail.trim() } : { kind: "consultingSkill" };
  // ADR 0228 §6: the run waits while its computer fetches the CLI it thinks with.
  if (name === PREPARE_CLI_TOOL) return preparingOf(detail);
  // "Rodou: Rerun the tests": the command it checked, by the engine's label (`toolDetail`).
  if (name === PERMISSION_TOOL)
    return detail?.trim() ? { kind: "runningCommand", app: detail.trim() } : { kind: "runningCommandAny" };
  const builtin = BUILTIN[name] ?? OWN_TOOLS[name];
  if (builtin) return { kind: builtin };
  // The tools on demand: looking one up (a big connector's own directory too) is ours, not an app.
  if (name === "find_tools" || name.endsWith("_find_tools")) return { kind: "findingTools" };
  // The agent's own browser (ADR 0040) and screen (ADR 0062): not apps called "browser" and "desktop".
  if (name.startsWith("browser_")) return { kind: "browsing" };
  if (name.startsWith("desktop_")) return { kind: "usingScreen" };
  if (name.startsWith("phone_")) return { kind: "testingOnPhone" };
  const label = connector?.trim();
  if (label) {
    if (isDrive(serviceKey(label))) return { kind: "readingDrive" };
    return { kind: "consulting", app: label };
  }
  // The org's databases (`pg_<slug>_query`, ADR 0039) when the event names no connection.
  if (name.startsWith("pg_")) return { kind: "queryingDatabase" };
  const prefix = name.split(/[_.:]/)[0] ?? "";
  if (isDrive(prefix) || name.startsWith("google_drive_")) return { kind: "readingDrive" };
  const known = CONNECTORS[prefix];
  // Only a catalog connector's own prefix names an app: any other first word is a word of the tool's name.
  return known ? { kind: "consulting", app: known } : { kind: "usingTool" };
}

export interface ActivityEntry {
  id: string;
  type: "agent" | "person";
  name: string;
  activity: Activity;
  /** The agent is asking another agent (or just heard back): its own phrase, never grouped. */
  consult?: EntryConsult;
}

export interface EntryConsult {
  /** The agent it asked. */
  to: string;
  toName: string;
  status: LiveConsultStatus;
  /** When the question went out (the clock). */
  since: number;
  /** A question, or work handed off (none: a question). */
  kind?: "question" | "note";
  /** The conversation's question or hand-off it stands for (its id opens the two agents' talk). */
  id?: string;
  /** What the consulted agent waits on now, as the conversation's list says (none: it works). */
  wait?: ConsultationWait | null;
  /** Since when it waits (ms). */
  waitSince?: number | null;
  /** It waits on the person reading: their card from it is here (it wins over the list). */
  yours?: "approval" | "answer" | null;
  /** The consulted agent's run, as the list says: the cards it posts here carry it. */
  toRun?: string | null;
  /** The consulted agent's step in the bar's words, from its line ("lendo o Drive"), while it works. */
  step?: string | null;
}

/**
 * Lines that name an activity, as the bar's own verbs say them (each language's words, never a line's case changed,
 * ADR 0122): the consulted agent's step ("Atlas lendo o Drive").
 */
const STEP_VERBS: Partial<Record<NonNullable<AgentStatusLine["kind"]>, ActivityKind>> = {
  files: "readingDrive",
  coding: "runningCode",
  browsing: "browsing",
  wiki: "writingWiki",
  data: "queryingDatabase",
  connector: "consulting",
  computer: "usingScreen",
};

/** An agent's step from its line (ADR 0084), in the bar's words, when the line names an activity; else null. */
export function lineStep(t: TFunction, line: AgentStatusLine | null | undefined): string | null {
  const kind = line?.kind && !line.text ? STEP_VERBS[line.kind] : undefined;
  if (!kind) return null;
  return activityVerb(t, kind === "consulting" ? { kind, app: line?.subject ?? "" } : { kind });
}

/**
 * What the bar adds to a question or hand-off out from here (ADR 0095 addendum of 2026-11-13): its id and where it
 * stands in the conversation's list, whether the consulted agent's card here waits on the person reading (`yours`, by
 * the agent and the run the list names for it, unknown before the list has it), and its step while it works.
 */
export function consultDetails(
  c: Pick<LiveConsult, "runId" | "consultedAgentId" | "kind">,
  list: readonly Pick<
    RunConsultation,
    "id" | "runId" | "consultedAgentId" | "consultedRunId" | "status" | "waiting" | "waitingSince"
  >[],
  yours: (agentId: string, runId: string | null) => "approval" | "answer" | null,
  step: (agentId: string) => string | null,
): Pick<EntryConsult, "kind" | "id" | "wait" | "waitSince" | "yours" | "toRun" | "step"> {
  const row = list.find((r) => r.runId === c.runId && r.consultedAgentId === c.consultedAgentId && r.status === "open");
  const since = row?.waitingSince ? Date.parse(row.waitingSince) : Number.NaN;
  const toRun = row?.consultedRunId ?? null;
  const mine = yours(c.consultedAgentId, toRun);
  return {
    kind: c.kind ?? "question",
    ...(row ? { id: row.id } : {}),
    wait: row?.waiting ?? null,
    waitSince: Number.isNaN(since) ? null : since,
    yours: mine,
    toRun,
    step: mine || row?.waiting ? null : step(c.consultedAgentId),
  };
}

/** The question or hand-off one entry tells, with what the list and the cards here add (`consultDetails`). */
export type ConsultWithDetails = LiveConsult &
  Partial<Pick<EntryConsult, "id" | "wait" | "waitSince" | "yours" | "toRun" | "step">>;

/** Live statuses the working bar shows (the ones "Parar" can stop; a provisional row is about to be one). */
const BAR_STATUSES: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * At work: its words wait for its message, which shows them whole once posted. Its row in the conversation draws only
 * for something to show meanwhile (its browser card), and the bar says who works, on what and for how long.
 */
export const waitsForWords = (r: Pick<LiveRun, "status">) =>
  // Waiting on an approval keeps the waiting row: a header for that moment would jump in and out again.
  BAR_STATUSES.has(r.status) || r.status === "waiting_approval";

/**
 * Who shows in the bar, in order: agents asking another agent (`consults`), agents at work (thinking, at a tool or
 * writing: their words show whole once posted), then people typing or recording a voice message.
 */
export function barEntries(
  runs: LiveRun[],
  typing: TypingWho[],
  agentName: (id: string) => string,
  personName: (id: string) => string | undefined,
  consults: ConsultWithDetails[] = [],
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const c of consults) {
    if (seen.has(c.agentId)) continue;
    // Its run failed: its row in the conversation says so.
    if (runs.some((r) => r.runId === c.runId && r.status === "failed")) continue;
    // At work on something else while its question is out (a message that came meanwhile started another turn, or
    // woke the asking one): the bar says that work, and the question takes the line back once it is done.
    if (
      c.status === "asking" &&
      runs.some((r) => r.agentId === c.agentId && (r.runId !== c.runId || c.woke) && BAR_STATUSES.has(r.status))
    )
      continue;
    seen.add(c.agentId);
    out.push({
      id: c.agentId,
      type: "agent",
      name: agentName(c.agentId),
      activity: { kind: "thinking" },
      consult: {
        to: c.consultedAgentId,
        toName: agentName(c.consultedAgentId),
        status: c.status,
        since: c.since,
        kind: c.kind ?? "question",
        ...(c.id ? { id: c.id } : {}),
        wait: c.wait ?? null,
        waitSince: c.waitSince ?? null,
        yours: c.yours ?? null,
        toRun: c.toRun ?? null,
        step: c.step ?? null,
      },
    });
  }
  for (const r of runs) {
    // Only work in progress: a run waiting (an approval, an answer, its computer) or ended isn't "working".
    if (!BAR_STATUSES.has(r.status) || seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    out.push({
      id: r.agentId,
      type: "agent",
      name: agentName(r.agentId),
      // `running` with no call out: its words are on their way (they show whole, once posted).
      activity:
        r.status === "running" && !r.tool ? { kind: "writing" } : toolActivity(r.tool, r.connector, r.toolDetail, r),
    });
  }
  for (const { id, kind } of typing) {
    const name = personName(id);
    if (name)
      out.push({ id, type: "person", name, activity: { kind: kind === "voice" ? "recordingVoice" : "typing" } });
  }
  return out;
}

/** How many small faces the bar stacks, however many are at work (the sentence says "e mais N"). */
export const BAR_FACES = 3;

/** What people do in the bar, in the order the bar says it. */
const PERSON_VERBS = ["typing", "recordingVoice"] as const;
type PersonVerb = (typeof PERSON_VERBS)[number];

const doing = (e: ActivityEntry, kind: PersonVerb) => e.type === "person" && e.activity.kind === kind;

/**
 * The faces the bar stacks: agents first, and at least one person typing when someone is. Who records shows after the
 * words, with their mark (`facesOf`); while someone records, who types does too (`bothAtIt`).
 */
export function barFaces(entries: ActivityEntry[]): ActivityEntry[] {
  const agents = entries.filter((e) => e.type === "agent");
  const people = bothAtIt(entries) ? [] : entries.filter((e) => doing(e, "typing"));
  const shown = agents.slice(0, people.length > 0 ? BAR_FACES - 1 : BAR_FACES);
  return [...shown, ...people.slice(0, BAR_FACES - shown.length)];
}

/** Who does it, a few faces at most: a group drawn by its words, after its mark. */
export const facesOf = (entries: ActivityEntry[], kind: PersonVerb) =>
  entries.filter((e) => doing(e, kind)).slice(0, BAR_FACES);

/** Whether someone types (the bar's dots), beside whatever else happens. */
export const someoneTypes = (entries: ActivityEntry[]) => entries.some((e) => doing(e, "typing"));

/** Someone types while someone records: each verb then has its own mark and faces, by its words. */
export const bothAtIt = (entries: ActivityEntry[]) =>
  someoneTypes(entries) && entries.some((e) => doing(e, "recordingVoice"));

/** The people at it by what they do, writing first: each group's names and its verb ("gravando áudio"). */
export function peopleGroups(entries: ActivityEntry[]): { kind: PersonVerb; names: string[] }[] {
  return PERSON_VERBS.flatMap((kind) => {
    const names = entries.flatMap((e) => (doing(e, kind) ? [e.name] : []));
    return names.length > 0 ? [{ kind, names }] : [];
  });
}

/** The question the bar tells and times: one agent's on its own (beside others, its reply tells it). */
export function barAsking(entries: ActivityEntry[]): EntryConsult | undefined {
  const agents = entries.filter((e) => e.type === "agent");
  const consult = agents.length === 1 ? agents[0]?.consult : undefined;
  return consult?.status === "asking" ? consult : undefined;
}

/**
 * A run's time shows only past a minute, coarse ("1 min", "2 min"): seconds ticking by make an agent at work feel
 * slow.
 */
export const RUN_CLOCK_AFTER_MS = 60_000;

/**
 * The turn the bar tells for one agent on its own, its phrase and its time alike: a turn that failed can still be
 * listed beside the one at work.
 */
const turnAtWork = (runs: LiveRun[], agentId: string) =>
  runs.find((r) => r.agentId === agentId && r.status !== "failed");

/** How long a run has been at it ("1 min", "2 min"), from a minute on: the bar's time and its live row's alike. */
export function runElapsed(t: TFunction, run: Pick<LiveRun, "startedAt" | "workingSince">, now: number): string | null {
  // The work it is doing now (`workingSince`), not the run's first start: a run that posted or waited counts again.
  const took = now - (run.workingSince ?? run.startedAt ?? now);
  return took < RUN_CLOCK_AFTER_MS ? null : durationText(t, took);
}

/** How long one agent on its own has been at it ("1 min", "2 min"): none for several, or while it asks another. */
export function barElapsed(t: TFunction, entries: ActivityEntry[], runs: LiveRun[], now: number): string | null {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (!only || only.consult?.status === "asking") return null;
  const run = turnAtWork(runs, only.id);
  return run ? runElapsed(t, run, now) : null;
}

/** "trabalhando", "consultando o GitHub". */
export const activityVerb = (t: TFunction, a: Activity) =>
  a.kind === "preparingCli"
    ? t(`chat.activity.${a.percent != null ? "preparingCliPct" : "preparingCli"}`, {
        app: appLabel(a),
        computer: a.computer ?? "",
        percent: a.percent ?? 0,
      })
    : t(`chat.activity.${a.kind}`, { app: appLabel(a) });

/**
 * The app as people read it: a connector's slug ("himetrica") starts with a capital ("Himetrica"); a name with
 * capitals of its own stays as it is written ("iCloud").
 */
export const appLabel = (a: { kind: string; app?: string }) => {
  const app = a.app ?? "";
  return a.kind === "consulting" && app === app.toLowerCase() ? app.charAt(0).toUpperCase() + app.slice(1) : app;
};

/** Wraps a name in the sentence (the bar shows names in bold); plain text by default. */
export type MarkName = (name: string) => string;
const plain: MarkName = (name) => name;
/** Wraps an agent's name that the line draws with its face before it (the bar's "Theo: …"); `mark` by default. */
export type MarkFace = (name: string, agentId: string) => string;

// Names travel through i18n wrapped in these, then come back drawn: in ink, or with the agent's face (its id rides
// along). Control characters, so no name or translation ever holds one.
const NAME_OPEN = "\u0001";
const NAME_CLOSE = "\u0002";
const FACE_OPEN = "\u0003";
const FACE_ID = "\u0004";
/** A name the line draws in ink. */
export const markInk: MarkName = (name) => `${NAME_OPEN}${name}${NAME_CLOSE}`;
/** A name the line draws with its agent's face before it. */
export const markFaced: MarkFace = (name, agentId) => `${FACE_OPEN}${agentId}${FACE_ID}${name}${NAME_CLOSE}`;

/** A piece of a marked sentence: plain words, a name in ink, or a name with its agent's face (`agentId`). */
export interface MarkedPiece {
  text: string;
  bold: boolean;
  agentId?: string;
}

/** A sentence marked with `markInk` / `markFaced`, in pieces (an unclosed name runs to the end). */
export function markedPieces(text: string): MarkedPiece[] {
  const out: MarkedPiece[] = [];
  let at = 0;
  while (at < text.length) {
    const ink = text.indexOf(NAME_OPEN, at);
    const faced = text.indexOf(FACE_OPEN, at);
    const open = ink < 0 ? faced : faced < 0 ? ink : Math.min(ink, faced);
    if (open < 0) {
      out.push({ text: text.slice(at), bold: false });
      break;
    }
    if (open > at) out.push({ text: text.slice(at, open), bold: false });
    const close = text.indexOf(NAME_CLOSE, open);
    const end = close < 0 ? text.length : close;
    if (open === ink) {
      const name = text.slice(open + 1, end);
      if (name) out.push({ text: name, bold: true });
    } else {
      const sep = text.indexOf(FACE_ID, open);
      const id = sep < 0 || sep > end ? "" : text.slice(open + 1, sep);
      const name = text.slice(sep < 0 || sep > end ? open + 1 : sep + 1, end);
      if (name) out.push({ text: name, bold: true, ...(id ? { agentId: id } : {}) });
    }
    at = end + 1;
  }
  return out;
}

/** "Theo", "Theo e Iris", "Theo e mais 2". */
export function listNames(t: TFunction, names: string[], mark: MarkName = plain) {
  if (names.length <= 2) return joinNames(names.map(mark), t);
  return t("chat.namesMore", { first: mark(names[0] ?? ""), count: names.length - 1 });
}

/** What the consulted agent waits on, said about it ("O Atlas espera uma aprovação"), by the list's word. */
const WAIT_PHRASE = {
  approval: "chat.consultGroup.waitingApproval",
  input: "chat.consultGroup.waitingInput",
  computer: "chat.consultGroup.waitingComputer",
  outage: "chat.consultGroup.waitingProvider",
  agents: "chat.consultGroup.waitingAgents",
  queued: "chat.consultGroup.queued",
} as const satisfies Record<ConsultationWait, string>;

/**
 * One consultation's phrase: "Dev is asking Infra", "Infra answered. Dev is writing". Work handed off says the other
 * agent's state: "Atlas reading the Drive", "Atlas helping Ada" (in the words of the reply that comes after it; `face`
 * draws Ada's face before her name), "Atlas is done. Ada is writing". Either way, what waits on the person reading
 * ("Atlas is waiting for your approval") or on someone else ("Atlas is waiting for an approval") takes the phrase.
 */
function consultPhrase(
  t: TFunction,
  from: { name: string; id: string },
  c: EntryConsult,
  mark: MarkName,
  face?: MarkFace,
) {
  const note = c.kind === "note";
  if (c.status === "asking") {
    if (c.yours)
      return t(c.yours === "approval" ? "chat.consult.yourApproval" : "chat.consult.yourAnswer", {
        name: mark(c.toName),
      });
    if (c.wait) return t(WAIT_PHRASE[c.wait], { name: mark(c.toName), context: agentGrammar(c.toName).context });
    if (!note) return t("chat.consult.asking", { from: mark(from.name), to: mark(c.toName) });
    return c.step
      ? t("chat.consult.doing", { name: mark(c.toName), doing: c.step })
      : t("chat.consult.helping", {
          to: mark(c.toName),
          from: face ? face(from.name, from.id) : mark(from.name),
          context: agentGrammar(from.name).context,
        });
  }
  if (c.status === "answered") {
    return t(note ? "chat.consult.done" : "chat.consult.answered", { from: mark(from.name), to: mark(c.toName) });
  }
  if (note) return t("chat.consult.notDone", { from: mark(from.name), to: mark(c.toName) });
  return t("chat.consult.writing", { from: mark(from.name) });
}

/**
 * The time a hand-off or a wait tells beside its phrase (lists' clock: "22 min", "3 min"): work handed off, since the
 * hand-off; someone's approval or answer, since the wait began. None for a question at work (its clock is
 * `ConsultClock`'s), what waits on the person reading, or a wait with no clock of its own.
 */
export function barConsultTime(locale: string, c: EntryConsult | undefined, now: number): string | null {
  if (c?.status !== "asking" || c.yours) return null;
  const from = c.wait
    ? c.wait === "approval" || c.wait === "input"
      ? c.waitSince
      : null
    : c.kind === "note"
      ? c.since
      : null;
  return from ? formatLineTime(locale, Math.max(1000, now - from)) : null;
}

/** "Theo e Iris estão trabalhando", "Marina está digitando". */
const doingPhrase = (t: TFunction, names: string[], activity: Activity, mark: MarkName) =>
  t("chat.doing", { count: names.length, names: listNames(t, names, mark), doing: activityVerb(t, activity) });

/** The agents' part: one says what it does (or whom it asks); several just work, their blocks say the rest. */
function agentsPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName, face?: MarkFace) {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (only?.consult) return consultPhrase(t, only, only.consult, mark, face);
  if (agents.length === 0) return "";
  const names = agents.map((e) => e.name);
  return doingPhrase(t, names, only?.activity ?? { kind: "thinking" }, mark);
}

const PHRASES_SEP = " · ";

/**
 * The bar's sentence, one short line however many are at work: "Theo e mais 2 estão trabalhando · Marina
 * está digitando · Rui está gravando áudio…"; "" when nobody. `mark` wraps each name (for bold).
 */
export function activitySentence(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain, face?: MarkFace) {
  const people = peopleGroups(entries).map((g) => doingPhrase(t, g.names, { kind: g.kind }, mark));
  const phrases = [agentsPhrase(t, entries, mark, face), ...people].filter(Boolean);
  return phrases.length > 0 ? `${phrases.join(PHRASES_SEP)}…` : "";
}

/** The bar's sentence as plain text (see `activitySentence`). */
export const activityText = (t: TFunction, entries: ActivityEntry[]) => activitySentence(t, entries);

/**
 * The card's phrase. One agent on its own says only its name (the bar adds its time): what it does is its waiting
 * row's step line in the conversation (`waitStep`), never said twice. Anyone else (several, a question out, people
 * typing): the plain sentence.
 */
export function barPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain, face?: MarkFace): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only?.type === "agent" && !only.consult) return mark(only.name);
  return activitySentence(t, entries, mark, face);
}

/** A group's phrase in two pieces, its names then what they do; a language that puts the names later keeps it whole. */
function namesFirst(t: TFunction, names: string[], kind: PersonVerb, mark: MarkName): [string, string] {
  const phrase = doingPhrase(t, names, { kind }, mark);
  const listed = listNames(t, names, mark);
  const at = phrase.startsWith(listed) ? listed.length : 0;
  return [phrase.slice(0, at), phrase.slice(at)];
}

/**
 * `barPhrase` in pieces, in the order they give way when the bar is short: the agents' words (then the " · "
 * after them, so it never leads the line), the names of who is typing, and never what they do (" está
 * digitando"), then who records a voice message the same way (" está gravando áudio"), after a " · " of its own
 * when someone types. The last phrase ends in "…". Joined, they read as `barPhrase`; all but the first are "" when
 * no person is at it.
 */
export function barWords(
  t: TFunction,
  entries: ActivityEntry[],
  mark: MarkName = plain,
  face?: MarkFace,
): [
  agents: string,
  sep: string,
  typers: string,
  typing: string,
  voiceSep: string,
  recorders: string,
  recording: string,
] {
  const groups = peopleGroups(entries);
  if (groups.length === 0) return [barPhrase(t, entries, mark, face), "", "", "", "", "", ""];
  const agents = agentsPhrase(t, entries, mark, face);
  const typing = groups.find((g) => g.kind === "typing");
  const voice = groups.find((g) => g.kind === "recordingVoice");
  const [typers, typed] = typing ? namesFirst(t, typing.names, typing.kind, mark) : ["", ""];
  const [recorders, recorded] = voice ? namesFirst(t, voice.names, voice.kind, mark) : ["", ""];
  return [
    agents,
    agents ? PHRASES_SEP : "",
    typers,
    typed && !voice ? `${typed}…` : typed,
    typing && voice ? PHRASES_SEP : "",
    recorders,
    recorded && `${recorded}…`,
  ];
}
