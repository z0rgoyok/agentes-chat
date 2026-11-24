import { and, desc, eq, gt, isNull, or, schema, sql } from "@agenteschat/db";
import { type ConnectorState, connectorStates, type ServerCatalog } from "../connectors/listing";
import { connectorsForUrl } from "../connectors/sites";
import { ownerOnlyPerson } from "../personal-use";
import { secretSite } from "../secret-request-tool";
import { REQUEST_SECRET_TOOL, secretStillHeld } from "../secrets";
import { HOW_TO_GET } from "./directory";
import { missingPermissions, REQUEST_PERMISSION_TOOL } from "./permission";
import type { ToolContext, ToolDefinition } from "./types";

/**
 * `offer_connect_app`'s name (built in `setup-tools.ts`, which re-exports it). Kept here: importing it from there
 * would close an import cycle (setup-tools → schedule-tools → routines → the gateway → this file) that reads
 * `ROUTINE_EVENTS` before `routines.ts` has set it.
 */
export const OFFER_CONNECT_APP_TOOL = "offer_connect_app";

/** How many of the people's last messages in the conversation `person_said` is looked for in. */
const PEOPLE_MESSAGES_READ = 30;
const TOOLS_NAMED = 5;
/** The `gh` CLI's variables. Any other `GH_` name goes by its purpose: `GH_API_KEY` may well be Greenhouse's. */
const GH_CLI_KEYS = new Set(["GH_PAT", "GH_TOKEN"]);
const KEY_WORDS = new Set("apikey credential credentials key pat passwd password pwd secret token".split(" "));
/** A variable made only of these says nothing of its service: its purpose does. */
const WORDS_OF_ANY_KEY = new Set([
  ...KEY_WORDS,
  "access",
  "api",
  "app",
  "auth",
  "bot",
  "gh",
  "oauth",
  "personal",
  "repo",
]);
/**
 * What a connection doesn't stand for: a secret that signs what a service sends, what identifies an app of the person's
 * own (`GITHUB_CLIENT_SECRET`, `SUPABASE_ANON_KEY`), and a company's own server of the service.
 */
const NOT_ACCESS = new Set("anon client enterprise public publishable signing webhook".split(" "));
/** The hosts a service signs in on. Any other host of its domain may be a customer's site (`shop.vercel.app`). */
const SERVICE_HOSTS = new Set("accounts app auth console dashboard id login www".split(" "));

const str = (v: unknown) => (typeof v === "string" ? v : "");
const wordsIn = (text: string) => `_${text.replace(/[^\p{L}\p{N}]+/gu, "_")}_`;
const squeezed = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The connector a `request_secret` call is a credential of. By its variable's name (`GITHUB_TOKEN`, `GH_TOKEN`), by the
 * site a password goes on (`github.com`), or, when the variable says nothing (`API_KEY`), by the service's name as
 * written in the purpose. Generic "Email" is a word in variables (`EMAIL_PASSWORD`), not a service.
 */
function serviceAsked(input: Record<string, unknown>, services: ConnectorState[]) {
  const variable = str(input.name);
  const words = (GH_CLI_KEYS.has(variable) ? "GITHUB_TOKEN" : variable).toLowerCase().split("_").filter(Boolean);
  const isKey = words.some((w) => KEY_WORDS.has(w)) && !words.some((w) => NOT_ACCESS.has(w));
  const name = `_${words.join("_")}_`;
  const says = isKey && words.every((w) => WORDS_OF_ANY_KEY.has(w)) ? wordsIn(str(input.purpose)) : "";
  const origin = secretSite(str(input.site).trim());
  const host = origin ? new URL(origin).hostname.split(".") : [];
  const domain = host.length === 2 || (host.length === 3 && SERVICE_HOSTS.has(host[0] ?? "")) ? host.at(-2) : undefined;
  return services.find((s) => {
    if (s.label === "Email") return false;
    const names = s.names.map((n) => wordsIn(n).toLowerCase());
    return (
      (isKey && names.some((n) => name.includes(n))) ||
      (domain !== undefined && names.includes(`_${domain}_`)) ||
      says.includes(wordsIn(s.label))
    );
  });
}

/**
 * The key is already the agent's: one a person gave or still has to answer (a refused one is replaced under its name),
 * or one in the Vault. Any key the workspace holds under that name counts: the card stays the way to replace it, and
 * `run_code`'s `keys` says whether this run may use it.
 */
async function holdsKey(ctx: ToolContext, name: string) {
  const { secretRequests: s, vaultItems: v } = schema;
  const [given] = await ctx.db
    .select({ id: s.id })
    .from(s)
    .where(
      and(
        eq(s.orgId, ctx.orgId),
        eq(s.agentId, ctx.agentId),
        eq(s.name, name),
        or(
          and(eq(s.status, "pending"), gt(s.expiresAt, sql`now()`)),
          and(eq(s.status, "delivered"), isNull(s.removedAt), secretStillHeld()),
        ),
      ),
    )
    .limit(1);
  if (given) return true;
  const [saved] = await ctx.db
    .select({ id: v.id })
    .from(v)
    .where(and(eq(v.orgId, ctx.orgId), eq(v.kind, "key"), eq(v.keyName, name), eq(v.missing, false)))
    .limit(1);
  return saved !== undefined;
}

/** Whether a person wrote these words here: what an agent says a person told it is checked, never taken on its word. */
async function personSaid(ctx: ToolContext, words: string) {
  const said = squeezed(words);
  if (said.length < 2) return false;
  const { messages } = schema;
  const rows = await ctx.db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, ctx.orgId),
        eq(messages.channelId, ctx.channelId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(PEOPLE_MESSAGES_READ);
  return rows.some((r) => squeezed(r.body).includes(said));
}

const listed = (tools: ToolDefinition[]) =>
  `${tools
    .slice(0, TOOLS_NAMED)
    .map((t) => t.name)
    .join(", ")}${tools.length > TOOLS_NAMED ? "…" : ""}`;

/** The right way to what the key (or the browser: `instead`) was for, by how the agent stands with the service. */
async function wayIn(
  ctx: ToolContext,
  service: ConnectorState,
  usable: ToolDefinition[],
  all: ToolDefinition[],
  instead = "a key",
) {
  const { label, state } = service;
  const ofService = (t: ToolDefinition) => Boolean(t.connectionId && service.connectionIds.includes(t.connectionId));
  const has = (name: string) => usable.some((t) => t.name === name);
  if (state === "usable") {
    const mine = usable.filter(ofService);
    const names = new Set(mine.map((t) => t.name));
    const lacking = all.filter((t) => ofService(t) && !names.has(t.name));
    const more = lacking.length
      ? ` If you need what you lack (${listed(lacking)}), say so: an admin gives it on your page, in Tools and access (in Portuguese, Ferramentas e acesso).`
      : "";
    return `${label} is connected and you have its tools (${listed(mine)}): use them, not ${instead}.${more}`;
  }
  if (state === "not_given" && has(REQUEST_PERMISSION_TOOL)) {
    const permission = (await missingPermissions(ctx)).find((m) =>
      service.connectionIds.includes(m.connectionId ?? ""),
    );
    if (permission) {
      return `${label} is connected in this workspace but not given to you: ask for it with ${REQUEST_PERMISSION_TOOL} (permission "${permission.id}"), not for ${instead}.`;
    }
  }
  if (state === "not_connected" && has(OFFER_CONNECT_APP_TOOL)) {
    return `${label} isn't connected in this workspace: offer it with ${OFFER_CONNECT_APP_TOOL} (app "${label}"), not ${instead}.`;
  }
  return `${label}: ${HOW_TO_GET[state](label)} Tell the person this instead of asking for ${instead}.`;
}

/**
 * A `request_secret` for a service we connect natively: the one line that replaces the card (the way in, and how a
 * person's own word still gets a key), or null for the card. What no connection can give here (`soon`, `unavailable`),
 * a one-time code finishing a sign-in, a project's own file (`.env`, `.npmrc`: its keys are the app's, not the agent's
 * access) and a key the agent already holds always go on.
 */
export async function connectorFirst(
  ctx: ToolContext,
  catalog: ServerCatalog,
  input: Record<string, unknown>,
  said: string,
  tools: { usable: ToolDefinition[]; all: ToolDefinition[] },
): Promise<string | null> {
  if (input.code !== undefined || input.target === "file") return null;
  const person = await ownerOnlyPerson(ctx);
  const states = await connectorStates(ctx.db, ctx.orgId, catalog, { usable: tools.usable, listed: tools.all }, person);
  const service = serviceAsked(input, states);
  if (!service || service.state === "soon" || service.state === "unavailable") return null;
  if (await holdsKey(ctx, str(input.name))) return null;
  if (said && (await personSaid(ctx, said))) return null;
  const way = await wayIn(ctx, service, tools.usable, tools.all);
  const unheard = said ? "`person_said` isn't what a person wrote here. " : "";
  return `${unheard}${way} Only if a person told you to use a key or password: call ${REQUEST_SECRET_TOOL} again with \`person_said\`, their exact words from this conversation. A key an app of theirs reads goes in its file (\`target\` file).`;
}

/** `browserFirst`'s answer code: a run step's `data.code`, how the next open in the conversation knows it was said. */
export const BROWSER_CONNECTOR_FIRST = "browser.connector_first";
/** How long one suggestion stands in a conversation: a person who chose the browser isn't asked again before that. */
const SUGGESTED_FOR = "7 days";

/** The addresses a browser call opens: `browser_open`'s, a `browser_do`'s `open` steps', a new tab's. */
export function browserOpens(name: string, input: Record<string, unknown>): string[] {
  if (name === "browser_open") return [str(input.url)];
  if (name === "browser_tabs" && input.action === "open") return [str(input.url)];
  if (name !== "browser_do" || !Array.isArray(input.steps)) return [];
  return input.steps.flatMap((s) => (s && typeof s === "object" && s.do === "open" ? [str(s.url)] : []));
}

/** Whether this agent already heard, in this conversation, of a connector for this site. */
async function suggestedHere(ctx: ToolContext, connector: string) {
  const { agentRuns: r, agentRunSteps: st } = schema;
  const [hit] = await ctx.db
    .select({ id: st.id })
    .from(st)
    .innerJoin(r, eq(r.id, st.runId))
    .where(
      and(
        eq(r.orgId, ctx.orgId),
        eq(r.agentId, ctx.agentId),
        eq(r.channelId, ctx.channelId),
        sql`${r.createdAt} > now() - ${SUGGESTED_FOR}::interval`,
        eq(st.orgId, ctx.orgId),
        eq(st.kind, "tool_result"),
        sql`${st.data}->'data'->>'code' = ${BROWSER_CONNECTOR_FIRST}`,
        sql`${st.data}->'data'->'connectors' ? ${connector}`,
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/**
 * A browser call to a page of a service we connect natively (Meta's Ads Manager, X): the first time in a conversation,
 * nothing opens and the agent hears the better way, to suggest in one line (the connect card) before going on. It is
 * a suggestion: opening the page again opens it, so a person who'd rather use the browser gets it. Null: open it.
 */
export async function browserFirst(
  ctx: ToolContext,
  catalog: ServerCatalog,
  urls: string[],
  tools: { usable: ToolDefinition[]; all: ToolDefinition[] },
): Promise<{ content: string; connectors: string[] } | null> {
  const ids = [...new Set(urls.flatMap(connectorsForUrl))];
  if (ids.length === 0) return null;
  const person = await ownerOnlyPerson(ctx);
  const states = await connectorStates(ctx.db, ctx.orgId, catalog, { usable: tools.usable, listed: tools.all }, person);
  const services = states.filter(
    (s) => s.state !== "soon" && s.state !== "unavailable" && ids.some((id) => s.names.includes(id)),
  );
  if (services.length === 0) return null;
  const connectors = ids.filter((id) => services.some((s) => s.names.includes(id)));
  const fresh = [];
  for (const id of connectors) if (!(await suggestedHere(ctx, id))) fresh.push(id);
  if (fresh.length === 0) return null;
  const ways = await Promise.all(services.map((s) => wayIn(ctx, s, tools.usable, tools.all, "the browser")));
  return {
    connectors,
    content: `Not opened yet: this site has an app connector here, which works without signing in to the site in your browser. ${ways.join(" ")} Before going on, suggest it to the person in one short line, with its card when you can offer one, and let them choose: it is a suggestion, never a reason to refuse. If they already said to use the browser, or say so now, or nobody is here to ask, open the page again: it opens.`,
  };
}
