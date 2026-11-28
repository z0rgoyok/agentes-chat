/**
 * What a Claude Code turn of a DM "oi" sends, by part: the system text the runner appends (by section), the parts
 * that go once per session or per turn, and our MCP tools as Claude Code lists them (`ALWAYS_LOADED` schemas whole,
 * the rest by name behind ToolSearch). Offline: the turns eval's world (every production tool source, fake model).
 * Characters are exact; tokens are estimated at 3.6 characters each unless `--count` asks Anthropic's
 * count_tokens endpoint (needs ANTHROPIC_API_KEY).
 *
 *   bun apps/server/scripts/speed-budget.ts [--count] [--json]
 */
import { parseArgs } from "node:util";
import { eq, schema } from "@agenteschat/db";
import { drainOutbox, isComputerTurnBlock, isConversationBlock, postPersonMessage } from "@agenteschat/engine";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import { placeOf, TURNS, turnsWorld } from "../../../packages/engine/eval/turns";
import { ALWAYS_LOADED } from "../runner/mcp";

const { values } = parseArgs({ options: { count: { type: "boolean" }, json: { type: "boolean" } } });
const key = process.env.ANTHROPIC_API_KEY;
if (values.count && !key) {
  console.error("--count needs ANTHROPIC_API_KEY");
  process.exit(2);
}

async function tokens(text: string): Promise<number> {
  if (!values.count || !key) return Math.round(text.length / 3.6);
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: text || "." }] }),
  });
  if (!res.ok) throw new Error(`count_tokens: ${res.status}`);
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

const turn = TURNS.find((t) => t.id === "greet-dm");
if (!turn) throw new Error("the turns eval has no greet-dm");
const world = await turnsWorld({ reply: () => ({ chunks: ["Oi!"] }) });
try {
  const { channelId, body } = placeOf(world, turn);
  await postPersonMessage({ db: world.db, pubsub: world.pubsub }, world.owner.id, world.org.id, channelId, { body });
  await drainOutbox(world.db, world.handlers);
  const request = world.provider.calls
    .map((c) => c.request)
    .find((r: ModelRequest) => (r.tools?.length ?? 0) > 0 && systemText(r.system).includes("(@dev)"));
  if (!request) throw new Error("the agent made no call");
  const [run] = await world.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, world.org.id));
  const blocks = ((run?.transcript as { system?: unknown } | null)?.system ?? []) as Parameters<
    typeof isComputerTurnBlock
  >[0][];
  const part = (b: (typeof blocks)[number]) =>
    isComputerTurnBlock(b) ? "this turn" : isConversationBlock(b) ? "conversation" : "system (agent)";
  const rows: { part: string; section: string; chars: number; tokens: number }[] = [];
  for (const b of blocks) {
    // A block may hold several sections: each "# " heading is its own row.
    for (const s of b.text.split(/\n(?=# )/)) {
      const section = /^#+ (.+)$/m.exec(s)?.[1]?.slice(0, 60) ?? "(untitled)";
      rows.push({ part: part(b), section, chars: s.length, tokens: await tokens(s) });
    }
  }
  // Our MCP tools as Claude Code reads them: always-loaded ones whole, the rest as a name in its deferred list (the
  // API brain's up-front list stands in for the run's grants: a real run's bridge serves every granted tool).
  const all = request.tools ?? [];
  const def = (t: { name: string; description: string; inputSchema: unknown }) =>
    JSON.stringify({ name: `mcp__agentes__${t.name}`, description: t.description, input_schema: t.inputSchema });
  const loaded = all.filter((t) => ALWAYS_LOADED.has(t.name));
  const deferred = all.filter((t) => !ALWAYS_LOADED.has(t.name));
  const loadedText = loaded.map(def).join("\n");
  const deferredText = deferred.map((t) => `mcp__agentes__${t.name}`).join("\n");
  const toolRows = [
    {
      part: "tools",
      section: `always loaded (${loaded.length})`,
      chars: loadedText.length,
      tokens: await tokens(loadedText),
    },
    {
      part: "tools",
      section: `deferred by name, of the up-front list (${deferred.length})`,
      chars: deferredText.length,
      tokens: await tokens(deferredText),
    },
    ...loaded
      .map((t) => ({ part: "tool", section: t.name, chars: def(t).length, tokens: Math.round(def(t).length / 3.6) }))
      .sort((a, b) => b.chars - a.chars),
  ];
  if (values.json) console.log(JSON.stringify({ rows, toolRows }, null, 2));
  else {
    const line = (r: { part: string; section: string; chars: number; tokens: number }) =>
      `${r.part.padEnd(16)} ${r.section.padEnd(62)} ${String(r.chars).padStart(7)} ${String(r.tokens).padStart(7)}`;
    console.log(`${"part".padEnd(16)} ${"section".padEnd(62)} ${"chars".padStart(7)} ${"tokens".padStart(7)}`);
    for (const r of rows) console.log(line(r));
    for (const p of ["system (agent)", "conversation", "this turn"]) {
      const g = rows.filter((r) => r.part === p);
      console.log(
        line({
          part: p,
          section: "= total",
          chars: g.reduce((n, r) => n + r.chars, 0),
          tokens: g.reduce((n, r) => n + r.tokens, 0),
        }),
      );
    }
    for (const r of toolRows) console.log(line(r));
  }
} finally {
  await world.close();
}
