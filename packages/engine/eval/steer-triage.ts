/**
 * Triage eval (ADR 0112 addendum of 2026-11-18): a person writes to an agent in the middle of a task they asked for;
 * does the production judgment (`steerHandling`, at `STEER_SURE`) take the message the right way: stop the task, read a
 * correction now, fold a detail in at the next pause, answer a quick question at once, or leave a separate request for
 * after the task? In a channel others share (addendum of 2026-11-19), a line may also be for someone else
 * (`elsewhere`, at `ELSEWHERE_SURE`): the person who asked turns to a colleague, or people talk among themselves. Cases
 * in Portuguese and English, written for this eval. It passes when 90% are right, every stop is caught, nothing else is
 * ever taken for a stop, no line for the agent is ever taken for someone else's, and 80% of the lines for someone else
 * are.
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/steer-triage.ts [--judge jev|llm]
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production) or `ANTHROPIC_API_KEY` for the LLM fallback (`EVAL_LLM_MODEL`,
 * default claude-haiku-5-5).
 */
import { createAnthropicProvider } from "@agenteschat/providers";
import { createJevJudge, createLlmJudge, type Judge, type SteerHandling, steerHandling } from "../src/judge";

const REPORT = "Gerar o relatório de vendas de outubro em PDF";
const BUG = "Corrigir o bug do login no repositório app-web";
const EMAIL = "Escrever um e-mail pro cliente Acme cobrando o pagamento atrasado";
const MIGRATE = "Migrar a tabela de usuários pro Postgres novo";
const FLIGHTS = "Pesquisar voos pra Lisboa na segunda semana de dezembro";
const DEPLOY = "Fazer o deploy da branch feature/pagamentos em produção";
const CONTRACT = "Resumir o contrato de prestação de serviços da Acme";
const COSTS = "Montar a planilha de custos do trimestre";
const AUTH = "Refactor the auth module to use the new token service";
const NOTES = "Write the release notes for v2.3";
const MEETING = "Organizar a reunião de planejamento com o time de vendas";
const DECK = "Montar a apresentação do resultado do trimestre pro board";

const CASES: [task: string, message: string, way: SteerHandling][] = [
  [REPORT, "para", "stop"],
  [REPORT, "deixa, não precisa mais", "stop"],
  [BUG, "cancela isso", "stop"],
  [FLIGHTS, "pode parar, já comprei aqui", "stop"],
  [CONTRACT, "esquece esse resumo", "stop"],
  [AUTH, "stop", "stop"],
  [DEPLOY, "não faz isso não, para agora", "stop"],
  [COSTS, "chega por hoje, deixa pra amanhã", "stop"],
  [BUG, "na verdade o bug é no app-mobile, não no web", "interrupt"],
  [REPORT, "não é outubro, é setembro", "interrupt"],
  [EMAIL, "não manda pro cliente, manda pro financeiro deles", "interrupt"],
  [MIGRATE, "usa a v2 do schema, a v1 tá errada", "interrupt"],
  [FLIGHTS, "muda pra Madri", "interrupt"],
  [DEPLOY, "espera, é a branch main, não a feature", "interrupt"],
  [CONTRACT, "esse é o contrato errado, o certo é o da Beta Corp", "interrupt"],
  [COSTS, "faz em reais, não em dólar", "interrupt"],
  [AUTH, "actually don't touch auth, the problem is in the session store", "interrupt"],
  [REPORT, "larga o relatório e vê o deploy que caiu agora", "interrupt"],
  [BUG, "urgente: o site saiu do ar", "interrupt"],
  [REPORT, "inclui o gráfico por região também", "add"],
  [EMAIL, "coloca o número da nota fiscal: 4512", "add"],
  [FLIGHTS, "prefiro voo direto, se tiver", "add"],
  [BUG, "o erro aparece só no Safari, se ajudar", "add"],
  [COSTS, "a conta de luz do trimestre foi R$ 820", "add"],
  [MEETING, "chama a Marina também", "add"],
  [DEPLOY, "depois do deploy roda as migrations", "add"],
  [CONTRACT, "foca nas cláusulas de multa", "add"],
  [NOTES, "also mention the new dark mode", "add"],
  [DECK, "usa o logo novo que tá no Drive", "add"],
  [REPORT, "oi", "answer"],
  [BUG, "tudo bem?", "answer"],
  [MIGRATE, "tá funcionando?", "answer"],
  [DEPLOY, "quanto falta?", "answer"],
  [FLIGHTS, "já terminou?", "answer"],
  [COSTS, "valeu!", "answer"],
  [CONTRACT, "como tá indo?", "answer"],
  [BUG, "você conseguiu acessar o repositório?", "answer"],
  [FLIGHTS, "achou alguma coisa até agora?", "answer"],
  [REPORT, "beleza, sem pressa", "answer"],
  [AUTH, "how's it going?", "answer"],
  [MEETING, "tá aí?", "answer"],
  [EMAIL, "qual a capital da Austrália?", "answer"],
  [REPORT, "depois vê por que o deploy de ontem falhou", "queue"],
  [BUG, "me lembra de pagar o boleto amanhã às 9h", "queue"],
  [FLIGHTS, "aproveita e depois reserva um restaurante pra sexta", "queue"],
  [COSTS, "manda um resumo da reunião de ontem pro time", "queue"],
  [DEPLOY, "também preciso que você revise o PR 231", "queue"],
  [CONTRACT, "agenda uma call com o jurídico na quinta", "queue"],
  [REPORT, "cria uma conta no Figma pra Marina", "queue"],
  [AUTH, "when you're done, can you update the README?", "queue"],
  [MEETING, "e vê o preço do iPhone 17 pra mim", "queue"],
  [DECK, "quando terminar, traduz a apresentação pra inglês", "queue"],
];

/**
 * In a channel others share, written by the person who asked (`fromAsker`) or by someone else there: lines for someone
 * else, and lines for the agent that name a person or sound like chat, which must stay the agent's.
 */
const CHANNEL_CASES: [task: string, message: string, fromAsker: boolean, way: SteerHandling][] = [
  [REPORT, "Maria, você viu o e-mail do cliente?", true, "elsewhere"],
  [BUG, "@joao consegue revisar meu PR depois?", true, "elsewhere"],
  [FLIGHTS, "Pedro, já reservou o hotel?", true, "elsewhere"],
  [DEPLOY, "Bruno, tô entrando na call em 2 min", true, "elsewhere"],
  [COSTS, "pessoal, almoço hoje às 13h?", true, "elsewhere"],
  [MEETING, "kkkkkk boa, Ana", false, "elsewhere"],
  [CONTRACT, "Carla, você fica com o cliente Beta essa semana?", false, "elsewhere"],
  [EMAIL, "bom dia, time!", false, "elsewhere"],
  [AUTH, "@sara can you take the on-call tonight?", true, "elsewhere"],
  [NOTES, "thanks Mike, that fixed it", false, "elsewhere"],
  [REPORT, "inclui o gráfico por região também", true, "add"],
  [MEETING, "chama a Marina também", true, "add"],
  [EMAIL, "manda com cópia pro Pedro", true, "add"],
  [FLIGHTS, "a Ana vai junto, então são duas passagens", true, "add"],
  [BUG, "na verdade o bug é no app-mobile, não no web", true, "interrupt"],
  [REPORT, "para", true, "stop"],
  [FLIGHTS, "já terminou?", true, "answer"],
  [COSTS, "valeu, Alf!", true, "answer"],
  [DECK, "Alf, tá aí?", true, "answer"],
  [REPORT, "Alf, depois vê por que o deploy de ontem falhou", true, "queue"],
];

const ORG = "00000000-0000-0000-0000-000000000000";
const which = process.argv.includes("--judge") ? process.argv[process.argv.indexOf("--judge") + 1] : "jev";
const noUsage = { recordExternalUsage: async () => null };

let judge: Judge;
if (which === "jev") {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is missing (or run with --judge llm)");
  judge = createJevJudge({ key: apiKey, gateway: noUsage, timeoutMs: 10_000 });
} else {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
  const provider = createAnthropicProvider();
  const model = process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5";
  judge = createLlmJudge({
    gateway: {
      complete: (async (call: Parameters<typeof provider.stream>[0]) =>
        provider.stream(call, { apiKey, onDelta: () => {} })) as never,
    },
    resolveModel: async () => model,
  });
}

const WAYS: SteerHandling[] = ["stop", "interrupt", "add", "answer", "queue", "elsewhere"];
const rows = await Promise.all([
  ...CASES.map(async ([task, text, want]) => ({
    task,
    text,
    want,
    got: await steerHandling(judge, { orgId: ORG, text, agentName: "Alf", task }),
  })),
  ...CHANNEL_CASES.map(async ([task, text, fromAsker, want]) => ({
    task,
    text: `[channel] ${text}`,
    want,
    got: await steerHandling(judge, { orgId: ORG, text, agentName: "Alf", task, shared: { fromAsker } }),
  })),
]);
const confusion = new Map<string, number>();
for (const r of rows) {
  const key = `${r.want}>${r.got}`;
  confusion.set(key, (confusion.get(key) ?? 0) + 1);
  console.log(`${r.got === r.want ? "PASS" : "FAIL"}  ${r.want.padEnd(9)} → ${r.got.padEnd(9)}  ${r.text}`);
}
console.log(`\n${"".padEnd(10)}${WAYS.map((w) => w.padStart(10)).join("")}   (row: expected, column: taken)`);
for (const want of WAYS)
  console.log(
    `${want.padEnd(10)}${WAYS.map((got) => String(confusion.get(`${want}>${got}`) ?? 0).padStart(10)).join("")}`,
  );
const right = rows.filter((r) => r.got === r.want).length;
const stopsMissed = rows.filter((r) => r.want === "stop" && r.got !== "stop").length;
const falseStops = rows.filter((r) => r.want !== "stop" && r.got === "stop").length;
// A line for the agent taken for someone else's is never read: the worst mistake here.
const falseElsewhere = rows.filter((r) => r.want !== "elsewhere" && r.got === "elsewhere").length;
const elsewhere = rows.filter((r) => r.want === "elsewhere");
const elsewhereCaught = elsewhere.filter((r) => r.got === "elsewhere").length / elsewhere.length;
const share = right / rows.length;
console.log(
  `\n${right}/${rows.length} right (${Math.round(share * 100)}%), ${stopsMissed} stops missed, ${falseStops} false stops, ${falseElsewhere} lines for the agent taken for someone else's, ${Math.round(elsewhereCaught * 100)}% of the lines for someone else caught`,
);
process.exit(
  share >= 0.9 && stopsMissed === 0 && falseStops === 0 && falseElsewhere === 0 && elsewhereCaught >= 0.8 ? 0 : 1,
);
