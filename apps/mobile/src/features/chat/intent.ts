import type { Agent } from "@agenteschat/client";
import type { IconName } from "@/ui";

/**
 * What an agent's first conversation offers: it introduces the agent in plain words and offers three first requests
 * tied to what it does. Pure: the screen turns the keys into text (`mobile.chat.intent.*`).
 */

// ── First conversation with an agent ─────────────────────────────────────────

/** Lowercase, without accents: "Função" and "funcao" match. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** What an agent does, as one plain sentence ("Responde os clientes no e-mail."), or null. */
export function plainWhat(instructions: string | null | undefined): string | null {
  const line = (instructions ?? "")
    .split("\n")
    // Headings name a section ("# Função"), they don't say what it does.
    .filter((l) => !/^\s*#/.test(l))
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .find((l) => l.length > 0);
  if (!line) return null;
  const sentence = (/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line).trim();
  if (sentence.length < 8 || sentence.length > 160) return null;
  // A prompt ("Você é…", "You are…") is not how a colleague introduces itself.
  if (/^(voce e|voces sao|you are|act as|aja como|atue como)\b/.test(fold(sentence))) return null;
  const text = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return /[.!?]$/.test(text) ? text.replace(/!$/, ".") : `${text}.`;
}

export type AgentIntro = { kind: "what"; text: string } | { kind: "role"; role: string } | { kind: "none" };

/** How a new agent introduces itself: what it does in its own words, else its role. */
export function agentIntro(agent: Pick<Agent, "role" | "instructions">): AgentIntro {
  const what = plainWhat(agent.instructions);
  if (what) return { kind: "what", text: what };
  const role = agent.role.trim();
  return role ? { kind: "role", role } : { kind: "none" };
}

/** Joined less than two weeks ago: "chegou na equipe". */
export const isNewAgent = (createdAt: string, now = Date.now(), days = 14) =>
  now - new Date(createdAt).getTime() < days * 86_400_000;

export const FIRST_ASK_KINDS = [
  "support",
  "ops",
  "qa",
  "dev",
  "research",
  "writing",
  "product",
  "sales",
  "general",
] as const;
export type FirstAskKind = (typeof FIRST_ASK_KINDS)[number];

/** Words (accents and case folded) that tell what an agent does; the first kind that matches wins. */
const KIND_WORDS: [FirstAskKind, RegExp][] = [
  ["support", /\b(atend\w*|suporte|support|clientes?|customers?|tickets?|sac|helpdesk)\b/],
  ["ops", /\b(ops|devops|sre|infra\w*|operac\w*|operations?|servidor\w*|servers?|deploys?|monitor\w*|uptime)\b/],
  ["qa", /\b(qa|testes?|tests?|testing|qualidade|quality)\b/],
  [
    "dev",
    /\b(dev|devs|developer|desenvolv\w*|codigo|code|coding|programa\w*|engenh\w*|engineer\w*|bugs?|github|frontend|backend|pull requests?)\b/,
  ],
  ["research", /\b(pesquis\w*|research\w*|mercado|market|concorr\w*|competitors?|analis\w*|analyst|analytics)\b/],
  ["writing", /\b(relatorios?|reports?|escrev\w*|writ\w*|redac\w*|redator\w*|conteudo|content|blog|textos?|copy)\b/],
  ["product", /\b(pm|produto|product|roadmap|issues?|planej\w*|projetos?|projects?|backlog)\b/],
  ["sales", /\b(vendas?|vend\w*|sales|leads?|comercial|marketing|campanhas?|campaigns?|prospec\w*)\b/],
];

/** What kind of work the agent does, from its role first and then its instructions. */
export function firstAskKind(agent: Pick<Agent, "role" | "instructions">): FirstAskKind {
  for (const text of [agent.role, agent.instructions]) {
    const folded = fold(text ?? "");
    for (const [kind, re] of KIND_WORDS) if (re.test(folded)) return kind;
  }
  return "general";
}

export interface FirstAsk {
  icon: IconName;
  /** Under `mobile.chat.intent.first.<kind>.*`: how it works, a first task, something every week. */
  key: `${FirstAskKind}.${"how" | "task" | "routine"}`;
}

/** Three first requests tied to what the agent does: a question, a first task and a routine. */
export function firstAsks(agent: Pick<Agent, "role" | "instructions">): FirstAsk[] {
  const kind = firstAskKind(agent);
  return [
    { icon: "help", key: `${kind}.how` },
    { icon: "pen", key: `${kind}.task` },
    { icon: "clock", key: `${kind}.routine` },
  ];
}
