import {
  ACCESS_ALLOW_PROTOCOL,
  ACCESS_LIMITS,
  ACCESS_PROTOCOL,
  grantedTo,
  type PermissionNeed,
  type PubSub,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerInfo,
  type RunnerToolchains,
  type RunnerTools,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, lt, type SQL, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { createAgentRuns, eligibleChannelAgents } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import type { MachineCaller } from "./machine-hub";
import { taskRequester } from "./machine-tasks";
import {
  assertNotPaused,
  getMachine,
  getMachineById,
  MachineOfflineError,
  machineOnline,
  publishMachineUpdated,
  REMOVED_COMPUTER_MESSAGE,
  requireMachineManager,
} from "./machines";
import { insertMessage, messageView } from "./messages";
import { type NotificationDeps, notify, resolveNotifications } from "./notifications";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { folderPickable } from "./runner-update";
import { replyThreadOf } from "./runs";
import { hopLimitReached, runStretchOf } from "./stretch";
import type { ToolContext } from "./tools/types";

const { machines, machineAccessRequests, agentRuns } = schema;

/**
 * Folders and tools on a connected computer (ADR 0036 §8, protocol 10). The
 * machine decides: its runner reports what it allows (`hello.access`,
 * `access.changed`) and the server keeps the last report per machine. The
 * site can only show it and ask the runner to reduce it (`access.reduce`).
 * An agent asks for a folder with `request_folder_access`; the person
 * answers on the machine (`access.decided`), and the outcome is posted in the
 * agent's thread and wakes it there, like a background task's end.
 */
export type AccessRequestRow = typeof machineAccessRequests.$inferSelect;

export interface AccessDeps {
  db: Database;
  pubsub?: PubSub;
}

/** The folders a machine allows for one agent (absolute paths). */
export function agentFolders(access: RunnerAccess | null | undefined, agentId: string): string[] {
  if (!access) return [];
  return access.folders.filter((f) => grantedTo(f, agentId)).map((f) => f.path);
}

const toolRequestKey = (machineId: string, tool: string) => `device-tool:${machineId}:${tool}`;
/** One inbox row per computer and program for its owner (`device.cli_request`, `askMachineCliInstall`). */
export const cliRequestKey = (machineId: string, tool: string) => `device-cli:${machineId}:${tool}`;
/** One inbox row per folder an agent waits for (`device.folder_request`), done when the machine answers it. */
export const folderRequestKey = (requestId: string) => `device-folder:${requestId}`;

/** The runner's report, stored as is (the machine is the source of truth), and told to the org. */
export async function storeMachineAccess(deps: AccessDeps, machineId: string, access: RunnerAccess) {
  const [row] = await deps.db
    .update(machines)
    // `exec` is the commands switch (as in `hello`): a change on the machine holds now, not at the next connect.
    .set({ access, execAllowed: access.tools.commands === true, updatedAt: new Date() })
    .where(eq(machines.id, machineId))
    .returning({ orgId: machines.orgId });
  if (!row) return;
  // Members refetch; the folders themselves are only in the API, for admins and the pairer.
  await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { access: true });
  // A tool on, from the apps or the computer's own switch, answers whoever asked for it.
  for (const [tool, on] of Object.entries(access.tools)) {
    if (on !== true) continue;
    await resolveNotifications(deps, row.orgId, {
      groupKey: toolRequestKey(machineId, tool),
      kind: "device.tool_request",
    }).catch(() => 0);
  }
}

/** What `machines.executors` keeps of the coding CLIs: each one found, those that can't start, and when they were looked up. */
export function storedExecutors(stored: schema.MachineExecutors | null | undefined): schema.MachineExecutors {
  if (!stored) return {};
  const { claude, codex, cursor, opencode, grok, antigravity, devin, broken, detectedAt } = stored;
  return Object.fromEntries(
    Object.entries({ claude, codex, cursor, opencode, grok, antigravity, devin, broken, detectedAt }).filter(
      ([, v]) => v !== undefined,
    ),
  );
}

/**
 * `executors.changed` (protocol 41): the coding CLIs the runner found since `hello`. Only those keys are replaced;
 * what `hello` stored beside them (the browser, the desktops, the own sign-ins' usage) stays.
 */
export async function storeMachineExecutors(
  deps: AccessDeps,
  machineId: string,
  executors: NonNullable<RunnerInfo["executors"]>,
) {
  const next = JSON.stringify({ ...executors, detectedAt: new Date().toISOString() });
  const [row] = await deps.db
    .update(machines)
    .set({
      executors: sql`(coalesce(${machines.executors}, '{}'::jsonb) - 'claude' - 'codex' - 'cursor' - 'opencode' - 'grok' - 'antigravity' - 'devin' - 'broken') || ${next}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(machines.id, machineId))
    .returning({ orgId: machines.orgId });
  if (!row) return;
  await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { executors: true });
  // A program installed, from the apps or by hand, answers whoever asked for it.
  for (const tool of ["claude", "codex"] as const) {
    if (!executors[tool]) continue;
    await resolveNotifications(deps, row.orgId, {
      groupKey: cliRequestKey(machineId, tool),
      kind: "device.cli_request",
    }).catch(() => 0);
  }
}

/** `toolchains.changed`: what `hello.toolchains` said, replaced whole; the rest of `executors` stays. */
export async function storeMachineToolchains(deps: AccessDeps, machineId: string, toolchains: RunnerToolchains) {
  const [row] = await deps.db
    .update(machines)
    .set({
      executors: sql`coalesce(${machines.executors}, '{}'::jsonb) || jsonb_build_object('toolchains', ${JSON.stringify(toolchains)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(machines.id, machineId))
    .returning({ orgId: machines.orgId });
  if (row) await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { toolchains: true });
}

/** `permissions.changed`: the OS permissions the computer waits on, replaced whole; the rest of `executors` stays. */
export async function storeMachinePermissions(deps: AccessDeps, machineId: string, permissions: PermissionNeed[]) {
  const [row] = await deps.db
    .update(machines)
    .set({
      executors: sql`coalesce(${machines.executors}, '{}'::jsonb) || jsonb_build_object('permissions', ${JSON.stringify(permissions)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(machines.id, machineId))
    .returning({ orgId: machines.orgId });
  if (row) await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { permissions: true });
}

export interface ReduceAccessInput {
  /** Remove a folder for every agent, or only for `agentId`. */
  removeFolder?: { path: string; agentId?: string };
  disableTool?: keyof RunnerTools;
}

/**
 * `POST …/machines/{machineId}/access/reduce` (an admin or the pairer): asks
 * the runner to remove a folder or turn a tool off, and returns what the
 * machine allows now. The op can only take access away; granting never
 * comes from the server.
 */
export async function reduceMachineAccess(
  deps: AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> },
  actorId: string,
  orgId: string,
  machineId: string,
  input: ReduceAccessInput,
): Promise<RunnerAccess> {
  if (!input.removeFolder && !input.disableTool) {
    throw new ValidationError("Say which folder to remove or which tool to turn off", "machine.access_nothing");
  }
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  // Turned back on only on the computer itself, which nobody in the workspace reaches (ADR 0056 §10).
  if (machine.kind === "managed") {
    throw new ForbiddenError(
      "This is the workspace's own computer: its tools and folders stay as they are",
      "machine.managed_access",
    );
  }
  if (machine.protocol < ACCESS_PROTOCOL) {
    throw new ValidationError(
      "This computer's app is too old to change its access from here. Update it.",
      "machine.access_outdated",
    );
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const removeFolder = input.removeFolder
    ? {
        path: input.removeFolder.path.slice(0, ACCESS_LIMITS.path),
        ...(input.removeFolder.agentId ? { agentId: input.removeFolder.agentId } : {}),
      }
    : undefined;
  const reply = await deps.hub.call(machine.id, {
    op: "access.reduce",
    ...(removeFolder ? { removeFolder } : {}),
    ...(input.disableTool ? { disableTool: input.disableTool } : {}),
  });
  await storeMachineAccess(deps, machine.id, reply.access);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.access_reduced",
    target: { type: "machine", id: machine.id },
    details: {
      ...(removeFolder ? { removeFolder } : {}),
      ...(input.disableTool ? { disableTool: input.disableTool } : {}),
    },
  });
  return reply.access;
}

/**
 * `POST …/machines/{machineId}/access/allow` (ADR 0036 §8): the person who paired the computer turns one of its
 * tools on from the apps, in one click where something needed it. Only they may: it is their computer, and an admin
 * still only turns tools off. The runner applies it as its own switch and tells whoever is at the computer, with
 * Undo. The workspace's own computer stays as it is.
 */
export async function allowMachineTool(
  deps: AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> },
  actorId: string,
  orgId: string,
  machineId: string,
  tool: keyof RunnerTools,
): Promise<RunnerAccess> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (machine.kind === "managed") {
    throw new ForbiddenError(
      "This is the workspace's own computer: its tools stay as they are",
      "machine.managed_access",
    );
  }
  if (machine.pairedByUserId !== actorId) {
    throw new ForbiddenError("Only the person who connected this computer can turn its tools on", "machine.not_owner", {
      ownerId: machine.pairedByUserId ?? null,
    });
  }
  if (machine.protocol < ACCESS_ALLOW_PROTOCOL) {
    throw new ValidationError(
      "This computer's app is too old to turn tools on from here. Update the app on it.",
      "machine.access_outdated",
      { name: machine.name },
    );
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const [me] = await deps.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, actorId));
  const reply = await deps.hub.call(machine.id, { op: "access.allow", tool, by: actorId, byName: me?.name ?? "" });
  await storeMachineAccess(deps, machine.id, reply.access);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.access_allow",
    target: { type: "machine", id: machine.id },
    details: { tool },
  });
  return reply.access;
}

/**
 * `POST …/machines/{machineId}/access/pick` (an admin or the person who connected it): asks the agentes.chat app on
 * the computer for a folder, for one agent there or all of them. The app shows who asks and the person there picks
 * the folder in the system's own picker, or says not now: nothing is allowed from here. With `requestId`, an agent's
 * pending folder request is shown there again. A computer without the app is refused (`machine.no_app`): the apps
 * show the terminal command instead.
 */
export async function askMachineFolder(
  deps: AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> },
  actorId: string,
  orgId: string,
  machineId: string,
  input: { agentId?: string; requestId?: string },
): Promise<{ asked: true }> {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  if (machine.kind === "managed") {
    throw new ForbiddenError(
      "This is the workspace's own computer: its folders stay as they are",
      "machine.managed_access",
    );
  }
  if (!folderPickable(machine)) {
    throw new ValidationError(
      "This computer has no agentes.chat app that can pick a folder (or it is too old). Allow it on the computer.",
      "machine.no_app",
      { name: machine.name },
    );
  }
  let agent: { id: string; name: string } | undefined;
  if (input.agentId) {
    const row = await getAgentCached(deps.db, orgId, input.agentId);
    if (!row || row.machineId !== machine.id)
      throw new NotFoundError("That agent doesn't work on this computer", "agent.not_found");
    agent = { id: row.id, name: row.name };
  }
  if (input.requestId) {
    const [request] = await deps.db
      .select({ status: machineAccessRequests.status })
      .from(machineAccessRequests)
      .where(and(eq(machineAccessRequests.id, input.requestId), eq(machineAccessRequests.machineId, machine.id)));
    if (!request) throw new NotFoundError("Folder request not found", "machine.request_not_found");
    if (request.status !== "pending") {
      throw new ConflictError("This request was already answered or has expired", "machine.request_done");
    }
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const [me] = await deps.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, actorId));
  await deps.hub.call(machine.id, {
    op: "access.pick",
    by: actorId,
    byName: me?.name ?? "",
    ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.access_pick",
    target: { type: "machine", id: machine.id },
    details: { ...(agent ? { agentId: agent.id } : {}), ...(input.requestId ? { requestId: input.requestId } : {}) },
  });
  return { asked: true };
}

/**
 * `POST …/machines/{machineId}/access/ask`: someone else needs a tool on a person's computer ("Pedir ao Rui"). Its
 * owner gets one inbox row per computer and tool (`device.tool_request`) with the same one-click button; done once
 * the tool is on (`storeMachineAccess`). Refused to the owner themselves (they turn it on).
 */
export async function askMachineTool(
  deps: AccessDeps & Pick<NotificationDeps, "now">,
  actorId: string,
  orgId: string,
  machineId: string,
  tool: keyof RunnerTools,
): Promise<{ ownerId: string }> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const ownerId = machine.pairedByUserId;
  if (machine.kind === "managed" || !ownerId) {
    throw new ForbiddenError("This computer's tools stay as they are", "machine.managed_access");
  }
  if (ownerId === actorId) {
    throw new ConflictError("It's your computer: turn it on yourself", "machine.ask_self");
  }
  await notify(deps, {
    orgId,
    userIds: [ownerId],
    kind: "device.tool_request",
    groupKey: toolRequestKey(machine.id, tool),
    waiting: true,
    actor: { type: "user", id: actorId },
    source: { machineId: machine.id, label: machine.name },
    latest: { reason: tool },
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.access_ask",
    target: { type: "machine", id: machine.id },
    details: { tool },
  });
  return { ownerId };
}

/** An absolute path on macOS, Linux or Windows (`~/…` too: the runner expands it). */
export const isAbsoluteMachinePath = (path: string) => /^(\/|~\/|~$|[A-Za-z]:[\\/])/.test(path);

/**
 * A path written in full inside the agent's own folder (`<handle>-<first 8 of its id>`, wherever it sits) as the
 * relative path it is there, which is how a secret's file is kept. Any other path stays as it is.
 */
export function pathInOwnFolder(path: string, agentId: string) {
  if (!isAbsoluteMachinePath(path)) return path;
  const id8 = agentId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  // `/home/ag-<id8>` ends the same way and is the agent's home, not its folder.
  const at = parts.map((p, i) => p.endsWith(`-${id8}`) && !(i === 1 && parts[0] === "home" && p === `ag-${id8}`));
  const last = at.lastIndexOf(true);
  return last < 0 ? path : parts.slice(last + 1).join("/");
}

/**
 * A path written in full, for the runner to check against the agent's folder, allowed folders and home; null for any
 * other (`/workspace/…` is the agent's folder under another name).
 */
export function fullMachinePath(raw: string) {
  const path = raw.trim();
  if (!isAbsoluteMachinePath(path) || /^\/workspace(\/|$)/.test(path)) return null;
  if (path.replace(/\\/g, "/").split("/").includes("..")) throw new Error(`invalid path: ${raw}`);
  return path;
}

export type FolderRequestResult =
  | { status: "granted"; requestId: string; path: string }
  | { status: "pending"; requestId: string; path: string };

/**
 * `request_folder_access`: records the request (with the conversation to
 * wake) and asks the runner, which shows it to the person and answers at
 * once: `granted` when that folder is already allowed for this agent, else
 * `pending` (the decision comes later as `access.decided`). Never blocks.
 */
export async function requestFolderAccess(
  deps: AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> },
  ctx: ToolContext,
  machineId: string,
  input: { path: string; reason: string },
): Promise<FolderRequestResult> {
  const path = input.path.trim();
  if (!path || path.length > ACCESS_LIMITS.path || !isAbsoluteMachinePath(path)) {
    throw new ValidationError("Give the folder's absolute path on the computer (like /Users/ana/Projects/site)");
  }
  const machine = await getMachineById(deps.db, machineId);
  if (!machine || machine.deletedAt || machine.orgId !== ctx.orgId) {
    throw new ValidationError(REMOVED_COMPUTER_MESSAGE);
  }
  if (machine.protocol < ACCESS_PROTOCOL) {
    throw new ValidationError(
      `The computer ${machine.name} can't grant folders yet: its owner should install the agentes app (or update agentes.chat there).`,
    );
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  await assertNotPaused(deps.db, machine);
  const agent = await getAgentCached(deps.db, ctx.orgId, ctx.agentId);
  const now = new Date();
  const [row] = await deps.db
    .insert(machineAccessRequests)
    .values({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      machineId: machine.id,
      channelId: ctx.channelId,
      threadRootId: replyThreadOf(ctx),
      runId: ctx.runId || null,
      requestedByUserId: await taskRequester(ctx).catch(() => null),
      path,
      reason: input.reason.trim().slice(0, ACCESS_LIMITS.reason),
      expiresAt: new Date(now.getTime() + ACCESS_LIMITS.requestTtlMs),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("machine_access_requests insert returned nothing");
  try {
    const reply = await deps.hub.call(machine.id, {
      agent: { id: ctx.agentId, handle: agent?.handle ?? "agent", ...(agent ? { name: agent.name } : {}) },
      op: "access.request",
      requestId: row.id,
      path,
      reason: row.reason,
    });
    if (reply.status === "granted") {
      await deps.db
        .update(machineAccessRequests)
        // Nothing to wake for: the agent hears it in the tool result.
        .set({ status: "granted", scope: "agent", decidedAt: new Date(), wokeAt: new Date() })
        .where(eq(machineAccessRequests.id, row.id));
      return { status: "granted", requestId: row.id, path };
    }
  } catch (error) {
    await deps.db
      .update(machineAccessRequests)
      .set({ status: "failed", decidedAt: new Date() })
      // The call can fail after the computer got it (a lost reply): an answer its person already gave stands.
      .where(and(eq(machineAccessRequests.id, row.id), eq(machineAccessRequests.status, "pending")));
    throw error;
  }
  // The agent now waits, up to a day, for whoever is at the computer: its owner hears about it in the inbox, waiting.
  await notifyFolderRequest(deps, row, machine).catch(() => undefined);
  const [settled] = await deps.db
    .select({ status: machineAccessRequests.status })
    .from(machineAccessRequests)
    .where(eq(machineAccessRequests.id, row.id));
  // The answer reached us while the row was being written: nothing waits any more.
  if (settled && settled.status !== "pending") {
    await resolveNotifications(deps, row.orgId, { groupKey: folderRequestKey(row.id) }).catch(() => 0);
  }
  await recordAudit(deps.db, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.agentId },
    action: "machine.access_requested",
    target: { type: "machine", id: machine.id },
    details: { requestId: row.id, path, runId: ctx.runId ?? null },
  }).catch(() => undefined);
  await postRequestedNote(deps, row, machine.name, agent?.handle ?? "agent").catch(() => undefined);
  return { status: "pending", requestId: row.id, path };
}

/**
 * The owner of the computer hears about the folder an agent waits for (`device.folder_request`): one waiting row per
 * request, the agent as actor, the computer and the folder in it. A folder is allowed only on the machine; from the
 * row the owner can only say no (`refuseFolderRequest`). Whichever answer comes first ends it.
 */
async function notifyFolderRequest(
  deps: AccessDeps,
  row: AccessRequestRow,
  machine: { id: string; name: string; pairedByUserId: string | null },
) {
  const ownerId = machine.pairedByUserId;
  if (!ownerId) return;
  await notify(deps, {
    orgId: row.orgId,
    userIds: [ownerId],
    kind: "device.folder_request",
    groupKey: folderRequestKey(row.id),
    waiting: true,
    actor: { type: "agent", id: row.agentId },
    source: {
      machineId: machine.id,
      label: machine.name,
      agentId: row.agentId,
      requestId: row.id,
      channelId: row.channelId,
      ...(row.threadRootId ? { threadId: row.threadRootId } : {}),
      ...(row.requestedByUserId ? { userId: row.requestedByUserId } : {}),
    },
    latest: { title: row.path, text: row.reason },
  });
}

/** The terminal command that allows the folder on a machine without the app (ADR 0036 §8). */
export function allowFolderCommand(path: string, handle: string) {
  const quoted = /^[\w./~:-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
  return `agentes-runner folders allow ${quoted} --agent ${handle}`;
}

/**
 * The pending request as a note in the thread (as the agent, no run): the
 * people see what was asked, and the command for a machine without the app.
 */
async function postRequestedNote(deps: AccessDeps, row: AccessRequestRow, computer: string, handle: string) {
  const command = allowFolderCommand(row.path, handle);
  const message = await insertMessage(deps.db, {
    orgId: row.orgId,
    channelId: row.channelId,
    threadId: row.threadRootId,
    author: { type: "agent", agentId: row.agentId, runId: null, hop: 0, stretchId: null },
    body: `Asked the owner of ${computer} for ${row.path}${row.reason ? ` (${row.reason})` : ""}. Without the app there, they can run: ${command}`,
    meta: {
      machineAccess: { requestId: row.id, path: row.path, decision: "pending", computer, machineId: row.machineId },
      bodyCode: "machine_access_requested",
      bodyParams: { path: row.path, computer, command },
    },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
}

/**
 * Ends the pending requests `where` picks, once each, and the outbox wakes each agent's conversation
 * (`machine.access_decided`). Whoever got there first (the machine, the owner in the apps, the sweep) decides.
 */
async function settleAccessRequests(
  deps: AccessDeps,
  where: SQL | undefined,
  decision: "granted" | "denied" | "expired",
  scope?: "agent" | "all",
): Promise<AccessRequestRow[]> {
  const rows = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(machineAccessRequests)
      .set({
        status: decision,
        scope: decision === "granted" ? (scope ?? "agent") : null,
        decidedAt: new Date(),
      })
      .where(and(eq(machineAccessRequests.status, "pending"), where))
      .returning();
    for (const row of rows) {
      await enqueue(tx, {
        orgId: row.orgId,
        kind: "machine.access_decided",
        payload: { requestId: row.id },
        dedupeKey: `machine.access_decided:${row.id}`,
        maxAttempts: 6,
      });
    }
    return rows;
  });
  // The row waiting on the owner in the inbox is done.
  for (const row of rows) {
    await resolveNotifications(deps, row.orgId, { groupKey: folderRequestKey(row.id) }).catch(() => 0);
  }
  return rows;
}

/** `access.decided` from the machine: the request gets its outcome, once. */
export async function applyAccessDecided(
  deps: AccessDeps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "access.decided" }>,
) {
  const [row] = await settleAccessRequests(
    deps,
    and(eq(machineAccessRequests.id, frame.requestId), eq(machineAccessRequests.machineId, machineId)),
    frame.decision,
    frame.scope,
  );
  return row ?? null;
}

/**
 * `POST …/machines/{machineId}/access/requests/{requestId}/refuse` (an admin or the person who connected it): says no
 * to a folder an agent waits for, from the apps, even with the computer offline. Only a no: a folder is
 * allowed on the computer itself. The agent hears it as the owner's no. An answer given first stands, and is returned.
 */
export async function refuseFolderRequest(
  deps: AccessDeps,
  actorId: string,
  orgId: string,
  machineId: string,
  requestId: string,
): Promise<{ status: string }> {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  const mine = and(eq(machineAccessRequests.id, requestId), eq(machineAccessRequests.machineId, machine.id));
  const [refused] = await settleAccessRequests(deps, mine, "denied");
  if (refused) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "machine.access_refused",
      target: { type: "machine", id: machine.id },
      details: { requestId, path: refused.path },
    });
    return { status: refused.status };
  }
  const [row] = await deps.db.select({ status: machineAccessRequests.status }).from(machineAccessRequests).where(mine);
  if (!row) throw new NotFoundError("That folder request is gone", "machine.not_found");
  return { status: row.status };
}

/**
 * Requests past their day that the machine never answered (offline, or removed), ended as expired here too, so the
 * agent hears it and the owner's inbox row is done (worker, every minute). The runner expires its own copy as well.
 */
export async function expireFolderRequests(deps: AccessDeps, now = new Date()) {
  return (await settleAccessRequests(deps, lt(machineAccessRequests.expiresAt, now), "expired")).length;
}

/** The note in the thread (English; the app shows `bodyCode` in the person's language). */
export function accessDecisionNotice(row: AccessRequestRow, computer: string) {
  const body =
    row.status === "granted"
      ? `The owner allowed ${row.path} on ${computer}${row.scope === "all" ? " for every agent" : ""}.`
      : row.status === "denied"
        ? `The owner didn't allow ${row.path} on ${computer}.`
        : `Nobody answered the request for ${row.path} on ${computer} in time, so it expired.`;
  return {
    body,
    meta: {
      machineAccess: {
        requestId: row.id,
        path: row.path,
        decision: row.status,
        ...(row.scope ? { scope: row.scope } : {}),
        computer,
        machineId: row.machineId,
        // The run that asked: the work it needed the folder for continues for whoever is behind it (`authority.ts`).
        ...(row.runId ? { runId: row.runId } : {}),
      },
      bodyCode: `machine_access_${row.status}`,
      bodyParams: { path: row.path, computer },
    } as Record<string, unknown>,
  };
}

/**
 * `machine.access_decided`: a note in the thread the agent asked from (as
 * the agent), and a run of that agent on it, unless the hop limit, the
 * agent's audience or its leaving the channel says no. Once per request.
 */
export async function wakeForAccessDecision(deps: AccessDeps, requestId: string, options: { maxHops: number }) {
  const [row] = await deps.db.select().from(machineAccessRequests).where(eq(machineAccessRequests.id, requestId));
  if (!row || row.wokeAt || row.status === "pending" || row.status === "failed") return null;
  const machine = await getMachineById(deps.db, row.machineId);
  const computer = machine?.name ?? "the computer";
  const [origin] = row.runId
    ? await deps.db
        .select({
          hop: agentRuns.hop,
          stretchId: agentRuns.stretchId,
          triggerMessageId: agentRuns.triggerMessageId,
          threadRootId: agentRuns.threadRootId,
          replyInThread: agentRuns.replyInThread,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, row.runId))
    : [];
  const hop = origin?.hop ?? 1;
  // The work it ends is the origin run's, in its stretch (ADR 0089).
  const stretchId = origin ? runStretchOf(origin) : null;
  const eligible = await eligibleChannelAgents(
    deps.db,
    row.orgId,
    row.channelId,
    [row.agentId],
    row.requestedByUserId ? { requesterUserId: row.requestedByUserId } : {},
  );
  const notice = accessDecisionNotice(row, computer);
  const result = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineAccessRequests)
      .set({ wokeAt: new Date() })
      .where(and(eq(machineAccessRequests.id, row.id), isNull(machineAccessRequests.wokeAt)))
      .returning({ id: machineAccessRequests.id });
    if (!claimed) return null;
    const message = await insertMessage(tx, {
      orgId: row.orgId,
      channelId: row.channelId,
      threadId: row.threadRootId,
      author: { type: "agent", agentId: row.agentId, runId: null, hop, stretchId },
      body: notice.body,
      meta: notice.meta,
    });
    const runs =
      eligible.length > 0 && !(await hopLimitReached(tx, message, options.maxHops))
        ? // The run that asked goes on where it answered (ADR 0214).
          await createAgentRuns(tx, message, [row.agentId], "mention", origin ? { after: origin } : {})
        : [];
    return { message, runs };
  });
  if (!result) return null;
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(result.message));
  for (const run of result.runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: row.channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
    });
  }
  return result;
}

/** The access an agent sees in its context: its folders and the tools, when its computer reports them. */
export async function agentMachineAccess(db: Database, orgId: string, agentId: string, machineId: string) {
  const machine = await getMachineById(db, machineId);
  if (!machine || machine.deletedAt || machine.orgId !== orgId || !machine.access) return null;
  return {
    name: machine.name,
    online: machineOnline(machine),
    folders: agentFolders(machine.access, agentId),
    tools: machine.access.tools,
  };
}
