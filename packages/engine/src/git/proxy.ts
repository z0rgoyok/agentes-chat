import { gunzipSync } from "node:zlib";
import {
  DELETE_BRANCHES_POINTER,
  NO_TERMINAL_COMMANDS,
  otherBranchPointer,
} from "@agenteschat/adapters/command-policy";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { connectorScope } from "../connectors/catalog";
import { type ConnectorDeps, GITHUB_APP_AUTH } from "../connectors/connections";
import { toolMachineId } from "../right-hand-seats";
import { standingRefusal } from "../standing";
import { CONNECTOR_ALL, freshGrantedKeys, grantKey, isAllowed, toolAccess } from "../tools/scopes";
import {
  branchBlock,
  githubToken,
  hostConnectionToken,
  type PushGrant,
  pushGrantKey,
  pushGrants,
  validBranch,
} from "./branches";
import { machineGitGen, verifyGitToken } from "./credential";
import type { GitHubAppConfig } from "./github-app";
import { appMissMessage } from "./github-call";
import {
  basic,
  GIT_HOSTS,
  type GitHostId,
  type GitVerb,
  gitHostOf,
  gitToolName,
  type HostAt,
  refInList,
  repoPathOn,
  repoRefName,
} from "./hosts";
import { hostAt } from "./hosts/reach";
import { parseReceivePackRequest, pkt, type RefCommand, readPack, walkToOld, ZERO_OID } from "./pack";
import { personAccountOfPush } from "./person-account";
import { agentRepositoryList } from "./repos";

const { machines, agents, connectorConnections } = schema;

/** An agent's git scopes on a host's connection (`gitlab:git.read`). */
export const gitScopes = (host: GitHostId) => ({
  read: connectorScope(host, "git.read"),
  write: connectorScope(host, "git.write"),
});

export const GIT_SCOPES = gitScopes("github");

export const GIT_LIMITS = {
  /** A push request (commands + pack). */
  pushBytes: 100 * 1024 * 1024,
  /** Ref updates in one push, refused above before any is looked up. */
  maxCommands: 100,
  /** What one fetch/clone may download through us. */
  fetchBytes: 2 * 1024 * 1024 * 1024,
  /** Wants/haves of a fetch. */
  fetchRequestBytes: 10 * 1024 * 1024,
  maxObjects: 50_000,
  /** Decompressed pack content is bounded independently of the wire size. */
  maxInflatedBytes: 128 * 1024 * 1024,
  maxCommitBytes: 2 * 1024 * 1024,
};

export interface GitProxyDeps {
  db: Database;
  /** AGENTES_SECRET: the proxy credentials are HMACs derived from it. */
  secret: string;
  connectors: ConnectorDeps;
  /** GitHub (tests: a fake upstream). */
  upstream?: { gitUrl: string; apiUrl: string; fetch: typeof fetch };
  /** Preferred over the connection's token when the app is installed on the repo. */
  app?: GitHubAppConfig | null;
  limits?: Partial<typeof GIT_LIMITS>;
  now?: () => Date;
}

type Service = "git-upload-pack" | "git-receive-pack";

const text = (status: number, message: string, extra: Record<string, string> = {}) =>
  new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/repo(.git)/(info/refs|git-upload-pack|git-receive-pack)` → its parts, or null. */
export function parseGitPath(path: string) {
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  const [, owner, repo, action] = m as unknown as [string, string, string, string];
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo, action };
}

/** `{path}(.git)/(info/refs|git-upload-pack|git-receive-pack)` on a host → the repository's path and the action. */
export function parseHostGitPath(host: GitHostId, path: string) {
  const m = /^(.+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  // The computer's remote ends in `.git` whatever the host (`git.sync`): the one it added comes off here.
  const repo = repoPathOn(host, (m[1] as string).replace(/\.git$/, ""));
  return repo ? { path: repo, action: m[2] as string } : null;
}

/** What an agent may do with git on a connection: its git scopes, or "every tool of this connection". */
export function gitAccess(keys: Set<string>, connectionId: string, host: GitHostId = "github") {
  const scopes = gitScopes(host);
  const all = keys.has(grantKey(connectionId, CONNECTOR_ALL));
  const write = all || keys.has(grantKey(connectionId, scopes.write));
  return { read: write || keys.has(grantKey(connectionId, scopes.read)), write };
}

/**
 * A push command as the proxy reads it before any grant: the agent's own branch (`agentes/{handle}/…`, or under a
 * handle it had before a rename) goes; tags, deletes (`delete_branches` deletes), refs that aren't branches and
 * creating someone else's branch are refused; an update of any other existing branch goes only with a grant
 * (`request_branch_push`).
 */
export type RefVerdict =
  | { ok: true }
  | { grant: string }
  | { refused: string; kind: "tag" | "delete" | "ref" | "create" };

export function refRule(
  cmd: RefCommand,
  handle: string,
  previousHandles: string[] = [],
  host: GitHostId = "github",
): RefVerdict {
  if (cmd.ref.startsWith("refs/tags/")) return { refused: "tags can't be pushed by agents", kind: "tag" };
  if (cmd.newOid === ZERO_OID) {
    return {
      refused: GIT_HOSTS[host].deleteBranch
        ? `branches are deleted with ${gitToolName(host, "delete_branches")}`
        : "agents don't delete branches here",
      kind: "delete",
    };
  }
  for (const h of [handle, ...previousHandles]) {
    const own = `refs/heads/agentes/${h}/`;
    if (cmd.ref.startsWith(own) && cmd.ref.length > own.length) return { ok: true };
  }
  const branch = cmd.ref.startsWith("refs/heads/") ? cmd.ref.slice("refs/heads/".length) : "";
  if (!validBranch(branch)) return { refused: `agents push only to branches agentes/${handle}/…`, kind: "ref" };
  if (cmd.oldOid === ZERO_OID) return { refused: `agents create only branches agentes/${handle}/…`, kind: "create" };
  return { grant: branch };
}

/**
 * The report git shows for a refused push (report-status, inside side-band when asked). `told`: what the person
 * running git reads as `remote: agentes: …`, each line once, ending with `NO_TERMINAL_COMMANDS` whatever was refused.
 */
function refusal(commands: RefCommand[], reasons: Map<string, string>, told: Iterable<string>, capabilities: string[]) {
  let report = pkt("unpack ok\n");
  for (const c of commands) {
    const reason = reasons.get(c.ref) ?? "refused with the rest of the push (atomic)";
    report += pkt(`ng ${c.ref} ${reason}\n`);
  }
  report += "0000";
  const sideband = capabilities.includes("side-band-64k") || capabilities.includes("side-band");
  let body = report;
  if (sideband) {
    const lines = [...told];
    if (!lines.some((r) => r.endsWith(NO_TERMINAL_COMMANDS))) lines.push(NO_TERMINAL_COMMANDS);
    const human = lines.map((r) => pkt(`\x02agentes: ${r}\n`)).join("");
    body = `${human}${pkt(`\x01${report}`)}0000`;
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}

/** A body that errors after `max` bytes (a clone bigger than we allow stops). */
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("download larger than the limit"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

export async function readBody(req: Request, max: number) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > max) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          void reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
    try {
      return new Uint8Array(gunzipSync(raw, { maxOutputLength: max }));
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Smart-HTTP git for agents' computers (ADR 0024): `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/…`.
 * - The computer authenticates with our short-lived per-computer credential.
 * - Policy is checked here, the same on every git host (ADR 0227; the host is the connection's): the agent's
 *   `git.read` / `git.write` grants on that connection (and repo list, when set); pushes to
 *   `agentes/{handle}/*`, or to another existing branch a person approved
 *   (`request_branch_push`) that its host says isn't the default or protected;
 *   fast-forward only, no tags or deletes; size limits and at most 100 refs.
 * - The request goes to the host with the org's token added here (on GitHub, a GitHub App
 *   installation token when configured), never logged, never sent back.
 * - Fetches and pushes are audited.
 */
export async function handleGitProxy(
  deps: GitProxyDeps,
  req: Request,
  params: { orgId: string; connectionId: string; path: string },
): Promise<Response> {
  try {
    return await proxyGit(deps, req, params);
  } catch (error) {
    if (connectionDropped(error)) return text(503, "agentes: the connection dropped. Try again.");
    throw error;
  }
}

/** The computer or GitHub hung up mid-transfer: nothing broke here, and git only needs to try again. */
const connectionDropped = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || /\bECONNRESET\b/.test(`${(error as { code?: string }).code} ${error.message}`));

async function proxyGit(
  deps: GitProxyDeps,
  req: Request,
  params: { orgId: string; connectionId: string; path: string },
): Promise<Response> {
  const limits = { ...GIT_LIMITS, ...deps.limits };
  // Which path is a repository's depends on the host, and the host on the connection: read once the caller is known.
  const action = /(?:^|\/)(info\/refs|git-upload-pack|git-receive-pack)$/.exec(params.path)?.[1];
  if (!action) return text(404, "agentes: not a git repository path");
  const url = new URL(req.url);
  const service: Service | null =
    action === "info/refs" ? ((url.searchParams.get("service") as Service | null) ?? null) : (action as Service);
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return text(403, "agentes: only smart HTTP (upload-pack / receive-pack) is supported");
  }
  if (action !== "info/refs" && req.method !== "POST") return text(405, "method not allowed");

  // 1. Who: our credential (git sends it as the password of HTTP Basic).
  const auth = req.headers.get("authorization") ?? "";
  const given = /^Basic\s+(.+)$/i.exec(auth);
  const password = given
    ? Buffer.from(given[1] as string, "base64")
        .toString("utf8")
        .split(":")
        .slice(1)
        .join(":")
    : "";
  const now = deps.now?.() ?? new Date();
  const claims = password ? verifyGitToken(deps.secret, password, now) : null;
  if (!claims || claims.orgId !== params.orgId || claims.kind !== "machine") {
    return text(401, "agentes: sign in with the computer's git credential", {
      "www-authenticate": 'Basic realm="agentes git"',
    });
  }
  const revoked = () =>
    text(401, "agentes: this credential was revoked", { "www-authenticate": 'Basic realm="agentes git"' });
  const [agent] = await deps.db
    .select({
      id: agents.id,
      handle: agents.handle,
      previousHandles: agents.previousHandles,
      archivedAt: agents.archivedAt,
      machineId: agents.machineId,
      builtin: agents.builtin,
      orgId: agents.orgId,
    })
    .from(agents)
    .where(and(eq(agents.id, claims.agentId), eq(agents.orgId, claims.orgId)));
  // A connected machine (ADR 0024 addendum): still paired, same token, and still this agent's computer.
  const [machine] = await deps.db
    .select({ id: machines.id, tokenHash: machines.tokenHash })
    .from(machines)
    .where(and(eq(machines.id, claims.sandboxId), eq(machines.orgId, claims.orgId), isNull(machines.deletedAt)));
  if (
    !machine?.tokenHash ||
    machineGitGen(machine.tokenHash) !== claims.gen ||
    (await toolMachineId(deps.db, agent)) !== machine.id
  ) {
    return revoked();
  }
  /** What the audit names as the computer. */
  const where = { machineId: machine.id };
  if (!agent || agent.archivedAt) return text(403, "agentes: this agent is archived");
  // Work already on a computer reaches GitHub through us: a hold or suspension stops it here too.
  const paused = await standingRefusal(deps.db, claims.orgId, claims.agentId);
  if (paused) return text(403, `agentes: ${paused.message}`);

  // 2. Which GitHub connection, and what this agent may do with it.
  const [connection] = await deps.db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, params.connectionId),
        eq(connectorConnections.orgId, claims.orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  // The workspace's connection to a git host (ADR 0227): a person's own account is never a proxy's connection.
  const host = connection && !connection.ownerUserId ? gitHostOf(connection.connector) : null;
  if (!connection || !host) return text(404, "agentes: no git host is connected here in this organization");
  const parsed = parseHostGitPath(host.id, params.path);
  if (!parsed) return text(404, "agentes: not a git repository path");
  const scopes = gitScopes(host.id);
  const keys = await freshGrantedKeys(deps.db, claims.orgId, claims.agentId);
  const { read: canRead, write: canWrite } = gitAccess(keys, connection.id, host.id);
  /** The repository as it is stored and audited: `owner/name` on GitHub, `gitlab:group/project` anywhere else. */
  const repoName = repoRefName({ host: host.id, path: parsed.path });
  if (!canRead) return text(403, `agentes: ${agent.handle} has no git access to ${host.label} (scope ${scopes.read})`);
  // The agent's repositories (`agent_repositories`): none = all; reads count too.
  if (!refInList(await agentRepositoryList(deps.db, claims.orgId, claims.agentId), repoName)) {
    return text(
      403,
      `agentes: ${repoName} isn't one of ${agent.handle}'s repositories (ask whoever can edit it to add it)`,
    );
  }
  if (service === "git-receive-pack" && !canWrite) {
    return text(403, `agentes: ${agent.handle} can't push (scope ${scopes.write})`);
  }

  // 3. The host's credential, added here only.
  const at: HostAt =
    host.id === "github" && deps.upstream
      ? { fetch: deps.upstream.fetch, api: deps.upstream.apiUrl, git: deps.upstream.gitUrl, site: "github.com" }
      : hostAt(host, connection.serverUrl, { http: deps.upstream?.fetch, resolveHost: deps.connectors.resolveHost });
  const write = service === "git-receive-pack";
  const [owner = "", repo = ""] = parsed.path.split("/");
  const bearer =
    host.id === "github"
      ? await githubToken(
          deps,
          { fetch: at.fetch, apiUrl: at.api },
          { db: deps.db, orgId: claims.orgId },
          connection,
          { owner, repo },
          // Workflow files too where the installation grants it (ADR 0156): an older installation has contents alone.
          write ? [{ contents: "write", workflows: "write" }, { contents: "write" }] : { contents: "read" },
        )
      : await hostConnectionToken(deps.connectors, connection).catch(() => null);
  if (!bearer) {
    return connection.authType === GITHUB_APP_AUTH
      ? text(403, `agentes: ${appMissMessage(repoName, "not_installed")}`)
      : text(502, `agentes: the organization's ${host.label} connection has no usable token`);
  }
  /** What the computer's own guard says of GitHub's tools, in this host's names. */
  const onHost = (told: string) =>
    host.id === "github"
      ? told
      : told
          .replace(/\b(delete_branches|request_branch_push)\b/g, (verb) => gitToolName(host.id, verb as GitVerb))
          .replace(/\bon GitHub\b/g, `on ${host.label}`)
          .replace(/\ba pull request\b/g, `a ${host.request}`);
  const upstreamAuth = basic(host.gitLogin(bearer));
  const target = `${host.remote(at, parsed.path)}/${parsed.action}${url.search}`;
  const forward = (body?: Uint8Array, authorization = upstreamAuth) => {
    const headers: Record<string, string> = { authorization, "user-agent": "git/agentes-proxy" };
    for (const h of ["content-type", "accept", "git-protocol"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    return at.fetch(target, { method: req.method, headers, body, redirect: "manual" });
  };
  const relay = async (res: Response, max: number) => {
    // The host saying no is a permission, not an outage: a 5xx sends the agent waiting for a fix that never comes.
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      const why =
        connection.authType === GITHUB_APP_AUTH
          ? appMissMessage(repoName, "refused")
          : write && res.status === 403
            ? `${host.label} refused the workspace's credential for pushing to ${repoName}: the account connected in Settings › Connectors can't write there. Push the branch to a fork that account can write and open the ${host.request} from there.`
            : `${host.label} refused the workspace's credential for ${repoName}: the account connected in Settings › Connectors can't reach it, or its sign-in ended. Tell the person: an admin reconnects ${host.label} there with an account that has access to ${repoName}.`;
      return text(403, `agentes: ${why}`);
    }
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    const type = res.headers.get("content-type");
    if (type) headers["content-type"] = type;
    return new Response(res.body ? capped(res.body, max) : null, { status: res.status, headers });
  };

  if (parsed.action === "info/refs") return relay(await forward(), limits.fetchBytes);

  if (service === "git-upload-pack") {
    const body = await readBody(req, limits.fetchRequestBytes);
    if (!body) return text(413, "agentes: fetch request too large");
    const res = await forward(body);
    if (res.ok) {
      await recordAudit(deps.db, {
        orgId: claims.orgId,
        actor: { type: "agent", id: claims.agentId },
        action: "git.fetch",
        target: { type: "git_repo", id: repoName },
        details: { connectionId: connection.id, ...where },
      }).catch(() => undefined);
    }
    return relay(res, limits.fetchBytes);
  }

  // 4. A push: read it whole, check every command and the pack, then send it.
  const body = await readBody(req, limits.pushBytes);
  if (!body) return text(413, `agentes: push larger than ${Math.round(limits.pushBytes / 1024 / 1024)} MB`);
  let request: ReturnType<typeof parseReceivePackRequest>;
  try {
    request = parseReceivePackRequest(body);
  } catch {
    return text(400, "agentes: unreadable push");
  }
  if (request.commands.length > limits.maxCommands) {
    return text(413, `agentes: a push may update at most ${limits.maxCommands} refs at once`);
  }
  const reasons = new Map<string, string>();
  const told = new Set<string>();
  /** Someone else's branches by ref: pushed with a grant, or named once to the agent. */
  const others = new Map<string, string>();
  for (const cmd of request.commands) {
    const verdict = refRule(cmd, agent.handle, agent.previousHandles, host.id);
    if ("refused" in verdict) {
      reasons.set(cmd.ref, verdict.refused);
      told.add(verdict.kind === "delete" && host.deleteBranch ? onHost(DELETE_BRANCHES_POINTER) : verdict.refused);
    } else if ("grant" in verdict) others.set(cmd.ref, verdict.grant);
  }
  const pushTool = gitToolName(host.id, "request_branch_push");
  const granting = { orgId: claims.orgId, agentId: claims.agentId, connectionId: connection.id, host: host.id };
  // A denied request_branch_push grants nothing: no rule or approval is read (ADR 0015).
  const mayAsk = isAllowed(toolAccess(keys, { name: pushTool, scope: scopes.write, connectionId: connection.id }));
  const grants =
    others.size > 0 && mayAsk
      ? await pushGrants(
          deps.db,
          granting,
          [...others.values()].map((b) => pushGrantKey(repoName, b)),
          now,
        )
      : new Map<string, PushGrant>();
  const granted = new Map<string, { branch: string; grant: PushGrant }>();
  const ungranted: string[] = [];
  for (const [ref, branch] of others) {
    const grant = grants.get(pushGrantKey(repoName, branch));
    if (grant) granted.set(ref, { branch, grant });
    else {
      reasons.set(ref, `not your branch (ask with ${pushTool})`);
      ungranted.push(branch);
    }
  }
  if (ungranted.length > 0) told.add(onHost(otherBranchPointer(ungranted, agent.handle)));
  // A granted branch may have become the default or protected since: its host says so now, and no answer refuses.
  if (reasons.size === 0 && granted.size > 0) {
    const facts = await host.branchFacts(at, bearer, parsed.path, [
      ...new Set([...granted.values()].map((g) => g.branch)),
    ]);
    for (const [ref, { branch }] of granted) {
      const block = facts ? branchBlock(facts, branch, false) : "unknown";
      if (!block) continue;
      const [short, long] =
        block === "unknown"
          ? [
              `${host.label} didn't answer`,
              `${host.label} didn't say whether ${branch} is protected: nothing was pushed, try again`,
            ]
          : block === "missing"
            ? [
                `not on ${host.label}`,
                `${branch} isn't on ${host.label}: an approval covers updating a branch, never creating one`,
              ]
            : [
                block === "default" ? "the default branch" : "protected",
                `${branch} is ${block === "default" ? "the default branch" : "protected"}: push to agentes/${agent.handle}/<topic> and open a ${host.request}; merging is a separate step`,
              ];
      reasons.set(ref, short);
      told.add(long);
    }
  }
  let commits = 0;
  if (reasons.size === 0) {
    let pack: ReturnType<typeof readPack>;
    try {
      pack = readPack(body, request.packStart, {
        maxObjects: limits.maxObjects,
        maxInflatedBytes: limits.maxInflatedBytes,
        maxCommitBytes: limits.maxCommitBytes,
      });
    } catch {
      return text(400, "agentes: unreadable pack");
    }
    commits = pack.commits.length;
    for (const cmd of request.commands) {
      if (cmd.oldOid === ZERO_OID) continue;
      // Fast-forward only: the new tip must descend from the old one.
      const walk = walkToOld(pack.commits, cmd.oldOid, cmd.newOid);
      let ok = walk.reached;
      for (const oid of walk.outside.slice(0, 5)) {
        if (ok) break;
        // A commit the push didn't carry is on the host already: the host says whether it descends from the old tip.
        // A host with no such answer takes only a push that carries its own history.
        ok = host.descends ? await host.descends(at, bearer, parsed.path, cmd.oldOid, oid).catch(() => false) : false;
      }
      if (!ok) {
        const why = "not a fast-forward (force pushes are not allowed)";
        reasons.set(cmd.ref, why);
        told.add(why);
      }
    }
  }
  if (reasons.size > 0) {
    await recordAudit(deps.db, {
      orgId: claims.orgId,
      actor: { type: "agent", id: claims.agentId },
      action: "git.push_refused",
      target: { type: "git_repo", id: repoName },
      details: { refs: request.commands.map((c) => c.ref), reasons: Object.fromEntries(reasons) },
    }).catch(() => undefined);
    return refusal(request.commands, reasons, told, request.capabilities);
  }
  // A code session's branch, pushed while a person is behind its run, goes to the host as that person, by the account
  // they connected as their own (ADR 0215 §13). The host refusing their token (no access to this repository, a token
  // that ended) sends it as the workspace, as every other push goes.
  const person = await personAccountOfPush(deps.db, {
    orgId: claims.orgId,
    agentId: claims.agentId,
    repo: repoName,
    refs: request.commands.map((c) => c.ref),
  }).catch(() => null);
  const personToken =
    person?.host === host.id ? await hostConnectionToken(deps.connectors, person.connection).catch(() => null) : null;
  let res = personToken ? await forward(body, basic(host.gitLogin(personToken))) : null;
  const asPerson = res !== null && res.status !== 401 && res.status !== 403 && res.status !== 404;
  if (res && !asPerson) await res.body?.cancel().catch(() => undefined);
  if (!res || !asPerson) res = await forward(body);
  if (res.ok) {
    await recordAudit(deps.db, {
      orgId: claims.orgId,
      actor: { type: "agent", id: claims.agentId },
      action: "git.push",
      target: { type: "git_repo", id: repoName },
      details: {
        connectionId: connection.id,
        ...(asPerson && person ? { asPersonId: person.personId } : {}),
        ...where,
        refs: request.commands.map((c) => ({ ref: c.ref, from: c.oldOid, to: c.newOid })),
        commits,
        ...(granted.size > 0 ? { grants: Object.fromEntries([...granted].map(([ref, g]) => [ref, g.grant])) } : {}),
      },
    }).catch(() => undefined);
  }
  return relay(res, limits.fetchBytes);
}
