import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Machine } from "@agenteschat/client";
import { cleanup, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { Egress } from "@/components/computer/Egress";
import { createI18n } from "@/i18n";

afterEach(cleanup);

const workspaceComputer = (over: Partial<Machine> = {}) =>
  ({
    id: "m-cloud",
    kind: "managed",
    name: "Workspace computer",
    online: true,
    egress: null,
    egressVia: { machineId: "m-mac", name: "MacBook Pro da Ana", userName: "Ana Costa" },
    ...over,
  }) as Machine;

const line = (machine: Machine) =>
  render(
    <I18nextProvider i18n={createI18n("pt-BR")}>
      <Egress machine={machine} compact />
    </I18nextProvider>,
  ).container;

test("a lent internet names the computer alone: who connected it is its name's tip, with no icon of its own", () => {
  const box = line(workspaceComputer());
  expect(box.textContent).toBe("Agentes usam a internet de MacBook Pro da Ana");
  const name = [...box.querySelectorAll("span")].find((s) => s.textContent === "MacBook Pro da Ana");
  expect(name?.getAttribute("title")).toBe("Conectado por Ana Costa");
  // Its country is not known yet: the globe, never a flag from before.
  expect(box.querySelector("img")).toBeNull();
  expect(box.querySelectorAll("svg")).toHaveLength(1);
});

test("nobody named: the name has no tip; a country known for the route shows its flag", () => {
  const box = line(
    workspaceComputer({
      egressVia: { machineId: "m-mac", name: "MacBook Pro da Ana", userName: null },
      egress: { ip: "198.51.100.4", country: "BR", at: "2026-11-20T10:00:00.000Z" },
    }),
  );
  const name = [...box.querySelectorAll("span")].find((s) => s.textContent === "MacBook Pro da Ana");
  expect(name?.hasAttribute("title")).toBe(false);
  expect(box.querySelector("img")).toBeTruthy();
});
