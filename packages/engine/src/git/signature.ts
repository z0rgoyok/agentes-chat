import { and, asc, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { getAgentCached } from "../agents";
import { accountablePerson, runAuthorityById } from "../authority";
import { emailLocale } from "../email";
import { getMembership } from "../organizations";
import type { GitHubHttp } from "./github-app";

const { accounts, organizationMembers, organizationSettings, users } = schema;

/**
 * What an agent writes on GitHub says whose agent it is (ADR 0156): every body ends with one line naming the agent and
 * the person it works for ("Theo, agente de Ana no agentes.chat", in the workspace owner's language), and commits
 * credit that person (`Co-Authored-By`) when they linked GitHub to sign in, never with their email. Every commit also
 * ends with the agent's own line (`agentCoAuthor`), unless a person asked an agent to turn it off for the workspace.
 */

/** The agents' address in their own line: GitHub shows the account that verified it, agentes.chat's. */
export const AGENT_CO_AUTHOR_EMAIL = "noreply@agentes.chat";

/** Where the line starts in a body, so an edit can replace it. */
export const SIGNATURE_MARK = "<!-- agentes.chat -->";

/**
 * A line of ours left in a body the agent sends again (an edit): the mark on a line of its own, then the line. One
 * quoted from another comment (`> `) is the agent's text, and so is everything around it.
 */
const OWN_LINE = /[\r\n]*^[ \t]*<!-- agentes\.chat -->[ \t]*\r?\n<sub>[^<\r\n]*<\/sub>[ \t]*$/gm;

/** A name as GitHub shows it: one line, no markup, no @mention, no link. */
const escapeLine = (s: string) => s.replace(/\s+/g, " ").replace(/[&<>@#*_`~|\\[\]]/g, (c) => `&#${c.charCodeAt(0)};`);

/** `body` with the agent's line at its end, once (an old line of ours is taken out, nothing else). */
export function signedBody(body: string, line: string) {
  const text = body
    .replace(OWN_LINE, "")
    .replace(/^[\r\n]+/, "")
    .trimEnd();
  return `${text ? `${text}\n\n` : ""}${SIGNATURE_MARK}\n<sub>${escapeLine(line)}</sub>`;
}

/** One of our agents wrote this body (its line ends it): through an account's connection it isn't the app's bot. */
export const signedByAgent = (body: string) =>
  /(?:^|\n)[ \t]*<!-- agentes\.chat -->[ \t]*\r?\n<sub>[^<\r\n]*<\/sub>$/.test(body.trimEnd());

/**
 * `message` with each trailer on a last line of its own, inside its trailer block when it ends with one; each once,
 * whatever its capitals (Claude Code writes `Co-Authored-By`).
 */
export function creditedMessage(message: string, ...trailers: string[]) {
  let out = message;
  for (const trailer of trailers) {
    if (out.toLowerCase().includes(trailer.toLowerCase())) continue;
    const text = out.trimEnd();
    const paragraphs = text.split(/\n[ \t]*\n/);
    const last = paragraphs.at(-1) ?? "";
    const block = paragraphs.length > 1 && last.split("\n").every((l) => /^[A-Za-z][A-Za-z-]*: \S/.test(l));
    out = `${text}${block ? "\n" : "\n\n"}${trailer}`;
  }
  return out;
}

/** A name in a trailer: one line, nothing that ends it early (`<`, `>`) or breaks it (control characters). */
export const trailerName = (name: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters would break the trailer
  name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, "").trim();

/** `Co-Authored-By: Nick <noreply@agentes.chat>`: the agent's own line on its commits (its handle when its name is empty). */
export const agentCoAuthor = (agent: { name: string; handle: string }) =>
  `Co-Authored-By: ${trailerName(agent.name) || agent.handle} <${AGENT_CO_AUTHOR_EMAIL}>`;

/** The capitals a runner older than protocol 85 (`CO_AUTHOR_CASE_PROTOCOL`) takes: it drops any other. */
export const oldCoAuthorCase = (line: string) => line.replace(/^Co-Authored-By:/, "Co-authored-by:");

/** Whether the workspace's agents end their commits with their own line: on unless a person asked to turn it off. */
export async function agentCoAuthorOn(db: Executor, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSettings.agentCoAuthor })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.on ?? true;
}

export async function setAgentCoAuthor(db: Executor, orgId: string, on: boolean) {
  await db
    .insert(organizationSettings)
    .values({ orgId, agentCoAuthor: on })
    .onConflictDoUpdate({ target: organizationSettings.orgId, set: { agentCoAuthor: on, updatedAt: new Date() } });
}

/** The agent's own line, or null where the workspace turned it off. */
export async function agentCoAuthorLine(db: Executor, orgId: string, agent: { name: string; handle: string }) {
  return (await agentCoAuthorOn(db, orgId)) ? agentCoAuthor(agent) : null;
}

/** The person behind a call: who asked (or a routine's creator), else the agent's responsável; members only. */
async function personBehind(db: Database, ctx: { orgId: string; runId?: string }, ownerUserId: string | null) {
  const asked = ctx.runId ? accountablePerson(await runAuthorityById(db, ctx.orgId, ctx.runId)) : null;
  for (const id of new Set([asked, ownerUserId])) {
    if (id && (await getMembership(db, id, ctx.orgId))) return id;
  }
  return null;
}

/** The workspace's language for what agents sign: its first owner's, as the workspace's computer is named. */
async function workspaceLocale(db: Database, orgId: string) {
  const [owner] = await db
    .select({ locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);
  return emailLocale(owner?.locale);
}

const logins = new Map<string, { login: string | null; at: number }>();
const LOGIN_TTL_MS = 24 * 3600_000;
const MISS_TTL_MS = 10 * 60_000;

/** A GitHub account's login by its id (`GET /user/{id}`), cached for a day; null when GitHub didn't say. */
async function githubLogin(http: GitHubHttp, id: string, token?: string | null) {
  const known = logins.get(id);
  if (known && Date.now() - known.at < (known.login ? LOGIN_TTL_MS : MISS_TTL_MS)) return known.login;
  const res = await http
    .fetch(`${http.apiUrl}/user/${id}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "agentes.chat",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    .catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { login?: unknown } | null) : null;
  const login = typeof body?.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(body.login) ? body.login : null;
  logins.set(id, { login, at: Date.now() });
  return login;
}

interface CoAuthorDeps {
  db: Database;
  http: GitHubHttp;
  token?: string | null;
  /** The most GitHub's login lookup is waited for; past it the person goes uncredited and the lookup is cached on. */
  loginWaitMs?: number;
}

/**
 * `Co-Authored-By: Ana <123+ana@users.noreply.github.com>` for a person who linked GitHub to sign in (their GitHub id
 * from that sign-in, the login GitHub has for it now). Null otherwise: no address is guessed.
 */
export async function coAuthorOf(deps: CoAuthorDeps, personId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ githubId: accounts.accountId, name: users.name })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(accounts.userId, personId), eq(accounts.providerId, "github")))
    .limit(1);
  if (!row || !/^\d{1,20}$/.test(row.githubId)) return null;
  const lookup = githubLogin(deps.http, row.githubId, deps.token);
  const login = await (deps.loginWaitMs === undefined
    ? lookup
    : Promise.race([lookup, Bun.sleep(deps.loginWaitMs).then(() => null)]));
  if (!login) return null;
  return `Co-Authored-By: ${trailerName(row.name) || login} <${row.githubId}+${login}@users.noreply.github.com>`;
}

/** The line under what this agent writes on GitHub in this run. */
export async function signatureLine(db: Database, ctx: { orgId: string; agentId: string; runId?: string }) {
  const agent = await getAgentCached(db, ctx.orgId, ctx.agentId);
  const personId = await personBehind(db, ctx, agent?.ownerUserId ?? null);
  const [person] = personId ? await db.select({ name: users.name }).from(users).where(eq(users.id, personId)) : [];
  const vars = { agent: agent?.name ?? "agent", person: person?.name ?? "" };
  const key = person ? "githubApp.signature.forPerson" : "githubApp.signature.alone";
  return serverText(await workspaceLocale(db, ctx.orgId), key, vars);
}

/**
 * The lines this run's commits end with: the agent's own, unless the workspace turned it off, then the credit for the
 * person behind the run (as `signatureLine` names them).
 */
export async function runCoAuthors(
  deps: CoAuthorDeps,
  ctx: { orgId: string; agentId: string; runId?: string },
): Promise<string[]> {
  const agent = await getAgentCached(deps.db, ctx.orgId, ctx.agentId);
  const personId = await personBehind(deps.db, ctx, agent?.ownerUserId ?? null);
  const lines = await Promise.all([
    agent ? agentCoAuthorLine(deps.db, ctx.orgId, agent) : null,
    personId ? coAuthorOf(deps, personId) : null,
  ]);
  return lines.filter((l): l is string => l !== null);
}
