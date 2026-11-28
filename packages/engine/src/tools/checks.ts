import type { GitHostId } from "../git/hosts/refs";
import { checkGithubCall, checkHostRepoCall } from "../git/repos";
import type { CallCheck, ToolContext, ToolDefinition } from "./types";

type ScopedCheck = (input: Record<string, unknown>, ctx: ToolContext) => Promise<CallCheck>;

/**
 * Connector-wide per-call checks, by scope prefix: every tool whose scope
 * starts with the prefix gets the check, whichever source made it (catalog
 * MCP, our git tools), so a new tool can't forget it.
 */
/** Another git host's tools (ADR 0227): only the agent's repositories there, as on GitHub. */
const hostCheck =
  (host: GitHostId): ScopedCheck =>
  async (input, ctx) => {
    const r = await checkHostRepoCall(ctx.db, ctx.orgId, ctx.agentId, host, input);
    if (r.ok) return { ok: true, ...(r.repo ? { data: { repo: r.repo } } : {}) };
    return { ok: false, message: r.message, data: r.repo ? { deniedRepo: r.repo, refusal: "repo" } : {} };
  };

const SCOPE_CHECKS: Record<string, ScopedCheck> = {
  // GitHub: only the agent's repositories (ADR 0024), reads included.
  "github:": async (input, ctx) => {
    const r = await checkGithubCall(ctx.db, ctx.orgId, ctx.agentId, input);
    if (r.ok) return { ok: true, ...(r.repo ? { data: { repo: r.repo } } : {}) };
    return { ok: false, message: r.message, data: r.repo ? { deniedRepo: r.repo, refusal: "repo" } : {} };
  },
  "gitlab:": hostCheck("gitlab"),
  "bitbucket:": hostCheck("bitbucket"),
  "git:": hostCheck("git"),
};

/**
 * The one place the gateway asks "may this call run with these arguments?":
 * the connector-wide check for the tool's scope, then the tool's own
 * `checkCall`. Data from both is merged when allowed.
 */
export async function checkToolCall(
  tool: Pick<ToolDefinition, "scope" | "checkCall">,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallCheck> {
  let data: Record<string, unknown> | undefined;
  for (const [prefix, check] of Object.entries(SCOPE_CHECKS)) {
    if (!tool.scope.startsWith(prefix)) continue;
    const r = await check(input, ctx);
    if (!r.ok) return r;
    if (r.data) data = { ...data, ...r.data };
  }
  if (tool.checkCall) {
    const r = await tool.checkCall(input, ctx);
    if (!r.ok) return r;
    if (r.data) data = { ...data, ...r.data };
  }
  return data ? { ok: true, data } : { ok: true };
}
