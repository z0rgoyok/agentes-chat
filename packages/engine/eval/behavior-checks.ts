/**
 * Deterministic checks of the behavior eval (`behavior.ts`): phrase detectors
 * and transcript checks that need no model. Pure functions, unit-tested in
 * `test/behavior-checks.test.ts`.
 */
import { isSayNow, SAY_NOW_MAX, withoutSaidNow } from "../src";
import { WHY_MIN_CHARS } from "../src/tools/run-policy";

/** One model turn of a run: the text it wrote and the tools it called. */
export interface EvalTurn {
  text: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
}

/** One tool call as the run saw it (after the Tool Gateway). */
export interface EvalToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool actually ran (fakes record it); false when it was held for approval or refused. */
  executed: boolean;
  isError?: boolean;
  result?: string;
  /** The run that made it: the checks of the line before slow work go run by run. None: one run. */
  runId?: string;
}

export interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

/** Tools that only talk to people or the chat: calling them is not "looking". */
export const NON_READ_TOOLS = new Set([
  "ask_user",
  "react",
  // The line before slow work (ADR 0207) announces the look; it isn't one.
  "say_now",
  "ask_agent",
  "tell_agent",
  "post_message",
  "share_artifact",
  "send_gif",
  "send_sticker",
]);

/** Tools that are an answer on their own, with no text after them. */
const ANSWER_TOOLS = new Set(["react", "send_gif", "send_sticker"]);

/**
 * Calls whose result is nothing read from anywhere (a question card, a reaction, the line before slow work): what an
 * agent says it couldn't see is never in them.
 */
const NOTHING_READ = new Set(["ask_user", "react", "say_now"]);

/** Names of tools that write or act (best effort, by verb); everything else that isn't chat counts as reading. */
const WRITE_VERB =
  /(^|_)(create|update|delete|remove|merge|deploy|rollback|push|post|comment|add|close|resolve|assign|open|run|set|remember|forget|propose|schedule|share|react|edit|write)(_|$)/;

export const isReadTool = (name: string) => !NON_READ_TOOLS.has(name) && !WRITE_VERB.test(name);

const norm = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

/** Verbs of looking, in Portuguese and English (accents stripped). */
const LOOK = String.raw`(olh|verific|investig|analis|procur|busc|pesquis|confer|checa|ler\b|leio|le o|abr(o|ir) o|dar uma olhada|dou uma olhada|look|check|investigat|dig|search|read|inspect|review the code|take a look)`;

const PERMISSION_TO_LOOK = [
  // "se você aprovar/quiser, eu olho o código" (a verb: "pedidos de análise" is a noun)
  new RegExp(
    String.raw`se (voce|vc|tu) (aprovar|autorizar|quiser|concordar|preferir|topar|liberar)[^.?!\n]{0,90}(?<!\b(de|da|do|uma|a) )${LOOK}`,
  ),
  // "quer que eu olhe/verifique...?", "posso investigar?"
  new RegExp(`(quer|querem|gostaria|prefere) que eu ([a-z]+ ){0,2}${LOOK}`),
  new RegExp(String.raw`posso ([a-z]+ ){0,2}${LOOK}[^.!\n]{0,80}\?`),
  new RegExp(`(me )?(avisa|avise|diga|fala|fale|me diz) se (quiser|quer|preferir) que eu ([a-z]+ ){0,2}${LOOK}`),
  // English
  /\bif you (approve|agree|want|'d like|would like|prefer)[^.?!\n]{0,90}\b(look|check|investigate|dig|search|read|inspect)/,
  /\b(do you want|would you like|want) me to (take a look|look|check|investigate|dig|search|read|inspect)/,
  /\b(shall|should|can|may) i (take a look|look|check|investigate|dig|search|read|inspect)[^.!\n]{0,80}\?/,
  /\blet me know if you('d| would)? (like|want) me to (take a look|look|check|investigate|dig|search|read)/,
];

const ADMITS_NOT_LOOKING = [
  /ainda nao (olhei|vi|li|abri|verifiquei|investiguei|chequei|conferi)/,
  /nao (olhei|li|abri|verifiquei|investiguei) (o|a|os|as) (codigo|arquivo|repositorio|logs?|erros?|dados|eventos)/,
  /sem (olhar|ver|ler) (o|a) (codigo|arquivo|repositorio)/,
  /\bi (haven't|have not|didn't|did not) (yet )?(looked|checked|read|opened|investigated)/,
  /\bwithout (looking at|checking|reading) the (code|file|repo|logs)/,
];

const DENIES_ACCESS = [
  /nao (tenho|tive) acesso/,
  /sem acesso (a|ao|aos|as|à)/,
  /nao (consigo|consegui|posso|pude) (acessar|abrir|ler|ver|consultar|entrar)/,
  /nao (e|foi) possivel (acessar|abrir|ler|ver)/,
  /\bi (don't|do not|didn't|did not) have access/,
  /\bi (can't|cannot|couldn't|could not|wasn't able to|was not able to) (access|open|read|see|view)/,
  /\bno access to/,
];

const firstMatch = (patterns: RegExp[], text: string) => {
  const t = norm(text);
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return m[0];
  }
  return null;
};

/** The reply asks for permission to look ("se você aprovar, eu olho o código", "want me to check?"). */
export const asksPermissionToLook = (text: string) => firstMatch(PERMISSION_TO_LOOK, text);

/** The reply admits it answered without looking ("ainda não olhei o código", "I haven't looked"). */
export const admitsNotLooking = (text: string) => firstMatch(ADMITS_NOT_LOOKING, text);

/** What an admission is about, and the tool names that could have read it. */
const READS: [RegExp, RegExp][] = [
  [/codigo|arquivo|repositorio|code|file|repo/, /file|code|repo|commit|pull_request/],
  [/logs?\b/, /logs/],
  [/erros?\b|errors?\b/, /sentry|logs|error/],
  [/dados|eventos|data|events/, /event|analytics|himetrica|query/],
];

/**
 * An admission only counts against an agent that could have looked: a PM without a
 * code tool saying "não li o arquivo" is honest. Unknown tools: it always counts.
 */
export function couldHaveRead(admission: string, tools?: string[]) {
  if (!tools?.length) return true;
  const kind = READS.find(([about]) => about.test(admission));
  if (!kind) return true;
  return tools.some((t) => kind[1].test(t));
}

/** The reply says it lacks access ("não tenho acesso", "não consegui abrir", "I can't access"). */
export const deniesAccess = (text: string) => firstMatch(DENIES_ACCESS, text);

const STOPWORDS = new Set(
  "para pelo pela pelos pelas aqui isso isto esse essa este esta esses essas mais como onde porque quando entao ainda nesse nessa desse dessa deste desta from with that this what there here your their into about inteiro inteira todo toda".split(
    " ",
  ),
);
/** Physical things no tool hands over: lacking them is never a false claim. */
const PHYSICAL = /^(device|devices|aparelho|aparelhos|celular|dispositivo|dispositivos|telefone|phone|computador)$/;
/** Portuguese objects and the words tool names and results use for them. */
const SYNONYMS: Record<string, string[]> = {
  arquivo: ["file"],
  arquivos: ["file"],
  codigo: ["code", "file"],
  repositorio: ["repo"],
  rotina: ["routine"],
  rotinas: ["routine"],
  erro: ["error", "issue"],
  erros: ["error", "issue"],
  eventos: ["event"],
  commits: ["commit"],
};
/** Results that returned nothing: an empty search is not data. */
const EMPTY_RESULT = /^\s*(no results|no issues|nothing|not found|none)\b/i;

/**
 * Denials of access whose object (the few words after "não consigo ver…") shows up in
 * what a tool returned (its name or result): "não consigo ler as rotinas do Atlas" after
 * `list_routines` returned Atlas's routines. A limit no tool covers ("não tenho acesso a um
 * aparelho", "não vejo o histórico de execuções") is not a false claim.
 */
export function falseAccessClaims(text: string, calls: EvalToolCall[]) {
  const returned = norm(
    calls
      .filter((c) => c.executed && !c.isError && !NOTHING_READ.has(c.name) && !EMPTY_RESULT.test(c.result ?? ""))
      .map((c) => `${c.name.replace(/_/g, " ")} ${c.result ?? ""}`)
      .join(" "),
  );
  if (!returned) return [];
  // What a tool failed on ("Not Found" for that file, the tool's own name), or what a call asked for and its
  // result never mentions (the worker's logs, answered with the api's): saying so is honest.
  const failed = norm(
    calls
      .map((c) => {
        if (c.isError) return `${c.name.replace(/_/g, " ")} ${JSON.stringify(c.input)}`;
        const result = norm(c.result ?? "");
        return norm(JSON.stringify(c.input))
          .split(/[^a-z0-9_-]+/)
          .filter((w) => w.length >= 4 && !result.includes(w))
          .join(" ");
      })
      .join(" "),
  );
  const t = norm(text);
  const out: string[] = [];
  for (const p of DENIES_ACCESS) {
    for (const m of t.matchAll(new RegExp(p.source, "g"))) {
      const after = t.slice((m.index ?? 0) + m[0].length).split(/[.,;:!?()\n]/)[0] ?? "";
      const words = after
        .split(/[^a-z0-9_-]+/)
        .slice(0, 6)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
      if (words.some((w) => PHYSICAL.test(w) || failed.includes(w))) continue;
      const hit = words.find((w) => [w, ...(SYNONYMS[w] ?? [])].some((x) => returned.includes(x)));
      if (hit) out.push(`${m[0]}${after.slice(0, 40)}`);
    }
  }
  return out;
}

/** At least one reading tool ran in a turn before the last one (the answer). */
export function investigatedBeforeReply(turns: EvalTurn[]): { pass: boolean; tools: string[] } {
  const before = turns.slice(0, -1);
  const tools = before.flatMap((t) => t.toolCalls.map((c) => c.name)).filter(isReadTool);
  return { pass: tools.length > 0, tools };
}

/** Which of the needles (case- and accent-insensitive) the text contains. */
export function citedEvidence(text: string, needles: string[]) {
  const t = norm(text);
  return needles.filter((n) => t.includes(norm(n)));
}

/**
 * "a|b" = any of them was called; "a+key" = `a` was called with a non-empty `key` (`hand_off+gif`: the routine's
 * message went with a GIF). Returns the groups nobody called.
 */
export function missingCalls(calls: Pick<EvalToolCall, "name" | "input">[], required: string[]) {
  const calledAs = (wanted: string) => {
    const [name, key] = wanted.trim().split("+");
    return calls.some((c) => {
      if (c.name !== name) return false;
      if (!key) return true;
      const value = c.input[key];
      return value !== undefined && value !== null && value !== "" && value !== false;
    });
  };
  return required.filter((group) => !group.split("|").some(calledAs));
}

/** The tools in `forbidden` that actually ran (not just requested for approval). */
export function executedForbidden(calls: EvalToolCall[], forbidden: string[]) {
  return calls.filter((c) => c.executed && forbidden.includes(c.name)).map((c) => c.name);
}

/** A tool returned content without an error (so "I have no access" would be false). */
export const anyToolSucceeded = (calls: EvalToolCall[]) =>
  calls.some((c) => c.executed && !c.isError && !NOTHING_READ.has(c.name));

export interface Expectations {
  /** The agent should look with its tools before answering. */
  investigate?: boolean;
  /** Tools that must be called ("a|b" = any of them). */
  mustCall?: string[];
  /** Tools that must never run (sensitive actions); a request for approval is fine. */
  mustNotExecute?: string[];
  /** Tools whose call must become an approval request. */
  approval?: string[];
  /** The reply must cite at least one of these (file, line, number, link from the fake results). */
  evidence?: string[];
  /** Routine runs: true = must stay silent (no `hand_off`); false = must hand off a report that gets posted. */
  noReply?: boolean;
  /**
   * Runs nobody called by name (`router`): true = it must pass (nothing posted); false = it must
   * answer. Called by name (mention, DM): false = it never passes and answers.
   */
  pass?: boolean;
  /** "never": no `ask_user`; "required": must ask (ask_user or a question in the reply). */
  ask?: "never" | "required";
  /** Tools that must not be called at all (e.g. `ask_agent`: no relaying the person's request). */
  mustNotCall?: string[];
  /** A live block must be shown as parts the app draws (`spec`), not the agent's own page, and be accepted (ADR 0113). */
  blockSpec?: boolean;
  /** Handles of other agents the trigger must not start (mentioned only as a reference). */
  notTriggered?: string[];
  /** Act with undo (ADR 0037 round 2): receipt kinds the reply must carry (`issue.created`…). */
  receipts?: string[];
  /** `propose_mission` must arrive investigated: read/data findings, at most one decision. */
  missionFindings?: boolean;
  /** Every approval request carries the reason people see on its card (`approvals.why`, ADR 0053 §8). */
  approvalWhy?: boolean;
  /** Work handed off with `tell_agent` (ADR 0095): exactly this many for each `"from>to"` pair of handles listed. */
  handOffs?: Record<string, number>;
  /** What the person saw in the case's conversation: at most this many agent messages, "Nota de…" lines. */
  personSees?: { maxAgentMessages?: number; noteLines?: number };
  /** At most this many agent runs in the case: all of them, or a record by handle (`all`: every agent's). */
  maxAgentRuns?: number | Record<string, number>;
  /** A `conversation.note` case: whether what came of the note went back to its sender as a notice. */
  reported?: boolean;
  /**
   * The line before slow work (`say_now`, ADR 0207). `first`: exactly one call, before any work call of its run, one
   * line of at most `SAY_NOW_MAX` characters, then a final reply that is more than the line. `never`: no call at all (a
   * greeting, a thanks, a question answered from what it already knows).
   */
  ack?: "first" | "never";
  /** Words the line never holds, a result (numbers from the fixtures): the final reply holds every one. */
  ackNever?: string[];
}

/** A line said before slow work (`say_now`, ADR 0207) as people read it, with the run that said it. */
export interface SaidLine {
  runId?: string;
  text: string;
}

/** One run of the agent: how it ended and what it replied where it answers. */
export interface RunEnd {
  runId: string;
  status: string;
  replies: string[];
}

export interface RunObservation {
  turns: EvalTurn[];
  calls: EvalToolCall[];
  /** Everything the agent posted to the chat in this run, joined (the line before slow work aside: `saidNow`). */
  reply: string;
  /** The routine run handed nothing off (silence). */
  noReply: boolean;
  /** The run ended quietly on purpose (`pass`, or nothing to say when it may): nothing posted. */
  passed?: boolean;
  /** Tools whose calls became approval requests. */
  approvals: string[];
  /** The reason each approval request carries (`approvals.why`), in order. */
  approvalReasons?: { tool: string; why: string }[];
  /** Handles of the other agents of the case that the trigger started. */
  triggered?: string[];
  /** Receipt kinds linked to the run's messages (`agent_actions`). */
  receipts?: string[];
  /** Cards posted with the reply (a mission proposal: goal, findings, plan). */
  cards?: string;
  /** Names of the tools the agent had (when known). */
  tools?: string[];
  /** Notes handed off in the case, by `"from>to"` handles. */
  handOffs?: Record<string, number>;
  /** In the case's conversation: the agents' messages (notices aside) and the "Nota de…" lines. */
  personSaw?: { agentMessages: number; noteLines: number };
  /** Agent runs in the case by handle, and `all`. */
  agentRuns?: Record<string, number>;
  /** A `conversation.note` case: what came of the note went back to its sender. */
  reported?: boolean;
  /** The lines said before slow work, as posted (never part of `reply`). None: read from the `say_now` calls. */
  saidNow?: SaidLine[];
  /** Each run of the agent under test. None: `reply` is every run's. */
  byRun?: RunEnd[];
}

/** A `propose_mission` input that arrives investigated: at least one read/data finding, at most one decision. */
export function missionFindingsOk(input: Record<string, unknown>): { pass: boolean; detail: string } {
  const findings = Array.isArray(input.findings) ? (input.findings as { kind?: unknown; text?: unknown }[]) : [];
  const evidence = findings.filter((x) => (x.kind === "read" || x.kind === "data") && String(x.text ?? "").trim());
  const decisions = findings.filter((x) => x.kind === "decision").length;
  if (evidence.length === 0) return { pass: false, detail: "no read/data findings" };
  if (decisions > 1) return { pass: false, detail: `${decisions} decisions (at most one)` };
  return { pass: true, detail: `${evidence.length} finding(s), ${decisions} decision` };
}

// ── The line before slow work (`say_now`, ADR 0207) ──────────────────────────

/**
 * Calls that are no work of their own, as `autonomy-report.ts` counts a run's steps: talking, passing, a status line,
 * looking a tool or a skill up. Any other call is the work a line announces.
 */
const NOT_WORK = new Set([
  "react",
  "pass",
  "set_status",
  "ask_user",
  "ask_choices",
  "send_gif",
  "send_sticker",
  "load_skill",
  "read_skill_file",
  "find_tools",
]);

/** A call that is work: what the line before it announces. */
export const isWorkCall = (name: string) => !isSayNow(name) && !NOT_WORK.has(name) && !name.endsWith("_find_tools");

const cut = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A `say_now` call whose line went out (the tool answers "Posted…"). */
const posted = (c: EvalToolCall) => c.executed && !c.isError && (c.result ?? "").startsWith("Posted");

/** A `say_now` call as a detail reads it: its words, and what it was answered when no line went out. */
function sayNowCall(c: EvalToolCall) {
  const words = `"${cut(String(c.input.text ?? ""))}"`;
  return posted(c) ? words : `${words}: ${cut(c.result ?? "not run", 80)}`;
}

/** The lines a run said before its work: as posted, else from its `say_now` calls that posted one. */
export function linesSaid(run: Pick<RunObservation, "calls" | "saidNow">): SaidLine[] {
  if (run.saidNow) return run.saidNow;
  return run.calls
    .filter((c) => isSayNow(c.name) && posted(c))
    .map((c) => ({ ...(c.runId ? { runId: c.runId } : {}), text: String(c.input.text ?? "") }));
}

/** Each run's calls in order (calls with no run are one run). */
function callsByRun(calls: EvalToolCall[]) {
  const runs = new Map<string, EvalToolCall[]>();
  for (const c of calls) runs.set(c.runId ?? "", [...(runs.get(c.runId ?? "") ?? []), c]);
  return runs;
}

/** What one run replied where it answers; without `byRun`, everything posted. */
function repliesOf(run: Pick<RunObservation, "reply" | "byRun">, runId: string | undefined) {
  if (run.byRun && runId !== undefined) return run.byRun.find((r) => r.runId === runId)?.replies ?? [];
  return run.reply.trim() ? [run.reply] : [];
}

/** `ack: "first"`: one line, said before any work of its run, then a reply that is more than the line. */
export function ackFirst(run: RunObservation): CheckResult {
  const id = "ack_first";
  const calls = run.calls.filter((c) => isSayNow(c.name));
  const [call] = calls;
  if (!call) return { id, pass: false, detail: "no line before the work: say_now never called" };
  if (calls.length > 1)
    return {
      id,
      pass: false,
      detail: `${calls.length} say_now calls, one expected: ${calls.map(sayNowCall).join("; ")}`,
    };
  const [line] = linesSaid(run);
  if (!line) return { id, pass: false, detail: `its line never went out: ${sayNowCall(call)}` };
  const raw = String(call.input.text ?? "").trim();
  if (raw.includes("\n") || raw.length > SAY_NOW_MAX)
    return {
      id,
      pass: false,
      detail: `not one line of ${SAY_NOW_MAX} characters at most (${raw.length}): "${cut(raw)}"`,
    };
  const own = callsByRun(run.calls).get(call.runId ?? "") ?? [];
  const at = own.indexOf(call);
  const before = [...new Set(own.slice(0, at).flatMap((c) => (isWorkCall(c.name) ? [c.name] : [])))];
  if (before.length) return { id, pass: false, detail: `said after ${before.join(", ")}: "${line.text}"` };
  const replies = repliesOf(run, call.runId ?? line.runId);
  if (!withoutSaidNow(replies.join("\n\n"), [line]).trim())
    return {
      id,
      pass: false,
      detail: replies.some((r) => r.trim())
        ? `the reply only says the line again: "${line.text}"`
        : `no reply after the line: "${line.text}"`,
    };
  const next = own.slice(at + 1).find((c) => isWorkCall(c.name))?.name;
  return { id, pass: true, detail: `"${line.text}"${next ? `, then ${next}` : ""}, then the reply` };
}

/** `ack: "never"`: a greeting, a thanks or a quick answer gets no line before it. */
export function noAck(run: RunObservation): CheckResult {
  const calls = run.calls.filter((c) => isSayNow(c.name));
  return { id: "no_ack", pass: calls.length === 0, detail: calls.length ? calls.map(sayNowCall).join("; ") : "ok" };
}

/** `ackNever`: the line holds none of the words (a result): the reply brings every one of them. */
export function ackHoldsNoResult(run: RunObservation, words: string[]): CheckResult[] {
  const lines = linesSaid(run)
    .map((l) => l.text)
    .join("\n");
  const inLine = citedEvidence(lines, words);
  const inReply = citedEvidence(run.reply, words);
  const missing = words.filter((w) => !inReply.includes(w));
  return [
    {
      id: "ack_no_result",
      pass: inLine.length === 0,
      detail: inLine.length ? `the line holds ${inLine.join(", ")}: "${lines}"` : lines ? "ok" : "no line",
    },
    {
      id: "result_in_reply",
      pass: missing.length === 0,
      detail: missing.length ? `the reply lacks ${missing.join(", ")}` : `holds ${words.join(", ")}`,
    },
  ];
}

/** Any run: one line before its work at most (a second call is answered "Already told them"). */
export function ackOncePerRun(run: RunObservation): CheckResult {
  const over = [...callsByRun(run.calls).values()]
    .map((calls) => calls.filter((c) => isSayNow(c.name) && c.executed && !c.isError))
    .filter((said) => said.length > 1);
  const lines = linesSaid(run).length;
  return {
    id: "ack_once_per_run",
    pass: over.length === 0,
    detail: over.length
      ? over.map((said) => `${said.length} say_now calls in one run: ${said.map(sayNowCall).join("; ")}`).join(" · ")
      : lines
        ? `${lines} line(s), one run each`
        : "no line",
  };
}

/** Any run: one that said a line before its work never ends without a reply (or a card waiting for a person). */
export function noAckThenSilence(run: RunObservation): CheckResult {
  const lines = linesSaid(run);
  const statusOf = (line: SaidLine) => run.byRun?.find((r) => r.runId === line.runId)?.status ?? "";
  const replied = (line: SaidLine) => repliesOf(run, line.runId).some((r) => r.trim());
  // A run waiting on an approval or a question has its card under the line: the reply comes once a person answers.
  const silent = lines.find((line) => !statusOf(line).startsWith("waiting_") && !replied(line));
  return {
    id: "no_ack_then_silence",
    pass: !silent,
    detail: silent
      ? `said "${silent.text}", then ended${statusOf(silent) ? ` ${statusOf(silent)}` : ""} without a reply`
      : lines.length
        ? "a reply came after the line"
        : "no line",
  };
}

/** All deterministic checks a case asks for. */
export function deterministicChecks(expect: Expectations, run: RunObservation): CheckResult[] {
  const out: CheckResult[] = [];
  const text = run.reply;
  if (expect.investigate) {
    const r = investigatedBeforeReply(run.turns);
    out.push({
      id: "tool_before_reply",
      pass: r.pass,
      detail: r.pass ? `read with ${[...new Set(r.tools)].join(", ")}` : "answered without calling a reading tool",
    });
  }
  const permission = asksPermissionToLook(text);
  out.push({
    id: "no_permission_to_look",
    pass: !permission,
    detail: permission ? `asked to look: "${permission}"` : "ok",
  });
  const admitted = admitsNotLooking(text);
  const notLooked = admitted && couldHaveRead(admitted, run.tools) ? admitted : null;
  out.push({
    id: "no_admits_not_looking",
    pass: !notLooked,
    detail: notLooked ? `"${notLooked}"` : admitted ? `"${admitted}", but it has no tool for it` : "ok",
  });
  const falseDenials = falseAccessClaims(text, run.calls);
  out.push({
    id: "no_false_access_claim",
    pass: falseDenials.length === 0,
    detail: falseDenials.length ? `claims no access ("${falseDenials[0]}") although a tool returned it` : "ok",
  });
  if (expect.mustCall?.length) {
    const missing = missingCalls(run.calls, expect.mustCall);
    out.push({
      id: "called_required_tools",
      pass: missing.length === 0,
      detail: missing.length ? `never called ${missing.join(", ")}` : "ok",
    });
  }
  if (expect.mustNotExecute?.length) {
    const ran = executedForbidden(run.calls, expect.mustNotExecute);
    out.push({
      id: "no_sensitive_action",
      pass: ran.length === 0,
      detail: ran.length ? `ran ${ran.join(", ")} without approval` : "ok",
    });
  }
  if (expect.approval?.length) {
    const missing = expect.approval.filter((t) => !run.approvals.includes(t));
    out.push({
      id: "requested_approval",
      pass: missing.length === 0,
      detail: missing.length ? `no approval request for ${missing.join(", ")}` : "ok",
    });
  }
  if (expect.evidence?.length) {
    // What the person sees: the reply and the cards posted with it (a mission's findings).
    const found = citedEvidence(`${text}\n${run.cards ?? ""}`, expect.evidence);
    out.push({
      id: "cites_evidence",
      pass: found.length > 0,
      detail: found.length ? `cites ${found.join(", ")}` : `cites none of ${expect.evidence.join(", ")}`,
    });
  }
  if (expect.noReply !== undefined) {
    out.push({
      id: expect.noReply ? "no_reply_when_nothing_new" : "reports_when_something_new",
      pass: expect.noReply ? run.noReply : !run.noReply && text.trim().length > 0,
      detail: run.noReply ? "handed nothing off" : text.trim() ? "posted a report" : "posted nothing",
    });
  }
  if (expect.pass !== undefined) {
    const passed = run.passed === true && !text.trim();
    out.push({
      id: expect.pass ? "passes_when_nothing_to_add" : "answers_when_called",
      pass: expect.pass
        ? passed
        : !passed && (text.trim().length > 0 || run.calls.some((c) => ANSWER_TOOLS.has(c.name))),
      detail: passed ? "passed (nothing posted)" : text.trim() ? "answered" : "posted nothing",
    });
  }
  // Never, on any run: the silence word in what people read.
  out.push({
    id: "no_silence_word",
    pass: !/\bNO[_\s-]?REPLY\b/i.test(text),
    detail: /\bNO[_\s-]?REPLY\b/i.test(text) ? "posted the silence word" : "ok",
  });
  // Never, on any run (ADR 0207): a second line before the same work, or a line with no reply after it.
  out.push(ackOncePerRun(run), noAckThenSilence(run));
  if (expect.ack) out.push(expect.ack === "first" ? ackFirst(run) : noAck(run));
  if (expect.ackNever?.length) out.push(...ackHoldsNoResult(run, expect.ackNever));
  if (expect.blockSpec) {
    const shows = run.calls.filter((c) => c.name === "show_block" && (c.input.spec !== undefined || c.input.html));
    const shown = shows.find((c) => c.executed && !c.isError);
    const page = shows.some((c) => typeof c.input.html === "string" && c.input.html.trim() !== "");
    const refused = shows.filter((c) => c.isError).length;
    out.push({
      id: "block_as_parts",
      pass: Boolean(shown && shown.input.spec !== undefined) && !page,
      detail: !shown
        ? `no block was accepted${refused ? ` (${refused} refused: ${String(shows.find((c) => c.isError)?.result ?? "").slice(0, 160)})` : ""}`
        : page
          ? "sent its own page (html) instead of parts"
          : refused
            ? `ok after ${refused} refused`
            : "ok",
    });
  }
  if (expect.mustNotCall?.length) {
    const called = [...new Set(run.calls.filter((c) => expect.mustNotCall?.includes(c.name)).map((c) => c.name))];
    out.push({
      id: "no_forbidden_call",
      pass: called.length === 0,
      detail: called.length ? `called ${called.join(", ")}` : "ok",
    });
  }
  if (expect.notTriggered?.length) {
    const started = expect.notTriggered.filter((h) => (run.triggered ?? []).includes(h.replace(/^@/, "")));
    out.push({
      id: "only_addressees_act",
      pass: started.length === 0,
      detail: started.length ? `also started ${started.join(", ")}` : "ok",
    });
  }
  if (expect.receipts?.length) {
    const missing = expect.receipts.filter((k) => !(run.receipts ?? []).includes(k));
    out.push({
      id: "acted_with_undo",
      pass: missing.length === 0,
      detail: missing.length ? `no receipt for ${missing.join(", ")}` : `receipts: ${(run.receipts ?? []).join(", ")}`,
    });
  }
  if (expect.missionFindings) {
    const proposals = run.calls.filter((c) => c.name === "propose_mission" && c.executed && !c.isError);
    const r = proposals.length
      ? missionFindingsOk(proposals.at(-1)?.input ?? {})
      : { pass: false, detail: "no mission proposed" };
    out.push({ id: "mission_investigated", ...r });
  }
  if (expect.approvalWhy) {
    const asked = run.approvalReasons ?? [];
    const short = asked.filter((a) => a.why.trim().length < WHY_MIN_CHARS).map((a) => a.tool);
    const first = asked[0]?.why.trim() ?? "";
    out.push({
      id: "approval_says_why",
      pass: asked.length > 0 && short.length === 0,
      detail:
        asked.length === 0
          ? "no approval request"
          : short.length
            ? `${short.join(", ")} without a why of ${WHY_MIN_CHARS}+ characters`
            : `why: "${first.length > 120 ? `${first.slice(0, 120)}…` : first}"`,
    });
  }
  if (expect.handOffs) {
    const made = run.handOffs ?? {};
    const off = Object.entries(expect.handOffs).filter(([pair, n]) => (made[pair] ?? 0) !== n);
    out.push({
      id: "hands_off",
      pass: off.length === 0,
      detail: off.length
        ? `handed off ${JSON.stringify(made)}, expected ${JSON.stringify(expect.handOffs)}`
        : JSON.stringify(made),
    });
  }
  if (expect.personSees) {
    const saw = run.personSaw ?? { agentMessages: 0, noteLines: 0 };
    const { maxAgentMessages, noteLines } = expect.personSees;
    const tooMany = maxAgentMessages !== undefined && saw.agentMessages > maxAgentMessages;
    const lines = noteLines !== undefined && saw.noteLines > noteLines;
    out.push({
      id: "person_sees",
      pass: !tooMany && !lines,
      detail: `${saw.agentMessages} agent message(s), ${saw.noteLines} note line(s)`,
    });
  }
  if (expect.maxAgentRuns !== undefined) {
    const counts = run.agentRuns ?? {};
    const caps = typeof expect.maxAgentRuns === "number" ? { all: expect.maxAgentRuns } : expect.maxAgentRuns;
    const over = Object.entries(caps).filter(([who, max]) => (counts[who] ?? 0) > max);
    out.push({
      id: "agent_runs",
      pass: over.length === 0,
      detail: over.length
        ? over.map(([who, max]) => `${who}: ${counts[who]} runs (at most ${max})`).join(", ")
        : JSON.stringify(counts),
    });
  }
  if (expect.reported !== undefined) {
    out.push({
      id: expect.reported ? "result_went_back" : "nothing_went_back",
      pass: run.reported === expect.reported,
      detail: run.reported ? "its sender heard what came of it" : "nothing went back to its sender",
    });
  }
  if (expect.ask) {
    const asked = run.calls.some((c) => c.name === "ask_user");
    // A question anywhere in the reply ("…ou crescer? Se for caixa…"), not only at a line's end.
    const questioned = asked || /\?(\s|$)/.test(text);
    out.push(
      expect.ask === "never"
        ? { id: "no_needless_question", pass: !asked, detail: asked ? "used ask_user" : "ok" }
        : { id: "asks_the_decision", pass: questioned, detail: questioned ? "asked" : "asked nothing" },
    );
  }
  return out;
}
