/**
 * An agent picked among the system share sheet's suggestions (ADR 0213), as the share extension's link says it:
 * `…?nonce=…&to=<workspace>/<agent>#media`. Pure, so it is read the same way on every platform and in tests.
 */
export interface PickedAgent {
  orgId: string;
  agentId: string;
}

/** A suggestion's conversation id: the workspace and the agent, so a pick made for another workspace is told apart. */
export const suggestionId = (orgId: string, agentId: string) => `${orgId}/${agentId}`;

/** A suggestion's conversation id read back; null for anything else. */
export function pickedOf(id: string | null | undefined): PickedAgent | null {
  const [orgId, agentId, extra] = (id ?? "").split("/");
  if (!orgId || !agentId || extra !== undefined) return null;
  return { orgId, agentId };
}

/** The agent picked in the share sheet, from the share extension's link; null: the share came without a pick. */
export function pickedOfShareLink(url: string | null | undefined): PickedAgent | null {
  const value = /[?&]to=([^&#]+)/.exec(url ?? "")?.[1];
  if (!value) return null;
  try {
    return pickedOf(decodeURIComponent(value));
  } catch {
    return null;
  }
}
