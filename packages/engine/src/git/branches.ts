import { and, type Database, desc, type Executor, eq, gt, gte, inArray, ne, schema } from "@agenteschat/db";
import { RULE_REMOVED_AUDIT } from "../approval-rules";
import { connectorScope } from "../connectors/catalog";
import {
  type ConnectorConnection,
  type ConnectorDeps,
  connectionHeaders,
  connectionSecret,
} from "../connectors/connections";
import { type AppPermissions, appTokenForRepo, type GitHubAppConfig, type GitHubHttp } from "./github-app";

import { type GitHostId, gitToolName, parseRepoRef, repoRefName, tokenOfSecret } from "./hosts";

export { branchFacts, branchPath, githubHeaders } from "./hosts/github";
export { type BranchBlock, type BranchFact, type BranchFacts, branchBlock } from "./hosts/types";

const { agents, approvalRules, approvals, auditLog } = schema;

/**
 * Branches that aren't the agent's own (ADR 0024, addendum of 2026-10-31): a person approves deleting them
 * (`delete_branches`, on GitHub's API) or pushing to one (`request_branch_push`, then a plain push through the
 * proxy), and GitHub is asked first that none is the default branch or protected. Shared by the git tools and the
 * proxy.
 */
export const DELETE_BRANCHES_TOOL = "delete_branches";
export const BRANCH_PUSH_TOOL = "request_branch_push";
/** How long a person's approval of `request_branch_push` lets the agent push there, from the decision. */
export const PUSH_GRANT_MS = 24 * 3600_000;

type Repo = { owner: string; repo: string };

/** The token a connection holds for its git host (ADR 0227), fresh. Null when it has none; throws what refreshing threw. */
export async function hostConnectionToken(connectors: ConnectorDeps, connection: ConnectorConnection) {
  return tokenOfSecret(await connectionSecret(connectors, connection));
}

/** What `git check-ref-format` refuses in a branch name, plus a full ref, `HEAD` or `@` (the tools take names). */
const NOT_A_BRANCH = /[^\x21-\x7e -￿]|[~^:?*[\\]|\.\.|@\{|\/\/|^[/.-]|\/\.|[/.]$|\.lock(\/|$)|^refs\/|^(HEAD|@)$/;
export const validBranch = (name: string) => name.length > 0 && name.length <= 200 && !NOT_A_BRANCH.test(name);

/**
 * What a push grant is kept and compared by: `owner/repo:branch`, the repository in lower case as its host reads it
 * (a repository's stored name on another host, `gitlab:group/project:branch`).
 */
export const pushGrantKey = (repo: Repo | string, branch: string) =>
  `${(typeof repo === "string" ? repo : `${repo.owner}/${repo.repo}`).toLowerCase()}:${branch}`;

/** The grant key a `request_branch_push` call names (its input, or an approval's params); null when it names none. */
export function pushGrantKeyOf(input: Record<string, unknown>): string | null {
  const repo = typeof input.repo === "string" ? parseRepoRef(input.repo) : null;
  const branch = typeof input.branch === "string" ? input.branch : "";
  return repo && validBranch(branch) ? pushGrantKey(repoRefName(repo), branch) : null;
}

/**
 * The server's GitHub token for one repository: the GitHub App's installation token when the app is installed there
 * for this organization, else the connection's own. Null when neither works.
 */
export async function githubToken(
  deps: { connectors: ConnectorDeps; app?: GitHubAppConfig | null },
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  connection: ConnectorConnection,
  repo: Repo,
  permissions: AppPermissions | AppPermissions[],
): Promise<string | null> {
  const app = deps.app
    ? await appTokenForRepo(deps.app, http, tenant, repo.owner, repo.repo, permissions).catch(() => null)
    : null;
  if (app) return app;
  return connectionToken(deps.connectors, connection).catch(() => null);
}

/**
 * The GitHub connection's own token (a key pasted in Conectores, or OAuth's, refreshed when it is about to expire).
 * Null when it has none. Throws what refreshing it threw: the provider refusing (`ValidationError`), or no answer.
 */
export async function connectionToken(connectors: ConnectorDeps, connection: ConnectorConnection) {
  return (await connectionHeaders(connectors, connection)).authorization?.replace(/^Bearer\s+/i, "") || null;
}

export type PushGrant = { approvalId: string } | { ruleId: string };

/**
 * What lets an agent push to branches that aren't its own through the proxy, by grant key: a rule someone approved
 * for good (read only while the agent doesn't always ask), or a person's approval of `request_branch_push` decided in the last 24 h (its params read through the
 * same key) and after that key's rule was last removed. The proxy has no run, so any of the agent's runs may use it.
 * A key nothing grants is left out. Three queries at most, whatever the number of keys.
 */
export async function pushGrants(
  db: Executor,
  at: { orgId: string; agentId: string; connectionId: string; host?: GitHostId },
  keys: readonly string[],
  now: Date,
): Promise<Map<string, PushGrant>> {
  const grants = new Map<string, PushGrant>();
  if (keys.length === 0) return grants;
  const tool = gitToolName(at.host ?? "github", "request_branch_push");
  const rules = await db
    .select({ id: approvalRules.id, action: approvalRules.action })
    .from(approvalRules)
    .innerJoin(agents, and(eq(agents.id, approvalRules.agentId), ne(agents.approvalsLevel, "always")))
    .where(
      and(
        eq(approvalRules.orgId, at.orgId),
        eq(approvalRules.agentId, at.agentId),
        eq(approvalRules.connectionId, at.connectionId),
        eq(approvalRules.tool, tool),
        inArray(approvalRules.action, [...keys]),
      ),
    );
  for (const rule of rules) grants.set(rule.action, { ruleId: rule.id });
  const wanted = new Set(keys.filter((k) => !grants.has(k)));
  if (wanted.size === 0) return grants;
  const recent = await db
    .select({ id: approvals.id, params: approvals.params, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, at.orgId),
        eq(approvals.agentId, at.agentId),
        eq(approvals.connectionId, at.connectionId),
        eq(approvals.tool, tool),
        eq(approvals.scope, connectorScope(at.host ?? "github", "git.write")),
        eq(approvals.status, "approved"),
        gt(approvals.decidedAt, new Date(now.getTime() - PUSH_GRANT_MS)),
      ),
    )
    .orderBy(desc(approvals.decidedAt));
  const hits = recent.flatMap((a) => {
    const key = pushGrantKeyOf(a.params);
    return key && wanted.has(key) && a.decidedAt ? [{ id: a.id, key, decidedAt: a.decidedAt }] : [];
  });
  const oldest = hits.at(-1);
  if (!oldest) return grants;
  // Removing an "Aprovar sempre" rule ends what was approved for that branch before, the approval it came from too.
  const removals = await db
    .select({ details: auditLog.details, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, at.orgId),
        eq(auditLog.action, RULE_REMOVED_AUDIT),
        eq(auditLog.targetId, at.agentId),
        gte(auditLog.createdAt, oldest.decidedAt),
      ),
    );
  const removedAt = new Map<string, Date>();
  for (const { details: d, createdAt } of removals) {
    if (d.tool !== tool || d.connectionId !== at.connectionId || typeof d.action !== "string") continue;
    const last = removedAt.get(d.action);
    if (!last || createdAt > last) removedAt.set(d.action, createdAt);
  }
  for (const hit of hits) {
    const removed = removedAt.get(hit.key);
    if (!grants.has(hit.key) && (!removed || hit.decidedAt > removed)) grants.set(hit.key, { approvalId: hit.id });
  }
  return grants;
}
