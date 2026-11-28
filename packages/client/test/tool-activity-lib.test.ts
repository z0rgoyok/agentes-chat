import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { serverBody } from "../src/lib/message-body";
import { showsActivity } from "../src/lib/work";

test("a reply's tools show only for a person who turned them on: off by default and with an older server", () => {
  expect(showsActivity({ showActivity: true })).toBe(true);
  expect(showsActivity({ showActivity: false })).toBe(false);
  expect(showsActivity({})).toBe(false);
  expect(showsActivity(null)).toBe(false);
});

test("a secret request's text names who asked; one posted before that reads without a name", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const meta = (bodyParams: Record<string, string>) => ({ bodyCode: "secret_request", bodyParams });
  expect(serverBody(t, "…", meta({ agent: "Ada", name: "BILLING_API_KEY" }))).toBe("chat.body.secret_request");
  expect(serverBody(t, "…", meta({ name: "BILLING_API_KEY" }))).toBe("chat.body.secret_requestAnon");
});

test("a computer brain cut mid-turn says why and the way on in the person's words, never the tools it ran", async () => {
  const { resources } = await import("@agenteschat/i18n");
  const i18next = (await import("i18next")).default;
  const lang = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
    return instance.t;
  };
  const cut = (code: string, text = "") => ({
    brainInterrupted: {
      brain: "claude_code",
      code,
      text,
      tools: ["run_code", "mcp__agentes__update_plan", "github_list_issues", "run_code"],
    },
  });
  expect(serverBody(lang("pt-BR"), "…", cut("canceled"), "pt-BR")).toBe(
    "_O computador parou o Claude Code antes de terminar. Peça de novo para continuar._",
  );
  expect(serverBody(lang("en"), "…", cut("canceled"), "en")).toBe(
    "_The computer stopped Claude Code before it finished. Ask again to continue._",
  );
  expect(serverBody(lang("en"), "…", cut("timeout"), "en")).toBe(
    "_Claude Code ran past its time limit and stopped before finishing. Ask again to continue._",
  );
  expect(serverBody(lang("en"), "…", cut("executor_crashed", "Installing Go now."), "en")).toBe(
    "Installing Go now.\n\n_Claude Code stopped before finishing. Ask again to continue._",
  );
  for (const lng of ["pt-BR", "en", "de", "ja"])
    expect(serverBody(lang(lng), "…", cut("canceled"), lng)).not.toMatch(/GitHub|update_plan|run_code/);
});
