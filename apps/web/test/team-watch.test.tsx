import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("what the right hand found: the problem itself as the headline, in the reader's language, and a button that names the way out", async () => {
  const state = seedState({
    notifications: [
      notification({
        id: "n-apps",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        count: 4,
        latest: {
          reason: "connector",
          names: ["Slack", "Notion", "Linear"],
          text: "Slack, Notion, Linear, and 1 more need reconnecting.",
        },
      }),
      notification({
        id: "n-plan",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        latest: { reason: "sign_in", names: ["Claude da Ana"], text: "The sign-in for Claude da Ana ended." },
      }),
      notification({
        id: "n-out",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { agentId: ADA_ID },
        latest: { reason: "budget_out", names: ["Ada"], text: "Ada is out of budget." },
      }),
      notification({
        id: "n-pc",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        latest: { reason: "computer", names: ["Mac do escritório"], text: "The computer is offline." },
      }),
      notification({
        id: "n-budget",
        kind: "team_watch",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { agentId: ADA_ID },
        latest: { reason: "budget_low", names: ["Ada"], text: "Ada is about to run out of budget." },
      }),
      // A cause from a newer server: its own sentence stands.
      notification({
        id: "n-new",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        latest: { reason: "something_new", names: ["X"], text: "Algo novo parou. Veja em Configurações" },
      }),
    ],
  });
  await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(8);
  const waiting = screen().getByRole("region", { name: "Esperando você" });
  const row = (id: string) => waiting.querySelector(`[data-n="${id}"]`) as HTMLElement;
  const apps = row("n-apps");
  // The headline is the problem, said for how many there are. Nothing under it says it again, and who found it is
  // named once, on the row's top line.
  expect(apps.querySelector(".rq__lead")?.textContent).toBe(
    "Slack, Notion, Linear e mais 1 precisam ser reconectados.",
  );
  expect(apps.querySelector(".nt-wr__sub")).toBeNull();
  expect(apps.querySelector(".rq__who")?.textContent).toBe("Ada");
  expect(apps.querySelector(".rq__lead")?.textContent).not.toContain("Ada");
  expect(apps.querySelector(".nt-wr__src")?.textContent).toBe("Conectores e MCPs");
  // The row's one button is the way out of its cause, never a plain Abrir.
  const button = (id: string) => row(id).querySelector(".nt-wr__open")?.textContent;
  expect(button("n-apps")).toBe("Reconectar");
  expect(row("n-plan").querySelector(".rq__lead")?.textContent).toBe("O login de Claude da Ana acabou.");
  expect(button("n-plan")).toBe("Entrar de novo");
  expect(row("n-out").querySelector(".rq__lead")?.textContent).toBe("O orçamento de Ada acabou.");
  expect(button("n-out")).toBe("Aumentar orçamento");
  expect(row("n-pc").querySelector(".rq__lead")?.textContent).toBe(
    "Mac do escritório está offline com agentes esperando.",
  );
  expect(button("n-pc")).toBe("Trocar computador");
  expect(within(waiting).queryByRole("button", { name: "Abrir" })).toBe(row("n-new").querySelector(".nt-wr__open"));
  // A cause this build doesn't know: the server's sentence is the headline, and its button only opens.
  const unknown = row("n-new");
  expect(unknown.querySelector(".rq__lead")?.textContent).toBe("Algo novo parou. Veja em Configurações");
  expect(unknown.querySelector(".nt-wr__sub")).toBeNull();

  // A budget about to end waits on nobody: a plain row, its sentence said once.
  const budget = document.querySelector('[data-n="n-budget"]') as HTMLElement;
  expect(waiting.contains(budget)).toBe(false);
  expect(budget.querySelector(".nt-what")?.textContent).toBe("O orçamento de Ada está quase no fim.");
  expect(budget.querySelector(".nt-snip")).toBeNull();
});
