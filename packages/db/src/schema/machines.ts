import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A plan's usage limits as the runner last reported them (protocol 19): the
 * same shape as `PlanUsage` in the machine protocol.
 */
export interface MachinePlanUsage {
  windows: {
    kind: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "monthly" | "other";
    label?: string;
    usedPercent: number;
    resetsAt?: string;
    /** When this window was last read, where that is before `at` (`PlanWindow.at`). */
    at?: string;
  }[];
  limited?: boolean;
  source: "turn" | "probe";
  at: string;
  /** The models at a limit of their own, by model id (`PlanModelLimit` in `@agenteschat/adapters`). */
  models?: Record<string, { at: string; until?: string; region?: true; off?: true; inactive?: true }>;
  /** The model that last answered with the account's key (`PlanUsage.answered`). */
  answered?: string;
  /** Stuck at its limit: when the server last asked its computer to read it again (`recheckStuckPlans`). */
  checkedAt?: string;
}

/**
 * What `hello` says about the coding CLIs on the machine (ADR 0025, protocol 7), its browser (protocol 12),
 * its desktops and its terminal (protocol 18), and the agents' use of their desktops (protocol 21).
 */
export interface MachineExecutors {
  /** `loggedIn`/`authMethod`/`plan`: from `claude auth status` (protocol 8; absent = unknown). */
  claude?: { version: string; loggedIn?: boolean; authMethod?: string; plan?: string };
  /**
   * `path`: the copy its runner starts, the newest it found. `loggedIn`/`authMethod`/`plan`: its own sign-in as its
   * app-server's `account/read` says (`chatgpt` with its plan, `api_key`, `provider`), else `codex login status` on a
   * sign-in it found (absent = unknown). `sandbox` (Windows, runner protocol 80): what holds its commands there, `none`
   * where nothing could; absent until its runner knows.
   */
  codex?: {
    version: string;
    path?: string;
    loggedIn?: boolean;
    authMethod?: string;
    plan?: string;
    sandbox?: "mxc" | "unelevated" | "none";
  };
  /** Cursor's CLI (protocol 36, ADR 0114) and the models its sign-in lists; `inPlan`: the CLI said the plan includes it. */
  cursor?: { version: string; models?: { id: string; label?: string; inPlan?: boolean }[] };
  /** OpenCode's CLI (protocol 39, ADR 0132) and the models it lists; `free`: OpenCode's free tier. */
  opencode?: { version: string; models?: { id: string; label?: string; free?: boolean }[] };
  /** Grok Build, xAI's CLI (protocol 43, ADR 0142), and the models it lists. */
  grok?: { version: string; models?: { id: string; label?: string }[] };
  /** Google's Antigravity CLI (protocol 44, ADR 0143), and the models it lists. */
  antigravity?: { version: string; models?: { id: string; label?: string }[] };
  /**
   * Cognition's Devin CLI (protocol 89, ADR 0253), and the model families its accounts list: each one's levels, whether
   * it has a faster variant, its window, and whether the plan serves it at no cost.
   */
  devin?: {
    version: string;
    models?: {
      id: string;
      label?: string;
      free?: boolean;
      efforts?: string[];
      fast?: boolean;
      contextWindow?: number;
    }[];
  };
  /** A CLI that is there and can't start (`--version` keeps failing), with its own error line; `git_missing`: see `CLI_GIT_MISSING`. */
  broken?: Partial<Record<"claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin", string>>;
  /** `hello.browser` (ADR 0040): whether the agent browser can run there; absent = not reported. */
  browser?: {
    available: boolean;
    version?: string;
    chrome?: string;
    reason?: string;
    /** `reason` as a code the apps word (protocol frames from older runners have none). */
    code?: string;
    chromeMissing?: true;
  };
  /** `hello.desktop` (ADR 0058): whether the agents' desktops can run there; absent = not reported. */
  desktop?: { available: boolean; reason?: string; code?: string; width?: number; height?: number };
  /** `hello.terminal` (ADR 0058): whether people can open a terminal there; absent = not reported. */
  terminal?: { available: boolean; reason?: string; code?: string };
  /** `hello.desktopUse` (ADR 0062): whether agents can use their desktops there; absent = not reported. */
  desktopUse?: { available: boolean; reason?: string; code?: string };
  /** `hello.apps` (ADR 0258): whether agents can use the person's apps there; absent = not reported. */
  apps?: { available: boolean; reason?: string; code?: string };
  /** `hello.mode` (ADR 0058 §10): each agent works as its own OS user; absent = all as the runner's user. */
  mode?: "system";
  /** `hello.windowsBuild` (runner protocol 80): a Windows computer's build (`10.0.19045`); absent elsewhere or older. */
  windowsBuild?: string;
  /**
   * `hello.clis` (ADR 0228 §6): the coding CLIs its runner fetches by itself there, and where each fetch stands
   * (`fetching` with bytes done and total, `ready`, or `failed` with why), updated by its `cli.fetch` frames.
   */
  copies?: {
    fetchable?: ("claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin" | "git")[];
    fetch?: Partial<
      Record<
        "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin" | "git",
        | { state: "fetching"; version: string; done: number; total: number | null }
        | { state: "ready"; version: string }
        | {
            state: "failed";
            version: string;
            reason: "offline" | "hash_mismatch" | "no_build" | "disk_full" | "failed";
          }
      >
    >;
  };
  /** `hello.claudeLoginMethods` (protocol 50): what a new Claude sign-in for all agents can use there; absent: older. */
  claudeLoginMethods?: ("cli_login" | "setup_token" | "api_key")[];
  /** `hello.claudeLoginBlocked`: why the computer's self-check keeps `cli_login` for all agents off, kept until a check passes. */
  claudeLoginBlocked?: string;
  /** `hello.authEgressGroup` (protocol 50): root's Claude sign-in CLIs there run in the `agentes-auth` group. */
  authEgressGroup?: true;
  /** `hello.app` (protocol 87): the agentes.chat app runs its runner; absent: from the terminal, or an older runner. */
  app?: true;
  /**
   * `hello.permissions` and `permissions.changed`: the OS permissions its agents' work waits on there (macOS's Full
   * Disk Access, Screen Recording…), one each, with what asked and when; absent: none reported.
   */
  permissions?: { permission: string; trigger: string; agentId?: string; since: string }[];
  /** `hello.toolchains` (bring your own devices): what it can build and drive phones with, by tool, its version. */
  toolchains?: Record<string, string>;
  /** The usage of the computer's own sign-ins (protocol 19), by brain; kept across reconnects. */
  ownUsage?: {
    claude_code?: MachinePlanUsage;
    codex?: MachinePlanUsage;
    cursor?: MachinePlanUsage;
    opencode?: MachinePlanUsage;
    grok?: MachinePlanUsage;
    antigravity?: MachinePlanUsage;
    devin?: MachinePlanUsage;
  };
  detectedAt?: string;
}

/** What we do to the workspace's own computer (`PUT …/maintenance`), worded by the apps (ADR 0257). */
export const MAINTENANCE_KINDS = ["moving", "restarting", "updating", "converting", "host_maintenance"] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
/**
 * Why, or which step, as a code the apps word: a move's `copying` (it works, maybe slower) or `handover` (away for a
 * minute or two), a restart's `unresponsive` (it stopped answering, so we restarted it).
 */
export const MAINTENANCE_DETAILS = ["copying", "handover", "unresponsive"] as const;
export type MaintenanceDetail = (typeof MAINTENANCE_DETAILS)[number];

export interface MachineMaintenanceRecord {
  kind: MaintenanceKind;
  /** ISO: when this kind of work began (kept while the operator says the same kind again). */
  since: string;
  /** ISO: when it should be back or done, as the operator expects; null: unknown. */
  eta: string | null;
  detail: MaintenanceDetail | null;
}

/** A computer's size as its runner reported it (protocol 22), the same shape as `MachineSize` in the protocol. */
export interface MachineSizeRecord {
  cpus: number;
  memoryGb: number;
  diskGb: number;
  limit?: { cpus: number; memoryGb: number };
  /** Background tasks it runs at once (protocol 75), also as `runner.state` and `limits.set` said it since. */
  maxTasks?: number;
  /** Protocol 78: about how many more tasks fit now, where memory is read (`TaskRoomReport` in the protocol). */
  room?: { more: number; freeGb: number; cpuBusy: boolean; pushHarder: boolean };
  /** The processor's and the system's names (`MachineSize.cpuModel`, `system`); absent from an older runner. */
  cpuModel?: string;
  system?: string;
  /** Physical cores (`MachineSize.cores`); `cpus` counts logical CPUs. Absent from an older runner and Windows. */
  cores?: number;
}

/** How busy a computer got over the last day (protocol 22: `MachineLoad` in the protocol), and when it said so. */
export interface MachineLoadRecord {
  loadAvg: number;
  loadPeak: number;
  memoryAvg: number;
  memoryPeak: number;
  hours: number;
  /** Processes stopped for memory in the agents' slices over those hours (`MachineLoad.oomKills`). */
  oomKills?: number;
  /** The workspace disk's free GB and share in use, and the shared folder's GB (ADR 0115). */
  diskFreeGb?: number;
  diskUse?: number;
  sharedGb?: number;
  /** The workspace disk's size in GB, and what takes it by kind (`MachineLoad.diskGb`, `diskParts`). */
  diskGb?: number;
  diskParts?: { projects: number; apps: number; agents: number; caches: number; system: number };
  /** What the agents' temporary folders held in memory, GB (`MachineLoad.agentTmpRamGb`). */
  agentTmpRamGb?: number;
  /** The server's own mark: its admins heard of this disk passing the line, and won't again until it drops under 80%. */
  diskWarned?: boolean;
  at: string;
}

/** What its agents' browsers sent and received over the last day (protocol 23: `BrowserTraffic`), and when it said so. */
export interface MachineTrafficRecord {
  up: number;
  down: number;
  hours: number;
  at: string;
}

/**
 * What the machine allows beyond the agents' own folders (ADR 0036 §8,
 * protocol 10), as its runner last reported it (`hello.access`,
 * `access.changed`). The same shape as `RunnerAccess` in the machine protocol.
 */
export interface MachineAccess {
  folders: { path: string; agents: string[] }[];
  tools: {
    claude: boolean;
    codex: boolean;
    cursor?: boolean;
    opencode?: boolean;
    grok?: boolean;
    antigravity?: boolean;
    devin?: boolean;
    commands: boolean;
    browser?: boolean;
    desktop?: boolean;
    terminal?: boolean;
  };
}

/**
 * Where a computer came from: `connected` (a person paired it, ADR 0036 §5),
 * `host` (the server's own computer, one row per organization it serves) or
 * `managed` (the workspace's computer, given by the operator's provisioner:
 * ADR 0056 §10; one per organization).
 */
export type MachineKind = "connected" | "host" | "managed";

/** One runner socket that closed: when it opened and closed, and the close code and reason. */
export interface MachineDisconnect {
  connectedAt: string;
  at: string;
  code: number;
  reason: string;
}

/**
 * Connected computers (ADR 0025): machines people paired, where our runner
 * keeps one outbound WebSocket open. The token is stored as SHA-256 only;
 * deleting a machine (soft) clears it, so the runner is refused at once.
 */
export const machines = pgTable(
  "machines",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().$type<MachineKind>().notNull().default("connected"),
    pairedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** SHA-256 (hex) of `agm_…`; null once deleted. */
    tokenHash: text().unique(),
    /**
     * `host` rows: SHA-256 of the `HOST_COMPUTER_TOKEN` their token was
     * issued under; a server started with another one retires that token.
     */
    hostKey: text(),
    hostname: text().notNull().default(""),
    /** `linux`, `darwin`, `windows` or `other`. */
    os: text().notNull().default("other"),
    arch: text().notNull().default(""),
    runnerVersion: text().notNull().default(""),
    protocol: integer().notNull().default(1),
    /** Absolute path of the workspace on the machine (admins and the pairer only). */
    workspace: text().notNull().default(""),
    /** `false`: the runner was started with `--no-exec` (files and uploads only). */
    execAllowed: boolean().notNull().default(true),
    /**
     * Coding CLIs the runner found on the machine at its last `hello`
     * (`claude`, `codex`: their `--version`), and when it looked. Empty: an
     * older runner that doesn't report them.
     */
    executors: jsonb().$type<MachineExecutors>().notNull().default({}),
    /**
     * The owner paused this computer (ADR 0036 §6, protocol 9): no new work
     * goes to it. `paused_until` null with `paused`: until they resume. A
     * past `paused_until` means it is no longer paused.
     */
    paused: boolean().notNull().default(false),
    pausedUntil: timestamp({ withTimezone: true }),
    /** Who paused it from the apps (`REMOTE_PAUSE_PROTOCOL`); null when paused on the computer itself. */
    pausedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Folders and tools the machine allows (protocol 10); null: its runner doesn't report them. */
    access: jsonb().$type<MachineAccess>(),
    /** Its size (protocol 22, kept from the last runner that said); null: unknown. */
    size: jsonb().$type<MachineSizeRecord>(),
    /** Its last day's load (protocol 22); null: unknown. */
    load: jsonb().$type<MachineLoadRecord>(),
    /** Its agents' browsers' last day of traffic, in bytes (protocol 23); null: unknown. */
    browserTraffic: jsonb().$type<MachineTrafficRecord>(),
    /** The address an agent process observed, updated only when it changes. */
    egress: jsonb().$type<{ ip: string | null; country?: string; at: string }>(),
    networkTransition: jsonb().$type<{ state: "draining" | "restart_required"; deadline: string; agents: string[] }>(),
    /** A background task interrupted by the machine going away resumes by itself when it comes back (ADR 0029). */
    resumeTasks: boolean().notNull().default(true),
    /**
     * Agents that used this computer when it was removed (set by the removal,
     * which leaves them with no computer). Reconnecting the same computer
     * gives it back to those that still have none, then clears this.
     */
    previousAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * Who may point their agents at it as a target (bring your own devices): `owner` (its pairer, and agents working
     * for them), `everyone`, or `people` (`audience_user_ids`, anyone holding one of `audience_role_ids`, plus the
     * owner). An agent whose home it is always uses it; the machine's own `access` stays the ceiling.
     */
    audienceMode: text().$type<"everyone" | "people" | "owner">().notNull().default("owner"),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** An admin marked it the workspace's: it stays when its pairer leaves (an `owner` rule then reads as everyone). */
    belongsToWorkspace: boolean().notNull().default(false),
    /**
     * "Help when the team's computer is full or away" (ADR 0233): while an agent's own computer is full or away, a
     * fresh turn of its owner's agents (anyone's, on a computer marked the workspace's) may think here instead, on a
     * sign-in of the agent's owner. Only whoever connected it turns it on.
     */
    spillOwn: boolean().notNull().default(true),
    /**
     * "Use this computer for my agents' work" (ADR 0233 addendum): its owner's agents' fresh turns that aren't a
     * person's reply (asks, routines, long work at its start) start here whenever it is free, before the line of
     * their own computer. Only whoever connected it turns it on.
     */
    spillFirst: boolean().notNull().default(false),
    /** Retired by ADR 0233 (one switch, `spill_own`): nothing reads it. */
    spillOthers: boolean().notNull().default(false),
    /**
     * ADR 0237, a person's computer (`connected`): its owner lets the workspace's own computer's web traffic go out
     * through this computer's internet. On for every computer: the owners of those paired before the choice was shown
     * heard it once in the inbox (`device.internet_shared`, migration 0351).
     */
    egressShare: boolean().notNull().default(true),
    /** When it was last turned on or picked: the newest online one carries the traffic. Null: since it was paired. */
    egressShareAt: timestamp({ withTimezone: true }),
    /**
     * With `egressShare` on: the workspace's agents use only this computer's internet (ADR 0237, amendment
     * 2026-11-27 c), their AI calls included, and never their usual way. Offline, they have no internet until it is
     * back. Only whoever connected it turns it on.
     */
    egressOnly: boolean().notNull().default(false),
    /**
     * A computer that borrows (`borrowsInternet`): the lent computer that carried its last connection, and when (written
     * at most once a minute per server process). The apps say whose internet it uses while that is recent. `since`:
     * when that computer began carrying them (absent on rows written before it was kept).
     */
    egressVia: jsonb().$type<{ machineId: string; at: string; since?: string | null }>(),
    /**
     * A lending computer (`connected`): when it last carried a lent connection, whoever borrowed (written at most once
     * a minute per server process). Its page says "In use now" while that is recent.
     */
    egressLentAt: timestamp({ withTimezone: true }),
    /** Last known; trust it only with a recent `last_seen_at` (a replica may have died). */
    online: boolean().notNull().default(false),
    /** The server process holding its socket. */
    connectedReplica: text(),
    lastSeenAt: timestamp({ withTimezone: true }),
    /** Its runner's last sockets that closed, newest first (at most `MACHINE_DISCONNECTS_KEPT`): why it went offline. */
    disconnects: jsonb().$type<MachineDisconnect[]>().notNull().default([]),
    /**
     * The operator put the workspace's own computer (`managed`) in standby (ADR 0161): asleep by design, it is woken
     * when something wants it. Its runner's next hello clears it.
     */
    standbyAt: timestamp({ withTimezone: true }),
    /**
     * In standby, when something first wanted it awake (`wantMachine`). People see it online only for a while after
     * (`shownStandby`): one that never wakes shows its real state. Cleared with `standby_at`.
     */
    wakeWantedAt: timestamp({ withTimezone: true }),
    /**
     * The operator says the workspace's own computer's agents wait for their way out (`PUT …/egress-waiting`): where
     * its network sends them only through a proxy, none works now, so their connections are refused for a while. The
     * apps show a line; null: they don't wait.
     */
    egressWaitingAt: timestamp({ withTimezone: true }),
    /**
     * When the operator last said what it does to the workspace's own computer (`PUT …/maintenance`, or `PUT …/moving`
     * from before kinds, hence the name): the apps say that instead of offline (`shownMaintenance`). Null: nothing.
     */
    movingAt: timestamp({ withTimezone: true }),
    /** What it does, as last said (`PUT …/maintenance`); null with `moving_at` set: a move told by `PUT …/moving`. */
    maintenance: jsonb().$type<MachineMaintenanceRecord>(),
    /** Last time a run or a person wanted this computer (written at most every 30 s per server process). */
    wantedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.id),
    index().on(t.orgId),
    // Removed ones too: turning the server's computer back on, or issuing a
    // managed computer again, brings the same row back.
    uniqueIndex("machines_host_org").on(t.orgId).where(sql`${t.kind} = 'host'`),
    uniqueIndex("machines_managed_org").on(t.orgId).where(sql`${t.kind} = 'managed'`),
  ],
);

/**
 * How far the workspace's computer is (ADR 0056 §10), with
 * `MACHINE_PROVISIONING=external`: `preparing` (`step`: reserving, starting,
 * installing, connecting), `waiting` (`reason`: capacity; an older
 * provisioner's `approval` reads as capacity) and `problem` are the
 * provisioner's to set; `ready` is set here, on the managed computer's first
 * hello. No row: nothing reported yet.
 */
export const machineProvisioning = pgTable("machine_provisioning", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  state: text().notNull(),
  step: text(),
  /** With `preparing`: what the computer is doing within its step, in the provisioner's word (`updating`, `apps`…). */
  stage: text(),
  reason: text(),
  /** With `preparing`: the earliest ready time this wait was told (already past: it runs over). */
  expectedReadyAt: timestamp({ withTimezone: true }),
  /** When people started waiting: set when the computer is taken away; null: since the workspace was created. */
  requestedAt: timestamp({ withTimezone: true }),
  /** The wait was said to take over a minute: the owners were told they'd get the ready email. */
  emailWhenReady: boolean().notNull().default(false),
  specs: jsonb().$type<{ cpus: number; memoryGb: number; diskGb: number }>(),
  /** When this state (and step or reason) began. */
  since: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Accounts of the computer brains on a machine (ADR 0041, ADR 0059): a folder
 * on the computer (`<runner home>/accounts/<kind>/<id>`) where Claude Code or
 * Codex keeps its own sign-in. Nothing secret here: what the CLI's status
 * command says (email, plan) and whether it is still signed in. `id` is the
 * folder's name (made by the server when a sign-in starts, or by the desktop
 * app's runner), so it is unique per organization; the runner's
 * `hello.accounts` keeps the rows in sync.
 */
export const machineAccounts = pgTable(
  "machine_accounts",
  {
    id: uuid().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    /** `claude_code` or `codex` (validated in code). */
    kind: text().notNull(),
    /** What people call it ("Trabalho"); "Claude 2" when nobody named it (ADR 0059 §4). */
    label: text().notNull(),
    email: text(),
    /** `pro`, `max`, `ultra`, `team`, `enterprise`… from what the CLI says. */
    plan: text(),
    /**
     * `active`, `signed_out` (the CLI refused the sign-in, or said it isn't
     * signed in), `signing_in` (started from the app, not finished yet: not an
     * account until the runner reports it) or `removing` (disconnected: the
     * runner signs it out and deletes its folder, even if that waits for the
     * computer to come back, then the row goes).
     */
    status: text().notNull().default("active"),
    /**
     * Whose account it is: who started its sign-in, bound when it starts. One
     * the runner reported first (the desktop app) is its pairer's. Null: nobody's.
     */
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    /** A coding plan's provider for an account that signs in with a key; null: the CLI's own sign-in. */
    provider: text(),
    /** The last 4 characters of a plan key, as the runner reports them. */
    keyHint: text(),
    /** The Claude Team or Enterprise organization of the seat, as the CLI reports it. */
    orgName: text(),
    /** The plan's usage limits, as the runner last reported them. */
    usage: jsonb().$type<MachinePlanUsage>(),
    /**
     * The runner says it thinks for all of its owner's agents on that computer (protocol 29, ADR 0059 §2); else a
     * login thinks for one agent.
     */
    shared: boolean().notNull().default(false),
    /**
     * Who it thinks for (ADR 0059 §3): `everyone` in the workspace (people's right hand and any agent), or only its
     * `owner`'s. Only the person who connected it changes it, for every login of that account.
     */
    serves: text().notNull().default("everyone"),
    /**
     * Its three permissions, each an audience of people besides its owner, who always holds them: `owner` (nobody
     * else), `admins` (administrators), `roles` or `people` (the ids below) or `everyone`. "Gerenciar" renames,
     * removes it and sets "Usar em agentes"; "Usar em agentes" is whose agents (by the agent's owner) and right hand
     * may think with it, and replaces `serves`, which stays only for older apps; "Atender todos" is whom an agent on it
     * answers besides the agent's owner (`owner` there: the agent's owner alone).
     */
    manageMode: text().notNull().default("admins"),
    manageUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    manageRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    useMode: text().notNull().default("everyone"),
    useUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    useRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    replyMode: text().notNull().default("owner"),
    replyUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    replyRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * Its place in the workspace's order of use (ADR 0041 §6): at a plan's limit a run goes on with the next account
     * that serves its agent, lowest first; null after every numbered one, oldest first.
     */
    useOrder: integer(),
    /**
     * How it signs in (protocol 50): `cli_login`, `setup_token` or `api_key`. Set when its sign-in starts and from
     * what the runner reports, never cleared by a report that doesn't say; null: unknown.
     */
    authMethod: text(),
    /** The runner's last look at its status was inconclusive: `status` is the last conclusive one. */
    statusUnknown: boolean().notNull().default(false),
    /** The Claude organization it signed in to, as the CLI reports it (no secret). */
    providerOrgId: text(),
    /** Why its last turn failed (a `ProviderFailureCause`), and when; and when a turn last succeeded. */
    lastFailureCause: text(),
    lastFailureAt: timestamp({ withTimezone: true }),
    lastSuccessAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }).onDelete("cascade"),
    index().on(t.orgId, t.machineId),
    check("machine_accounts_auth_method", sql`${t.authMethod} in ('cli_login', 'setup_token', 'api_key')`),
  ],
);

/**
 * How NEW Claude sign-ins for all agents are made on computers where each agent is its own OS user, set through
 * the operator API: `setup_token` everywhere, or `cli_login` for the listed workspaces (`selected`), for the listed
 * ones plus `percent` of the rest (`percent`, by a stable hash of the workspace's id) or for all. Elsewhere such a
 * sign-in is always the CLI's own. A connection keeps the method it started with. One row for the whole
 * installation, so no `org_id`; a missing row reads as `setup_token`, `selected`, no workspaces, 0%.
 */
export const claudeAuthSettings = pgTable(
  "claude_auth_settings",
  {
    id: integer().primaryKey().default(1),
    method: text({ enum: ["cli_login", "setup_token"] })
      .notNull()
      .default("setup_token"),
    rollout: text({ enum: ["selected", "percent", "all"] })
      .notNull()
      .default("selected"),
    orgIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** With `percent`: the share of workspaces, 0–100, on top of the listed ones. */
    percent: integer().notNull().default(0),
    /** When it last changed; null: never. */
    changedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("claude_auth_settings_one_row", sql`${t.id} = 1`),
    check("claude_auth_settings_method", sql`${t.method} in ('cli_login', 'setup_token')`),
    check("claude_auth_settings_rollout", sql`${t.rollout} in ('selected', 'percent', 'all')`),
    check("claude_auth_settings_percent", sql`${t.percent} between 0 and 100`),
    check("claude_auth_settings_org_ids", sql`coalesce(cardinality(${t.orgIds}), 0) <= 500`),
  ],
);

/**
 * Connecting a computer (ADR 0036 §5, a device-code flow): the computer asks
 * for a code (`POST /api/machines/device`), a signed-in person confirms it on
 * the site for one of their organizations, and the computer polls until it
 * gets its token, once. `device_code` is stored as SHA-256 only; `user_code`
 * is only compared by people. `org_id` is set on confirm (null while pending).
 */
export const machineDeviceCodes = pgTable(
  "machine_device_codes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    /** The organization chosen on confirm; null until then. */
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    deviceCodeHash: text().notNull().unique(),
    /** 6 characters, normalized (no separator). Unique among pending codes. */
    userCode: text().notNull(),
    /** `pending`, `confirmed`, `denied` or `redeemed` (expiry comes from `expires_at`). */
    status: text().notNull().default("pending"),
    /** What the computer said about itself. */
    name: text().notNull().default(""),
    os: text().notNull().default("other"),
    arch: text().notNull().default(""),
    hostname: text().notNull().default(""),
    /** Its maker's model as the runner read it ("MacBook Pro"); empty from older runners. Names it on confirm. */
    model: text().notNull().default(""),
    runnerVersion: text().notNull().default(""),
    /** Optional extras a runner may send (copied to the machine row). */
    protocol: integer(),
    workspace: text(),
    execAllowed: boolean(),
    /** Where the request came from (rate limits, the confirm page). */
    requesterIp: text().notNull().default(""),
    approxLocation: text(),
    confirmedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /**
     * The computer asks to come back as this machine (it was refused: removed
     * or its token revoked). Honoured on confirm only for a machine of the
     * chosen organization that the confirming person may manage; else a new one.
     */
    previousMachineId: uuid(),
    /** The machine made (or reconnected) on confirm; its token is issued when the computer polls. */
    machineId: uuid(),
    /** The connect link the computer came with (`machine_connect_links`): only that link's maker may approve it. */
    linkId: uuid(),
    lastPolledAt: timestamp({ withTimezone: true }),
    decidedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("machine_device_codes_pending_user_code").on(t.userCode).where(sql`${t.status} = 'pending'`),
    index().on(t.requesterIp, t.createdAt),
  ],
);

/**
 * A request for a machine whose socket is on another replica: the caller
 * writes it here and signals the holder through pub/sub; the holder runs it
 * and writes the reply (NOTIFY payloads are too small for file bodies).
 */
export const machineRpc = pgTable(
  "machine_rpc",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    request: jsonb().$type<Record<string, unknown>>().notNull(),
    reply: jsonb().$type<Record<string, unknown>>(),
    /** `pending`, `done` or `failed`. */
    status: text().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    repliedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.createdAt)],
);

/**
 * A machine's `mcp.call`s by their `callId`, kept about 10 minutes: the runner sends a call cut by a
 * reconnect again under the same id, and it runs once (the copy gets this answer). `result` null: running.
 */
export const machineMcpCalls = pgTable(
  "machine_mcp_calls",
  {
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    callId: text().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    result: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.callId] }), index().on(t.createdAt)],
);

/**
 * A stored file one computer may fetch, once (`GET /api/machines/pulls/{id}`): the row is deleted by that fetch. Made
 * after the read check of whoever asked; the id is all the computer holds, so what it gets is what the row names.
 */
export const machineFilePulls = pgTable(
  "machine_file_pulls",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    storageConfigId: uuid(),
    blobKey: text().notNull(),
    size: integer().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.machineId, t.expiresAt), index().on(t.orgId)],
);

/** What a phone's host last said about it (`RunnerPhone` in the machine protocol, minus who holds it). */
export interface MachinePhoneFacts {
  /**
   * `usb`, `wifi` (adb over the network, or an iPhone through its Mac's CoreDevice tunnel) or `local` (an emulator or
   * simulator on the host itself).
   */
  transport?: "usb" | "wifi" | "local";
  screen?: { width: number; height: number };
  abi?: string;
  /** On power (`ac`) or battery, when the host can tell. */
  power?: "ac" | "battery";
  battery?: number;
}

/** Who holds a phone right now (its host keeps the lock; this is the last it said). */
export interface MachinePhoneHolder {
  runId: string | null;
  agentId: string | null;
  /** The person the agent works for. */
  userId: string | null;
  /** What it is doing, in the agent's words ("Recording a test video"). */
  label?: string;
  since: string;
}

/**
 * Phones reached through a connected computer (bring your own devices): Android over adb, iPhone through a Mac
 * (`devicectl`), and the host's own emulators and simulators. A phone keeps its row, name and rule when it moves to
 * another host; `machine_id` is its host now (null: none sees it). An iPhone follows its host's rule
 * (`follows_host`): building and testing run on the Mac as its owner. An Android phone has its own: sharing it grants
 * only the phone operations, never the host's commands.
 */
export const machinePhones = pgTable(
  "machine_phones",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid(),
    /** `android` or `ios`. */
    platform: text().$type<"android" | "ios">().notNull(),
    /** adb's serial, or the iPhone's UDID (a simulator's UDID). */
    serial: text().notNull(),
    /** `device`, `emulator` or `simulator`. */
    kind: text().$type<"device" | "emulator" | "simulator">().notNull().default("device"),
    name: text().notNull(),
    model: text().notNull().default(""),
    osVersion: text().notNull().default(""),
    /** `ready`, `needs_you`, `preparing`, `unsupported` or `offline` (its host doesn't see it, or is offline). */
    state: text().notNull().default("ready"),
    /** With `needs_you`, `preparing` or `unsupported`: a code the apps word (`locked`, `unauthorized`, `developer_mode_off`…). */
    reason: text(),
    facts: jsonb().$type<MachinePhoneFacts>().notNull().default({}),
    holder: jsonb().$type<MachinePhoneHolder>(),
    /** Whose phone it is: the person who paired its host when it was first seen. */
    ownerUserId: text().references(() => users.id, { onDelete: "set null" }),
    followsHost: boolean().notNull().default(false),
    audienceMode: text().$type<"everyone" | "people" | "owner">().notNull().default("owner"),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    lastSeenAt: timestamp({ withTimezone: true }),
    /** Since when `state` and `reason` hold as they are: every report bumps `updated_at`, a change only this. */
    stateSince: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A setup step that stayed stuck since `state_since` was reported (once): cleared when the state or reason moves. */
    stuckReportedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("machine_phones_serial").on(t.orgId, t.platform, t.serial),
    index().on(t.orgId, t.machineId),
    check("machine_phones_platform", sql`${t.platform} in ('android', 'ios')`),
    check("machine_phones_kind", sql`${t.kind} in ('device', 'emulator', 'simulator')`),
  ],
);

/**
 * A one-line install for a new computer (bring your own devices): `curl -fsSL <server>/i/<code> | sh`. The code is
 * stored as SHA-256 only, works once and for a few minutes, and grants nothing by itself: the computer that runs it
 * asks to join (a `machine_device_codes` row with `link_id`), and only the link's maker can approve it.
 */
export const machineConnectLinks = pgTable(
  "machine_connect_links",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text().notNull().unique(),
    /** `server` (a system install, each agent its own user) or `computer` (one person's). */
    kind: text().$type<"server" | "computer">().notNull().default("server"),
    /** The device code of the computer that used it; null until one did. */
    deviceCodeId: uuid(),
    usedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

/**
 * An agent asked to use a device its requester isn't allowed on (bring your own devices). The device's owner
 * answers: `once` (that run, until `expires_at`), `always` (the requester joins its rule) or `denied`.
 */
export const deviceAccessRequests = pgTable(
  "device_access_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The computer, or the phone's host when `phone_id` is set. */
    machineId: uuid(),
    phoneId: uuid(),
    requesterUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid(),
    runId: uuid(),
    /** What the agent wants to do there, in its words. */
    reason: text().notNull().default(""),
    /** `pending`, `once`, `always`, `denied` or `expired`. */
    status: text().notNull().default("pending"),
    decidedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.requesterUserId, t.status), index().on(t.orgId, t.machineId)],
);
