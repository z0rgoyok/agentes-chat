import type { BrainEvent, BrainTurn } from "./types";

/**
 * A CLI's words that the model it was given isn't one its sign-in or endpoint serves: Claude Code's "There's an issue
 * with the selected model (…). It may not exist or you may not have access to it", the API's `not_found_error` on a
 * model, OpenAI's "The model `…` does not exist or you do not have access to it" (`model_not_found`), Codex's
 * ChatGPT sign-in ("The '…' model is not supported when using Codex with a ChatGPT account"), and the like. Never
 * Claude Code's `unrecognized_model` notice: it prints that for a model outside its own catalog and goes on.
 */
const MODEL_UNAVAILABLE = new RegExp(
  [
    "issue with the selected model",
    "model[_ ]not[_ ]found",
    "not_found_error.{0,40}model:",
    "not a valid model",
    "(?:unknown|unsupported) model\\b",
    "invalid model (?:name|id)\\b",
    // "The model `x` does not exist…", "The 'x' model is not supported…": the model's name beside the words, quoted or
    // shaped like one (a digit or a dash in it), so a sentence about something else the model did ("a tool the model
    // called does not exist") isn't one.
    "\\bmodel\\s+(?:[`'\"][\\w./:-]+[`'\"]|[\\w./:]*[\\d-][\\w./:-]*)\\s+(?:does(?: not|n't) exist|is not (?:supported|available)|isn't (?:supported|available))",
    "[`'\"][\\w./:-]+[`'\"]\\s+model\\s+(?:does(?: not|n't) exist|is not (?:supported|available)|isn't (?:supported|available))",
    "do(?: not|n't) have access to (?:the |this )?model",
  ].join("|"),
  "i",
);

/** The runner's own sentence for a CLI that ended its turn with nothing in it (`Codex ended without finishing the turn`). */
const EMPTY_END = /^\S.*? ended without (?:finishing the turn|an answer)\.?$/;

/** No cause, or one that says nothing (`unknown`, an older runner's for any other failure): the words decide. */
const unsaid = (cause: string | undefined) => cause === undefined || cause === "unknown";

/** The error says the model it was given isn't served: a newer runner's cause, else its words. */
export const modelUnavailable = (error: { message: string; cause?: string }) =>
  error.cause === "model_unavailable" || (unsaid(error.cause) && MODEL_UNAVAILABLE.test(error.message));

/** The CLI ended its turn without an answer and said nothing more. */
export const emptyAnswer = (error: { message: string; cause?: string }) =>
  error.cause === "empty_answer" || (unsaid(error.cause) && EMPTY_END.test(error.message.trim()));

/**
 * A computer brain's event with the cause its words say, where the runner gave none: every CLI's failure reads the same
 * way (an older runner, and the CLIs whose runner side names no cause), so the engine words it and retries it alike.
 */
export function withFailureCause(event: BrainEvent): BrainEvent {
  if (event.type !== "error" || !unsaid(event.cause)) return event;
  if (modelUnavailable(event)) return { ...event, cause: "model_unavailable" };
  if (emptyAnswer(event)) return { ...event, cause: "empty_answer" };
  return event;
}

/**
 * How long a model refused for a sign-in is left out of its turns. A ChatGPT sign-in's list of Codex models is fixed by
 * its plan (`codexModelRefused`), so its refusal holds for hours; any other refusal may be the endpoint's for now.
 */
export const REFUSED_MODEL_MS = 10 * 60_000;
export const CHATGPT_REFUSED_MODEL_MS = 6 * 60 * 60_000;

/**
 * A ChatGPT sign-in offers Codex its own list of models, not the API's (catalog rows a plan may not have, or not yet),
 * and refuses any other: "The '<model>' model is not supported when using Codex with a ChatGPT account." It refuses
 * before the model runs, so the executor takes the turn again with no model, in a fresh session: a Codex thread keeps
 * the model it was given, and a turn can't clear it. Any other CLI's refusal of its model goes the same way.
 */
export const codexModelRefused = (message: string) =>
  /model is not supported when using Codex with a ChatGPT account/i.test(message);

// Per process: each server process pays one refused turn per sign-in and model, the same as a deploy does.
const refusedModels = new Map<string, number>();

const refusedKey = (kind: string, turn: Pick<BrainTurn, "model" | "session" | "account">) =>
  turn.model && turn.session ? `${kind}:${turn.account?.id ?? turn.session.machineId}:${turn.model}` : null;

/** The turn as it goes out: without its model while that sign-in refused it lately (the CLI's default instead). */
export function skipRefusedModel<T extends Pick<BrainTurn, "model" | "session" | "account">>(
  kind: string,
  turn: T,
  now = Date.now(),
): T {
  const key = refusedKey(kind, turn);
  return key !== null && (refusedModels.get(key) ?? 0) > now ? { ...turn, model: undefined } : turn;
}

/** A turn's event: a refusal of its model is remembered for that sign-in. */
export function noteModelRefusal(
  kind: string,
  turn: Pick<BrainTurn, "model" | "session" | "account">,
  event: BrainEvent,
  now = Date.now(),
) {
  if (event.type !== "error" || !modelUnavailable(event)) return;
  const key = refusedKey(kind, turn);
  if (key === null) return;
  for (const [k, until] of refusedModels) if (until <= now) refusedModels.delete(k);
  refusedModels.set(key, now + (codexModelRefused(event.message) ? CHATGPT_REFUSED_MODEL_MS : REFUSED_MODEL_MS));
}
