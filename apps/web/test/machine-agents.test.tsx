import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Machine } from "@agenteschat/client";
import { SHARED_SEAT } from "@agenteschat/client/lib/seat";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { OpenComputerContext } from "@/components/computer/open";
import { MachineAgents } from "@/components/Machines";
import { ADA_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(cleanup);

/** Ada on a computer where each agent is its own user, as an owner sees its page. */
async function page(over: Partial<Machine> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const screens = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!screens || !machines) throw new Error("no fakes");
  const paired = machines.pair({ name: "Servidor", os: "linux", mode: "system" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, paired.id);
  screens.desktops.set(ADA_ID, { available: true, reason: null, running: true, canControl: true });
  const machine = (await api.machines.list(ORG_ID)).find((m) => m.id === paired.id);
  if (!machine) throw new Error("no machine");
  const opened: unknown[][] = [];
  await renderPage(
    <OpenComputerContext.Provider value={(...args) => opened.push(args)}>
      <MachineAgents machine={{ ...machine, ...over }} />
    </OpenComputerContext.Provider>,
    { api, org: true },
  );
  await settle(6);
  const rows = () => [...document.querySelectorAll<HTMLElement>(".machine-page__agent-row")];
  return { state, rows, opened };
}

test("an agent's shared place is a row of its own, named for what it is, and Abrir opens that place", async () => {
  const t = await page({ sharedSeatOf: ADA_ID });
  const [own, shared] = t.rows();
  expect(t.rows()).toHaveLength(2);
  expect(own?.textContent).not.toContain("compartilhado");
  expect(shared?.textContent).toContain("Ada (compartilhado)");
  expect(shared?.textContent).toContain("Todo o workspace compartilha este espaço");
  // Its screen's state is asked of that place, apart from the agent's own.
  const asked = t.state.calls.filter((c) => c.method === "desktop.status").map((c) => c.args[2]);
  expect(asked).toContain(SHARED_SEAT);
  expect(asked).toContain(undefined);
  const open = (row: HTMLElement | undefined) => within(row as HTMLElement).getByRole("button", { name: /^Abrir/ });
  expect(open(shared).getAttribute("aria-label")).toBe("Abrir: Computador da Ada (compartilhado)");
  await act(async () => fireEvent.click(open(shared)));
  await act(async () => fireEvent.click(open(own)));
  expect(t.opened).toEqual([
    [ADA_ID, SHARED_SEAT],
    [ADA_ID, undefined],
  ]);
});

test("nobody the server doesn't show it to gets that row", async () => {
  const t = await page();
  expect(t.rows()).toHaveLength(1);
  expect(document.body.textContent).not.toContain("compartilhado");
});
