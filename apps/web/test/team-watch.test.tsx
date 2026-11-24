import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("what the right hand found: the problem itself as the headline, in the reader's language, and a button that names the way out", async () => {
  const state = seedState({
    // The seed's proposals would be rows among what waits (ADR 0218): this is about what the right hand found.
    proposals: [],
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
  const row = (id: string) => document.querySelector(`.ib-list [data-n="${id}"]`) as HTMLElement;
  /** A click on a row opens it beside the list (ADR 0218). */
  const open = async (id: string) => {
    await act(async () => fireEvent.click(row(id)));
    await settle(4);
    return document.querySelector("section.ib-read") as HTMLElement;
  };
  const headline = (id: string) => row(id).querySelector(".ib-row__line")?.textContent;
  /** The open item's one button: the way out of its cause, never a plain Abrir. */
  const button = async (id: string) =>
    within((await open(id)).querySelector(".ib-decide") as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.textContent);
  for (const id of ["n-apps", "n-plan", "n-out", "n-pc", "n-new"]) expect(waiting.contains(row(id))).toBe(true);
  // The headline is the problem, said for how many there are. Nothing under it says it again: the line under it is
  // only where it is fixed.
  expect(headline("n-apps")).toBe("Slack, Notion, Linear e mais 1 precisam ser reconectados.");
  expect(headline("n-apps")).not.toContain("Ada");
  expect(row("n-apps").querySelector(".ib-row__sub")?.textContent).toBe("Conectores e MCPs");
  // Open: who found it is named once, on the line over the headline, and no words repeat it under.
  const apps = await open("n-apps");
  expect(apps.querySelector(".ib-read__who")?.textContent).toMatch(/^Ada · Conectores e MCPs · /);
  expect(apps.querySelector("h2.ib-read__title")?.textContent).toBe(
    "Slack, Notion, Linear e mais 1 precisam ser reconectados.",
  );
  expect(apps.querySelector(".ib-read__say")).toBeNull();
  expect(await button("n-apps")).toEqual(["Reconectar"]);
  expect(headline("n-plan")).toBe("O login de Claude da Ana acabou.");
  expect(await button("n-plan")).toEqual(["Entrar de novo"]);
  expect(headline("n-out")).toBe("O orçamento de Ada acabou.");
  expect(await button("n-out")).toEqual(["Aumentar orçamento"]);
  expect(headline("n-pc")).toBe("Mac do escritório está offline com agentes esperando.");
  expect(await button("n-pc")).toEqual(["Trocar computador"]);
  // A cause this build doesn't know: the server's sentence is the headline, and its button only opens.
  expect(headline("n-new")).toBe("Algo novo parou. Veja em Configurações");
  expect(row("n-new").querySelector(".ib-row__sub")).toBeNull();
  expect(await button("n-new")).toEqual(["Abrir"]);
  expect(document.querySelector("section.ib-read .ib-read__say")).toBeNull();

  // A budget about to end waits on nobody: a plain row, its sentence said once.
  const budget = row("n-budget");
  expect(waiting.contains(budget)).toBe(false);
  expect(headline("n-budget")).toBe("O orçamento de Ada está quase no fim.");
  // Its sentence isn't said again: the line under it is only where it's fixed, in plain words.
  expect(budget.querySelector(".ib-row__sub")?.textContent).toBe("IA e uso");
  expect((await open("n-budget")).querySelector(".ib-read__say")).toBeNull();
});
