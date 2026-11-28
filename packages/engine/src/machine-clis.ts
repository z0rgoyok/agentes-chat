import {
  CLI_ERROR_MAX,
  CLI_INSTALL_CAUSES,
  CLI_INSTALL_PROTOCOL,
  CLI_INSTALL_STATES,
  type CliInstall,
  type InstallableCli,
  parseExecutors,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { type AccessDeps, cliRequestKey, storeMachineExecutors } from "./machine-access";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { getMachine, MachineOfflineError, type MachineRow } from "./machines";
import { type NotificationDeps, notify } from "./notifications";
import { requirePermission } from "./organizations";

type Deps = AccessDeps & { hub: Pick<MachineCaller, "call" | "status"> };

/** The computer, refused where nobody installs from here: the workspace's own (ours installs by itself) and old apps. */
async function installable(db: Database, actorId: string, orgId: string, machineId: string): Promise<MachineRow> {
  await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (machine.kind === "managed") {
    throw new ForbiddenError(
      "This is the workspace's own computer: it installs its programs itself",
      "machine.managed_access",
    );
  }
  if (machine.protocol < CLI_INSTALL_PROTOCOL) {
    throw new ValidationError(
      "This computer's app is too old to install or look for programs from here. Update the app on it.",
      "machine.cli_outdated",
      { name: machine.name },
    );
  }
  return machine;
}

/**
 * `POST …/machines/{machineId}/clis/check` ("Já instalei, verificar de novo"): the computer reads its PATH again and
 * looks for its coding CLIs now. Anyone who may read the workspace: it changes nothing but what we know. What it finds
 * is stored at once (the runner's `executors.changed` may come later or, with nothing new, never).
 */
export async function checkMachineClis(deps: Deps, actorId: string, orgId: string, machineId: string) {
  const machine = await installable(deps.db, actorId, orgId, machineId);
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind, status?.maintenance);
  const reply: { executors?: unknown } = await deps.hub.call(machine.id, { op: "clis.check" });
  // Checked like `hello.executors`: the row's other fields (`mode`, `ownUsage`…) are never the runner's to set here.
  const executors = parseExecutors(
    reply?.executors && typeof reply.executors === "object" ? (reply.executors as Record<string, unknown>) : {},
  );
  await storeMachineExecutors(deps, machine.id, executors);
  return { found: Object.keys(executors).filter((k) => k !== "broken") };
}

/** The runner's answer, checked: it comes from the person's computer. */
function installOf(r: { install?: unknown } | undefined, tool: InstallableCli): CliInstall | null {
  const f = r?.install as Record<string, unknown> | null | undefined;
  if (!f || typeof f !== "object") return null;
  const state = CLI_INSTALL_STATES.find((s) => s === f.state) ?? "failed";
  const message = typeof f.message === "string" ? f.message.slice(0, CLI_ERROR_MAX) : "";
  const cause = CLI_INSTALL_CAUSES.find((c) => c === f.cause);
  return {
    tool: f.tool === "claude" || f.tool === "codex" ? f.tool : tool,
    state,
    ...(message ? { message } : {}),
    ...(state === "failed" && cause ? { cause } : {}),
  };
}

/**
 * `POST`, `GET` and `DELETE …/machines/{machineId}/cli-install`: install a coding CLI on the computer through its
 * vendor's installer, run as the person there, see where it stands, or stop it. Only the person who connected it, the
 * rule that turns its programs on (`allowMachineTool`): an admin asks them (`askMachineCliInstall`). Offline: to start,
 * `MachineOfflineError`; to ask about, none.
 */
export async function machineCliInstall(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  action: "start" | "status" | "cancel",
  tool: InstallableCli,
): Promise<{ install: CliInstall | null }> {
  const machine = await installable(deps.db, actorId, orgId, machineId);
  if (machine.pairedByUserId !== actorId) {
    throw new ForbiddenError(
      "Only the person who connected this computer can install programs on it",
      "machine.not_owner",
      {
        ownerId: machine.pairedByUserId ?? null,
      },
    );
  }
  if (action === "start") {
    const status = await deps.hub.status(machine.id);
    if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind, status?.maintenance);
  }
  let reply: { install?: unknown };
  try {
    reply = await deps.hub.call(machine.id, { op: "cli.install", action, tool });
  } catch (error) {
    if (action !== "start" && (error instanceof MachineRequestError || error instanceof MachineOfflineError))
      return { install: null };
    throw error;
  }
  if (action === "start") {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "machine.cli_install",
      target: { type: "machine", id: machine.id },
      details: { tool },
    });
  }
  return { install: installOf(reply, tool) };
}

/**
 * `POST …/machines/{machineId}/cli-install/ask`: someone else needs a program installed on a person's computer ("Pedir
 * ao Rui"). Its owner gets one inbox row per computer and program (`device.cli_request`) with the install button;
 * done once the program is found there (`storeMachineExecutors`). Refused to the owner themselves (they install it).
 */
export async function askMachineCliInstall(
  deps: AccessDeps & Pick<NotificationDeps, "now">,
  actorId: string,
  orgId: string,
  machineId: string,
  tool: InstallableCli,
): Promise<{ ownerId: string }> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const ownerId = machine.pairedByUserId;
  if (machine.kind === "managed" || !ownerId) {
    throw new ForbiddenError("This computer's programs stay as they are", "machine.managed_access");
  }
  if (ownerId === actorId) throw new ConflictError("It's your computer: install it yourself", "machine.ask_self");
  await notify(deps, {
    orgId,
    userIds: [ownerId],
    kind: "device.cli_request",
    groupKey: cliRequestKey(machine.id, tool),
    waiting: true,
    actor: { type: "user", id: actorId },
    source: { machineId: machine.id, label: machine.name },
    latest: { reason: tool },
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.cli_ask",
    target: { type: "machine", id: machine.id },
    details: { tool },
  });
  return { ownerId };
}

/** The CLI each computer brain thinks with, as `cli.install` names it. */
const CLI_OF_BRAIN = { claude_code: "claude", codex: "codex" } as const satisfies Record<string, InstallableCli>;

/**
 * Turning "Help when the team's computer is full or away" on (ADR 0233): the CLIs its owner's agents think with that
 * the computer lacks start installing now, with their vendor's installer, so its first spilled turn finds them. Best
 * effort: offline, an app too old, or an install that won't start leaves the turn to say so later. The tools started.
 */
export async function installHelpClis(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
): Promise<InstallableCli[]> {
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine || machine.pairedByUserId !== actorId || machine.kind === "managed") return [];
  const brains = await deps.db
    .selectDistinct({ brain: schema.agents.brain })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.ownerUserId, actorId),
        inArray(schema.agents.brain, Object.keys(CLI_OF_BRAIN)),
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
      ),
    );
  const missing = brains
    .map((b) => CLI_OF_BRAIN[b.brain as keyof typeof CLI_OF_BRAIN])
    .filter((tool) => !machine.executors?.[tool]);
  const started: InstallableCli[] = [];
  for (const tool of missing) {
    const done = await machineCliInstall(deps, actorId, orgId, machineId, "start", tool).catch(() => null);
    if (done?.install) started.push(tool);
  }
  return started;
}
