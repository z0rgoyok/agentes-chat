import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { toYmd } from "@agenteschat/client/lib/format";
import { cleanup } from "@testing-library/react";
import { pinFileClock } from "./clock";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

pinFileClock();

afterEach(() => cleanup());

/**
 * A stack of runs drawn shorter when it holds more: alone a run's name wraps (44px) and the stack takes in the run 40
 * minutes later (29px under it); holding both it shows two short rows (24px), which lets that run go again. Measured
 * as drawn on every render, the week flipped between one stack and two until React stopped it as an endless loop.
 */
test("the week's measured layout settles when what a stack holds changes how tall it is drawn", async () => {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("cal-week__runs")) return 0;
      return this.querySelectorAll(".cal-chip--run").length === 1 ? 44 : 24;
    },
  });
  try {
    const state = seedState();
    const api = createFakeApi(state);
    const agentId = state.agents[0]?.id ?? "";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [name, time] of [
      ["Bom dia", "07:00"],
      ["Resumo", "07:40"],
    ] as const)
      await api.routines.create(ORG_ID, {
        name,
        agentId,
        prompt: "Faça algo.",
        target: { type: "dm" },
        trigger: { type: "schedule", rule: { freq: "daily", times: [time], timezone } },
      });
    await renderApp(`/org/${ORG_ID}/calendar`, { api });
    await settle(8);
    const col = document.querySelector<HTMLElement>(`.cal-week__col[data-day="${toYmd(new Date())}"]`);
    expect(col).not.toBeNull();
    // One stack holds both runs, as the taller measure (the run alone, wrapping) said.
    const runs = (stack: Element) =>
      [...stack.querySelectorAll(".cal-chip--run")].map((chip) => chip.getAttribute("aria-label"));
    const stacks = [...(col?.querySelectorAll(".cal-week__runs") ?? [])].map(runs);
    expect(stacks.filter((names) => names.some((n) => /Bom dia|Resumo/.test(n ?? "")))).toEqual([
      ["Rotina Bom dia, 07:00", "Rotina Resumo, 07:40"],
    ]);
  } finally {
    if (own) Object.defineProperty(HTMLElement.prototype, "offsetHeight", own);
    else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  }
});
