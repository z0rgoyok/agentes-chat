import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { ApiError } from "../src/index";
import { APPROVAL_REASON_MAX } from "../src/lib/approval-card";
import { FIELD_LIMITS } from "../src/lib/field-limits";
import { LIMIT_NEAR, overLimitText, tooLongRefusal, tooLongToSend } from "../src/lib/message-length";

const root = join(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const num = (s: string) => Number(s.replace(/_/g, ""));

test("each field's limit is the number its route takes", () => {
  const routes = (file: string) => read(`apps/server/src/routes/app/${file}`);
  const has = (source: string, pattern: RegExp, limit: number) =>
    expect([...source.matchAll(pattern)].map((m) => num(m[1] ?? ""))).toContain(limit);
  has(routes("agents.ts"), /instructions: z\.string\(\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.instructions);
  has(routes("memory.ts"), /text: z\.string\(\)\.min\(1\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.memory);
  has(routes("account.ts"), /const Context = z\.string\(\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.workspaceContext);
  has(routes("routines.ts"), /prompt: z\.string\(\)\.min\(1\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.routinePrompt);
  has(routes("calendar.ts"), /description: z\.string\(\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.eventDescription);
  has(routes("issues.ts"), /description: z\.string\(\)\.max\(([\d_]+)\)/g, FIELD_LIMITS.issueDescription);
  has(read("packages/engine/src/right-hand-approvals.ts"), /guidanceChars: ([\d_]+)/g, FIELD_LIMITS.rightHandGuidance);
  has(read("packages/engine/src/approvals.ts"), /export const APPROVAL_REASON_MAX = ([\d_]+)/g, APPROVAL_REASON_MAX);
  has(read("packages/ui/src/components/Field.tsx"), /const LIMIT_NEAR = ([\d.]+)/g, LIMIT_NEAR);
});

test("a field's limit counts as the server does, and its line says the size, the limit and the way out", () => {
  expect(tooLongToSend(` ${"x".repeat(300)} `, 300)).toBe(false);
  expect(tooLongToSend("x".repeat(301), 300)).toBe(true);
  const i18n = i18next.createInstance();
  void i18n.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });
  expect(overLimitText(i18n.t, "pt-BR", 20_512, 20_000)).toBe(
    "O texto tem 20.512 caracteres e o limite é 20.000. Encurte o texto.",
  );
  const refused = new ApiError(400, "message.too_long", "Message is longer than 100000 characters", {
    length: 100_412,
    max: 100_000,
  });
  expect(tooLongRefusal(i18n.t, "pt-BR", refused, "Encurte a resposta.")).toBe(
    "A mensagem tem 100.412 caracteres e o limite é 100.000. Encurte a resposta.",
  );
  expect(tooLongRefusal(i18n.t, "pt-BR", new ApiError(500, "internal", "boom"), "Encurte a resposta.")).toBeNull();
});
