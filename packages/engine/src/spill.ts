import type { PlanUsage } from "@agenteschat/adapters";
import { and, type Executor, eq, isNull, ne, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import { autoPlanModel, claudeCodeModel, NEXT_ACCOUNT_KINDS, planOf } from "@agenteschat/providers/plans";
import type { Agent } from "./agents";
import { accountOrderSql, chainWhereSql } from "./ai-accounts/chain";
import { type BrainPlan, computerBrainUnavailable, NO_AI_CODES, planIsOwners, storedPlanUsage } from "./brains/select";
import type { BrainAccount, BrainSession } from "./brains/types";
import { machineRule, mayUseDevice } from "./devices";
import type { MachineStatus } from "./machine-hub";
import { isRightHand } from "./right-hand";

const { agentRuns, machineAccounts, machines } = schema;

/** Where a spilled run thinks (`Transcript.spill`): `from` is the agent's own computer, which was full. */
export interface SpillRecord {
  from: string;
  to: string;
}

type SpillDeps = { db: Executor; machines?: { status(machineId: string): Promise<MachineStatus | null> } };

/**
 * The run's computer plan moved to `machineId`, on a sign-in there the agent's owner has (an account of theirs, else
 * the computer's own sign-in when they connected it): null when that plan can't think there now.
 */
export async function spillPlan(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  machineId: string,
  session: { id: string; resume: boolean },
): Promise<BrainPlan | null> {
  if (plan.kind === "model" || !deps.machines) return null;
  const [status, row] = await Promise.all([
    deps.machines.status(machineId).catch(() => null),
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        status: machineAccounts.status,
        provider: machineAccounts.provider,
      })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, agent.orgId),
          eq(machineAccounts.machineId, machineId),
          eq(machineAccounts.kind, plan.kind),
          eq(machineAccounts.status, "active"),
          eq(machineAccounts.createdBy, agent.ownerUserId ?? ""),
        ),
      )
      .limit(1)
      .then(([r]) => r),
  ]);
  const account: BrainAccount | undefined = row
    ? { id: row.id, label: row.label, status: "active", ...(row.provider ? { provider: row.provider } : {}) }
    : undefined;
  const usage = await storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, account?.id).catch(() => null);
  const model =
    plan.kind === "claude_code" && plan.model && !isAutoModel(plan.model)
      ? claudeCodeModel(planOf(account?.provider), plan.model)
      : plan.model;
  const ownersPlan = await planIsOwners(
    deps.db,
    { orgId: agent.orgId, ownerUserId: agent.ownerUserId },
    machineId,
    account,
  );
  if (computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, ownersPlan, usage, model))
    return null;
  const { account: _home, usage: _homeUsage, ...rest } = plan;
  return {
    ...rest,
    ...(model ? { model } : {}),
    session: { ...session, machineId, cwd: "" },
    ...(account ? { account } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * A run that went on with another account at its plan's limit (`Transcript.accountMove`, ADR 0041 §6). The agent's own
 * account never changes: the next run starts on it again.
 */
export interface AccountMove {
  /** The account the run started on: its agent's own. */
  from: string;
  to: string;
  /** Whose plan `to` is when that isn't the agent's owner: lent to the run, so it never spends paid extra usage. */
  lentBy?: string;
  /** Every account the run thought with or was refused on, `from` and `to` included: each at most once per run. */
  tried: string[];
}

/** `Transcript.accountSwitch`: each account by id and the name the run's details show it by. */
export interface AccountSwitch {
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** What moved it: its plan's limit, the pause line (99%) of long work, or the paid extra usage it would go into. */
  cause: "limit" | "line" | "extra";
}

/** Where `nextAccountPlan` landed: the plan on the next account, else how many accounts are all limited and the first reset. */
export type NextAccount =
  | { plan: BrainPlan; lentBy: string | null; lenderName?: string }
  | { plan: null; chain: number; resetsAt?: string };

type SeatRow = { id: string; email: string | null; providerOrgId: string | null };
/** Two logins of one seat share its limits (`sameAccountWhere`): one email, in the same Claude organization when both know it. */
const sameSeat = (a: SeatRow, b: SeatRow) =>
  a.id === b.id ||
  (!!a.email &&
    a.email.toLowerCase() === b.email?.toLowerCase() &&
    (!a.providerOrgId || !b.providerOrgId || a.providerOrgId === b.providerOrgId));

type ChainAgent = Pick<Agent, "id" | "orgId" | "ownerUserId" | "brainAccountPinned" | "builtin">;

/**
 * The accounts on `machineId` of `kind` a run of `agent` may go on with at its plan's limit (ADR 0041 §6,
 * `chainWhereSql`): those that serve its owner. The right hand goes on only with the accounts of the person it answers
 * (`forPerson`), so never on a plan someone else gave it. `keep`: the run's own accounts, whatever their sharing.
 * `asker`: someone besides its owner the run answers, whom the account's "Atender todos" must take.
 */
function chainWhere(
  agent: ChainAgent,
  kind: string,
  machineId: string,
  forPerson: string | null,
  keep: string[],
  asker: string | null = null,
) {
  const owner = agent.ownerUserId ?? null;
  if (isRightHand(agent))
    return chainWhereSql(agent.orgId, machineId, kind, forPerson === owner ? owner : null, keep, true);
  return chainWhereSql(agent.orgId, machineId, kind, owner, keep, false, asker);
}

/** Its owner still in the workspace (`planIsOwners`). */
const ownerIsMember = and(
  eq(schema.organizationMembers.orgId, machineAccounts.orgId),
  eq(schema.organizationMembers.userId, machineAccounts.createdBy),
);

/**
 * The next account a run at its plan's limit goes on with (ADR 0041 §6), on the same computer and of the same kind
 * (`chainWhere`): its owner's own first and then the others that serve everyone, each by `use_order`. Never an account
 * `tried` or one of their seats, nor one limited by what is stored: unknown usage is worth a try (a setup token can't
 * read its usage without a turn). `own`: the agent's own account, which takes the run back when it has room. `room`:
 * what long work also needs of an account's stored usage. Null plan: no such account, with how many accounts are limited (the
 * tried ones counted) and the earliest reset.
 */
export async function nextAccountPlan(
  deps: SpillDeps,
  agent: ChainAgent,
  plan: BrainPlan,
  tried: readonly string[],
  options: {
    room?: (usage: PlanUsage | null, accountId: string) => boolean;
    forPerson?: string | null;
    /** Someone besides the agent's owner the run answers (`runAsker`). */
    asker?: string | null;
    own?: string;
  } = {},
): Promise<NextAccount> {
  const machineId = plan.session?.machineId;
  const owner = agent.ownerUserId;
  const none = { plan: null, chain: 0 } as const;
  if (!machineId || !owner || !plan.account || plan.missionId || !NEXT_ACCOUNT_KINDS.includes(plan.kind)) return none;
  if (agent.brainAccountPinned || plan.account.provider) return none;
  const keep = [plan.account.id, ...(options.own ? [options.own] : [])];
  const [status, rows] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    deps.db
      .select({
        id: machineAccounts.id,
        label: machineAccounts.label,
        email: machineAccounts.email,
        providerOrgId: machineAccounts.providerOrgId,
        createdBy: machineAccounts.createdBy,
        ownerName: schema.users.name,
        usage: machineAccounts.usage,
      })
      .from(machineAccounts)
      .innerJoin(schema.organizationMembers, ownerIsMember)
      .leftJoin(schema.users, eq(schema.users.id, machineAccounts.createdBy))
      .where(
        and(
          chainWhere(agent, plan.kind, machineId, options.forPerson ?? null, keep, options.asker ?? null),
          eq(machineAccounts.status, "active"),
        ),
      )
      .orderBy(...accountOrderSql(owner)),
  ]);
  const triedRows = rows.filter((r) => tried.includes(r.id));
  const now = Date.now();
  const chain: SeatRow[] = [];
  let earliest: number | null = null;
  for (const r of rows) {
    const account: BrainAccount = { id: r.id, label: r.label, status: "active" };
    const usage = (r.usage as PlanUsage | null) ?? null;
    const model = isAutoModel(plan.model) ? autoPlanModel(undefined, plan.model, usage) : plan.model;
    const why = computerBrainUnavailable(plan.kind, machineId, status, now, account, true, usage, model);
    const limited = why?.code === "plan_limit";
    if (limited || tried.includes(r.id)) {
      if (!chain.some((c) => sameSeat(c, r))) chain.push(r);
      const at = Date.parse(why?.resetsAt ?? "");
      if (limited && at > now && (earliest === null || at < earliest)) earliest = at;
    }
    if (why || tried.includes(r.id) || triedRows.some((t) => sameSeat(t, r))) continue;
    if (options.room && !options.room(usage, r.id)) continue;
    const { unavailable: _, usage: _usage, ...rest } = plan;
    return {
      plan: {
        ...rest,
        account,
        ...(plan.model ? { model: plan.model } : {}),
        ...(usage ? { usage } : {}),
        session: { ...(plan.session as BrainSession), id: Bun.randomUUIDv7(), resume: false },
      },
      lentBy: r.createdBy === owner ? null : r.createdBy,
      ...(r.createdBy !== owner && r.ownerName ? { lenderName: r.ownerName } : {}),
    };
  }
  return {
    plan: null,
    chain: chain.length,
    ...(earliest !== null ? { resetsAt: new Date(earliest).toISOString() } : {}),
  };
}

/**
 * A resumed run's plan on the account it moved to (`AccountMove.to`), in the session it has there, with what keeps
 * that account from thinking now: null when it may no longer take the run (`chainWhere`: gone from the agent's
 * computer, no longer serving it or its person, or no longer shared).
 */
export async function movedAccountPlan(
  deps: SpillDeps,
  agent: ChainAgent,
  plan: BrainPlan,
  accountId: string,
  forPerson: string | null = null,
  asker: string | null = null,
): Promise<BrainPlan | null> {
  const machineId = plan.session?.machineId;
  if (!machineId || plan.kind === "model") return null;
  const [row] = await deps.db
    .select({ id: machineAccounts.id, label: machineAccounts.label, status: machineAccounts.status })
    .from(machineAccounts)
    .innerJoin(schema.organizationMembers, ownerIsMember)
    .where(and(eq(machineAccounts.id, accountId), chainWhere(agent, plan.kind, machineId, forPerson, [], asker)));
  if (!row) return null;
  const account: BrainAccount = {
    id: row.id,
    label: row.label,
    status: row.status === "active" ? "active" : "signed_out",
  };
  const [status, usage] = await Promise.all([
    deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    storedPlanUsage(deps.db, agent.orgId, machineId, plan.kind, row.id).catch(() => null),
  ]);
  const model = isAutoModel(plan.model) ? autoPlanModel(undefined, plan.model, usage) : plan.model;
  // Of its own account's refusal only what holds for the run on any account (the right hand's, say): its limit,
  // its sign-in or its owner's sharing belong to that account.
  const own = plan.unavailable;
  const carried =
    own && own.code !== "plan_limit" && own.code !== "plan_not_owner" && !NO_AI_CODES.has(own.code) ? own : null;
  const why =
    computerBrainUnavailable(plan.kind, machineId, status, Date.now(), account, true, usage, model) ?? carried;
  const { unavailable: _, usage: _usage, ...rest } = plan;
  return { ...rest, account, ...(usage ? { usage } : {}), ...(why ? { unavailable: why } : {}) };
}

/** Online computers of the workspace other than `home` that take spill-over for someone, with nothing in their line. */
const spillable = (orgId: string, home: string) =>
  and(
    eq(machines.orgId, orgId),
    ne(machines.id, home),
    isNull(machines.deletedAt),
    eq(machines.online, true),
    eq(machines.paused, false),
    eq(machines.execAllowed, true),
    sql`(${machines.spillOwn} or ${machines.spillOthers})`,
    sql`${machines.executors}->>'mode' is distinct from 'system'`,
    sql`not exists (select 1 from ${agentRuns} w where w.org_id = ${machines.orgId}
      and w.waiting_machine_id = ${machines.id} and w.status = 'waiting_input'
      and coalesce(w.state, w.transcript)->'waitingForBrain'->>'code' = 'busy')`,
  );

/** Whether a turn waiting behind others on `home` may find another computer (`spillTarget`): worth a look now. */
export async function spillMayHelp(db: Executor, orgId: string, home: string): Promise<boolean> {
  const [row] = await db.select({ id: machines.id }).from(machines).where(spillable(orgId, home)).limit(1);
  return row !== undefined;
}

/**
 * Spill-over: another online computer of the workspace that may think `personId`'s waited-on turn now, while the
 * agent's own (`plan.session.machineId`) is full. Its owner allowed it (`spill_own` for the owner's own turns,
 * `spill_others` for anyone's whose agents may use it), nothing waits in its line, and the agent's owner has a
 * sign-in there. A server install (an OS user per agent) is never one: the agent has no user of its own there.
 */
export async function spillTarget(
  deps: SpillDeps,
  agent: Agent,
  plan: BrainPlan,
  personId: string,
  session: { id: string },
): Promise<{ machineId: string; plan: BrainPlan } | null> {
  const home = plan.session?.machineId;
  if (!home) return null;
  const candidates = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        spillable(agent.orgId, home),
        sql`(${machines.spillOthers} or (${machines.spillOwn} and ${machines.pairedByUserId} = ${personId}))`,
      ),
    )
    .orderBy(
      sql`${machines.pairedByUserId} = ${personId} desc nulls last`,
      sql`${machines.size}->>'memoryGb' desc nulls last`,
    );
  for (const m of candidates) {
    if (m.pairedByUserId !== personId && !(await mayUseDevice(deps.db, agent.orgId, personId, machineRule(m))))
      continue;
    const moved = await spillPlan(deps, agent, plan, m.id, { id: session.id, resume: false });
    if (moved) return { machineId: m.id, plan: moved };
  }
  return null;
}
