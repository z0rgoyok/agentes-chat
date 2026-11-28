/**
 * Live speed probe: posts typical messages to an agent through the public API (an integration app's token, ADR 0251)
 * and times each one from the post to the agent's reply in place, the wait a person feels. The run goes through the
 * real path (router or mention, context, the agent's own brain and model, its computer), on the agent's own plan.
 * An app's message skips the hold for a person still typing; everything after it is the same.
 *
 *   AGENTES_URL=https://… AGENTES_PROBE_TOKEN=agi_… AGENTES_PROBE_CHANNEL=<channel id> \
 *     bun apps/server/scripts/speed-probe.ts --agent dev [--only greeting,lookup] [--repeat 3] [--gap 0] [--json]
 *
 * Make the app in Settings › Integrations with a channel of its own that only the probed agents are in, so nobody is
 * notified. `--gap`: seconds between posts (0 measures warm turns; past 200 the agent's process has closed, so
 * every turn starts cold). Each reply's run is in the operator console by its time (`list_runs`, `get_run_trace`).
 */
import { parseArgs } from "node:util";
import { percentile } from "@agenteschat/engine";

interface ProbeCase {
  id: string;
  text: string;
  /** What a good reply holds: a quick quality check beside the time. */
  expect: RegExp;
}

const CASES: ProbeCase[] = [
  { id: "greeting", text: "oi", expect: /\S/ },
  { id: "quick", text: "Em uma frase: qual a diferença entre um bug e uma regressão?", expect: /regress/i },
  { id: "lookup", text: "Que dia da semana é hoje e que horas são em Tóquio agora?", expect: /\d{1,2}[:h]\d{2}/ },
  {
    id: "task",
    text: "Procure na web as 3 últimas versões estáveis do Bun, com a data de cada uma, e me dê numa tabela.",
    expect: /\|.*\d+\.\d+/,
  },
];

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    gap: { type: "string", default: "0" },
    timeout: { type: "string", default: "600" },
    json: { type: "boolean" },
  },
});
const base = process.env.AGENTES_URL?.replace(/\/$/, "");
const token = process.env.AGENTES_PROBE_TOKEN;
const channel = process.env.AGENTES_PROBE_CHANNEL;
if (!base || !token || !channel || !values.agent) {
  console.error("Needs AGENTES_URL, AGENTES_PROBE_TOKEN, AGENTES_PROBE_CHANNEL and --agent <handle>.");
  process.exit(2);
}
const only = values.only?.split(",");
const cases = CASES.filter((c) => !only || only.includes(c.id));
const repeat = Math.max(1, Number(values.repeat));
const gapMs = Math.max(0, Number(values.gap)) * 1000;
const timeoutMs = Math.max(10, Number(values.timeout)) * 1000;

interface ApiMessage {
  id: string;
  author: { type: string; name: string };
  text: string;
  in_reply_to: string | null;
  created_at: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  for (;;) {
    const res = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (res.status === 429) {
      await Bun.sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/** Posts `text` mentioning the agent and waits for an agent's message answering it. */
async function probe(c: ProbeCase) {
  const posted = await api<{ message: ApiMessage; answering: { agentId: string }[] }>("/messages", {
    method: "POST",
    body: JSON.stringify({ channel_id: channel, text: `@${values.agent} ${c.text}`, sender: "speed probe" }),
  });
  const sentAt = Date.now();
  let after = posted.message.id;
  while (Date.now() - sentAt < timeoutMs) {
    await Bun.sleep(1000);
    const page = await api<{ messages: ApiMessage[] }>(`/messages?channel_id=${channel}&after=${after}&limit=100`);
    const reply = page.messages.find((m) => m.author.type === "agent" && m.in_reply_to === posted.message.id);
    if (reply) {
      // The reply's own time, not when the poll saw it.
      const ms = Date.parse(reply.created_at) - Date.parse(posted.message.created_at);
      return { case: c.id, ms, ok: c.expect.test(reply.text), chars: reply.text.length, replyId: reply.id };
    }
    after = page.messages.at(-1)?.id ?? after;
  }
  return { case: c.id, ms: null, ok: false, chars: 0, replyId: null };
}

const results: Awaited<ReturnType<typeof probe>>[] = [];
for (let n = 0; n < repeat; n++) {
  for (const c of cases) {
    if (results.length > 0 && gapMs > 0) await Bun.sleep(gapMs);
    const r = await probe(c);
    results.push(r);
    if (!values.json)
      console.log(
        `${r.ok ? "OK  " : "MISS"} ${c.id}${repeat > 1 ? ` #${n + 1}` : ""}: ${r.ms === null ? "no reply" : `${(r.ms / 1000).toFixed(1)} s`}, ${r.chars} chars`,
      );
  }
}
const summary = cases.map((c) => {
  const times = results.filter((r) => r.case === c.id && r.ms !== null).map((r) => r.ms as number);
  return {
    case: c.id,
    runs: results.filter((r) => r.case === c.id).length,
    p50: times.length ? percentile(times, 0.5) : null,
    p90: times.length ? percentile(times, 0.9) : null,
    ok: results.filter((r) => r.case === c.id && r.ok).length,
  };
});
if (values.json) console.log(JSON.stringify({ agent: values.agent, gapMs, results, summary }, null, 2));
else
  for (const s of summary)
    console.log(
      `${s.case.padEnd(9)} p50 ${s.p50 === null ? "-" : (s.p50 / 1000).toFixed(1)} s, p90 ${s.p90 === null ? "-" : (s.p90 / 1000).toFixed(1)} s, ${s.ok}/${s.runs} good`,
    );
