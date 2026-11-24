import type { AgentAudience } from "@agenteschat/client";
import type { Level, LevelState } from "@agenteschat/client/lib/access-levels";
import {
  type AgentSection,
  type AgentTab,
  type BrainChoice,
  budgetValue,
  sameAudience,
  sameBrain,
  sameEditors,
  sameList,
} from "@agenteschat/client/lib/agent-edit";
import type { EditorsValue } from "@agenteschat/client/lib/audience";
import { handleAfterRename } from "@agenteschat/client/lib/new-agent";
import { type RepoChoice, sameRepoChoice } from "@agenteschat/client/lib/repos";
import type { AgentAppearance } from "@agenteschat/ui";

export * from "@agenteschat/client/lib/agent-edit";

/*
 * The agent page: one draft over
 * everything that can be edited, one save bar. What the server says is
 * `Saved`; what the person changed is `Edits` (only the touched fields), so
 * parts that load later (access, skills, the computer) never reset a draft.
 */

export type Look = Required<AgentAppearance>;

/** What can be edited, as the server has it now. Parts not loaded yet are absent. */
export interface Saved {
  name: string;
  /** Its @ now. */
  handle: string;
  role: string;
  look: Look;
  instructions: string;
  model: string;
  /** `DEFAULT_KEY` or a credential id (admins only). */
  key?: string;
  /** Its own budget (US$); null = the workspace default (admins only). */
  budget?: number | null;
  /** A user id, a role's `role:<id>` (ADR 0085, addendum of 2026-11-21) or `NO_OWNER`. */
  owner: string;
  audience: AgentAudience;
  /** "Quem pode editar" (ADR 0085 addendum of 2026-11-17): who else edits how it works. Absent, nothing to compare. */
  editors?: EditorsValue;
  /** Resource id → level (from the access tree). */
  levels?: Record<string, LevelState>;
  /** Its GitHub repositories (all, or some in order). */
  repos?: RepoChoice;
  /** Enabled skill ids, sorted. */
  skills?: string[];
  /** Channels it is in that the viewer can pick (no DMs), sorted. */
  channels?: string[];
  /** `NO_COMPUTER` or a machine id. */
  machine?: string;
  /** Who thinks (owner and admins only; absent until loaded). */
  brain?: BrainChoice;
  /** Its group (ADR 0083): `NO_GROUP` or a group id; absent until the groups load. */
  group?: string;
}

/** What the person changed. `budget` is the text typed; `levels` only the resources touched. */
export interface Edits {
  name?: string;
  /** The @ typed in Menções (or the saved one, to keep it); absent, it follows the name (`handleAfterRename`). */
  handle?: string;
  role?: string;
  look?: Look;
  instructions?: string;
  model?: string;
  key?: string;
  budget?: string;
  owner?: string;
  audience?: AgentAudience;
  editors?: EditorsValue;
  levels?: Record<string, Level>;
  repos?: RepoChoice;
  skills?: string[];
  channels?: string[];
  machine?: string;
  brain?: BrainChoice;
  group?: string;
}

export type Field = Exclude<keyof Edits, "levels"> | "levels";

/**
 * Who edits what (the server's rules, ADR 0085 addendum of 2026-11-17): who manages the agent (`admin`, the server's
 * `canManage`) everything; who edits how it works (`editor`, the server's `canEdit`: its "Quem pode editar") its
 * instructions, role and skills (`EDITOR_EDITS`); the agent's owner those too, and its look, audience, who edits it
 * ("Quem pode editar", which its editors don't change), channels, computer and who thinks, its API model and which of
 * the workspace's keys it uses included (connecting keys stays admins'). Channels, for both, only the ones they may put
 * an agent in (`addsAgentsTo`). Access and repositories are admins' like its scopes: giving an agent more is an admin's
 * call.
 */
export type Viewer = "admin" | "owner" | "editor" | "member";
export const EDITOR_EDITS: ReadonlySet<Field> = new Set<Field>(["instructions", "role", "skills"]);
export const OWNER_EDITS: ReadonlySet<Field> = new Set<Field>([
  ...EDITOR_EDITS,
  "look",
  "audience",
  "editors",
  "channels",
  "machine",
  "brain",
  "model",
  "key",
]);
export const canEdit = (viewer: Viewer, field: Field) =>
  viewer === "admin" ||
  (viewer === "owner" && OWNER_EDITS.has(field)) ||
  (viewer === "editor" && EDITOR_EDITS.has(field));

/**
 * The agent's owner or who manages it: who reads its runs and its private settings (who thinks, its computer, its
 * browser) and decides for it. Who only edits how it works (`editor`) doesn't.
 */
export const ownsOrManages = (viewer: Viewer) => viewer === "admin" || viewer === "owner";

/** The built-in area whose level says whether the agent uses its skills: it lives on the Skills tab. */
export const SKILLS_AREA = "area:skills";

/** Where each field lives: its tab, and its section in Configurações. */
export const FIELD_PLACE: Record<Field, { tab: AgentTab; sec?: AgentSection }> = {
  name: { tab: "settings", sec: "identity" },
  handle: { tab: "settings", sec: "identity" },
  role: { tab: "settings", sec: "identity" },
  look: { tab: "settings", sec: "identity" },
  instructions: { tab: "instructions" },
  levels: { tab: "access" },
  repos: { tab: "access" },
  skills: { tab: "skills" },
  model: { tab: "settings", sec: "brain" },
  key: { tab: "settings", sec: "brain" },
  budget: { tab: "settings", sec: "budget" },
  owner: { tab: "settings", sec: "owner" },
  audience: { tab: "settings", sec: "audience" },
  editors: { tab: "settings", sec: "editors" },
  channels: { tab: "settings", sec: "channels" },
  machine: { tab: "settings", sec: "computer" },
  brain: { tab: "settings", sec: "brain" },
  group: { tab: "settings", sec: "identity" },
};

export const sameLook = (a: Look, b: Look) => a.color === b.color && a.eyes === b.eyes && a.accessory === b.accessory;

/** One changed thing: a field, or one resource's level (`levels:{resourceId}`). */
export interface ChangeKey {
  key: string;
  field: Field;
  /** For levels: the resource id. */
  resource?: string;
}

/** The keys that differ from what is saved. */
export function changedKeys(saved: Saved, edits: Edits): ChangeKey[] {
  const out: ChangeKey[] = [];
  const add = (field: Field) => out.push({ key: field, field });
  if (edits.name !== undefined && edits.name !== saved.name) add("name");
  if (handleAfterRename(saved, edits.name ?? saved.name, edits.handle) !== saved.handle) add("handle");
  if (edits.role !== undefined && edits.role !== saved.role) add("role");
  if (edits.look && !sameLook(edits.look, saved.look)) add("look");
  if (edits.instructions !== undefined && edits.instructions !== saved.instructions) add("instructions");
  if (edits.levels && saved.levels) {
    for (const [id, level] of Object.entries(edits.levels)) {
      if (saved.levels[id] !== undefined && saved.levels[id] !== level)
        out.push({ key: `levels:${id}`, field: "levels", resource: id });
    }
  }
  if (edits.repos && saved.repos && !sameRepoChoice(edits.repos, saved.repos)) add("repos");
  if (edits.skills && saved.skills && !sameList(edits.skills, saved.skills)) add("skills");
  if (edits.model !== undefined && edits.model !== saved.model) add("model");
  if (edits.key !== undefined && saved.key !== undefined && edits.key !== saved.key) add("key");
  if (edits.budget !== undefined && saved.budget !== undefined && budgetValue(edits.budget) !== saved.budget)
    add("budget");
  if (edits.owner !== undefined && edits.owner !== saved.owner) add("owner");
  if (edits.audience && !sameAudience(edits.audience, saved.audience)) add("audience");
  if (edits.editors && saved.editors && !sameEditors(edits.editors, saved.editors)) add("editors");
  if (edits.channels && saved.channels && !sameList(edits.channels, saved.channels)) add("channels");
  if (edits.machine !== undefined && saved.machine !== undefined && edits.machine !== saved.machine) add("machine");
  if (edits.brain && saved.brain && !sameBrain(edits.brain, saved.brain)) add("brain");
  if (edits.group !== undefined && saved.group !== undefined && edits.group !== saved.group) add("group");
  return out;
}

/** Edits without one change (Desfazer). */
export function revertKey(edits: Edits, key: string): Edits {
  const next = { ...edits };
  if (key.startsWith("levels:")) {
    const id = key.slice("levels:".length);
    const levels = { ...(next.levels ?? {}) };
    delete levels[id];
    next.levels = levels;
    return next;
  }
  delete next[key as keyof Edits];
  return next;
}

/** Edits without the ones that went through (a field, or every level). */
export function dropFields(edits: Edits, fields: Field[]): Edits {
  const next = { ...edits };
  for (const f of fields) delete next[f];
  return next;
}
