import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AuditRow } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/*
 * A request's whole review (its facts, what it will write, how the run got to it) reads in its details dialog, over
 * the page the person is on. Requests are decided in the inbox (ADR 0218), on the conversation's own card; the list of
 * missions waiting is in Threads.
 */

/** The audit's row of the call that waits on the seed's merge request: its panel links to the request. */
const call: AuditRow = {
  id: "a1",
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  actor: { type: "agent", id: ADA_ID, name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "merge_pull_request" },
  details: { kind: "external", connector: "GitHub", behind: "person", approvalId: "ap-merge", input: {} },
  runId: "run-1",
  channelId: ENG_ID,
  channel: { id: ENG_ID, name: "eng", kind: "channel" },
  onBehalfOf: { id: "u-walter", name: "Walter" },
  outcome: "pending",
  approval: { id: "ap-merge", status: "pending", decidedBy: null },
  secret: null,
};

/** The merge request's details, opened from the audit's row over that page. */
async function details(state: ReturnType<typeof seedState>) {
  state.audit = [call];
  const { router } = await renderApp(`/org/${ORG_ID}/settings/audit`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => fireEvent.click(document.querySelector(".audit-row") as HTMLElement));
  await settle(4);
  const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
  await act(async () => fireEvent.click(within(panel).getByRole("link", { name: "Ver o pedido" })));
  await settle(8);
  // Over the page, which stays where it was.
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/audit`);
  return document.querySelector(".ap-dialog") as HTMLElement;
}

describe("A request's details: how it got here", () => {
  test("how it got here: the run's steps before the ask, then the ask itself, on one track", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge?.runId) throw new Error("no approval");
    const asked = Date.parse(merge.createdAt);
    const at = (seconds: number) => new Date(asked + seconds * 1000).toISOString();
    state.runSteps = {
      [merge.runId]: [
        { seq: 1, kind: "tool_call", data: { toolUseId: "c1", name: "search_context", input: {} }, createdAt: at(-60) },
        { seq: 2, kind: "tool_result", data: { toolUseId: "c1", content: "ok" }, createdAt: at(-59) },
        { seq: 3, kind: "tool_call", data: { toolUseId: "c2", name: "read_wiki_page", input: {} }, createdAt: at(-30) },
        { seq: 4, kind: "tool_result", data: { toolUseId: "c2", content: "ok" }, createdAt: at(-29) },
        // The call that waits on the decision: the ask stands for it.
        {
          seq: 5,
          kind: "tool_call",
          data: { toolUseId: "c3", name: "github_merge_pull_request", connector: "github", input: {} },
          createdAt: at(0),
        },
      ],
    };
    const pane = await details(state);
    expect(pane.textContent).toContain("Fazer um merge");
    const track = within(pane).getByRole("list", { name: "Como chegou aqui" });
    const steps = [...track.querySelectorAll(".ac-track__step")];
    expect(steps.map((li) => [...li.classList].find((c) => c.startsWith("is-")))).toEqual([
      "is-done",
      "is-done",
      "is-now",
    ]);
    // No words under the nodes: one line under the track tells the step that waits, whole, with its time.
    const line = () => pane.querySelector(".ac-track__line")?.textContent ?? "";
    const nodes = within(track).getAllByRole("button");
    expect(nodes.at(-1)?.getAttribute("aria-current")).toBe("step");
    expect(nodes.at(-1)?.hasAttribute("data-told")).toBe(true);
    expect(line()).toStartWith("Pediu aprovação · ");
    expect(line()).toBe(nodes.at(-1)?.getAttribute("aria-label") ?? "");
    // Pointing at another node tells that one instead, and leaving goes back.
    const first = nodes[0] as HTMLElement;
    await act(async () => fireEvent.mouseEnter(first));
    expect(line()).toBe(first.getAttribute("aria-label") ?? "");
    expect(line()).not.toBe("");
    await act(async () => fireEvent.mouseLeave(first));
    expect(line()).toStartWith("Pediu aprovação");
    // "See each step" unfolds them as the reply's tool block.
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Ver cada passo" })));
    await settle(4);
    expect(within(pane).getByRole("button", { name: "Esconder os passos" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("A request's details: a long way to the request", () => {
  test("60 steps with long commands: the middle folds into one node, and the line tells any step whole", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge?.runId) throw new Error("no approval");
    const asked = Date.parse(merge.createdAt);
    const at = (seconds: number) => new Date(asked + seconds * 1000).toISOString();
    const command =
      "git log --oneline origin/main..HEAD -- packages/engine/src/context/memory.ts packages/engine/src/context/items.ts apps/server/test";
    state.runSteps = {
      [merge.runId]: [
        ...Array.from({ length: 59 }, (_, i) => [
          {
            seq: i * 2 + 1,
            kind: "tool_call" as const,
            data: { toolUseId: `c${i}`, name: "permission_prompt", detail: `${command} # ${i}`, input: {} },
            createdAt: at(-600 + i * 10),
          },
          {
            seq: i * 2 + 2,
            kind: "tool_result" as const,
            data: { toolUseId: `c${i}`, content: "ok", ...(i === 57 ? { isError: true } : {}) },
            createdAt: at(-599 + i * 10),
          },
        ]).flat(),
        {
          seq: 119,
          kind: "tool_call",
          data: { toolUseId: "ask", name: "github_merge_pull_request", connector: "github", input: {} },
          createdAt: at(0),
        },
      ],
    };
    const pane = await details(state);
    expect(pane.textContent).toContain("Fazer um merge");
    const track = within(pane).getByRole("list", { name: "Como chegou aqui" });
    const nodes = within(track).getAllByRole("button");
    const line = () => pane.querySelector(".ac-track__line")?.textContent ?? "";
    // 60 steps on 8 nodes: the first two, 53 folded, the last five.
    expect(nodes).toHaveLength(8);
    expect(nodes[2]?.getAttribute("aria-label")).toBe("53 passos");
    expect(track.querySelector(".ac-track__label")).toBeNull();
    expect(line()).toStartWith("Pediu aprovação");
    // The first step's whole command, however long.
    await act(async () => fireEvent.mouseEnter(nodes[0] as HTMLElement));
    await settle(2);
    expect(line()).toBe(nodes[0]?.getAttribute("aria-label") ?? "");
    expect(line()).toBe(`Rodou: ${command} # 0`);
    expect(line().length).toBeGreaterThan(120);
    // A press keeps a step told after the pointer leaves.
    await act(async () => fireEvent.click(nodes[0] as HTMLElement));
    await act(async () => fireEvent.mouseLeave(nodes[0] as HTMLElement));
    await settle(2);
    expect(line()).toBe(`Rodou: ${command} # 0`);
    expect(nodes[0]?.hasAttribute("data-told")).toBe(true);
    // The folded node tells how many it holds under the pointer, and a press on it shows them all.
    await act(async () => fireEvent.mouseEnter(nodes[2] as HTMLElement));
    await settle(2);
    expect(line()).toBe("53 passos");
    expect(within(pane).queryByRole("button", { name: "Esconder os passos" })).toBeNull();
    await act(async () => fireEvent.click(nodes[2] as HTMLElement));
    await settle(4);
    expect(within(pane).getByRole("button", { name: "Esconder os passos" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("A request's details: what it will publish", () => {
  test("a long text to publish folds, and Ver mais under it opens it in place for good", async () => {
    const state = seedState();
    const long = Array.from({ length: 9 }, (_, i) => `Parágrafo ${i + 1} do texto que vai sair.`).join("\n\n");
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    // A GitHub comment: its body is the text.
    Object.assign(merge, {
      tool: "add_issue_comment",
      scope: "github:issues.write",
      title: "GitHub: add_issue_comment",
      detail: "add_issue_comment · acme/loja · issue 45",
      connector: "github",
      params: { owner: "acme", repo: "loja", issue_number: 45, body: long },
    });
    const pane = await details(state);
    expect(pane.textContent).toContain("O que vai ser publicado");
    const text = pane.querySelector(".ap-review__text") as HTMLElement;
    expect(text.classList.contains("is-folded")).toBe(true);
    // On the request's one surface, no card around it: "Ver mais" goes under the words, as a message's.
    expect(text.closest(".ac-card")).toBeNull();
    await act(async () =>
      fireEvent.click(within(text.parentElement as HTMLElement).getByRole("button", { name: "Ver mais" })),
    );
    await settle(4);
    expect(text.classList.contains("is-folded")).toBe(false);
    expect(within(pane).queryByRole("button", { name: /^(Ver menos|Mostrar menos|Ver inteiro)$/ })).toBeNull();
    expect(within(text.parentElement as HTMLElement).queryByRole("button", { name: "Ver mais" })).toBeNull();
    expect(document.activeElement === text).toBe(true);
  });
});

describe("A request's details: asked of a role (request_approval)", () => {
  test("waits for the role, not the agent's owner; the role decides, and the requester who approves by role is said", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    Object.assign(merge, {
      tool: "request_approval",
      canDecide: false,
      approvers: { label: "Diretoria", requestedByUserId: "u-requester", requesterDecides: true },
    });
    // Who decides is the role, and the bar says the requester may decide too, without buttons.
    const pane = await details(state);
    const facts = [...pane.querySelectorAll(".ac-facts__item")].map((f) => [
      f.querySelector(".ac-facts__label")?.textContent,
      f.querySelector(".ac-facts__value")?.textContent,
    ]);
    expect(facts).toContainEqual(["Quem decide", "Aguardando Diretoria"]);
    expect(pane.querySelector(".ap-bar__text")?.textContent).toContain("Pedido por quem também aprova pelo cargo");
    expect(pane.querySelector("[data-approve]")).toBeNull();
  });
});
