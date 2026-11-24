import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgPlanUsage, PlanAccountUsage } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { shareLabel, shareRow } from "./plan-rows";
import { renderApp, screen, settle, showIn } from "./render";

/**
 * Settings › AI and usage: under an open account's agents, its use by kind, both behind "Detalhes", and near the limit,
 * when handoffs between agents led the week, a hint to message the agent that took most of that work.
 */

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function claudeMax(over: Partial<PlanAccountUsage> = {}): PlanAccountUsage {
  return {
    key: "machine_1:claude_code:acct_max",
    machineId: "machine_1",
    machineName: "MacBook",
    kind: "claude_code",
    accountId: "acct_max",
    label: "Claude Max",
    plan: "max",
    provider: null,
    ownerName: "Walter",
    mine: false,
    email: null,
    signedOut: false,
    usage: {
      windows: [
        {
          kind: "five_hour",
          usedPercent: 86,
          resetsAt: soon(2),
          agents: [
            { agentId: LODI_ID, name: "Lodi", percent: 44 },
            { agentId: ADA_ID, name: "Ada", percent: 27 },
            { agentId: ATLAS_ID, name: "Atlas", percent: 15 },
          ],
        },
        {
          kind: "seven_day",
          usedPercent: 71,
          resetsAt: soon(72),
          agents: [
            { agentId: LODI_ID, name: "Lodi", percent: 33 },
            { agentId: ADA_ID, name: "Ada", percent: 24 },
            { agentId: ATLAS_ID, name: "Atlas", percent: 14 },
          ],
        },
      ],
      source: "turn",
      at: new Date().toISOString(),
    },
    agents: [
      { agentId: LODI_ID, name: "Lodi", tokens: 6_200_000, now: true },
      { agentId: ADA_ID, name: "Ada", tokens: 4_500_000, now: true },
      { agentId: ATLAS_ID, name: "Atlas", tokens: 2_600_000, now: true },
    ],
    monthTokens: 13_300_000,
    kinds: [
      { kind: "routines", tokens: 1_400_000, percent: 7 },
      { kind: "handoffs", tokens: 6_900_000, percent: 37 },
      { kind: "people", tokens: 5_000_000, percent: 27 },
    ],
    hint: { kind: "handoffs", agentId: ADA_ID },
    ...over,
  };
}

async function openUsage(account: PlanAccountUsage, lang?: "en") {
  const api = createFakeApi(withRightHand(seedState()));
  api.orgs.planUsage = async (): Promise<OrgPlanUsage> => ({
    month: new Date().toISOString().slice(0, 7),
    money: false,
    api: [],
    accounts: [account],
  });
  const { services } = await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
  await settle(6);
  if (lang) await showIn(services, lang);
  await act(async () =>
    fireEvent.mouseDown(screen().getByRole("tab", { name: lang === "en" ? "Usage" : "Uso" }), { button: 0 }),
  );
  await settle(4);
  const head = document.querySelector(".plan-row__head");
  // Every row starts closed, near its limit too.
  expect(head?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => fireEvent.click(head as Element));
  await settle(4);
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  return document.querySelector(".plan-row__body") as HTMLElement;
}

test("an open account keeps its agents and kinds behind Detalhes, closed, and the bars plain until it opens", async () => {
  const body = await openUsage(claudeMax());
  const details = body.querySelector("details.plan-details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Detalhes");
  // Everything past the bars waits inside it: the agents, the kinds, the month's tokens.
  expect(details.querySelector(".plan-kinds")).not.toBeNull();
  expect(details.textContent).toContain("13,3 mi tokens este mês");
  expect(body.querySelectorAll(".ac-meter__seg")).toHaveLength(0);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(body.querySelectorAll(".ac-meter__seg").length).toBeGreaterThan(0);
  cleanup();
});

test("an open account lists its use by kind under the agents, handoffs first, and near the limit offers to message Ada", async () => {
  const body = await openUsage(claudeMax(), "en");
  // Two labelled groups: the agents, then the use by kind, the window's name over their shares.
  const labels = [...body.querySelectorAll(".plan-group__label")];
  expect(labels.map(shareLabel)).toEqual(["Agents", "By kind"]);
  expect(labels[0]?.querySelector(".plan-shares__share")?.textContent).toBe("week");
  const rows = [...body.querySelectorAll(".plan-kinds .plan-shares__row")].map(shareRow);
  expect(rows).toEqual([
    "Handoffs between agents · 37% · 6.9M tokens",
    "Conversations with people · 27% · 5M tokens",
    "Routines · 7% · 1.4M tokens",
  ]);
  const hint = body.querySelector(".plan-kinds__hint") as HTMLElement;
  expect(hint.textContent).toContain("Most of it came from handoffs between agents.");
  const link = within(hint).getByRole("link", { name: "Message Ada" });
  expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  cleanup();
});

test("far from the limit, no hint: it would only be noise", async () => {
  const base = claudeMax();
  const usage = base.usage && {
    ...base.usage,
    windows: base.usage.windows.map((w) => ({ ...w, usedPercent: 40 })),
  };
  const body = await openUsage({ ...base, usage });
  expect(body.querySelector(".plan-kinds__hint")).toBeNull();
  cleanup();
});

test("no hint from the server, no hint; no kinds (an older server), no list", async () => {
  let body = await openUsage(claudeMax({ hint: null }));
  expect(body.querySelectorAll(".plan-kinds .plan-shares__row")).toHaveLength(3);
  expect(body.querySelector(".plan-kinds__hint")).toBeNull();
  cleanup();
  const { kinds: _k, hint: _h, ...older } = claudeMax();
  body = await openUsage(older);
  expect(body.querySelector(".plan-kinds")).toBeNull();
  expect([...body.querySelectorAll(".plan-group__label")].map(shareLabel)).toEqual(["Agentes"]);
  cleanup();
});
