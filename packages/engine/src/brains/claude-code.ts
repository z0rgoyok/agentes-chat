import { createHash, randomBytes } from "node:crypto";
import {
  ACCOUNTS_PROTOCOL,
  type AgentScope,
  ASKS_PROTOCOL,
  BRAIN_PROFILES_PROTOCOL,
  BRAIN_PROTOCOL,
  BRAIN_WARM_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  CLI_GIT_MISSING,
  CONTEXT_LIMIT_PROTOCOL,
  CONVERSATION_PROTOCOL,
  HELD_TURN_PROTOCOL,
  LOCKED_BRAIN_PROTOCOL,
  type MachineReplies,
  type PubSub,
  parseBrainEvent,
  SPEED_PROTOCOL,
  STEER_PROTOCOL,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import { type Database, schema, sql } from "@agenteschat/db";
import { catalogModelOf, costAtRates, costNanoUsd } from "@agenteschat/providers";
import { CLI_FLOORS, CLI_UPDATE_COMMAND, cliVersionProblem, type FloorCli } from "@agenteschat/providers/cli-floors";
import { autoContextFor } from "@agenteschat/providers/context-limits";
import { getAgentCached } from "../agents";
import { isShutdown } from "../cancel";
import { fetchesCli } from "../cli-fetch";
import type { CodeSetup } from "../git/machine";
import {
  computerBackSoon,
  type MachineCaller,
  type MachineCallOptions,
  MachineRequestError,
  type MachineStatus,
} from "../machine-hub";
import {
  MachineDroppedError,
  MachineOfflineError,
  MachinePausedError,
  maintenanceWords,
  pausedMessage,
} from "../machines";
import { addPersonSpend } from "../person-usage";
import { apiNano } from "../plan-usage";
import { respanPrimary, respanRates, usesRespanPricing } from "../respan-pricing";
import { runnerUpdateWay } from "../runner-update";
import { budgetPeriodOf } from "../usage";
import { noteModelRefusal, skipRefusedModel, withFailureCause } from "./failure-causes";
import { inPhase } from "./phase";
import { computerPrompt, systemWithConversation } from "./prompt";
import {
  askingPermissions,
  BRAIN_NAMES,
  BRAIN_PLAN_NAMES,
  type Brain,
  type BrainAccount,
  type BrainEvent,
  type BrainIO,
  type BrainTurn,
  type SteerMessage,
  type SteerReply,
} from "./types";

/**
 * The Claude Code brain (ADR 0032): an agent thinks with Claude Code on its
 * computer, on the owner's plan.
 *
 * - One turn = one `brain.turn` request to the machine (protocol 8) through
 *   the hub. The runner streams `brain.event` frames; the hub publishes them
 *   on `brainTopic(runId)` for whichever replica runs the turn, and the brain
 *   yields them as `BrainEvent`s. The request's result repeats the final event
 *   (`done` or `error`), so the turn ends even if a published event is lost.
 * - Tools: Claude Code calls them through the runner's MCP bridge (block 2),
 *   executed by the engine's Tool Gateway; here they only arrive as
 *   `tool_call` events with `executed` (for the transcript and the live view).
 * - Usage: `usage{source:"plan"}` (no cost; `recordPlanUsage` writes it).
 *   A plan limit: `limit{resetsAt}` and then `error{code:"plan_limit"}`.
 * - Before sending anything the machine is checked: offline, commands off,
 *   an older runner, no Claude Code, or not logged in (the agent's account,
 *   ADR 0041, when it has one) end the turn at once
 *   with an `error` whose `retryable: true` tells the engine the run may wait
 *   for the computer (ADR 0032 §5).
 *
 * - Live steering (runner protocol 15): once the turn is sent, the brain
 *   hands the engine `steer` (`BrainIO.steerable`): a person's messages go to
 *   the turn in progress (`brain.steer`), Claude Code reads them at its next
 *   tool boundary, and `steer_read` events say which it read.
 *
 * Error codes (`retryable` = the turn may run on another brain):
 * `no_session`, `machine_offline`, `exec_disabled`, `runner_outdated`,
 * `cli_missing`, `not_logged_in`, `plan_limit`, `busy` (all retryable);
 * `claude_failed`, `canceled`, `timeout`, `runner_error`, `bad_request` (not).
 */

export interface ClaudeCodeBrainDeps {
  hub: Pick<MachineCaller, "call" | "status" | "wake">;
  pubsub: PubSub;
  /** The agent as the runner names its folder (`agentScopeFromDb`). */
  agentScope: (turn: BrainTurn) => Promise<AgentScope>;
  /** Keep one Claude Code process per thread alive between turns (default true; false for a background run). */
  keepAlive?: boolean;
  /** Also load the machine owner's own MCP servers (default false: only our bridge). */
  personalMcp?: (turn: BrainTurn) => boolean | Promise<boolean>;
  /**
   * The turn's permission profile (missions: their own plan/work, branch prefix and allowed rules; other
   * runs: `work`, whoever woke them, ADR 0109). A `plan` turn needs `BRAIN_PROFILES_PROTOCOL` (an older runner's plan
   * reads secrets and loads project settings): below it the turn fails with `runner_outdated`.
   */
  permissions?: (
    turn: BrainTurn,
  ) => BrainTurnRequest["permissions"] | undefined | Promise<BrainTurnRequest["permissions"] | undefined>;
  /** The run's MCP bridge token (default: random per run). */
  mcpToken?: (turn: BrainTurn) => string;
  /**
   * Before a chat turn (ADR 0024 addendum): updates the agent's checkouts on
   * the machine and says where the turn starts and what to add to the
   * system text ("# Your code"). Null or a failure: the turn runs as before.
   */
  prepare?: (turn: BrainTurn, signal: AbortSignal) => Promise<CodeSetup | null>;
  /** How long a turn may take (default: the hub's, 3 h). */
  timeoutMs?: number;
  /** After the request's result, how long to wait for the stream's last events (default 1.5 s). */
  finalGraceMs?: number;
  /** How long a `brain.steer` may take (default `STEER_CALL_MS`). */
  steerTimeoutMs?: number;
  /** Tests: `HELD_TURN_WAIT_MS`. */
  heldTurnWaitMs?: number;
}

/** A `brain.warm` answers once the CLI started, or a cold worker came up first; past this nobody waits on it. */
export const WARM_CALL_MS = 30_000;

/** A `brain.steer` answers at once (it only writes to the CLI's stdin): longer means the computer is in trouble. */
export const STEER_CALL_MS = 2000;

/** Hands messages to the turn of `runId` on its computer (`brain.steer`); a failed call is `no_turn` (they wait). */
export async function steerOnMachine(
  hub: Pick<MachineCaller, "call">,
  input: { machineId: string; runId: string; session: string; agent: AgentScope; timeoutMs?: number },
  messages: SteerMessage[],
): Promise<SteerReply> {
  try {
    const reply = await hub.call<"brain.steer">(
      input.machineId,
      {
        op: "brain.steer",
        runId: input.runId,
        session: input.session,
        messages: messages.map((m) => ({ uuid: m.uuid, text: m.text, ...(m.urgent ? { urgent: true } : {}) })),
        agent: input.agent,
      },
      { timeoutMs: input.timeoutMs ?? STEER_CALL_MS },
    );
    if (reply?.status === "accepted" && Array.isArray(reply.accepted)) {
      const sent = new Set(messages.map((m) => m.uuid));
      return { status: "accepted", accepted: reply.accepted.filter((u) => typeof u === "string" && sent.has(u)) };
    }
    if (reply?.status === "unsupported")
      return { status: "unsupported", ...(reply.reason ? { reason: reply.reason } : {}) };
    return { status: "no_turn", ...(reply && "reason" in reply && reply.reason ? { reason: reply.reason } : {}) };
  } catch (error) {
    return { status: "no_turn", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The agent's id and handle, as the runner names its folder (and its name, for the machine's activity log). */
export const agentScopeFromDb =
  (db: Database) =>
  async (turn: BrainTurn): Promise<AgentScope> => {
    const agent = await getAgentCached(db, turn.orgId, turn.agentId);
    return { id: turn.agentId, handle: agent?.handle ?? "agent", ...(agent ? { name: agent.name } : {}) };
  };

/**
 * A stable Claude Code session id for one agent in one conversation (a
 * thread, or a channel/DM without threads): a UUID derived from both, so the
 * engine needs to store nothing to resume it (the runner checks the
 * machine's disk to pick `--resume` or `--session-id`).
 */
export function brainSessionId(agentId: string, conversation: string, salt = "claude_code"): string {
  const h = createHash("sha256").update(`${salt}:${agentId}:${conversation}`).digest("hex");
  // RFC 4122 layout, version 5-style (name-based) and the variant bits.
  const v = `5${h.slice(13, 16)}`;
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`;
}

const err = (code: string, message: string, retryable: boolean): BrainEvent => ({
  type: "error",
  code,
  message,
  retryable,
});

/**
 * Why the agent's account can't take the turn (ADR 0041; null: it can): a
 * runner older than accounts, or an account its CLI signed out. It never
 * falls back to another account.
 */
export function accountUnavailable(
  status: { name?: string; protocol?: number; kind?: string; executors?: { mode?: string } } | null,
  account: BrainAccount | undefined,
  kind: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin",
): { code: string; message: string } | null {
  if (!account) return null;
  const name = BRAIN_PLAN_NAMES[kind];
  const where = status?.name ? ` on ${status.name}` : "";
  if (status?.protocol !== undefined && status.protocol < ACCOUNTS_PROTOCOL) {
    return {
      code: "runner_outdated",
      message: `The agentes.chat program${where} is too old for agents with their own ${name} account. ${runnerUpdateWay(status)}`,
    };
  }
  if (account.status === "signed_out") {
    return {
      code: "not_logged_in",
      message: `The ${name} account "${account.label}"${where} is signed out. Its owner can sign in again in Settings, AI accounts.`,
    };
  }
  return null;
}

/** Sent only to a runner that knows accounts (protocol 13): older ones never see these fields. */
export function accountFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "account" | "effort">,
): Pick<BrainTurnRequest, "account" | "effort"> {
  if (protocol !== undefined && protocol < ACCOUNTS_PROTOCOL) return {};
  return {
    ...(turn.account ? { account: turn.account.id } : {}),
    ...(turn.effort ? { effort: turn.effort } : {}),
  };
}

/**
 * The agent's context limit, or "Automático"'s for this program (`autoContextFor`), sent only to a runner that knows
 * it (`CONTEXT_LIMIT_PROTOCOL`): an older one keeps compacting at the model's window.
 */
export function contextFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "contextTokens">,
  kind: string,
): Pick<BrainTurnRequest, "contextTokens"> {
  const tokens = turn.contextTokens || autoContextFor(kind);
  if (!tokens || (protocol !== undefined && protocol < CONTEXT_LIMIT_PROTOCOL)) return {};
  return { contextTokens: tokens };
}

/** The turn's speed, sent only to a runner that knows it (`SPEED_PROTOCOL`). */
export function speedFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "speed">,
): Pick<BrainTurnRequest, "speed"> {
  if (!turn.speed || (protocol !== undefined && protocol < SPEED_PROTOCOL)) return {};
  return { speed: turn.speed };
}

/** A CLI the computer doesn't list: not installed, or there and failing to start (`executors.broken`) with its error. */
export function cliMissingMessage(
  program: string,
  status: Pick<MachineStatus, "name" | "executors">,
  cli: keyof NonNullable<NonNullable<MachineStatus["executors"]>["broken"]>,
) {
  const said = status.executors?.broken?.[cli];
  if (!said) return `${program} is not installed on ${status.name}.`;
  return said === CLI_GIT_MISSING
    ? `${program} is on ${status.name} but can't start: Git for Windows isn't installed there.`
    : `${program} is on ${status.name} but can't start: ${said}`;
}

/**
 * A CLI the computer reports at a version agentes.chat holds back (`CLI_FLOORS`): older than its floor, or a blocked one.
 * Its turns wait (`cli_outdated` is in `UNAVAILABLE_CODES`) until the runner reports a newer one (`executors.changed`
 * resumes them), never sent to fail there. Null: it may run.
 */
export function cliOutdated(
  status: {
    name?: string | null;
    executors?:
      | (Partial<Record<FloorCli, { version: string }>> & Pick<schema.MachineExecutors, "copies" | "mode">)
      | null;
    kind?: string | null;
    os?: string;
    protocol?: number;
  },
  cli: FloorCli,
  program: string,
  floors = CLI_FLOORS,
): { code: "cli_outdated"; message: string } | null {
  // Its runner fetches the pinned CLI itself (ADR 0228 §6): the turn goes, and the runner brings it first.
  if (fetchesCli(status, cli)) return null;
  const problem = cliVersionProblem(cli, status.executors?.[cli]?.version, floors);
  if (!problem) return null;
  const where = status.name || "the computer";
  const command = CLI_UPDATE_COMMAND[cli];
  const how = command
    ? `Update it there (${command}).`
    : "Update it there, from the agent's settings or with the installer it came from.";
  return {
    code: "cli_outdated",
    message:
      problem.kind === "too_old"
        ? `${program} ${problem.version} on ${where} is older than ${problem.min}, the oldest version agentes.chat works with. ${how}`
        : `${program} ${problem.version} on ${where} has a known problem with agentes.chat. ${how}`,
  };
}

/** Why the turn can't go to this machine now (null: it can). With an account, the account decides the sign-in. */
export function claudeCodeAvailability(status: MachineStatus | null, account?: BrainAccount): BrainEvent | null {
  if (!status) return err("machine_offline", "The agent's computer is not connected to the organization.", true);
  if (!status.online) {
    const away = status.maintenance?.away ? status.maintenance : null;
    return err(
      "machine_offline",
      away ? maintenanceWords(status.name, away) : `Claude Code on ${status.name} is offline.`,
      true,
    );
  }
  if (status.paused) {
    return err("machine_paused", pausedMessage(status.name, status.paused.until, status.paused.timezone), true);
  }
  // A machine that reports its tools (protocol 10, the desktop app) runs Claude Code when that tool is on,
  // whatever "commands" says (the runner checks the same); an older runner follows its `exec` switch.
  const off = toolOff(status, "claude");
  if (off) return err(off.code, off.message, true);
  if (status.protocol < BRAIN_PROTOCOL) {
    return err(
      "runner_outdated",
      `The agentes.chat program on ${status.name} is too old for agents that think with Claude Code. ${runnerUpdateWay(status)}`,
      true,
    );
  }
  const ex = status.executors ?? {};
  if (ex.detectedAt && !ex.claude && !fetchesCli(status, "claude")) {
    return err("cli_missing", cliMissingMessage("Claude Code", status, "claude"), true);
  }
  const old = cliOutdated(status, "claude", "Claude Code");
  if (old) return err(old.code, old.message, true);
  if (account) {
    const e = accountUnavailable(status, account, "claude_code");
    return e ? err(e.code, e.message, true) : null;
  }
  if (ex.claude?.loggedIn === false) {
    return err("not_logged_in", `Claude Code on ${status.name} is not logged in (run claude auth login there).`, true);
  }
  return null;
}

/**
 * Whether the machine refuses this coding CLI: its tool switched off (protocol
 * 10, `access.tools`), or commands off on a runner that doesn't report tools.
 */
export function toolOff(
  status: Pick<MachineStatus, "name" | "execAllowed" | "access">,
  tool: "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin",
): { code: string; message: string } | null {
  const tools = status.access?.tools;
  const name = tool === "claude" ? "Claude Code" : BRAIN_NAMES[tool];
  if (tools) {
    // A runner before Cursor's switch (protocol 36) reports none: Cursor follows Codex's there, as on the runner.
    return (tool === "claude" || tool === "codex" ? tools[tool] : (tools[tool] ?? tools.codex)) === true
      ? null
      : {
          code: "tool_off",
          message: `${name} is turned off on ${status.name} (its owner can turn it on in the agentes app).`,
        };
  }
  return status.execAllowed ? null : { code: "exec_disabled", message: `Commands are turned off on ${status.name}.` };
}

/**
 * The folder a computer turn was to start in, when the runner refused the turn because it isn't on the computer
 * (`not_found`, which a Claude Code runner answers as `bad_request`, in every runner version); else null.
 */
export const missingTurnFolder = (message: string): string | null =>
  /^The folder (.+) doesn't exist$/.exec(message)?.[1] ?? null;

/**
 * The runner refused the turn before starting it, for lack of room (`no_slot`) or at its request ceiling
 * (`internal` "busy", every runner version): `busy`, and the engine waits for room.
 */
export function busyRefusal(error: unknown): BrainEvent | null {
  if (!(error instanceof MachineRequestError)) return null;
  if (error.code === "no_slot") return err("busy", error.message, true);
  if (error.code === "internal" && error.message === "busy") {
    return err("busy", "The computer is busy with other requests.", true);
  }
  return null;
}

/**
 * How long a turn whose computer dropped waits for it, still running, before the drop stands. Under the runner's
 * `HELD_TURN_MS`, so the turn is still held there when the computer is back in time.
 */
export const HELD_TURN_WAIT_MS = 90_000;
/** Drops one turn rides through: a computer that keeps dropping is left to the engine's own wait. */
const HELD_TURN_DROPS = 3;

/**
 * `brain.turn` through short drops (`HELD_TURN_PROTOCOL`): the runner keeps the turn running when the link drops, so
 * the turn waits for the computer (`computerBackSoon`; the run stays `running`) and takes the rest of the same turn
 * over (`reattach`) instead of failing it and starting it again. A runner that no longer has it (it restarted) answers
 * `not_found`, and the first drop stands: the engine's wait for the computer goes on from there.
 */
export async function callTurnThroughDrops(
  hub: Pick<MachineCaller, "call" | "status" | "wake">,
  machineId: string,
  request: BrainTurnRequest & { agent?: AgentScope },
  options: MachineCallOptions & { waitMs?: number } = {},
): Promise<MachineReplies["brain.turn"]> {
  const { waitMs = HELD_TURN_WAIT_MS, ...call } = options;
  let dropped: unknown = null;
  for (let drops = 0; ; drops++) {
    try {
      return await hub.call<"brain.turn">(
        machineId,
        { op: "brain.turn", ...request, ...(dropped ? { reattach: true } : {}) },
        call,
      );
    } catch (error) {
      if (!(error instanceof MachineDroppedError) || drops >= HELD_TURN_DROPS) throw dropped ?? error;
      dropped ??= error;
      const canceled = () => call.signal?.aborted === true;
      const back = canceled()
        ? null
        : await computerBackSoon(hub, machineId, { waitMs, signal: call.signal, canceled });
      if (back === null) {
        // The runner holds the turn still, running on, and no cancel can reach it. Not on our own restart: the next
        // server takes the turn over.
        if (!isShutdown(call.signal?.reason)) void stopHeldTurn(hub, machineId, request, waitMs);
        throw new MachineRequestError("canceled", "canceled");
      }
      if (!back) throw dropped;
      const status = await hub.status(machineId).catch(() => null);
      if ((status?.protocol ?? 0) < HELD_TURN_PROTOCOL) throw dropped;
    }
  }
}

/**
 * Once the computer is back within `waitMs`, it ends the canceled run's turn it may still hold (`reattach: "stop"`).
 * Never wakes it: a computer that sleeps holds no turn.
 */
async function stopHeldTurn(
  hub: Pick<MachineCaller, "call" | "status">,
  machineId: string,
  request: BrainTurnRequest & { agent?: AgentScope },
  waitMs: number,
) {
  for (const until = Date.now() + waitMs; ; await Bun.sleep(1_000)) {
    const status = await hub.status(machineId).catch(() => null);
    if (status?.online) {
      if ((status.protocol ?? 0) < HELD_TURN_PROTOCOL) return;
      await hub
        .call<"brain.turn">(machineId, { op: "brain.turn", ...request, reattach: "stop" }, { timeoutMs: 30_000 })
        .catch(() => {});
      return;
    }
    if (Date.now() >= until) return;
  }
}

/** A failed `brain.turn` request as the turn's error. */
export function claudeCodeCallError(error: unknown): BrainEvent {
  if (error instanceof MachineDroppedError && error.serverStop) {
    return { type: "error", code: "machine_offline", message: error.message, retryable: true, serverStop: true };
  }
  if (error instanceof MachineOfflineError) return err("machine_offline", error.message, true);
  if (error instanceof MachinePausedError) return err("machine_paused", error.message, true);
  const busy = busyRefusal(error);
  if (busy) return busy;
  if (error instanceof MachineRequestError) {
    switch (error.code) {
      case "canceled":
        return err("canceled", "The turn was canceled.", false);
      case "timeout":
        return err("timeout", error.message, false);
      case "exec_disabled":
        return err("exec_disabled", error.message, true);
      case "bad_request":
        if (/unknown op|no brain turns/i.test(error.message)) return err("runner_outdated", error.message, true);
        return err("bad_request", error.message, false);
      default:
        return err("runner_error", error.message, false);
    }
  }
  return err("runner_error", error instanceof Error ? error.message : String(error), false);
}

/** A runner's event, with the cause its words say where the runner gave none (`withFailureCause`). */
const toBrainEvent = (e: WireBrainEvent): BrainEvent => withFailureCause(e as BrainEvent);
const isFinal = (e: BrainEvent) => e.type === "done" || e.type === "error";

type Item = { kind: "event"; event: BrainEvent } | { kind: "stream_end" } | { kind: "reply"; final: BrainEvent };

/** A tiny async queue with an optional wait limit. */
class Queue {
  private items: Item[] = [];
  private waiter: ((item: Item | null) => void) | null = null;

  push(item: Item) {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(item);
    } else this.items.push(item);
  }

  next(timeoutMs?: number): Promise<Item | null> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.waiter = (i) => {
        if (timer) clearTimeout(timer);
        resolve(i);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, timeoutMs);
      }
    });
  }
}

export function createClaudeCodeBrain(deps: ClaudeCodeBrainDeps): Brain {
  return {
    kind: "claude_code",
    // The launch the turn below sends (its folder before `prepare` moves it to a checkout), without its words.
    async warm(turn: BrainTurn) {
      const session = turn.session;
      if (!session || deps.keepAlive === false) return false;
      const status = await deps.hub.status(session.machineId).catch(() => null);
      if (!status || status.protocol < BRAIN_WARM_PROTOCOL || claudeCodeAvailability(status, turn.account))
        return false;
      try {
        const [agent, personalMcp, asked] = await Promise.all([
          deps.agentScope(turn),
          Promise.resolve(deps.personalMcp?.(turn) ?? false),
          deps.permissions?.(turn),
        ]);
        const permissions = askingPermissions(asked, true);
        // Locked down as its turn is (ADR 0137 §4), the same launch, so the turn takes this process. Every runner that
        // warms (`BRAIN_WARM_PROTOCOL`) locks the CLI down.
        const chat = permissions?.mode === "chat";
        const reply = await deps.hub.call<"brain.warm">(
          session.machineId,
          {
            op: "brain.warm",
            runId: turn.runId,
            kind: "claude_code",
            session: { id: session.id, resume: session.resume },
            cwd: session.cwd,
            ...(turn.model ? { model: turn.model } : {}),
            personalMcp: personalMcp && !chat,
            // A code session's turn starts with its own tools (ADR 0215 §6): the warm process the same, or it isn't
            // the one the turn takes.
            ...(session.codeSession && !chat ? { codeSession: true } : {}),
            ...(permissions ? { permissions } : {}),
            ...accountFields(status.protocol, turn),
            ...contextFields(status.protocol, turn, "claude_code"),
            ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
            agent,
          },
          { timeoutMs: WARM_CALL_MS },
        );
        return reply.open === true;
      } catch {
        // the turn starts its CLI itself
        return false;
      }
    },
    async *run(asked: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
      // A model the sign-in refused lately goes out as the CLI's default; a new refusal is remembered (as Codex's).
      const turn = skipRefusedModel("claude_code", asked);
      const session = turn.session;
      if (!session) {
        yield err("no_session", "This agent has no computer for Claude Code.", true);
        return;
      }
      const status = await deps.hub.status(session.machineId).catch(() => null);
      const unavailable = claudeCodeAvailability(status, turn.account);
      if (unavailable) {
        yield unavailable;
        return;
      }
      const queue = new Queue();
      let steering = false;
      const off = deps.pubsub.subscribe(brainTopic(turn.runId), (e) => {
        // Only the agent's own computer speaks for this run.
        if (e.machineId !== session.machineId) return;
        if (e.type === "brain.done") return queue.push({ kind: "stream_end" });
        if (e.type !== "brain.event") return;
        const event = parseBrainEvent(e.event);
        if (event) queue.push({ kind: "event", event: toBrainEvent(event) });
      });
      try {
        const [agent, personalMcp] = await Promise.all([
          deps.agentScope(turn),
          Promise.resolve(deps.personalMcp?.(turn) ?? false),
        ]);
        const permissions = askingPermissions(await deps.permissions?.(turn), (status?.protocol ?? 0) >= ASKS_PROTOCOL);
        // The team's right hand on a plan (ADR 0137 §4): only a runner that locks the CLI down to our tools gets it,
        // in its own empty folder, with no checkout and none of the owner's servers.
        const chat = permissions?.mode === "chat";
        if (chat && (status?.protocol ?? 0) < LOCKED_BRAIN_PROTOCOL) {
          yield err(
            "runner_outdated",
            `The agentes.chat program on the computer is too old to keep Claude Code to the right hand's tools. ${runnerUpdateWay(status)}`,
            true,
          );
          return;
        }
        // An older runner's `plan` lets the CLI read secrets and loads the project's settings files: the
        // turn waits for an updated runner instead of reading with more power than asked for (§3).
        if (permissions?.mode === "plan" && (status?.protocol ?? 0) < BRAIN_PROFILES_PROTOCOL) {
          yield err(
            "runner_outdated",
            `The agentes.chat program on the computer is too old to keep Claude Code within this agent's permissions. ${runnerUpdateWay(status)}`,
            true,
          );
          return;
        }
        const prepared = chat ? null : (turn.code ?? deps.prepare?.(turn, io.signal))?.catch(() => null);
        const code = prepared ? await inPhase(io, "code", prepared) : null;
        // A runner that takes the conversation apart reads it at the start of the session: the system text stays the
        // agent's, the same in each of its conversations (and its cached prefix with it).
        const apart = (status?.protocol ?? 0) >= CONVERSATION_PROTOCOL;
        const request: BrainTurnRequest = {
          runId: turn.runId,
          kind: "claude_code",
          session: { id: session.id, resume: session.resume },
          cwd: code?.cwd || session.cwd,
          ...(turn.model ? { model: turn.model } : {}),
          system: apart ? turn.system : systemWithConversation(turn, code?.prompt),
          ...(apart ? { conversation: [turn.conversation, code?.prompt].filter(Boolean).join("\n\n") } : {}),
          prompt: computerPrompt(turn, code?.start),
          mcp: { token: deps.mcpToken?.(turn) ?? randomBytes(24).toString("base64url") },
          keepAlive: deps.keepAlive !== false,
          personalMcp: personalMcp && !chat,
          ...(session.codeSession && !chat ? { codeSession: true } : {}),
          ...(permissions ? { permissions } : {}),
          ...accountFields(status?.protocol, turn),
          ...contextFields(status?.protocol, turn, "claude_code"),
          ...(turn.personWaiting ? { personWaiting: true } : {}),
          ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
          // Each answer the turn finishes before it goes on is its own message (ADR 0112).
          answers: "each",
        };
        callTurnThroughDrops(
          deps.hub,
          session.machineId,
          { ...request, agent },
          {
            signal: io.signal,
            ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
            ...(deps.heldTurnWaitMs !== undefined ? { waitMs: deps.heldTurnWaitMs } : {}),
          },
        ).then(
          (reply) => {
            const final = parseBrainEvent(reply?.final);
            queue.push({
              kind: "reply",
              final:
                final && isFinal(toBrainEvent(final))
                  ? toBrainEvent(final)
                  : err("runner_error", "The computer answered without an end to the turn.", false),
            });
          },
          (error: unknown) => queue.push({ kind: "reply", final: claudeCodeCallError(error) }),
        );
        // The turn is on its way: a person's messages can reach it mid-turn (an older runner reads them at the end).
        if (io.steerable && (status?.protocol ?? 0) >= STEER_PROTOCOL) {
          const target = {
            machineId: session.machineId,
            runId: turn.runId,
            session: session.id,
            agent,
            ...(deps.steerTimeoutMs ? { timeoutMs: deps.steerTimeoutMs } : {}),
          };
          io.steerable((messages) => steerOnMachine(deps.hub, target, messages));
          steering = true;
        }
        let streamEnded = false;
        let replyFinal: BrainEvent | null = null;
        for (;;) {
          const item = await queue.next(replyFinal ? (streamEnded ? 0 : (deps.finalGraceMs ?? 1500)) : undefined);
          if (item === null) {
            if (replyFinal) {
              noteModelRefusal("claude_code", asked, replyFinal);
              yield replyFinal;
            }
            return;
          }
          if (item.kind === "event") {
            noteModelRefusal("claude_code", asked, item.event);
            yield item.event;
            if (isFinal(item.event)) return;
          } else if (item.kind === "stream_end") {
            streamEnded = true;
          } else {
            replyFinal = item.final;
          }
        }
      } finally {
        if (steering) io.steerable?.(null);
        off();
      }
    },
  };
}

/**
 * Records a computer brain's plan usage (source "plan"): tokens with the
 * run, agent and org, cost zero, billed to the owner's plan. The engine calls
 * it for each `usage` event with `source: "plan"` (the Model Gateway records
 * API usage itself), and the router for a plan that picked who answers
 * (kind `router`, no run).
 */
export async function recordPlanUsage(
  db: Database,
  input: {
    orgId: string;
    agentId: string;
    runId?: string;
    kind?: "agent" | "router";
    /** The person behind the run (ADR 0141): the row names them and their month counts the API-equivalent. */
    personId?: string | null;
    /** `claude_code` or `codex`. */
    provider: string;
    /** The computer the turn ran on and the account it spent; `accountId` null: that computer's own sign-in. */
    machineId?: string;
    accountId?: string | null;
    model?: string;
    /** Every input token the turn read, cache included. */
    inputTokens: number;
    outputTokens: number;
    /** How much of `inputTokens` was read from, or written to, the cache (older runners: unknown, 0). */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): Promise<string | null> {
  const cacheRead = Math.max(0, Math.round(input.cacheReadTokens ?? 0));
  const cacheWrite = Math.max(0, Math.round(input.cacheWriteTokens ?? 0));
  const now = new Date();
  const usage = {
    inputTokens: Math.max(0, Math.round(input.inputTokens) - cacheRead - cacheWrite),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
  const model = input.model ?? input.provider;
  const rates = respanRates(model, now);
  const known = catalogModelOf(model);
  const cost = usesRespanPricing()
    ? rates
      ? costAtRates(rates, usage, now)
      : known
        ? costNanoUsd(known, usage, now)
        : 0
    : 0;
  const row = await db.transaction(async (tx) => {
    const [record] = await tx
      .insert(schema.usageRecords)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        kind: input.kind ?? "agent",
        runId: input.runId ?? null,
        credentialId: null,
        provider: input.provider,
        model: input.model ?? input.provider,
        requestedModel: input.model ?? input.provider,
        // Stored like API usage: uncached input apart from cache reads and writes (the totals are the same).
        ...usage,
        createdAt: now,
        costNanoUsd: cost,
        pricingReceipt: usesRespanPricing()
          ? { basis: "api_equivalent", model, card: respanPrimary(model) ?? null }
          : undefined,
        billedTo: "plan",
        machineId: input.machineId ?? null,
        brainAccountId: input.machineId ? (input.accountId ?? null) : null,
        personId: input.personId ?? null,
      })
      .returning({ id: schema.usageRecords.id, inputTokens: schema.usageRecords.inputTokens });
    if (record && cost && (input.kind ?? "agent") === "agent") {
      const periods = schema.agentBudgetPeriods;
      await tx
        .insert(periods)
        .values({ orgId: input.orgId, agentId: input.agentId, periodStart: budgetPeriodOf(now), spentNanoUsd: cost })
        .onConflictDoUpdate({
          target: [periods.agentId, periods.periodStart],
          set: { spentNanoUsd: sql`${periods.spentNanoUsd} + ${cost}`, updatedAt: now },
        });
    }
    return record;
  });
  if (row && input.personId) {
    // One unit for everything: a plan's tokens count at what they would cost through the API.
    const equivalent = usesRespanPricing()
      ? cost
      : apiNano(input.model ?? null, {
          input: row.inputTokens,
          output: Math.max(0, Math.round(input.outputTokens)),
          cacheRead,
          cacheWrite,
        });
    if (equivalent)
      await addPersonSpend(db, { orgId: input.orgId, personId: input.personId, amountNanoUsd: equivalent });
  }
  return row?.id ?? null;
}
