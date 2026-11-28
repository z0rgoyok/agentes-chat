/**
 * Ask kinds eval (ADR 0254): does Jev read what a person's message asks of an agent (`judgeAskKind`, at
 * `ASK_KIND_SURE`) as the kind of work it is: small talk, a question it can answer, a lookup, one action, a task of
 * minutes, or long work? Cases in Portuguese, English, Spanish, German, Japanese and Arabic, written for this eval, a
 * few with what was said before (a short go-ahead asks for the work discussed). Its kinds set the target each reply is
 * timed against, so a near miss costs less than a far one: it passes when 75% are exactly right and 95% land within one
 * kind of the right one (`ASK_KINDS` is ordered from the lightest to the heaviest work), with no answer below the bar.
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/ask-kinds.ts
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production).
 */
import { ASK_KINDS, type AskKind, judgeAskKind } from "../src/asks";
import { createJevJudge } from "../src/judge";

type Case = [message: string, kind: AskKind, recent?: string[]];

const CASES: Case[] = [
  ["oi", "chat"],
  ["bom dia!", "chat"],
  ["valeu, ficou ótimo", "chat"],
  ["thanks!", "chat"],
  ["ok 👍", "chat"],
  ["¡hola! ¿qué tal?", "chat"],
  ["こんにちは", "chat"],
  ["شكرا جزيلا", "chat"],
  ["qual a diferença entre CPF e CNPJ?", "question"],
  ["what does idempotent mean?", "question"],
  ["como se diz 'prazo' em inglês?", "question"],
  ["¿cuál es la capital de Australia?", "question"],
  ["Was ist der Unterschied zwischen TCP und UDP?", "question"],
  ["você lembra o que a gente decidiu ontem sobre o preço?", "question", ["Ana: fechamos o plano em R$ 49"]],
  ["qual o status do pedido 4512?", "lookup"],
  ["tem alguma reunião minha amanhã de manhã?", "lookup"],
  ["is the CI on main green?", "lookup"],
  ["acha o contrato da Acme no Drive", "lookup"],
  ["¿cuántos usuarios se registraron ayer?", "lookup"],
  ["今日のサーバーのエラーログを確認して", "lookup"],
  ["manda um e-mail pro João dizendo que a reunião mudou pras 15h", "action"],
  ["cria uma issue: o login quebra no Safari", "action"],
  ["schedule a call with Marina on Friday at 10", "action"],
  ["agenda um lembrete pra pagar o boleto amanhã às 9h", "action"],
  ["Bitte schick dem Team den Link zum Dokument", "action"],
  ["أرسل الفاتورة إلى العميل", "action"],
  ["monta um relatório de vendas de outubro com gráfico por região", "task"],
  ["pesquisa os 5 principais concorrentes e compara os preços numa tabela", "task"],
  ["fix the failing login test and open a PR", "task"],
  ["escreve um post pro blog sobre o lançamento, com 3 opções de título", "task"],
  ["analiza las reseñas de este mes y resume las quejas principales", "task"],
  [
    "sim, pode fazer",
    "task",
    ["Ada: Posso montar a planilha de custos do trimestre a partir das notas fiscais. Quer?"],
  ],
  ["migra o banco de usuários pro Postgres novo, sem downtime", "project"],
  ["implementa o checkout com Stripe no app, do zero", "project"],
  ["cuida do onboarding dos clientes novos daqui pra frente, toda semana", "project"],
  ["rewrite the billing service in Go and roll it out", "project"],
];

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("TYPESAFE_API_KEY is needed (Jev).");
  process.exit(1);
}
const judge = createJevJudge({ key, gateway: { recordExternalUsage: async () => null }, timeoutMs: 10_000 });
const agent = { name: "Ada", role: "Assistente da equipe", instructions: "Ajuda o time no que for preciso." };
const rank = (k: AskKind | null) => (k ? ASK_KINDS.indexOf(k) : -10);

const results = await Promise.all(
  CASES.map(async ([message, want, recent = []]) => {
    const read = await judgeAskKind(judge, { orgId: "eval", agentId: "eval", runId: "eval", agent, message, recent });
    return { message, want, got: read?.kind ?? null, p: read?.p ?? null };
  }),
);
for (const r of results) {
  const mark = r.got === r.want ? "ok  " : Math.abs(rank(r.got) - rank(r.want)) <= 1 ? "near" : "MISS";
  console.log(`${mark} ${r.want.padEnd(8)} ${String(r.got).padEnd(8)} ${r.p?.toFixed(2) ?? "-   "}  ${r.message}`);
}
const exact = results.filter((r) => r.got === r.want).length / results.length;
const near = results.filter((r) => Math.abs(rank(r.got) - rank(r.want)) <= 1).length / results.length;
const unsure = results.filter((r) => r.got === null).length;
console.log(`\nexact ${(exact * 100).toFixed(0)}%, within one kind ${(near * 100).toFixed(0)}%, unsure ${unsure}`);
const pass = exact >= 0.75 && near >= 0.95 && unsure === 0;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
