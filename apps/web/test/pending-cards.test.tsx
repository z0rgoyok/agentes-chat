import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { AddressBar } from "../src/components/browser/AddressBar";
import { RequestCard } from "../src/components/RequestCard";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** happy-dom's `:disabled` doesn't see a fieldset's. */
const off = (el: Element) => (el as HTMLButtonElement).disabled || el.closest("fieldset[disabled]") !== null;

describe("a form whose action is on its way", () => {
  test("what the CSS reached as a child it still reaches through the lock's fieldset", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    expect(await read("../src/components/tasks/tasks.css")).toMatch(/\.tm-saywhy \.tm-why \{\s*flex: 1;/);
    expect(await read("../src/layout.css")).toContain(".rq > .ac-locked > .waitcard__lines {");
  });

  test("the kit's small buttons with no disabled look of their own dim with the form", async () => {
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    for (const name of [".ac-recur__day", ".ac-token__remove", ".ac-searchfield__clear", ".ac-setmore__toggle"])
      expect(css).toMatch(new RegExp(`\\.ac-locked:disabled :is\\([^)]*\\${name}`));
  });

  test("what a fieldset can't stop waits on the flag itself: a dropped file, the photo's crop", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    expect(await read("../src/components/vault/VaultImportDialog.tsx")).toContain("return !importer.busy;");
    const photo = await read("../src/components/ProfilePhoto.tsx");
    expect(photo).toContain("if (busy) return;");
    expect(photo).toContain("if (!busy) void choose(");
  });

  test("the island's reply locks with its send; a mission's join answer takes its row away at once, with no lock", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    const island = await read("../src/components/NoticeIsland.tsx");
    expect(island).toMatch(/<Locked when=\{reply\.isPending\}>\s*<input/);
    const mission = await read("../src/components/missions/MissionDialogs.tsx");
    expect(mission).not.toMatch(/<Locked when=\{decide\.isPending\}>/);
    expect(mission).toMatch(/decide\.mutateAsync\(/);
  });

  const card = (locked: boolean) => (
    <RequestCard
      id="r1"
      kind="question"
      agent={undefined}
      label="Pedido"
      mine
      lead="Qual?"
      object={{ logo: null, title: "Objeto", more: "Ver" }}
      details={<input aria-label="detalhe" defaultValue="d" />}
      body={<input aria-label="campo" defaultValue="escrito" />}
      actions={<button type="button">Enviar</button>}
      end={<button type="button">Pular</button>}
      what="Pedido"
      locked={locked}
    />
  );

  test("a request card turns off what it holds and keeps it, while Ver still opens", () => {
    const { rerender } = render(card(false));
    fireEvent.click(screen().getByRole("button", { name: "Ver" }));
    rerender(card(true));
    const field = screen().getByLabelText("campo") as HTMLInputElement;
    for (const el of [field, screen().getByLabelText("detalhe")]) expect(off(el)).toBe(true);
    for (const name of ["Enviar", "Pular"]) expect(off(screen().getByRole("button", { name }))).toBe(true);
    expect(field.value).toBe("escrito");
    expect(off(screen().getByRole("button", { name: "Ver" }))).toBe(false);
    rerender(card(false));
    expect(off(field)).toBe(false);
  });

  test("one button deciding a request turns off the others on it, whichever mutation each runs", async () => {
    // Three requests on one card, waiting on me in the inbox, where they are decided (ADR 0218).
    const state = seedState({
      notifications: [
        notification({
          id: "n-merge",
          kind: "approval",
          waiting: true,
          actors: [{ type: "agent", id: ADA_ID }],
          source: { approvalId: "ap-merge", channelId: ENG_ID },
        }),
      ],
    });
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("the seed's merge request");
    const other = (id: string, tool: string, title: string, minutes: number) => ({
      ...merge,
      id,
      tool,
      title,
      detail: tool,
      createdAt: new Date(Date.parse(merge.createdAt) + minutes * 60_000).toISOString(),
    });
    state.approvals = [
      merge,
      other("ap-issue", "create_issue", "Create issue", 1),
      other("ap-comment", "add_issue_comment", "Add issue comment", 2),
    ];
    const api = createFakeApi(state);
    let finish = () => {};
    const approve = api.approvals.approve;
    api.approvals.approve = async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return approve(...args);
    };
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(4);
    const card = document.querySelector(".ib-read .rq") as HTMLElement;
    // One request's own button approves it alone; "Approve all" over the card is another mutation.
    const all = () => within(card).getByRole("button", { name: "Aprovar tudo" });
    const others = () => [...card.querySelectorAll<HTMLElement>('.rq__item[data-status="pending"] [data-approve]')];
    expect(others()).toHaveLength(3);
    expect(off(all())).toBe(false);
    await act(async () => fireEvent.click(card.querySelector('[data-approve="ap-merge"]') as HTMLElement));
    await settle(2);
    expect(others().map((b) => b.getAttribute("data-approve"))).toEqual(["ap-issue", "ap-comment"]);
    expect(off(all())).toBe(true);
    for (const button of others()) expect(off(button)).toBe(true);
    await act(async () => finish());
    await settle(4);
    expect(off(all())).toBe(false);
  });

  const failing = (open: () => Promise<void>) => (
    <AddressBar url="https://a.test" host="a.test" grammar={{ name: "Lia" } as never} onOpen={open} />
  );
  const typeAndSend = async (input: HTMLInputElement) => {
    input.focus();
    fireEvent.change(input, { target: { value: "b.test" } });
    await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement));
  };

  test("the address bar: refused, it opens up with the words typed and the focus back; opened, the bar lets go", async () => {
    let settleOpen: (fail: boolean) => void = () => {};
    const open = () =>
      new Promise<void>((resolve, reject) => {
        settleOpen = (fail) => (fail ? reject(new Error("no")) : resolve());
      });
    const { container } = render(failing(open));
    const input = container.querySelector("input") as HTMLInputElement;
    await typeAndSend(input);
    expect(off(input)).toBe(true);
    input.blur();
    await act(async () => settleOpen(true));
    await settle(1);
    expect(off(input)).toBe(false);
    expect(input.value).toBe("b.test");
    expect(document.activeElement === input).toBe(true);
    await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement));
    input.blur();
    await act(async () => settleOpen(false));
    await settle(1);
    expect(document.activeElement === input).toBe(false);
    expect(input.value).toBe("a.test");
  });
});
