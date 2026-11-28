import { expect, test } from "bun:test";
import {
  CHATGPT_REFUSED_MODEL_MS,
  emptyAnswer,
  modelUnavailable,
  noteModelRefusal,
  REFUSED_MODEL_MS,
  skipRefusedModel,
  withFailureCause,
} from "../src/brains/failure-causes";
import type { BrainEvent } from "../src/brains/types";

const error = (message: string, cause?: string): BrainEvent =>
  ({ type: "error", code: "codex_failed", message, ...(cause ? { cause } : {}) }) as BrainEvent;

test("a model the sign-in or its endpoint doesn't serve, in any CLI's words", () => {
  for (const said of [
    "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run /model to pick a different model.",
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}',
    "The model `gpt-x` does not exist or you do not have access to it.",
    "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.",
    "error: model_not_found",
    "Cursor exited with code 2: error: unknown model",
  ]) {
    expect(modelUnavailable({ message: said })).toBe(true);
    expect(withFailureCause(error(said))).toMatchObject({ cause: "model_unavailable" });
  }
  for (const said of [
    // Claude Code's notice for a model outside its own catalog: it goes on.
    '[claude-code:unrecognized_model] {"model":"x","query_source":"sdk"}',
    "A tool the model called does not exist: foo",
    "MCP server agentes exited with code 1",
    "stream disconnected before completion: idle timeout",
  ]) {
    expect(modelUnavailable({ message: said })).toBe(false);
  }
  // A runner's own cause stands; `unknown` lets the words decide.
  expect(withFailureCause(error("The model `gpt-x` does not exist", "quota"))).toMatchObject({ cause: "quota" });
  expect(withFailureCause(error("The model `gpt-x` does not exist", "unknown"))).toMatchObject({
    cause: "model_unavailable",
  });
  const done: BrainEvent = { type: "done", text: "" };
  expect(withFailureCause(done)).toBe(done);
});

test("a CLI that ended its turn with nothing in it", () => {
  expect(emptyAnswer({ message: "Codex ended without finishing the turn" })).toBe(true);
  expect(emptyAnswer({ message: "OpenCode ended without an answer." })).toBe(true);
  expect(withFailureCause(error("Grok Build ended without finishing the turn"))).toMatchObject({
    cause: "empty_answer",
  });
  // Ended with something to say about it: not empty, its words are the failure.
  expect(emptyAnswer({ message: "Claude Code ended without an answer (exit 1): TypeError: x" })).toBe(false);
});

test("a refused model stays out of that sign-in's turns for a while; others keep it", () => {
  const session = { id: "s", resume: false, machineId: "m-1", cwd: "app" };
  type Turn = Parameters<typeof skipRefusedModel>[1];
  const turn = { model: "glm-9", session, account: { id: "acct-1" } } as never as Turn;
  const now = 1_000_000;
  noteModelRefusal("claude_code", turn, error("model_not_found"), now);
  expect(skipRefusedModel("claude_code", turn, now + 1).model).toBeUndefined();
  // Another brain, or once the window passed: the model goes out again.
  expect(skipRefusedModel("codex", turn, now + 1).model).toBe("glm-9");
  expect(skipRefusedModel("claude_code", turn, now + REFUSED_MODEL_MS + 1).model).toBe("glm-9");
  // A ChatGPT sign-in's list is its plan's: hours.
  const chatgpt = { ...turn, model: "gpt-6.2-sol" } as typeof turn;
  noteModelRefusal(
    "codex",
    chatgpt,
    error("The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account."),
    now,
  );
  expect(skipRefusedModel("codex", chatgpt, now + REFUSED_MODEL_MS + 1).model).toBeUndefined();
  expect(skipRefusedModel("codex", chatgpt, now + CHATGPT_REFUSED_MODEL_MS + 1).model).toBe("gpt-6.2-sol");
  // Any other failure is no refusal.
  const other = { ...turn, model: "glm-8" } as typeof turn;
  noteModelRefusal("claude_code", other, error("stream disconnected"), now);
  expect(skipRefusedModel("claude_code", other, now + 1).model).toBe("glm-8");
});
