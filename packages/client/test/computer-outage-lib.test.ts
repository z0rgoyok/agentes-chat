import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { AppNotification } from "../src/api/types";
import { computerOutageLine, isComputerOutage } from "../src/lib/computer-outage";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};

const notice = (kind: string, latest: AppNotification["latest"]) =>
  ({
    kind,
    source: { machineId: "m1", label: "Workspace computer" },
    latest,
    createdAt: "2026-11-23T22:42:00.000Z",
  }) as unknown as AppNotification;

test("a computer that isn't answering: its headline, since when and what waits; it opens that computer", () => {
  const down = notice("computer_down", { since: "2026-11-23T22:00:00.000Z", runs: 3, calls: 1 });
  const en = tFor("en");
  expect(isComputerOutage(down)).toBe(true);
  expect(en(workspaceHeadline(down) ?? "", { name: "Workspace computer" })).toBe("Workspace computer isn't answering");
  expect(computerOutageLine(en, down, "en")).toMatch(
    /^Since \d{1,2}:00.* · Waiting: 3 agent requests and 1 webhook call$/,
  );
  expect(openTarget(down)).toEqual({ to: "/org/$orgId/settings/computers/$machineId", params: { machineId: "m1" } });
});

test("back: how long it was away and what waited; nothing waiting says only how long", () => {
  const back = notice("computer_back", { since: "2026-11-23T22:00:00.000Z", runs: 2, calls: 0 });
  expect(computerOutageLine(tFor("en"), back, "en")).toBe("Back after 42 min · Waited: 2 agent requests");
  expect(computerOutageLine(tFor("pt-BR"), { ...back, latest: { since: back.latest.since } }, "pt-BR")).toBe(
    "Voltou depois de 42 min",
  );
  expect(tFor("pt-BR")(workspaceHeadline(back) ?? "", { name: "Computador" })).toBe("Computador voltou");
  // Any other kind: nothing.
  expect(computerOutageLine(tFor("en"), notice("computer_ready", {}), "en")).toBe("");
});

test("without Intl.ListFormat (the phone's Hermes), what waits is still a list in the language", () => {
  const down = notice("computer_down", { runs: 3, calls: 1 });
  const listFormat = Object.getOwnPropertyDescriptor(Intl, "ListFormat") as PropertyDescriptor;
  Reflect.deleteProperty(Intl, "ListFormat");
  try {
    expect(computerOutageLine(tFor("en"), down, "en")).toBe("Waiting: 3 agent requests and 1 webhook call");
    expect(computerOutageLine(tFor("pt-BR"), down, "pt-BR")).toMatch(/^.+: .+ e .+$/);
  } finally {
    Object.defineProperty(Intl, "ListFormat", listFormat);
  }
});
