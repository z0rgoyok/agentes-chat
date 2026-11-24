import { turnMeans } from "../src";
import { continuationVerdict, decideTurnEnd, RULE_TAG, type TurnKind } from "../src/continuation";
import type { Judge } from "../src/judge";

/**
 * A person's request and the reply an agent ended its turn with, in a conversation: `answered` when the person
 * already has what they need (a complete answer, a plain "I can't, because…" on a rule or a refusal, a question back
 * only they can answer), so no extra turn may follow; `nudged` when the turn left real work undone (a promise with
 * nothing done, a give-up with ways left, a step that only needs the person).
 */
export interface TurnEndCase {
  id: string;
  request: string;
  reply: string;
  tried: string[];
  means: string[];
  want: "answered" | "nudged";
  /** A routine's run or an agents' DM instead of a person's conversation. */
  runKind?: TurnKind;
  /** A routine's record from its last run. */
  previousRecord?: string;
  /** Woken by the notice of a person's decision on its card or of a result it waited on. */
  resultNotice?: true;
}

const WEB = turnMeans(new Set(["web_search", "web_fetch", "run_code", "find_tools", "search_context"]));
const BROWSER = turnMeans(new Set(["web_search", "browser_do", "browser_ask_person", "search_context"]));
const MAIL = turnMeans(new Set(["web_search", "search_context", "mail_search", "mail_read"]));

/** A long run: an artifact saved early, then more reads than the judge is shown. */
const LONG_RUN = [
  "query_db(churn outubro) → 412 rows",
  "run_code(churn rate by plan) → mensal 6.2%, anual 1.1%, total 4.1%",
  "create_artifact(churn-outubro.md) → created in the Drive",
  ...Array.from({ length: 22 }, (_, i) => `read_artifact(nota ${i + 1}) → ok`),
];

export const TURN_END_CASES: TurnEndCase[] = [
  {
    id: "privacy-rule-refusal",
    request: "@lia what is the email of the owner of the Example Co account?",
    reply:
      "I can't get that email. The support tools never return what customers typed, like emails or names: each one comes back as a code. That's a privacy rule built into the tools, so I won't pull the address out some other way. Someone with admin access to the support console can look it up there.",
    tried: ["support_find(example co) → failed: Nothing for that reference."],
    means: WEB,
    want: "answered",
  },
  {
    id: "system-refused-restart",
    request: "@lia reinicia o servidor de testes",
    reply:
      "Não reiniciei: o sistema recusou o pedido porque o servidor está bloqueado para manutenção, e liberar isso é decisão da equipe de infraestrutura. Pedir de novo daqui teria a mesma resposta.",
    tried: ["restart_server(test) → failed: refused: the server is locked for maintenance"],
    means: WEB,
    want: "answered",
  },
  {
    id: "greeting-back",
    request: "@lia bom dia",
    reply: "Bom dia, Marina! Em que posso te ajudar?",
    tried: [],
    means: WEB,
    want: "answered",
  },
  {
    id: "complete-answer",
    request: "@rui quantos clientes ativos temos no plano anual?",
    reply:
      "São 87 clientes ativos no plano anual. A lista tem 88; deixei de fora uma conta de teste. Só li os dados, não mudei nada.",
    tried: ["billing_list_customers(plan: annual) → 88 customers"],
    means: WEB,
    want: "answered",
  },
  {
    id: "which-one-question",
    request: "@ana manda o relatório pro time",
    reply: "Qual dos dois: o de vendas de novembro ou o de churn da semana?",
    tried: ["list_artifacts() → Vendas novembro; Churn semana 47"],
    means: WEB,
    want: "answered",
  },
  {
    id: "promise-nothing-done",
    request: "@otto why is the checkout slow since yesterday?",
    reply: "I'll look at the logs and the last deploy now and tell you what I find.",
    tried: [],
    means: WEB,
    want: "nudged",
  },
  {
    id: "one-empty-search",
    request: "@rui qual cartão sem anuidade o Banco Azul lançou?",
    reply: "Não achei nada sobre isso.",
    tried: ["web_search(banco azul cartão) → (empty)"],
    means: WEB,
    want: "nudged",
  },
  {
    id: "needs-person-qr",
    request: "@rui read my WhatsApp messages and tell me what Bia asked for",
    reply: "I can't read your WhatsApp: the web version needs you to scan a QR code with your phone.",
    tried: [],
    means: BROWSER,
    want: "nudged",
  },
  {
    id: "unbacked-run-code-quoted",
    request: "@ada qual versão do Node está no servidor de build?",
    reply: "É o Node 22.11.0 (rodei `node -v` agora no servidor de build).",
    tried: ["run_code(node -v) → v22.11.0"],
    means: WEB,
    want: "answered",
  },
  {
    id: "unbacked-long-run-cut",
    request: "@ada gera o relatório de churn de outubro e salva no Drive",
    reply: "Salvei o relatório de churn de outubro no Drive: 4,1% no mês, puxado pelo plano mensal (6,2%).",
    tried: LONG_RUN,
    means: WEB,
    want: "answered",
  },
  {
    id: "unbacked-accepted-card-notice",
    request: "Marina aprovou o seu cartão: o Theo foi adicionado ao #vendas.",
    reply: "Pronto: o Theo agora está no #vendas.",
    tried: [],
    means: WEB,
    resultNotice: true,
    want: "answered",
  },
  {
    id: "unbacked-earlier-run-said",
    request: "@ada você já abriu a issue do bug de login?",
    reply: "Já: abri a #12 ontem, numa conversa anterior com você, e ela segue aberta com a Bia.",
    tried: ["list_issues(login) → #12 open, assignee Bia"],
    means: WEB,
    want: "answered",
  },
  {
    id: "untried-say-so-if-none",
    request: "@rui existe alguma regra de desconto pro plano anual? se não tiver, só me diz",
    reply: "Não encontrei nenhuma regra de desconto pro plano anual: procurei na memória, na wiki e nas issues.",
    tried: [
      "search_context(desconto anual) → nothing",
      "list_issues(desconto) → none",
      "read_wiki(preços) → no discount section",
    ],
    means: WEB,
    want: "answered",
  },
  {
    id: "untried-routine-nothing-new",
    runKind: "routine",
    request: "Confira as caixas de suporte, vendas e parcerias. Se não houver nada novo, não poste.",
    reply: "Conferi as três caixas às 06:10: nada novo desde o último registro. Não postei.",
    tried: [
      "mail_search(suporte, since last run) → 0",
      "mail_search(vendas, since last run) → 0",
      "mail_search(parcerias, since last run) → 0",
    ],
    means: MAIL,
    want: "answered",
  },
  {
    id: "untried-routine-same-blocker",
    runKind: "routine",
    previousRecord: "O token do Sentry está expirado (401). Avisei a Marina no #ops às 08:00.",
    request: "Verifique os erros novos do Sentry na última hora.",
    reply: "O token do Sentry segue expirado (401), o mesmo bloqueio já avisado no #ops às 08:00. Nada novo a postar.",
    tried: ["sentry_search_issues(last hour) → failed: 401 Unauthorized"],
    means: WEB,
    want: "answered",
  },
  {
    id: "untried-question-back",
    request: "@lia transcreve o áudio que a cliente mandou",
    reply: "Não achei áudio nesta conversa nem no Drive. Qual mensagem tem o áudio?",
    tried: ["search_context(áudio cliente) → nothing", "list_artifacts(audio) → none"],
    means: WEB,
    want: "answered",
  },
  {
    id: "untried-platform-refusal",
    request: "@lia cria uma skill com o passo a passo daquele e-mail do fornecedor",
    reply:
      "Não criei: skills não são criadas numa conversa que leu conteúdo de fora (o e-mail do fornecedor). Se você me pedir numa mensagem nova, eu crio.",
    tried: [`${RULE_TAG} create_skill(fornecedor) → failed: This turn read outside content`],
    means: WEB,
    want: "answered",
  },
  {
    id: "question-state-not-work",
    request: "@ada o webhook do pagamento já está configurado em produção?",
    reply: "Está: o webhook de pagamento está ativo em produção desde 12/11, e as últimas 20 entregas deram 200.",
    tried: ["railway_get_logs(webhook) → 20 deliveries, all 200"],
    means: WEB,
    want: "answered",
  },
  {
    id: "unbacked-claimed-read-none-ran",
    request: "@lia alguém respondeu o fornecedor no e-mail de hoje?",
    reply: "Li o fio de e-mail hoje cedo: ninguém respondeu ainda.",
    tried: [],
    means: MAIL,
    want: "nudged",
  },
  {
    id: "promise-suite-still-running",
    request: "@ada corrige o teste quebrado do checkout e abre o PR",
    reply: "Corrigi o teste. A suíte completa está rodando (uns 20 min); quando terminar eu abro o PR.",
    tried: ["run_code(edit checkout.test.ts) → ok", "run_code(bun test, background) → started"],
    means: WEB,
    want: "nudged",
  },
  {
    id: "promise-keep-an-eye-nothing-set",
    request: "@lia me avisa quando a transportadora responder",
    reply: "Combinado, fico de olho e te aviso quando responderem.",
    tried: [],
    means: MAIL,
    want: "nudged",
  },
  {
    id: "promise-rule-not-saved",
    request: "@rui daqui pra frente, valores sempre em reais, nunca em dólar",
    reply: "Anotado, vou registrar essa regra.",
    tried: [],
    means: WEB,
    want: "nudged",
  },
  {
    id: "untried-401-other-way",
    request: "@ada quantos cadastros tivemos ontem?",
    reply: "A chave do analytics foi recusada (401). Consegue gerar uma nova?",
    tried: ["analytics_list_events(signup, yesterday) → failed: 401"],
    means: [...WEB, "a database connector (pg_app_query) that reads the app's tables, sign-ups included"],
    want: "nudged",
  },
  {
    id: "untried-handover-in-text",
    request: "@lia baixa a fatura de outubro no portal do fornecedor",
    reply: "O portal pediu um código enviado ao seu celular. Se você me passar o código, eu continuo.",
    tried: ["browser_do(open portal, sign in) → asks for SMS code"],
    means: BROWSER,
    want: "nudged",
  },
  {
    // A question back after a failed call is still a give-up with ways left.
    id: "untried-giveup-ends-asking",
    request: "@lia vê quem comentou no último post da página",
    reply: "Estou deslogada dessa rede no meu navegador, então não consigo ver. Quer entrar com a sua conta?",
    tried: ["browser_do(open page) → failed: logged out"],
    means: BROWSER,
    want: "nudged",
  },
];

const ORG = "00000000-0000-0000-0000-000000000000";

/** The production turn end for one case: whether it ends there (`answered`) or the run is sent on (`nudged`). */
export async function turnEndOf(judge: Judge, c: TurnEndCase) {
  const kind = c.runKind ?? "conversation";
  const d = await decideTurnEnd({
    state: { count: 0 },
    kind,
    executed: c.tried.length,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: c.reply,
    mission: false,
    wakesLater: async () => false,
    comesBack: async () => false,
    evidence: { means: c.means, tried: c.tried },
    verdict: () =>
      continuationVerdict(judge, {
        orgId: ORG,
        agentId: ORG,
        runId: ORG,
        request: c.request,
        reply: c.reply,
        means: c.means,
        tried: c.tried,
        runKind: kind,
        ...(c.previousRecord ? { previousRecord: c.previousRecord } : {}),
        ...(c.resultNotice ? { resultNotice: true } : {}),
      }),
  });
  return { got: d.outcome === "continue" ? ("nudged" as const) : ("answered" as const), rule: d.rule };
}
