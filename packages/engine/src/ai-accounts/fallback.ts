import { type Executor, eq, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ValidationError } from "../errors";
import { requirePermission } from "../organizations";

const { organizationSettings } = schema;

/**
 * "Continuar com a chave de API quando todos os planos estiverem no limite": with every plan account of a run's order
 * at its limit, the run goes on with the workspace's API key instead of waiting for the first reset. Off by default,
 * since it turns flat-rate plans into spend by the token.
 */
export async function planKeyFallbackOn(db: Executor, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSettings.planKeyFallback })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.on === true;
}

/** `PUT …/ai-accounts/key-fallback` (admins, `configure`). Audited as `ai.key_fallback`. */
export async function setPlanKeyFallback(db: Executor, userId: string, orgId: string, on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new ValidationError("on is true or false", "ai.invalid_key_fallback");
  await requirePermission(db, userId, orgId, "configure");
  if ((await planKeyFallbackOn(db, orgId)) === on) return on;
  await db
    .insert(organizationSettings)
    .values({ orgId, planKeyFallback: on })
    .onConflictDoUpdate({ target: organizationSettings.orgId, set: { planKeyFallback: on } });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "ai.key_fallback",
    target: { type: "organization", id: orgId },
    details: { on },
  });
  return on;
}
