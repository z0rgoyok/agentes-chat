import { and, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { managesAgent, ownsAgent } from "./audience";
import { caches } from "./cache";
import { NotFoundError } from "./errors";
import { can, requirePermission } from "./organizations";

/*
 * A new agent's setup checklist (ADR 0155 §2): the top of its chat lists what it still needs (an AI, apps, channels,
 * who talks to it, how it works). The apps draw it; this keeps the role it started from (for the suggestions) and the
 * steps a person confirmed. A step is also done when the agent's data says so, which the apps read themselves.
 */

const { agents } = schema;

export const SETUP_STEPS = ["ai", "apps", "where", "who", "how"] as const;
/**
 * The right hand's first run (ADR 0155 §6): what the workspace does, the team, an AI, apps and people. Its rows read
 * done from the workspace's data; only "Agora não" on apps and people is stored.
 */
export const FIRST_RUN_STEPS = ["about", "team", "ai", "apps", "people"] as const;
/** A personal workspace's first run (ADR 0159): the same rows but people, since it is for one person. */
export const PERSONAL_FIRST_RUN_STEPS = FIRST_RUN_STEPS.filter((s) => s !== "people");
const FIRST_RUN_SKIPS = new Set<string>(["apps", "people"]);
export type SetupStep = (typeof SETUP_STEPS)[number] | (typeof FIRST_RUN_STEPS)[number];
export const isSetupStep = (v: unknown): v is SetupStep =>
  SETUP_STEPS.includes(v as never) || FIRST_RUN_STEPS.includes(v as never);

export interface SetupChecklist {
  /** The ready-made role it started from ("support"); null: from scratch, or made some other way. */
  role: string | null;
  /** The steps a person confirmed, in the order they did. */
  done: SetupStep[];
  /** How it introduced itself on its card, in its own voice (ADR 0164): its first message says it back. */
  hello?: string;
  /** The personal starter it began as ("clara", ADR 0159 §3): its first tasks. */
  starter?: string;
  /** The apps it was made to use (catalog connector ids) at their levels (ADR 0164): its checklist suggests them. */
  apps?: Record<string, SetupAppLevel>;
  /** Closed on its page (its ×, `closeSetup`): the page shows it no more, whatever is left; its chat's stays. */
  closed?: true;
}

export type SetupAppLevel = "read" | "write";

/** What a new agent's card may add to its checklist (ADR 0164). */
export interface SetupExtras {
  hello?: string | null;
  starter?: string | null;
  apps?: Record<string, string> | null;
}

/** The role ids the apps offer are short lower-case words; anything else is no role. */
const ROLE_ID = /^[a-z][a-z_-]{0,31}$/;
/** A catalog connector's id ("google-calendar"). */
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SETUP_HELLO_MAX = 500;
export const SETUP_APPS_MAX = 12;

/** The card's extras as kept: a short hello, a starter id, at most twelve apps at read or write; the rest dropped. */
function setupExtras(extra: { hello?: unknown; starter?: unknown; apps?: unknown } | null | undefined) {
  const out: Pick<SetupChecklist, "hello" | "starter" | "apps"> = {};
  const hello = typeof extra?.hello === "string" ? extra.hello.trim().slice(0, SETUP_HELLO_MAX) : "";
  if (hello) out.hello = hello;
  if (typeof extra?.starter === "string" && ROLE_ID.test(extra.starter)) out.starter = extra.starter;
  if (extra?.apps && typeof extra.apps === "object" && !Array.isArray(extra.apps)) {
    const apps = Object.entries(extra.apps as Record<string, unknown>)
      .filter((e): e is [string, SetupAppLevel] => CONNECTOR_ID.test(e[0]) && (e[1] === "read" || e[1] === "write"))
      .slice(0, SETUP_APPS_MAX);
    if (apps.length > 0) out.apps = Object.fromEntries(apps);
  }
  return out;
}

/**
 * What a new agent's checklist starts with: who talks to it and how it works have good defaults, so they start done
 * (their rows keep Mudar) and a new agent asks only for its AI, apps and channels.
 */
export const newSetup = (role: string | null | undefined, extra?: SetupExtras | null): SetupChecklist => ({
  role: role && ROLE_ID.test(role) ? role : null,
  done: ["who", "how"],
  ...setupExtras(extra),
});

/** The right hand's first-run checklist, for a workspace with no agent besides it. */
export const FIRST_RUN_SETUP: SetupChecklist = { role: null, done: [] };

/** The stored checklist as the apps read it (unknown steps dropped); null for an agent made before it. */
export function setupOf(
  stored:
    | { role?: unknown; done?: unknown; hello?: unknown; starter?: unknown; apps?: unknown; closed?: unknown }
    | null
    | undefined,
): SetupChecklist | null {
  if (!stored) return null;
  const role = typeof stored.role === "string" && ROLE_ID.test(stored.role) ? stored.role : null;
  const done = Array.isArray(stored.done) ? stored.done.filter(isSetupStep) : [];
  return {
    role,
    done: [...new Set(done)],
    ...setupExtras(stored),
    ...(stored.closed === true ? { closed: true as const } : {}),
  };
}

/** The agent and the caller's membership, for whoever may set it up; not found for anyone else, as for no agent. */
async function setupAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!agent) throw new NotFoundError("Agent not found");
  return { agent, membership };
}

/** Its owner or who manages it (`managesAgent`, ADR 0085 addendum of 2026-11-17): who sets a new agent up. */
const setsUp = (
  agent: typeof agents.$inferSelect,
  actorId: string,
  membership: Awaited<ReturnType<typeof setupAgent>>["membership"],
) => !agent.builtin && (ownsAgent(agent, actorId, membership.roleIds) || managesAgent(agent, actorId, membership));

/**
 * A person confirmed one step of the agent's checklist (they chose in its dialog, or skipped it). Who may change the
 * agent may: its owner or who manages it (`setsUp`). On the right hand's first run only "Agora não" is stored, on apps
 * (who connects apps) and people (who invites). Confirming twice changes nothing; an agent with no checklist keeps none.
 */
export async function confirmSetupStep(db: Database, actorId: string, orgId: string, agentId: string, step: SetupStep) {
  const { agent, membership } = await setupAgent(db, actorId, orgId, agentId);
  const allowed =
    agent.builtin === "right_hand"
      ? FIRST_RUN_SKIPS.has(step) && can(membership, step === "apps" ? "manage_connectors" : "invite_people")
      : SETUP_STEPS.includes(step as never) && setsUp(agent, actorId, membership);
  // Not found for whoever may not change it, as for an agent that isn't there.
  if (!allowed) throw new NotFoundError("Agent not found");
  const one = JSON.stringify([step]);
  const done = sql`coalesce(${agents.setup}->'done', '[]'::jsonb)`;
  await db
    .update(agents)
    .set({ setup: sql`jsonb_set(${agents.setup}, '{done}', ${done} || ${one}::jsonb)` })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.orgId, orgId),
        isNotNull(agents.setup),
        sql`not (${done} @> ${one}::jsonb)`,
      ),
    );
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
}

/**
 * Who sets the agent up closed its checklist on its page (its ×): the page shows it no more, whatever is left, while
 * its chat keeps its own (the first message). Closing twice changes nothing; an agent with no checklist keeps none.
 */
export async function closeSetup(db: Database, actorId: string, orgId: string, agentId: string) {
  const { agent, membership } = await setupAgent(db, actorId, orgId, agentId);
  if (!setsUp(agent, actorId, membership)) throw new NotFoundError("Agent not found");
  await db
    .update(agents)
    .set({ setup: sql`jsonb_set(${agents.setup}, '{closed}', 'true'::jsonb)` })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNotNull(agents.setup)));
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
}
