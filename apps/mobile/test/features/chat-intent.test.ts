import { describe, expect, test } from "bun:test";
import { agentIntro, firstAskKind, firstAsks, isNewAgent, plainWhat } from "../../src/features/chat/intent";
import { agent } from "./fixtures";

describe("first conversation with an agent", () => {
  test("introduces itself with what it does, in one plain sentence", () => {
    expect(plainWhat("Responder os clientes no e-mail e me chamar quando for urgente")).toBe(
      "Responder os clientes no e-mail e me chamar quando for urgente.",
    );
    expect(plainWhat("# Função\n- cuida do código do app. Usa o GitHub.")).toBe("Cuida do código do app.");
    expect(plainWhat("Pesquisa mercado!")).toBe("Pesquisa mercado.");
  });

  test("a prompt, too short or too long is not an introduction", () => {
    expect(plainWhat("Você é a Lu, uma agente de atendimento.")).toBeNull();
    expect(plainWhat("You are a helpful assistant.")).toBeNull();
    expect(plainWhat("oi")).toBeNull();
    expect(plainWhat("a".repeat(200))).toBeNull();
    expect(plainWhat("")).toBeNull();
  });

  test("falls back to the role, then nothing", () => {
    expect(agentIntro({ role: "Dev", instructions: "You are a coder." })).toEqual({ kind: "role", role: "Dev" });
    expect(agentIntro({ role: " ", instructions: "" })).toEqual({ kind: "none" });
    expect(agentIntro({ role: "Dev", instructions: "Cuida do código do app e do site" })).toEqual({
      kind: "what",
      text: "Cuida do código do app e do site.",
    });
  });

  test("first requests follow what it does (role first, then instructions)", () => {
    expect(firstAskKind({ role: "Atendimento", instructions: "" })).toBe("support");
    expect(firstAskKind({ role: "", instructions: "Responde os clientes no e-mail" })).toBe("support");
    expect(firstAskKind({ role: "Dev", instructions: "Responde clientes" })).toBe("dev");
    expect(firstAskKind({ role: "Operações", instructions: "" })).toBe("ops");
    expect(firstAskKind({ role: "", instructions: "Pesquisa mercado e concorrentes" })).toBe("research");
    expect(firstAskKind({ role: "", instructions: "Escrever relatórios da semana" })).toBe("writing");
    expect(firstAskKind({ role: "QA", instructions: "" })).toBe("qa");
    expect(firstAskKind({ role: "PM", instructions: "" })).toBe("product");
    expect(firstAskKind({ role: "", instructions: "Cuida das vendas" })).toBe("sales");
    expect(firstAskKind({ role: "", instructions: "Ajuda no dia a dia" })).toBe("general");
    expect(firstAsks(agent({ id: "a", name: "Lu", role: "Atendimento" })).map((a) => a.key)).toEqual([
      "support.how",
      "support.task",
      "support.routine",
    ]);
  });

  test("new in the team for two weeks", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(isNewAgent("2026-10-17T12:00:00Z", now)).toBe(true);
    expect(isNewAgent("2026-09-01T12:00:00Z", now)).toBe(false);
  });
});
