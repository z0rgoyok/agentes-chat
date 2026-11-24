import type { Memory } from "../api/types";

/** New servers decide eligibility. Older servers omit it, so keep their existing sharing controls. */
export function canMakeTeamMemory(m: Pick<Memory, "canMakeTeam" | "archived" | "howTo" | "playbook" | "kind">) {
  return m.canMakeTeam ?? (!m.archived && !m.howTo && !m.playbook && m.kind !== "lesson");
}
