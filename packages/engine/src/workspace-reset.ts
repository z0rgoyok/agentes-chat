import type { BlobStoreResolver } from "@agenteschat/adapters";
import { and, type Database, eq, isNotNull, isNull, lte, notInArray, rowsOf, schema, sql } from "@agenteschat/db";
import { type AgentDeletionDeps, eraseAgent } from "./agent-deletion";
import { recordAudit } from "./audit";
import { invalidateOrg } from "./cache";
import { ForbiddenError } from "./errors";
import { publishAgentsChanged, publishChannelsChanged, publishListChanged, publishOrgEvent } from "./events";
import { transcriptKey } from "./file-reader";
import { publishMachineAgentsChanged } from "./machines";
import { lockOrgMembers } from "./organizations";
import { enqueue } from "./outbox";
import { ensureRightHand } from "./right-hand";
import { closedRefusal, STANDING_COLUMNS } from "./standing";
import { keptFromDeletion, keptOrg } from "./workspace-deletion";

const { agents, channels, channelMembers, organizations, organizationMembers, rightHandSeats } = schema;

/*
 * Resetting a workspace (owners, with the proof deleting it takes): it stays, with its plan, people, roles,
 * invitations, AI accounts, computers, connectors, Vault and usage, and everything made in it goes at once, for good.
 * Then it starts over as a new one: the right hand, #general with everyone in it, and the onboarding. The `org.reset`
 * job does it; `organizations.reset_requested_at` says it is under way until the transaction that erases it clears it.
 */

/** The job that resets a workspace (`resetWorkspace`). */
export const ORG_RESET_JOB = "org.reset";

/** What a reset waits on, as a deletion past its date does (`keptFromDeletion`): evidence outlives it. */
const KEPT_COLUMNS = { ...STANDING_COLUMNS, deletionHoldAt: organizations.deletionHoldAt };

/**
 * Tenant tables a reset leaves as they are: the workspace's settings, its people and how they join (and the apps they
 * have open), their own settings there, AI accounts and what their keys' models may write, computers, connectors, the
 * Vault (people's own logins among them) and storage, usage and the audit. `blobs` is a storage: the
 * erased files' bytes leave it through their store. `outbox` keeps only the jobs of `RESET_KEEPS_JOBS`, and
 * `outbox_dedupe` every key, as the outbox's finished rows do.
 */
export const RESET_KEEPS = [
  "organization_settings",
  "org_sandbox_settings",
  "organization_members",
  "presence_connections",
  "organization_member_roles",
  "org_roles",
  "organization_invitations",
  "organization_invite_links",
  "organization_join_codes",
  "organization_join_code_events",
  "organization_join_requests",
  "approval_covers",
  "right_hand_brains",
  "right_hand_approvals",
  "person_usage_months",
  "surface_links",
  "support_requests",
  "feedback_files",
  "provider_credentials",
  "model_output_limits",
  "machines",
  "machine_accounts",
  "machine_provisioning",
  "machine_phones",
  "machine_connect_links",
  "machine_device_codes",
  "machine_rpc",
  "connector_connections",
  "connector_tool_pins",
  // Kept connectors' tool names in a language: words, never anything made in the workspace.
  "tool_label_words",
  "custom_tools",
  "oauth_clients",
  "oauth_states",
  "github_app_installations",
  "mail_accounts",
  "vault_connections",
  "vault_items",
  "vault_uses",
  "db_connections",
  "webhook_endpoints",
  "storage_configs",
  "storage_migrations",
  "app_grants",
  "app_tokens",
  // An integration app (ADR 0251) is the workspace's connection, like a connector: its channels go with the channels.
  "integration_apps",
  "oauth_app_requests",
  "blobs",
  "usage_records",
  "connector_usage_days",
  "composio_usage",
  "composio_usage_days",
  "audit_log",
  "operator_events",
  "surface_calls",
  "outbox",
  "outbox_dedupe",
] as const;

/**
 * Jobs a reset leaves waiting: their rows are the kept tables' (people's email, the plan, usage, join requests,
 * connectors, the Vault, computers, storage). Every other job of the workspace still waiting was for something it
 * erases, and goes with it: run later, it would find nothing, or make again what was erased.
 */
export const RESET_KEEPS_JOBS = [
  "email.send",
  "plan.waiting",
  "usage.person_limit",
  "join_request.file",
  "connector.forget_accounts",
  "vault.sync",
  "machine.tasks_offline",
  "machine.down_notice",
  "machine.wake_overdue",
  "storage.migrate",
  "feedback.send",
] as const;

/**
 * Tenant tables whose rows stay as tombstones: agents (`eraseAgent`: usage and audit name them, and their usage
 * cascades from them) and the right hand's places on computers (marked removed, so the computer drops their files).
 */
export const RESET_TOMBSTONES = ["agents", "right_hand_seats"] as const;

/**
 * Tenant tables a reset empties. `messages` goes through its channels (no index of it starts with `org_id`), first
 * `MESSAGE_BATCH` at a time and then whatever came meanwhile.
 */
export const RESET_ERASES = [
  "integration_app_channels",
  "agent_actions",
  "agent_budget_periods",
  "agent_checkouts",
  "agent_consultations",
  "agent_groups",
  "agent_learning_days",
  "agent_questions",
  "agent_repositories",
  "agent_run_steps",
  "agent_runs",
  "agent_scopes",
  "agent_skills",
  "agent_works",
  "app_sends",
  "approval_rules",
  "approvals",
  "artifact_uploads",
  "artifact_versions",
  "artifacts",
  "ask_kinds",
  "autonomy_signals",
  "block_states",
  "browser_handoffs",
  "browser_profile_grants",
  "browser_profiles",
  "budget_reservations",
  "calendar_attendees",
  "calendar_events",
  "calendar_proposals",
  "channel_categories",
  "channel_members",
  "channel_permission_overrides",
  "channel_reads",
  "code_sessions",
  "messages",
  "channels",
  "choice_answers",
  "confidential_threads",
  "context_items",
  "context_proposals",
  "context_usage",
  "dashboard_widget_updates",
  "dashboard_widgets",
  "dashboards",
  "db_agent_policies",
  "db_queries",
  "device_access_requests",
  "drive_folders",
  "forum_participants",
  "forum_topics",
  "forum_turns",
  "github_items",
  "import_items",
  "issue_activity",
  "issue_assignees",
  "issue_columns",
  "issue_counters",
  "issue_projects",
  "issues",
  "live_assets",
  "live_doc_updates",
  "live_docs",
  "live_image_requests",
  "machine_access_requests",
  "machine_file_pulls",
  "machine_holds",
  "machine_mcp_calls",
  "machine_tasks",
  "mail_agent_policies",
  "mail_seen",
  "mail_sends",
  "mail_watches",
  "message_client_ids",
  "message_pins",
  "message_reactions",
  "mission_decisions",
  "mission_deliveries",
  "mission_events",
  "mission_files",
  "mission_join_requests",
  "mission_participants",
  "mission_plan_versions",
  "mission_reviews",
  "missions",
  "notifications",
  "outcomes",
  "poll_votes",
  "polls",
  "right_hand_decisions",
  "routine_hook_calls",
  "routine_hooks",
  "routine_runs",
  "routines",
  "routing_decisions",
  "run_tool_tokens",
  "search_documents",
  "secret_requests",
  "skill_files",
  "skill_uses",
  "skills",
  "surface_deliveries",
  "surface_page_links",
  "team_action_checks",
  "team_actions",
  "telegram_updates",
  "thread_follows",
  "thread_reads",
  "thread_reflections",
  "threads",
  "voice_clips",
  "wiki_folder_audiences",
  "wiki_links",
  "wiki_page_reads",
  "wiki_page_versions",
  "wiki_pages",
] as const;

/**
 * The erased tables that name stored bytes (`blob_key`, in `storage_config_id`'s store): the bytes go after the rows.
 * A file pull's bytes are a Drive version's or a skill's, named again.
 */
export const RESET_STORED_FILES = [
  "artifact_versions",
  "live_assets",
  "voice_clips",
  "skill_files",
  "machine_file_pulls",
] as const;

/** Messages deleted per statement before the reset's transaction. */
export const MESSAGE_BATCH = 5000;

export type ResetDeps = AgentDeletionDeps & {
  /** Where the erased files' bytes are (absent: they stay, with no row naming them). */
  blobs?: BlobStoreResolver;
};

/**
 * Starts a reset: an owner (read again under the lock), not while the workspace is suspended or being deleted. Its
 * audit row and the `org.reset` job go in the same transaction. One already under way keeps its start (`started`
 * false). The caller checked the proof.
 */
export async function requestReset(db: Database, actorId: string, orgId: string) {
  return db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    const [me] = await tx
      .select({
        role: organizationMembers.role,
        standing: STANDING_COLUMNS,
        resetAt: organizations.resetRequestedAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorId)));
    if (me?.role !== "owner") throw new ForbiddenError("Only an owner can reset the workspace");
    const refusal = closedRefusal(me.standing);
    if (refusal) throw refusal;
    if (me.resetAt) return { startedAt: me.resetAt, started: false };
    const [row] = await tx
      .update(organizations)
      .set({ resetRequestedAt: sql`now()`, resetRequestedBy: actorId })
      .where(eq(organizations.id, orgId))
      .returning({ at: organizations.resetRequestedAt });
    const startedAt = row?.at ?? new Date();
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.reset_requested",
      target: { type: "organization", id: orgId },
    });
    // No org_id: the job's row is no tenant's to stop.
    await enqueue(tx, {
      orgId: null,
      kind: ORG_RESET_JOB,
      payload: { orgId },
      dedupeKey: `${ORG_RESET_JOB}:${orgId}:${startedAt.getTime()}`,
    });
    return { startedAt, started: true };
  });
}

/**
 * The `org.reset` job: a no-op unless a reset is under way, and while the workspace is kept as a deletion past its
 * date is (`keptFromDeletion`): it waits, and `enqueueWaitingResets` comes back for it. Every agent goes as deleting it does (its work stops, its
 * secrets and sign-ins leave its computer, its row stays as a tombstone), the right hand included. Its messages go
 * in batches; then one transaction empties `RESET_ERASES` and its jobs for them, marks the right hand's places removed, makes the right hand and #general again
 * (everyone in it, its maker the same), opens the onboarding and clears the reset. After it commits, the erased files'
 * bytes and browser profiles leave their stores and computers, and every member's apps hear `org.reset`. Safe to run
 * again: each step only takes what is still there. Returns whether it reset.
 */
export async function resetWorkspace(deps: ResetDeps, orgId: string, { messageBatch = MESSAGE_BATCH } = {}) {
  const { db } = deps;
  const [org] = await db
    .select({ at: organizations.resetRequestedAt, by: organizations.resetRequestedBy, ...KEPT_COLUMNS })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org?.at || keptFromDeletion(org)) return false;
  const actorId = org.by ?? (await anOwner(db, orgId));
  if (!actorId) return false;

  const live = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  for (const agent of live) await eraseAgent(deps, actorId, orgId, agent.id);

  const files = deps.blobs ? await storedFiles(db, orgId) : [];
  const profiles = await db
    .select({ id: schema.browserProfiles.id, machineId: schema.browserProfiles.machineId })
    .from(schema.browserProfiles)
    .where(and(eq(schema.browserProfiles.orgId, orgId), isNull(schema.browserProfiles.deletedAt)));
  // Ahead of the transaction, each batch its own: a crash leaves the reset asked for, and the next run deletes the rest.
  if (!(await eraseMessages(db, orgId, org.at, messageBatch))) return false;

  const done = await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    const [still] = await tx
      .select({ at: organizations.resetRequestedAt, ...KEPT_COLUMNS })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (!still?.at || keptFromDeletion(still)) return false;
    // One made while the agents above went: a tombstone like theirs.
    await tx
      .update(agents)
      .set({ deletedAt: sql`now()`, builtin: null, handle: sql`'deleted-' || ${agents.id}`, previousHandles: [] })
      .where(and(eq(agents.orgId, orgId), isNull(agents.deletedAt)));
    await tx
      .update(rightHandSeats)
      .set({ removedAt: new Date() })
      .where(and(eq(rightHandSeats.orgId, orgId), isNull(rightHandSeats.removedAt)));
    const [general] = await tx
      .select({ by: channels.createdByUserId })
      .from(channels)
      .where(and(eq(channels.orgId, orgId), eq(channels.name, "general")))
      .limit(1);
    await tx
      .delete(schema.outbox)
      .where(
        and(
          eq(schema.outbox.orgId, orgId),
          eq(schema.outbox.status, "pending"),
          notInArray(schema.outbox.kind, [...RESET_KEEPS_JOBS]),
        ),
      );
    // ponytail: one transaction for every table but the messages' bulk; batch others if a reset outlives the job's lease.
    for (const table of RESET_ERASES) {
      if (table === "messages") {
        await tx.execute(
          sql`delete from messages where channel_id in (select id from channels where org_id = ${orgId}::uuid)`,
        );
      } else {
        await tx.execute(sql`delete from ${sql.identifier(table)} where org_id = ${orgId}::uuid`);
      }
    }
    await ensureRightHand(tx, orgId);
    // Its maker stays: the server's own computer finds the workspaces it serves by who made their #general.
    const [made] = await tx
      .insert(channels)
      .values({ orgId, name: "general", createdByUserId: general?.by ?? actorId })
      .returning({ id: channels.id });
    if (!made) throw new Error("channel insert returned nothing");
    await tx.execute(sql`insert into ${channelMembers} (org_id, channel_id, user_id)
      select org_id, ${made.id}::uuid, user_id from ${organizationMembers} where org_id = ${orgId}::uuid`);
    await tx
      .update(organizations)
      .set({ onboardingStep: "context", onboardedAt: null, resetRequestedAt: null, resetRequestedBy: null })
      .where(eq(organizations.id, orgId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.reset",
      target: { type: "organization", id: orgId },
      details: { agents: live.length },
    });
    return true;
  });
  if (!done) return false;

  // ponytail: bytes go after the commit, best effort; a crash between leaves them with no row naming them.
  for (const file of files) {
    const store = await deps.blobs?.forConfig(orgId, file.storageConfigId).catch(() => null);
    await store?.delete(file.blobKey).catch(() => undefined);
  }
  for (const profile of profiles) {
    await deps.hub
      ?.call(profile.machineId, { op: "browser.profile.delete", profile: { id: profile.id } }, { timeoutMs: 30_000 })
      .catch(() => undefined);
  }
  invalidateOrg(orgId);
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "org.reset", orgId } });
  await publishAgentsChanged(deps.pubsub, orgId);
  await publishChannelsChanged(deps.pubsub, orgId);
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  await publishMachineAgentsChanged(deps.pubsub, orgId);
  return true;
}

/**
 * Resets asked for over 10 minutes ago and not done: their job failed for good, a deploy lost it, or a hold kept it
 * waiting and has lifted. The hourly `deletions` tick queues them again. Returns how many.
 */
export async function enqueueWaitingResets(db: Database, now = new Date()) {
  const waiting = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        isNotNull(organizations.resetRequestedAt),
        lte(organizations.resetRequestedAt, new Date(now.getTime() - 600_000)),
        sql`not ${keptOrg}`,
      ),
    );
  const hour = now.toISOString().slice(0, 13);
  for (const { id } of waiting) {
    await enqueue(db, {
      orgId: null,
      kind: ORG_RESET_JOB,
      payload: { orgId: id },
      dedupeKey: `${ORG_RESET_JOB}:${id}:${hour}`,
    });
  }
  return waiting.length;
}

async function anOwner(db: Database, orgId: string) {
  const [owner] = await db
    .select({ id: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")))
    .limit(1);
  return owner?.id ?? null;
}

/** Every stored file a reset erases (`RESET_STORED_FILES`), and the words read from the Drive's versions. */
async function storedFiles(db: Database, orgId: string) {
  const named = RESET_STORED_FILES.map(
    (table) => sql`select storage_config_id as "storageConfigId", blob_key as "blobKey" from ${sql.identifier(table)}
      where org_id = ${orgId}::uuid and blob_key is not null`,
  );
  const words = sql`select storage_config_id, blob_key || ${transcriptKey("")} from artifact_versions
    where org_id = ${orgId}::uuid`;
  return rowsOf<{ storageConfigId: string | null; blobKey: string }>(
    await db.execute(sql.join([...named, words], sql` union all `)),
  );
}

/**
 * Each batch checks, with the workspace's row held, that this reset is still under way and nothing keeps it: a hold
 * placed meanwhile keeps the rest, and a second `org.reset` job running late never takes what the workspace posted
 * after the first one finished. False when it stopped for that.
 */
async function eraseMessages(db: Database, orgId: string, at: Date, batch: number) {
  const all = await db.select({ id: channels.id }).from(channels).where(eq(channels.orgId, orgId));
  for (const { id } of all) {
    for (;;) {
      const gone = await db.transaction(async (tx) => {
        const [still] = await tx
          .select({ at: organizations.resetRequestedAt, ...KEPT_COLUMNS })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .for("share");
        if (still?.at?.getTime() !== at.getTime() || keptFromDeletion(still)) return null;
        return rowsOf(
          await tx.execute(sql`delete from messages where (id, created_at) in
            (select id, created_at from messages where channel_id = ${id}::uuid limit ${batch}) returning 1 as gone`),
        ).length;
      });
      if (gone === null) return false;
      if (gone < batch) break;
    }
  }
  return true;
}
