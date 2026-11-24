/**
 * The turn end of a person's conversation, through the production judge (`continuationVerdict`) and controller
 * (`decideTurnEnd`): a turn that already answered the person ends there, and only real unfinished work is sent on.
 * Exit 1 on any wrong case.
 *
 *   bun --env-file=.env packages/engine/eval/turn-end.ts [--judge jev|llm]
 */
import { createAnthropicProvider } from "@agenteschat/providers";
import { createJevJudge, createLlmJudge, type Judge } from "../src/judge";
import { TURN_END_CASES, turnEndOf } from "./turn-end-cases";

const which = process.argv.includes("--judge") ? process.argv[process.argv.indexOf("--judge") + 1] : "jev";
let judge: Judge;
if (which === "jev") {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is missing (or run with --judge llm)");
  judge = createJevJudge({ key, gateway: { recordExternalUsage: async () => null }, timeoutMs: 10_000 });
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

const rows = await Promise.all(TURN_END_CASES.map(async (c) => ({ c, ...(await turnEndOf(judge, c)) })));
let right = 0;
for (const { c, got, rule } of rows) {
  const ok = got === c.want;
  if (ok) right++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${got.padEnd(8)}  ${rule.padEnd(12)}  ${c.id}`);
}
console.log(`\n${right}/${rows.length} right (${which})`);
process.exit(right === rows.length ? 0 : 1);
