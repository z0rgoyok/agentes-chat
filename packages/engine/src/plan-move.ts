import { type Database, eq, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ForbiddenError, ValidationError } from "./errors";
import { recordOperatorEvent } from "./operator-events";
import { requirePermission } from "./organizations";
import { isBillingHold } from "./standing";

const { organizations } = schema;

/**
 * Its payer moves a workspace's plan to another workspace they manage billing in (ADR 0079): this server only says so,
 * as the feed's `organization.plan_move_requested` (`data.to`, the workspace it goes to), and the billing service moves
 * the same subscription, which lifts the other workspace's hold within a minute. The payer is the one the billing
 * service named (`payerUserId`); the workspace it goes to has no plan in force, its billing hold says, and isn't being
 * deleted. Allowed while the workspace it leaves is being deleted: that is when a plan would otherwise be lost.
 */
export async function requestPlanMove(db: Database, input: { userId: string; orgId: string; to: string }) {
  const { userId, orgId, to } = input;
  if (to === orgId) throw new ValidationError("A plan moves to another workspace", "plan_move.same");
  await requirePermission(db, userId, orgId, "manage_billing");
  const target = await requirePermission(db, userId, to, "manage_billing");
  const [from] = await db
    .select({ payer: organizations.payerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (from?.payer !== userId)
    throw new ForbiddenError("Only whoever pays for the plan moves it", "plan_move.not_payer");
  const standing = target.standing;
  if (standing?.deletionDueAt) {
    throw new ValidationError("That workspace is being deleted", "plan_move.target_deleting");
  }
  if (!standing || !isBillingHold(standing)) {
    throw new ValidationError("That workspace already has a plan", "plan_move.target_has_plan");
  }
  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "billing.plan_move_requested",
      target: { type: "organization", id: to },
      details: { to },
    });
    await recordOperatorEvent(tx, { type: "organization.plan_move_requested", orgId, userId, data: { to } });
  });
}
