import { expect, test } from "bun:test";
import { computerOutageLine } from "@agenteschat/client/lib/computer-outage";
import { placeOf } from "../../src/features/activity/logic";
import { notification, translator } from "./fixtures";

test("a computer that isn't answering, and back: the phone's row says which, since when, and what waits (ADR 0241)", async () => {
  const t = await translator("pt-BR");
  const down = notification({
    id: "n1",
    kind: "computer_down",
    source: { machineId: "m1", label: "Computador do workspace" },
    latest: { since: "2026-11-23T22:00:00.000Z", runs: 3, calls: 7 },
  });
  expect(t("mobile.activity.kind.computer_down", { count: 1 })).toBe("Um computador não está respondendo");
  expect(placeOf(down)).toBe("Computador do workspace");
  expect(computerOutageLine(t, down, "pt-BR")).toMatch(
    /^Desde \d{1,2}:00 · Esperando: 3 pedidos a agentes e 7 chamadas de webhook$/,
  );
  const back = { ...down, kind: "computer_back" as const, createdAt: "2026-11-23T22:42:00.000Z" };
  expect(t("mobile.activity.kind.computer_back", { count: 1 })).toBe("Um computador voltou");
  expect(computerOutageLine(t, back, "pt-BR")).toBe(
    "Voltou depois de 42 min · Esperaram: 3 pedidos a agentes e 7 chamadas de webhook",
  );
});
