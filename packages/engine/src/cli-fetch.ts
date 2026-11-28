import {
  AGENTS_CLI_PROTOCOL,
  AGY_COPY_PROTOCOL,
  CLI_COPIES_PROTOCOL,
  type CliFetchState,
  type CliName,
  type FetchName,
  type PubSub,
  parseCliFetchState,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import type { MachineCaller } from "./machine-hub";
import { getMachine, MachineOfflineError, publishMachineUpdated } from "./machines";
import { requirePermission } from "./organizations";
import { replyThreadOf } from "./runs";

const { agentRuns, machines } = schema;

/**
 * The one way a computer gets its coding CLIs (ADR 0228 §6), on the server's side: which computers fetch a CLI by
 * themselves, and each fetch as its runner tells it (`cli.fetch`), kept with the computer, sent to the apps and shown
 * in the conversation of a run waiting for it.
 */

/** The CLI each brain thinks with. */
export const CLI_OF_KIND: Readonly<Record<string, CliName>> = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
  antigravity: "antigravity",
  devin: "devin",
};

/** The tool name a run's live line carries while its CLI is being fetched (the apps word it `preparingCli`). */
export const PREPARE_CLI_TOOL = "prepare_cli";

interface FetchingMachine {
  kind?: string | null;
  os?: string;
  protocol?: number;
  executors?: schema.MachineExecutors | null;
}

/**
 * Whether `cli` comes by itself on this computer: its runner fetches the pinned build when a turn or a sign-in needs it
 * (`hello.clis.fetchable`), so a CLI not installed there, too old or that won't start is no reason to refuse it. Never
 * the workspace's own computer (its image brings its CLIs) nor a system-mode one (its setup installs them). A runner
 * before `CLI_COPIES_PROTOCOL` brought only the Antigravity CLI, on macOS and Linux (`AGY_COPY_PROTOCOL`).
 */
export function fetchesCli(machine: FetchingMachine | null | undefined, cli: FetchName): boolean {
  if (!machine || machine.kind === "managed" || machine.executors?.mode === "system") return false;
  const protocol = machine.protocol ?? 0;
  if (protocol >= CLI_COPIES_PROTOCOL) return machine.executors?.copies?.fetchable?.includes(cli) ?? false;
  return cli === "antigravity" && protocol >= AGY_COPY_PROTOCOL && (machine.os === "darwin" || machine.os === "linux");
}

/**
 * Whether the apps may ask `machine` to fetch `cli` now (their "Try again" and, in system mode, "Install"): where it
 * comes by itself (`fetchesCli`), and in system mode from `AGENTS_CLI_PROTOCOL` on, for a CLI no agent reaches there.
 */
export function fetchesOnAsk(machine: FetchingMachine | null | undefined, cli: FetchName): boolean {
  if (machine?.executors?.mode !== "system" || machine.kind === "managed") return fetchesCli(machine, cli);
  return (
    (machine.protocol ?? 0) >= AGENTS_CLI_PROTOCOL && (machine.executors.copies?.fetchable?.includes(cli) ?? false)
  );
}

/** A fetch's percent, or null while its size isn't known. */
export const fetchPercent = (fetch: CliFetchState) =>
  fetch.state === "fetching" && fetch.total ? Math.min(100, Math.floor((fetch.done / fetch.total) * 100)) : null;

/**
 * A runner told a fetch moved on, ended or failed: kept with the computer (`executors.copies.fetch`), sent to the apps
 * (`machine.updated` with `cliFetch`), and, for each run whose turn waits for it there (`runIds`), its live line says
 * the CLI is being prepared, with how far (`prepare_cli`); once it ends the line goes back to the run's own.
 */
export async function storeCliFetch(
  deps: { db: Database; pubsub: PubSub | undefined },
  machineId: string,
  cli: FetchName,
  fetch: CliFetchState,
  runIds: readonly string[] = [],
) {
  const state = JSON.stringify({ [cli]: fetch });
  const [row] = await deps.db
    .update(machines)
    .set({
      executors: sql`coalesce(${machines.executors}, '{}'::jsonb) || jsonb_build_object('copies', coalesce(${machines.executors}->'copies', '{}'::jsonb) || jsonb_build_object('fetch', coalesce(${machines.executors}->'copies'->'fetch', '{}'::jsonb) || ${state}::jsonb))`,
    })
    .where(eq(machines.id, machineId))
    .returning({ orgId: machines.orgId, name: machines.name });
  if (!row) return;
  await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { cliFetch: { [cli]: fetch } });
  if (!runIds.length) return;
  const runs = await deps.db
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      channelId: agentRuns.channelId,
      threadRootId: agentRuns.threadRootId,
      triggerMessageId: agentRuns.triggerMessageId,
      replyInThread: agentRuns.replyInThread,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, row.orgId), inArray(agentRuns.id, [...runIds]), eq(agentRuns.status, "running")));
  const pct = fetchPercent(fetch);
  // `<cli>|<computer>|<percent>`: the apps word it (`preparingCli`), the computer's name as its owner gave it.
  const detail = `${cli}|${row.name.replace(/\|/g, " ").slice(0, 60)}|${pct ?? ""}`;
  for (const run of runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.tool",
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
      tool: fetch.state === "fetching" ? PREPARE_CLI_TOOL : null,
      ...(fetch.state === "fetching" ? { detail } : {}),
    });
  }
}

/**
 * `POST …/machines/{machineId}/clis/{cli}/fetch` (the apps' "Try again"): the computer fetches that CLI's pinned build
 * now, whatever an earlier failure said. Anyone who may read the workspace: it changes nothing but what is on the
 * computer, the version agentes.chat already chose. Where it stands comes back at once and then as `machine.updated`.
 */
export async function retryCliFetch(
  deps: { db: Database; pubsub: PubSub | undefined; hub: Pick<MachineCaller, "call" | "status"> },
  actorId: string,
  orgId: string,
  machineId: string,
  cli: FetchName,
): Promise<{ fetch: CliFetchState | null }> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (!fetchesOnAsk(machine, cli) || machine.protocol < CLI_COPIES_PROTOCOL) {
    throw new ValidationError("This computer doesn't fetch that program by itself.", "machine.cli_not_fetched", {
      name: machine.name,
    });
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const reply: { fetch?: unknown } = await deps.hub.call(machine.id, { op: "cli.fetch", cli });
  const fetch = parseCliFetchState(reply?.fetch);
  if (fetch) await storeCliFetch(deps, machine.id, cli, fetch);
  return { fetch };
}
