import type { PubSub } from "@agenteschat/adapters";
import { getAgentCached } from "../agents";
import { recordCodeSessionPr } from "../code-sessions";
import { connectorScope } from "../connectors/catalog";
import { activeConnections, type ConnectorConnection, type ConnectorDeps } from "../connectors/connections";
import { ago } from "../context";
import { publishChannelEvent } from "../events";
import { computerPreparing } from "../machine-provisioning";
import { missionOfRun } from "../mission-context";
import { isRightHand } from "../right-hand";
import { machineScope, NO_HOME_MESSAGE, toolMachineId } from "../right-hand-seats";
import { replyThreadOf } from "../runs";
import { NO_COMPUTER_MESSAGE, PREPARING_COMPUTER_MESSAGE, type SandboxDeps } from "../sandbox";
import { APPROVAL_DETAIL_CHARS } from "../tools/gateway";
import { grantedScopeKeys } from "../tools/scopes";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import {
  type BranchBlock,
  branchBlock,
  githubToken,
  hostConnectionToken,
  pushGrantKeyOf,
  validBranch,
} from "./branches";
import type { GitHubAppConfig } from "./github-app";
import { noTokenMessage } from "./github-call";
import { recordGitHubItem } from "./github-events";
import {
  checkoutDirOf,
  GIT_TOOL_SCOPES,
  type GitHost,
  type GitVerb,
  gitToolName,
  type HostAt,
  parseRepoRef,
  refInList,
  repoRefAt,
  repoRefName,
  teamGitConnections,
} from "./hosts";
import { hostAt } from "./hosts/reach";
import {
  type CheckoutsWaited,
  cloneOnMachine,
  machineGitUnavailable,
  WAIT_FOR_CODE_TOOL,
  waitForCheckouts,
} from "./machine";
import { onSessionRepo, personAccountOfRun } from "./person-account";
import { gitAccess } from "./proxy";
import { orgRepositories } from "./repo-listing";
import { agentRepositoryList } from "./repos";
import { signatureLine, signedBody } from "./signature";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

export interface GitToolDeps {
  sandbox: SandboxDeps;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: { apiUrl: string; fetch: typeof fetch };
  /** Live clone progress on a connected machine (`agent.tool.output`), and a code session's new pull request. */
  pubsub?: PubSub;
}

/** git's progress lines (`\r`-separated) as a few live lines: at most one per second, the last one wins. */
function progressPublisher(pubsub: PubSub | undefined, c: ToolContext) {
  if (!pubsub || !c.toolUseId) return undefined;
  const toolUseId = c.toolUseId;
  let last = "";
  let sentAt = 0;
  let sent = 0;
  return (_stream: "stdout" | "stderr", chunk: string) => {
    const line = chunk
      .split(/[\r\n]+/)
      .filter((l) => l.trim())
      .at(-1);
    if (line) last = line.trim();
    const now = Date.now();
    if (!last || now - sentAt < 1000 || sent > 300) return;
    sentAt = now;
    sent++;
    const text = `${last}\n`;
    last = "";
    void publishChannelEvent(pubsub, {
      type: "agent.tool.output",
      channelId: c.channelId,
      threadId: replyThreadOf(c),
      runId: c.runId,
      agentId: c.agentId,
      toolUseId,
      stream: "stderr",
      text,
    }).catch(() => undefined);
  };
}

/** What `wait_for_code` tells the agent: where each checkout is now, and whether the update ended. */
export function checkoutsWaitedText(waited: CheckoutsWaited, now: Date): string {
  const lines = waited.checkouts.flatMap((r) => {
    const where = r.path ?? r.dir;
    const at = [r.branch ?? r.defaultBranch, r.head].filter(Boolean).join(" at ");
    if (r.status === "missing") return [];
    if (r.status === "cloning") return [`${r.repo}: still downloading into ${where}; git_clone waits for it.`];
    if (r.status === "failed")
      return [
        `${r.repo} at ${where}: its update failed (${r.message || "no answer"}); it is as it was${r.head ? ` (${r.head})` : ""}. Run git pull --ff-only there to try yourself.`,
      ];
    return [`${r.repo} at ${where}${at ? ` (${at})` : ""}: updated${r.message ? `; ${r.message}` : ""}.`];
  });
  const when = waited.syncedAt ? ago(waited.syncedAt, now.getTime()) : null;
  const head = waited.done
    ? `Your checkouts were updated${when ? ` (${when})` : ""}.`
    : `The update is still running after a minute; your checkouts as the last update left them${when ? ` (${when})` : ""}: run git pull --ff-only in the one you need for its newest commits.`;
  return [
    head,
    ...(lines.length > 0 ? lines : ["No checkout of yours is on this computer yet: git_clone clones one."]),
  ].join("\n");
}

/** A branch its host keeps agents off, in the words a refusal names it with. */
const blocked = (block: BranchBlock, host: GitHost) =>
  block === "missing" ? `not on ${host.label}` : block === "default" ? "the default branch" : "protected";

/**
 * Git in the agent's computer (ADR 0024), through our proxy:
 * - `git_clone` (`github:git.read`): on the agent's connected computer, the runner's `git.sync` (protocol 11)
 *   clones it into the agent's folder (`repos/owner/name`) with our proxy credential, with no other scope and no
 *   approval (ADR 0024 addendum). Pushes from there go through the proxy too;
 * - `open_pull_request` (`github:pr.write`): opens a PR from a pushed branch
 *   with the org's GitHub credential (server side). Merging stays approval-gated;
 * - `delete_branches` and `request_branch_push` (`github:git.write`, sensitive): what a person approves for
 *   branches that aren't the agent's own (`branches.ts`). The default branch and protected ones are never offered.
 * One set per git host the organization connected (ADR 0227): GitHub's under these names, another host's with the
 * host first (`gitlab_git_clone`), each on its own connection and scopes, all through the same code and the same
 * rules. A host that has no call for something (a git server by address opens no pull request) offers no such tool.
 */
export function createGitToolSource(deps: GitToolDeps): ToolSource {
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  return {
    name: "git",
    async tools(ctx: ToolContext): Promise<ToolDefinition[]> {
      const connected = teamGitConnections(await activeConnections(ctx.db, ctx.orgId));
      if (connected.length === 0) return [];
      return [listTool(), waitTool(), ...connected.flatMap(({ host, connection }) => toolsOn(host, connection))];
    },
  };

  /**
   * One list for every git host the workspace connected: the repositories the agent can work in, each by the name
   * the git tools take. A tool of ours with no connection of its own: it shows a host's repositories only to an
   * agent that may read git there, and only the ones in the agent's own list.
   */
  function listTool(): ToolDefinition {
    return {
      name: "list_repositories",
      description:
        "List the repositories you can work in, on every git host this workspace connected (GitHub, GitLab, Bitbucket), most recently active first, each by the name the git tools take (repo). Use it before asking a person for a repository's name or path. `query` keeps the ones whose name has that text.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 100, description: "Part of a name or path" } },
        additionalProperties: false,
      },
      async execute(input, c) {
        try {
          const connections = await activeConnections(c.db, c.orgId);
          const keys = await grantedScopeKeys(c.db, c.orgId, c.agentId);
          const reads = new Set<string>(
            teamGitConnections(connections)
              .filter(({ host, connection }) => gitAccess(keys, connection.id, host.id).read)
              .map(({ host }) => host.id),
          );
          if (reads.size === 0) {
            return { content: "You have no git access here. Tell the person: whoever can edit you can give it." };
          }
          const listing = await orgRepositories(
            { db: c.db, connectors: deps.connectors, app: deps.app ?? null, github },
            c.orgId,
          );
          const mine = await agentRepositoryList(c.db, c.orgId, c.agentId);
          const query = str(input.query).trim().toLowerCase();
          const all = [...listing.accounts, ...listing.elsewhere]
            .filter((a) => reads.has(a.host))
            .flatMap((a) => a.repositories.map((r) => ({ ...r, hostLabel: a.hostLabel })))
            .filter((r) => refInList(mine, r.fullName) && (!query || r.fullName.toLowerCase().includes(query)))
            .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
          const shown = all.slice(0, 100);
          if (shown.length === 0) {
            return {
              content: query
                ? `No repository of yours has "${query}" in its name.`
                : "The workspace's git connections reach no repository you may use. Tell the person: the connection may lack access to it, or your repositories list leaves it out.",
            };
          }
          const lines = shown.map(
            (r) =>
              `${r.fullName} (${r.hostLabel}, ${r.private ? "private" : "public"}${r.updatedAt ? `, active ${r.updatedAt.slice(0, 10)}` : ""})`,
          );
          const more = all.length > shown.length || listing.truncated ? "\nThere are more: narrow it with query." : "";
          return { content: `${lines.join("\n")}${more}`, data: { repositories: shown.map((r) => r.fullName) } };
        } catch (error) {
          return failed(error);
        }
      },
    };
  }

  /**
   * `wait_for_code`: the turn started from the checkouts as their last update left them, with the next update beside
   * it (`prepareAgentCode`); when the task needs the newest code, the agent waits for that update here, inside its
   * turn, after saying so. A tool of ours with no connection of its own, like `list_repositories`.
   */
  function waitTool(): ToolDefinition {
    return {
      name: WAIT_FOR_CODE_TOOL,
      description:
        "Wait for the update of your checkouts on your computer (each repository fetched, its default branch fast-forwarded) that runs beside your turn, then see where each one is. Call it when the task needs the newest code and your turn said they were updating; with none running it starts one. Takes up to about a minute.",
      scope: "",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, c) {
        try {
          const [agent, mission] = await Promise.all([getAgentCached(c.db, c.orgId, c.agentId), missionOfRun(c)]);
          if (mission) {
            return {
              content:
                "In a mission you work in the mission's own folder: run git pull --ff-only there (or git fetch) for the newest commits.",
            };
          }
          if (isRightHand(agent)) return { content: "You have no checkouts of your own to update." };
          const machineId = await toolMachineId(c.db, agent);
          const machines = deps.sandbox.machines;
          const git = deps.sandbox.git;
          if (!agent || !machineId) {
            const preparing = await computerPreparing({ ...deps.sandbox, db: c.db }, c.orgId);
            return { content: preparing ? PREPARING_COMPUTER_MESSAGE : NO_COMPUTER_MESSAGE, isError: true };
          }
          if (!machines || !git) return { content: "Connected computers are not available here.", isError: true };
          const at = { orgId: c.orgId, agentId: c.agentId, machineId };
          const machineDeps = {
            db: c.db,
            hub: machines.hub,
            git,
            github: deps.app ? { app: deps.app, http: github } : null,
            ...(deps.sandbox.now ? { now: deps.sandbox.now } : {}),
          };
          const waited = await waitForCheckouts(machineDeps, at, c.signal);
          if (!waited) {
            const why = machineGitUnavailable(await machines.hub.status(machineId), c.orgId);
            return {
              content: why
                ? `Your checkouts can't be updated now: ${why.message}`
                : "You have no git access on your computer, so no checkout of yours is updated.",
              isError: true,
            };
          }
          return { content: checkoutsWaitedText(waited, deps.sandbox.now?.() ?? new Date()) };
        } catch (error) {
          return failed(error);
        }
      },
    };
  }

  function toolsOn(host: GitHost, connection: ConnectorConnection): ToolDefinition[] {
    {
      const named = (verb: GitVerb) => gitToolName(host.id, verb);
      const scopeOf = (verb: GitVerb) => connectorScope(host.id, GIT_TOOL_SCOPES[verb]);
      const example = repoRefName({ host: host.id, path: host.id === "gitlab" ? "group/project" : "owner/name" });
      const repoInput = { type: "string", minLength: 3, maxLength: 300, description: example };
      const branchInput = { type: "string", minLength: 1, maxLength: 200, description: "A branch name, not refs/…" };
      const at: HostAt =
        host.id === "github"
          ? { fetch: github.fetch, api: github.apiUrl, git: "https://github.com", site: "github.com" }
          : hostAt(host, connection.serverUrl, { http: deps.github?.fetch, resolveHost: deps.connectors.resolveHost });
      /** The repository a call names, when it is one of this host's: its path there. */
      const repoOf = (input: unknown) => {
        const given = str(input).trim();
        // A bare path is this host's (`group/project` on GitLab's tool); an address of a server of one's own too.
        const ref =
          parseRepoRef(host.id === "github" || /^[a-z]+:/.test(given) ? given : `${host.id}:${given}`) ??
          repoRefAt(host.id, connection.serverUrl, given);
        return ref?.host === host.id ? { ...ref, name: repoRefName(ref) } : null;
      };
      const badRepo = `repo must be ${example}`;
      const tokenFor = async (
        c: ToolContext,
        path: string,
        permissions: Parameters<typeof githubToken>[5] = { contents: "read" },
      ) => {
        if (host.id !== "github") return hostConnectionToken(deps.connectors, connection).catch(() => null);
        const [owner = "", repo = ""] = path.split("/");
        return githubToken(deps, github, { db: c.db, orgId: c.orgId }, connection, { owner, repo }, permissions);
      };
      const noToken = (name: string) =>
        host.id === "github"
          ? noTokenMessage(connection, name)
          : `${host.label} has no usable sign-in here. Tell the person: whoever manages connectors can connect it again.`;
      /** The host's answers on these branches, or why they couldn't be read. */
      const factsOf = async (c: ToolContext, repo: { path: string; name: string }, branches: string[]) => {
        const token = await tokenFor(c, repo.path);
        if (!token) return noToken(repo.name);
        return (
          (await host.branchFacts(at, token, repo.path, branches)) ??
          `${host.label} didn't answer about ${repo.name}'s branches. Nothing was asked: try again in a moment.`
        );
      };
      const deleteCheck = async (input: Record<string, unknown>, c: ToolContext): Promise<CallCheck> => {
        const repo = repoOf(input.repo);
        if (!repo) return { ok: false, message: badRepo };
        const branches = strings(input.branches);
        const invalid = branches.filter((b) => !validBranch(b));
        if (invalid.length > 0) {
          return {
            ok: false,
            message: `Not branch names: ${invalid.join(", ")}. Name branches only (fix/login), never refs/… or tags.`,
          };
        }
        const twice = [...new Set(branches.filter((b, i) => branches.indexOf(b) !== i))];
        if (twice.length > 0)
          return { ok: false, message: `Named more than once: ${twice.join(", ")}. Name each branch once.` };
        // The card lists every name it deletes: a list it would cut is refused.
        if (branches.join("\n").length > APPROVAL_DETAIL_CHARS) {
          return { ok: false, message: "These names don't fit on one card. Ask in smaller batches." };
        }
        const facts = await factsOf(c, repo, branches);
        if (typeof facts === "string") return { ok: false, message: facts };
        const refused = branches.flatMap((b) => {
          const block = branchBlock(facts, b, true);
          return block ? [`${b} (${blocked(block, host)})`] : [];
        });
        if (refused.length > 0) {
          return {
            ok: false,
            message: `Refused, nothing was asked or deleted: ${refused.join(", ")}. The default branch and protected branches are never deleted. Ask again without them.`,
          };
        }
        return { ok: true };
      };
      const pushCheck = async (input: Record<string, unknown>, c: ToolContext): Promise<CallCheck> => {
        const repo = repoOf(input.repo);
        if (!repo) return { ok: false, message: badRepo };
        const branch = str(input.branch);
        if (!validBranch(branch)) {
          return {
            ok: false,
            message: `${branch} isn't a branch name. Name the branch only (fix/login), never refs/… or a tag.`,
          };
        }
        const self = await getAgentCached(c.db, c.orgId, c.agentId);
        const handle = self?.handle ?? "";
        if ([handle, ...(self?.previousHandles ?? [])].some((h) => branch.startsWith(`agentes/${h}/`))) {
          return { ok: false, message: `${branch} is your own branch: just push to it, nothing to ask.` };
        }
        const facts = await factsOf(c, repo, [branch]);
        if (typeof facts === "string") return { ok: false, message: facts };
        const block = branchBlock(facts, branch, false);
        if (block === "missing") {
          return {
            ok: false,
            message: `${branch} isn't on ${host.label}, and an approval only covers updating an existing branch, never creating one. Push to agentes/${handle}/<topic> and open a ${host.request}.`,
          };
        }
        if (block) {
          return {
            ok: false,
            message: `${branch} is ${blocked(block, host)}: push to agentes/${handle}/<topic> and open a ${host.request}; merging is a separate step.`,
          };
        }
        return { ok: true };
      };
      const all: ToolDefinition[] = [
        {
          name: named("git_clone"),
          description: `Clone a ${host.label} repository into your folder on your computer (${checkoutDirOf({ host: host.id, path: host.id === "gitlab" ? "<group>/<project>" : "<owner>/<name>" })}; already there: it is updated); list_repositories lists the ones you can use. No approval needed. Real git through our proxy: commit and push from there to branches agentes/<your handle>/…${host.openPullRequest ? `, then ${named("open_pull_request")}` : `, then give the person the link the server prints to open a ${host.request}`}. ${host.deleteBranch ? `Delete branches with ${named("delete_branches")}; to` : "To"} push to someone else's branch, ask with ${named("request_branch_push")} first.`,
          scope: scopeOf("git_clone"),
          connectionId: connection.id,
          connector: { key: host.id, via: "native", tool: named("git_clone") },
          connectorLabel: connection.label,
          service: host.id,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              dir: {
                type: "string",
                maxLength: 200,
                description: "Folder in your workspace (default: repos/<owner>/<name>)",
              },
            },
            required: ["repo"],
            additionalProperties: false,
          },
          async execute(input, c) {
            try {
              const repo = repoOf(input.repo);
              if (!repo) return { content: badRepo, isError: true };
              const given = str(input.dir).trim();
              if (given.startsWith("/") || given.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(given))
                return { content: "dir must stay in the workspace", isError: true };
              const [agent, mission] = await Promise.all([getAgentCached(c.db, c.orgId, c.agentId), missionOfRun(c)]);
              // A connected machine (not in a mission's own folder): through the proxy with our credential.
              const machineId = await toolMachineId(c.db, agent);
              if (agent && machineId && !mission) {
                const machines = deps.sandbox.machines;
                const git = deps.sandbox.git;
                if (!machines || !git) return { content: "Connected computers are not available here.", isError: true };
                // The right hand clones into the seat its run works in, a person's own or the shared one (ADR 0175).
                const scope = await machineScope(machines.hub, c, machineId);
                const r = await cloneOnMachine(
                  {
                    db: c.db,
                    hub: machines.hub,
                    git,
                    github: deps.app ? { app: deps.app, http: github } : null,
                    ...(deps.sandbox.now ? { now: deps.sandbox.now } : {}),
                  },
                  { orgId: c.orgId, agentId: c.agentId, machineId, scope },
                  {
                    repo: repo.name,
                    ...(given ? { dir: given } : {}),
                    ...(c.signal ? { signal: c.signal } : {}),
                    onOutput: progressPublisher(deps.pubsub, c),
                  },
                );
                const where = r.path ?? r.dir;
                if (r.status === "cloning") {
                  return {
                    content: `${r.repo} is still downloading into ${where} on your computer (${r.message ?? "in progress"}). It goes on by itself; call git_clone again for it when you need the code, to wait for it.`,
                    data: { repo: r.repo, dir: r.dir, machineId, status: r.status },
                  };
                }
                if (r.status === "failed" && !r.head) {
                  return { content: `git clone failed: ${r.message ?? "unknown error"}`, isError: true };
                }
                const what =
                  r.status === "cloned"
                    ? `Cloned ${r.repo} into ${where}`
                    : r.status === "failed"
                      ? `${r.repo} is already at ${where}, but it couldn't be updated (${r.message ?? "unknown error"})`
                      : `${r.repo} was already at ${where}; updated it`;
                return {
                  content: `${what} (branch ${r.branch ?? "?"}${r.head ? ` at ${r.head}` : ""}${r.message && r.status !== "failed" ? `; ${r.message}` : ""}).\nWork there (cd ${where}); create a branch agentes/${agent.handle}/<topic> to push${host.openPullRequest ? `, then ${named("open_pull_request")}` : ""}.`,
                  data: { repo: r.repo, dir: r.dir, machineId, status: r.status },
                };
              }
              if (mission) {
                return {
                  content: mission.machineId
                    ? "In a mission, work in the mission's own folder on its computer (its repository is set up there)."
                    : "This mission has no computer yet: its owner chooses one first.",
                  isError: true,
                };
              }
              if (isRightHand(agent)) return { content: NO_HOME_MESSAGE, isError: true };
              const preparing = await computerPreparing({ ...deps.sandbox, db: c.db }, c.orgId);
              return { content: preparing ? PREPARING_COMPUTER_MESSAGE : NO_COMPUTER_MESSAGE, isError: true };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: named("open_pull_request"),
          description: `Open a ${host.request} on ${host.label} from a branch you pushed (agentes/<your handle>/…). Merging is a separate step.`,
          scope: scopeOf("open_pull_request"),
          connectionId: connection.id,
          connector: { key: host.id, via: "native", tool: named("open_pull_request") },
          connectorLabel: connection.label,
          service: host.id,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              branch: { type: "string", minLength: 1, maxLength: 200 },
              title: { type: "string", minLength: 1, maxLength: 256 },
              body: { type: "string", maxLength: 60_000 },
              base: { type: "string", maxLength: 200, description: "Default: the repository's default branch" },
              draft: { type: "boolean" },
            },
            required: ["repo", "branch", "title"],
            additionalProperties: false,
          },
          describe: (input) => ({ title: `Open a ${host.request} in ${str(input.repo)}: ${str(input.title)}` }),
          async execute(input, c) {
            try {
              const repo = repoOf(input.repo);
              const open = host.openPullRequest;
              if (!repo || !open) return { content: badRepo, isError: true };
              const token = await tokenFor(c, repo.path, { pull_requests: "write", contents: "read" });
              if (!token) return { content: noToken(repo.name), isError: true };
              const request = {
                head: str(input.branch),
                base: str(input.base),
                title: str(input.title),
                body: signedBody(str(input.body), await signatureLine(c.db, c)),
                draft: input.draft === true,
              };
              // In a code session, on its repository, it is opened as the person who asked, by the account they
              // connected as their own (ADR 0215 §13); the host refusing their token opens it as the workspace.
              const person = await personAccountOfRun(c.db, c.orgId, c.runId).catch(() => null);
              const own =
                person?.host === host.id && onSessionRepo(person, repo.name)
                  ? await hostConnectionToken(deps.connectors, person.connection).catch(() => null)
                  : null;
              let res = own ? await open(at, own, repo.path, request) : null;
              if (!res || (!res.ok && [401, 403, 404].includes(res.status))) {
                res = await open(at, token, repo.path, request);
              }
              if (!res.ok) {
                return {
                  content: `${host.label} refused the ${host.request} (${res.status}): ${res.message}`,
                  isError: true,
                };
              }
              if (host.id === "github") {
                await recordGitHubItem(c, { repo: repo.name, number: res.number, authored: true }).catch(() => {});
              }
              // From a code session's branch: the session keeps its pull request (ADR 0215).
              await recordCodeSessionPr({ db: c.db, pubsub: deps.pubsub }, c.orgId, repo.name, str(input.branch), {
                number: res.number,
                url: res.url,
              }).catch(() => {});
              return {
                content: `Opened ${host.id === "gitlab" ? "MR !" : "PR #"}${res.number}: ${res.url}`,
                data: { pullRequest: { number: res.number, url: res.url, repo: repo.name } },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: named("delete_branches"),
          description: `Delete branches on ${host.label}, your own included: the only way agents delete branches (git push --delete is refused). The whole list goes to a person on one card, unless you never ask, then they're deleted. Never tags, the default branch or a protected branch.`,
          scope: scopeOf("delete_branches"),
          connectionId: connection.id,
          connector: { key: host.id, via: "native", tool: named("delete_branches") },
          connectorLabel: connection.label,
          sensitive: true,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              branches: { type: "array", minItems: 1, maxItems: 50, items: branchInput },
            },
            required: ["repo", "branches"],
            additionalProperties: false,
          },
          describe: (input) => {
            const branches = strings(input.branches);
            return {
              title: `Apagar ${branches.length} ${branches.length === 1 ? "branch" : "branches"} em ${str(input.repo)}`,
              detail: branches.join("\n"),
            };
          },
          checkCall: deleteCheck,
          async execute(input, c) {
            try {
              const repo = repoOf(input.repo);
              const remove = host.deleteBranch;
              if (!repo || !remove) return { content: badRepo, isError: true };
              const token = await tokenFor(c, repo.path, { contents: "write" });
              if (!token) return { content: noToken(repo.name), isError: true };
              const deleted: string[] = [];
              const missed: string[] = [];
              // One at a time: parallel ref updates in one repository may conflict on the host.
              for (const branch of strings(input.branches)) {
                const status = await remove(at, token, repo.path, branch);
                if (status !== null && status >= 200 && status < 300) deleted.push(branch);
                else missed.push(`${branch} (${status ? `${host.label} answered ${status}` : "no answer"})`);
              }
              const lines = [
                ...(deleted.length > 0 ? [`Deleted on ${host.label}: ${deleted.join(", ")}.`] : []),
                ...(missed.length > 0 ? [`Not deleted: ${missed.join(", ")}.`] : []),
              ];
              return {
                content: lines.join("\n"),
                ...(missed.length > 0 ? { isError: true } : {}),
                data: { repo: repo.name, deleted, failed: missed },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: named("request_branch_push"),
          description: `Ask a person to let you push to a ${host.label} branch that isn't yours (agentes/<your handle>/… needs no asking). Once they approve, push again with git: fast-forwards to that existing branch, for 24 h or for good if they choose. Never the default branch or a protected one, never a new branch, never a force push.`,
          scope: scopeOf("request_branch_push"),
          connectionId: connection.id,
          connector: { key: host.id, via: "native", tool: named("request_branch_push") },
          connectorLabel: connection.label,
          sensitive: true,
          inputSchema: {
            type: "object",
            properties: { repo: repoInput, branch: branchInput },
            required: ["repo", "branch"],
            additionalProperties: false,
          },
          describe: (input) => ({
            title: `Enviar para ${str(input.branch)} em ${str(input.repo)} (24 h, sem force push)`,
          }),
          // Kept by the repository's stored name, as the proxy reads it on the push.
          rememberTarget: (input) => pushGrantKeyOf({ ...input, repo: repoOf(input.repo)?.name }),
          checkCall: pushCheck,
          // The grant is the approval itself (or the rule): the proxy reads it on the next push.
          execute: async (input) => ({
            content: `Approved: push to ${str(input.branch)} in ${str(input.repo)} again now with git (fast-forward only, no force push).`,
          }),
        },
      ];
      // A host with no call for something offers no such tool.
      return all.filter(
        (tool) =>
          (tool.name !== named("open_pull_request") || host.openPullRequest) &&
          (tool.name !== named("delete_branches") || host.deleteBranch),
      );
    }
  }
}
