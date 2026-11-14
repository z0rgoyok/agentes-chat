import { describe, expect, test } from "bun:test";
import { CONSULT_SUBJECT_CHARS, consultSubject } from "../src/lib/consultations";

describe("the subject of a question between agents", () => {
  test("its first sentence, as short as it is", () => {
    const question = "Investigate duplicate notifications. Then tell me who gets them.";
    expect(consultSubject(question)).toBe("Investigate duplicate notifications.");
  });

  test("a long one ends at a whole word within its bound, never passing for the whole", () => {
    const question = `Investigate why the same notification reaches ${"every member of the team ".repeat(8)}twice`;
    const subject = consultSubject(question);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(CONSULT_SUBJECT_CHARS);
    expect(question.startsWith(subject.slice(0, -1))).toBe(true);
    expect(question.charAt(subject.length - 1)).toBe(" ");
  });

  test("only its first line: a question written as a heading and a list, with no full stop, stays one line", () => {
    const listed = "Contexto:\n- a fila de e-mails dobrou\n- dois clientes reclamaram\n\nVeja o log de ontem";
    expect(consultSubject(listed)).toBe("Contexto:");
    expect(consultSubject("- a fila dobrou\n- dois clientes reclamaram")).toBe("a fila dobrou");
    // A heading frames what follows: the subject is the first line of prose under it.
    expect(consultSubject("## Notificações\n\nPor que chegam duas vezes? Veja o log.")).toBe(
      "Por que chegam duas vezes?",
    );
  });

  test("the relay line the server writes for the agent never reaches the subject", () => {
    const relayed =
      "[@ada mentioned you in #general, where you aren't a member, so it reaches you here]\n\nInvestigate duplicate notifications";
    expect(consultSubject(relayed)).toBe("Investigate duplicate notifications");
  });

  test("its Markdown marks are not part of it", () => {
    expect(consultSubject("**Investigate** the `duplicate` notifications")).toBe(
      "Investigate the duplicate notifications",
    );
  });

  test("no question, no subject", () => {
    expect(consultSubject("")).toBe("");
    expect(consultSubject("   \n ")).toBe("");
    expect(consultSubject(null)).toBe("");
    expect(consultSubject(undefined)).toBe("");
  });
});
