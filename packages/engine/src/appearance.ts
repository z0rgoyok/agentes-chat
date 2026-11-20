import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import type { Agent } from "./agents";
import { ownsOrManagesAgent, REACH_COLUMNS } from "./audience";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { requirePermission } from "./organizations";

const { agents } = schema;

/** The looks the app knows how to draw; anything else is refused. */
export const AGENT_LOOK = {
  colors: ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"],
  eyes: ["round", "dots", "wide", "happy", "sleepy"],
  // Pixel accessories drawn by the agent engine (packages/ui/src/agent/engine.js). Glasses were
  // dropped (2026-10-15): stored ones still load, and the app shows them with no accessory.
  accessories: [
    "none",
    "hat",
    "cap",
    "headphones",
    "bow",
    "crown",
    "antenna",
    "headset",
    "beanie",
    "party",
    "flower",
    "scarf",
  ],
} as const;

/** A custom color picked in "Personalizar": "#rrggbb", stored lowercase in the same field as a preset name. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface AgentAppearance {
  color: (typeof AGENT_LOOK.colors)[number] | `#${string}`;
  eyes: (typeof AGENT_LOOK.eyes)[number];
  accessory: (typeof AGENT_LOOK.accessories)[number];
}

/** A look as it is sent, checked by `validateAppearance`. */
export interface AppearanceInput {
  color?: unknown;
  eyes?: unknown;
  accessory?: unknown;
}

export function validateAppearance(input: AppearanceInput): AgentAppearance {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], field: string, or = ""): T => {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new ValidationError(`appearance.${field} must be one of: ${allowed.join(", ")}${or}`);
    }
    return value as T;
  };
  return {
    color:
      typeof input.color === "string" && HEX_COLOR.test(input.color)
        ? (input.color.toLowerCase() as `#${string}`)
        : pick(input.color, AGENT_LOOK.colors, "color", " or #rrggbb"),
    eyes: pick(input.eyes, AGENT_LOOK.eyes, "eyes"),
    accessory: pick(input.accessory ?? "none", AGENT_LOOK.accessories, "accessory"),
  };
}

/**
 * Changes an agent's look (`appearance` on PATCH/POST …/agents). Its owner or who manages it (`ownsOrManagesAgent`,
 * ADR 0085 addendum of 2026-11-17); `checked`: the caller already decided that (`editAgent`, `createAgent`). Audited.
 * `null` goes back to the default look.
 */
export async function setAgentAppearance(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  appearance: AppearanceInput | null,
  options: { pubsub?: PubSub; checked?: boolean } = {},
): Promise<Agent> {
  const membership = options.checked ? null : await requirePermission(db, actorId, orgId, "read");
  const [agent] = await db
    .select({ archivedAt: agents.archivedAt, appearance: agents.appearance, ...REACH_COLUMNS })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!options.checked && !ownsOrManagesAgent(agent, actorId, membership)) {
    throw new ForbiddenError("Only the agent's owner or an admin can change its look");
  }
  const look = appearance === null ? null : validateAppearance(appearance);
  const [updated] = await db
    .update(agents)
    .set({ appearance: look, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning();
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.appearance_changed",
    target: { type: "agent", id: agentId },
    details: { from: agent.appearance, to: look },
  });
  await publishAgentsChanged(options.pubsub, orgId);
  return updated;
}
