import { isGitHostId } from "../git/hosts/refs";

/**
 * A git host as the workspace's and as a person's own (ADR 0099, ADR 0215 §13, ADR 0227). The workspace has one
 * connection per host, the team's: the git proxy, repository lists, webhooks and the agents' tools read that one. A
 * person's own connection (`owner_user_id`) is their account in code sessions (`git/person-account.ts`): it has no
 * tools and no grants of its own, and is never read as the workspace's. Nothing but names is imported here: every
 * reader of either takes it from this file.
 */
interface Owned {
  connector: string;
  ownerUserId: string | null;
}

/** The workspace's GitHub connection: the team's one, never a person's own account. */
export const teamGitHub = <C extends Owned>(connections: readonly C[]) =>
  connections.find((c) => c.connector === "github" && !c.ownerUserId);

/** A person's own account on a git host. */
export const isOwnGitAccount = (c: Owned) => isGitHostId(c.connector) && Boolean(c.ownerUserId);
