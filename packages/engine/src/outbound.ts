import {
  normalizeUrl,
  type OutboundCode,
  outboundUrlProblem,
  TextPrints,
  urlCopiesPrivateText,
  urlsIn,
} from "@agenteschat/adapters";
import { and, desc, eq, gt, inArray, isNull, not, or, schema, sql } from "@agenteschat/db";
import type { ToolContext, ToolOutput } from "./tools/types";
import { IMAGE_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./web-tools";

const THREAD_LIMIT = 500;
const CHANNEL_LIMIT = 50;
const CACHED_RUNS = 200;
/**
 * Bytes of fingerprints (`TextPrints`) the cache holds at most, across runs. Past it the least recently used runs go;
 * their next check reads their stored steps again, as an evicted run's always did.
 */
export const CACHED_BYTES = 32 * 1024 * 1024;
/**
 * Bytes of fingerprints of what one run read from private data: at full precision about 2 M characters of random data,
 * many more of prose, which repeats. A run that reads more keeps every read checked, at the cost of refusing more
 * addresses wrongly (`TextPrints`).
 */
export const RUN_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunReads {
  seq: number;
  seen: Set<string>;
  privateText: TextPrints;
  /** What the agent wrote to its browser: where it can make a page or a tool's answer show any address. */
  written: TextPrints;
  names: Map<string, string>;
  /** Null: a call outside a stored run, never cached. */
  runId: string | null;
}

const bytesOf = (reads: RunReads) => reads.privateText.bytes + reads.written.bytes;

/** Per run, what its steps added so far: each check reads only the steps since the last one. Least recently used first. */
const cache = new Map<string, RunReads>();
let cachedBytes = 0;

const evict = (runId: string) => {
  const reads = cache.get(runId);
  if (reads) cachedBytes -= bytesOf(reads);
  cache.delete(runId);
};

/** Bytes `addResult` and `addWritten` just added to a run: past `CACHED_BYTES`, the least recently used runs go. */
function grew(reads: RunReads, bytes: number) {
  // Evicted meanwhile (or never cached): it holds nothing the cache counts.
  if (bytes === 0 || !reads.runId || cache.get(reads.runId) !== reads) return;
  cachedBytes += bytes;
  for (const oldest of cache.keys()) {
    if (cachedBytes <= CACHED_BYTES) break;
    evict(oldest);
  }
}

/** Whether this process holds reads of the run (`forgetRunReads`). */
export const holdsRunReads = (runId: string) => cache.has(runId);

/**
 * Drops a run's reads: one that ended (done, failed, canceled) never checks an address again. A run that parked (an
 * approval, its computer, a plan's limit) keeps them for when it goes on.
 */
export const forgetRunReads = (runId: string) => evict(runId);

/** Tests: the runs the cache holds, least recently used first, their bytes, and one run's. */
export const outboundCached = (runId?: string) => {
  const run = runId ? cache.get(runId) : undefined;
  return { runs: [...cache.keys()], bytes: cachedBytes, run: run ? bytesOf(run) : 0 };
};

/**
 * `outboundUrlProblem` with what this run knows (ADR 0117): `seen` is every address in the conversation (the
 * thread, the channel's latest messages) and in this run's tool results; `privateText` every tool result of the
 * run except the public web's. Null: the agent may open it.
 */
export async function checkOutboundUrl(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
  url: string,
): Promise<{ code: OutboundCode; message: string } | null> {
  const reads = await runReads(ctx);
  const seen = reads.seen;
  // The cheap checks first: a plain address needs no conversation.
  if (!outboundUrlProblem(url, { privateText: reads.privateText })) return null;
  for (const u of await conversationUrls(ctx)) seen.add(u);
  return outboundUrlProblem(url, { seen: (u) => seen.has(u), privateText: reads.privateText });
}

/** `checkOutboundUrl` as a tool's refusal (its code in `data.code`, final for the continuation), null to go on. */
export async function outboundRefusal(
  ctx: Parameters<typeof checkOutboundUrl>[0],
  url: string,
): Promise<ToolOutput | null> {
  const problem = await checkOutboundUrl(ctx, url);
  return problem ? { content: problem.message, isError: true, data: { code: problem.code, url } } : null;
}

const emptyReads = (runId: string | null = null): RunReads => ({
  runId,
  seq: -1,
  seen: new Set(),
  privateText: new TextPrints(RUN_BYTES),
  written: new TextPrints(RUN_BYTES / 8),
  names: new Map(),
});

function cachedReads(runId: string): RunReads {
  let reads = cache.get(runId);
  if (reads) {
    // Used again: the newest, the last to go.
    cache.delete(runId);
    cache.set(runId, reads);
    return reads;
  }
  reads = emptyReads(runId);
  if (cache.size >= CACHED_RUNS) evict(cache.keys().next().value as string);
  cache.set(runId, reads);
  return reads;
}

/**
 * Where the run's browser is, as the browser says it in a browser tool's result; a refusal's `data.url` is only what
 * was asked. Nothing the agent wrote gets here: it reaches an address by `outboundRefusal` or by the page's own doing.
 */
function browserPage(tool: string, data: unknown): string | null {
  const d = data as { url?: unknown; code?: unknown } | null | undefined;
  if (!tool.startsWith("browser_") || typeof d?.url !== "string" || d.code !== undefined) return null;
  return normalizeUrl(d.url);
}

/**
 * One tool result into what the run read. A private result's address that copies text the run read before is no
 * seen address: the agent made it (printed by run_code, echoed by any tool), so it gets the full check. The page the
 * browser is on is the exception, with the addresses that page shows on its own site: that server already has what
 * they carry, so going back sends nothing new. Unless the agent wrote that text to the browser itself: a tool's answer
 * repeats what it was asked (`find`, a target) beside the page, and a field shows what was typed in it, and neither
 * came from the server.
 */
function addResult(reads: RunReads, tool: string, content: string, data?: unknown) {
  const web = tool === WEB_SEARCH_TOOL || tool === WEB_FETCH_TOOL || tool === IMAGE_SEARCH_TOOL;
  const page = browserPage(tool, data);
  if (page) reads.seen.add(page);
  const site = page && new URL(page).host;
  for (const u of urlsIn(content)) {
    const own = site !== null && new URL(u).host === site && !urlCopiesPrivateText(u, reads.written);
    if (web || own || reads.seen.has(u) || !urlCopiesPrivateText(u, reads.privateText)) reads.seen.add(u);
  }
  // The public web's results are no private text.
  if (web) return;
  const before = reads.privateText.bytes;
  reads.privateText.add(content);
  grew(reads, reads.privateText.bytes - before);
}

const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(stringsIn)
      : [];

/** A browser tool's input as `written`: its text, and what its addresses carry decoded, as an address is compared. */
function addWritten(reads: RunReads, tool: string, input: unknown) {
  if (!tool.startsWith("browser_")) return;
  for (const text of stringsIn(input)) {
    const before = reads.written.bytes;
    for (const added of [text, ...urlsIn(text).map((u) => [...new URL(u).searchParams.values()].join(" "))]) {
      reads.written.add(added);
    }
    grew(reads, reads.written.bytes - before);
  }
}

/**
 * A tool's whole output, as the model got it: run steps keep only its first 4000 characters, and the check must
 * see all of it. Called by the gateway for each result of a stored run, with the call's input.
 */
export function recordRead(runId: string, tool: string, content: string, data?: unknown, input?: unknown) {
  if (!UUID.test(runId)) return;
  const reads = cachedReads(runId);
  addWritten(reads, tool, input);
  addResult(reads, tool, content, data);
}

async function runReads(ctx: Pick<ToolContext, "db" | "orgId" | "runId">): Promise<RunReads> {
  // A call outside a stored run (a test's bare context) has no reads.
  if (!UUID.test(ctx.runId)) return emptyReads();
  const reads = cachedReads(ctx.runId);
  const steps = await ctx.db
    .select({ seq: schema.agentRunSteps.seq, kind: schema.agentRunSteps.kind, data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, ctx.orgId),
        eq(schema.agentRunSteps.runId, ctx.runId),
        inArray(schema.agentRunSteps.kind, ["tool_call", "tool_result"]),
        gt(schema.agentRunSteps.seq, reads.seq),
      ),
    )
    .orderBy(schema.agentRunSteps.seq);
  for (const { seq, kind, data } of steps) {
    reads.seq = Math.max(reads.seq, seq);
    const id = typeof data.toolUseId === "string" ? data.toolUseId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (kind === "tool_call") {
      if (id) reads.names.set(id, name);
      addWritten(reads, name, data.input);
      continue;
    }
    addResult(reads, reads.names.get(id) ?? name, String(data.content ?? ""), data.data);
  }
  return reads;
}

/**
 * Addresses people and agents wrote where this run answers: its thread, and the channel's latest messages. What
 * this agent posted since the run started is left out: an address it posted itself is no seen address.
 */
async function conversationUrls(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
): Promise<string[]> {
  const m = schema.messages;
  const ids = [ctx.threadRootId, ctx.triggerMessageId].filter((id) => UUID.test(id));
  if (!UUID.test(ctx.channelId)) return [];
  const own = UUID.test(ctx.runId)
    ? sql`(${m.authorAgentId} is not distinct from ${ctx.agentId} and ${m.createdAt} >= (select ${schema.agentRuns.createdAt} from ${schema.agentRuns} where ${schema.agentRuns.id} = ${ctx.runId}))`
    : sql`false`;
  const scope = and(eq(m.orgId, ctx.orgId), eq(m.channelId, ctx.channelId), isNull(m.deletedAt), not(own));
  const [thread, recent] = await Promise.all([
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, ids.length > 0 ? or(inArray(m.threadId, ids), inArray(m.id, ids)) : sql`false`))
      .orderBy(desc(m.createdAt))
      .limit(THREAD_LIMIT),
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, isNull(m.threadId)))
      .orderBy(desc(m.createdAt))
      .limit(CHANNEL_LIMIT),
  ]);
  return [...thread, ...recent].flatMap((r) => urlsIn(r.body));
}
