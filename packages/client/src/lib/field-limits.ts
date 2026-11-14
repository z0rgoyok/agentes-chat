/**
 * How much the server takes in its long text fields, in characters, for each field's `limit` (web and phone). Each
 * mirrors its route's schema in apps/server/src/routes/app.
 */
export const FIELD_LIMITS = {
  /** `agents.ts` instructions. */
  instructions: 50_000,
  /** `memory.ts` text. */
  memory: 8000,
  /** `account.ts` Context. */
  workspaceContext: 20_000,
  /** `routines.ts` prompt. */
  routinePrompt: 10_000,
  /** `calendar.ts` description. */
  eventDescription: 10_000,
  /** `issues.ts` description. */
  issueDescription: 50_000,
  /** `approvals.ts` right-hand guidance (`RIGHT_HAND_CAPS.guidanceChars`). */
  rightHandGuidance: 2000,
} as const;
