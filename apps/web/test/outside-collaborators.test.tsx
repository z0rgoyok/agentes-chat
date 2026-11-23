import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { JoinRequest, Member, WorkspaceLimits } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
/** Mid-day: a request made 2 h ago reads "há 2 h". */
const MIDDAY = new Date(2026, 9, 21, 12);
/** Who an outside collaborator works for, at the server's longest and with no place to break. */
const LONG_OF = "N".repeat(80);

/** A workspace with no room left (ADR 0079 §4). */
const FULL: WorkspaceLimits = {
  members: { used: 2, limit: 2 },
  storage: { usedBytes: 0, limitBytes: null, ownStorage: false },
  uploads: { usedBytes24h: 0, limitBytesPerDay: null },
};

const request = (patch: Partial<JoinRequest>): JoinRequest => ({
  id: "r1",
  name: "Ana Souza",
  email: "ana@example.com",
  note: null,
  verified: true,
  confirmed: true,
  createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
  ...patch,
});

const outsider = (patch: Partial<Member> = {}): Member => ({
  userId: "u-bruno",
  name: "Bruno Lima",
  email: "bruno@example.com",
  image: null,
  role: "member",
  joinedAt: "2026-10-01T12:00:00.000Z",
  handle: "bruno",
  timezone: "America/Sao_Paulo",
  outsideOf: "Northwind Consulting",
  ...patch,
});

test("an outside collaborator's request says for whom and that they take no seat, and a full workspace approves it", async () => {
  setSystemTime(MIDDAY);
  const state = seedState({
    limits: FULL,
    joinRequests: [
      request({ id: "r-out", name: "Bruno Lima", email: "bruno@example.com", outsideOf: LONG_OF }),
      request({ id: "r-link", name: "Ana Souza" }),
    ],
  });
  await renderApp(`/org/${ORG_ID}/settings/invites`, { api: createFakeApi(state) });
  await settle(6);
  const row = screen().getByRole("group", { name: "Bruno Lima pede para entrar" });
  expect(row.querySelector(".members-row__state")?.textContent).toBe(
    `Pediu há 2 h para entrar como colaborador externo de ${LONG_OF}`,
  );
  expect(row.textContent).toContain(
    "Colaboradores externos não contam nas pessoas do seu plano, e você pode removê-los a qualquer momento.",
  );
  // Full: the ordinary request waits for room, the outside one doesn't.
  const approve = (el: HTMLElement) => within(el).getByRole("button", { name: "Aprovar" });
  expect(approve(screen().getByRole("group", { name: "Ana Souza pede para entrar" })).hasAttribute("disabled")).toBe(
    true,
  );
  expect(approve(row).hasAttribute("disabled")).toBe(false);
  await click(approve(row));
  await settle(4);
  expect(state.calls.find((c) => c.method === "joinRequests.approve")?.args).toEqual([ORG_ID, "r-out", []]);
});

test("Members: an outside collaborator shows the Outside chip and who they work for; the card says it too", async () => {
  const state = seedState();
  state.members.push(outsider({ outsideOf: LONG_OF }));
  await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
  await settle(6);
  const rows = [...document.querySelectorAll<HTMLElement>(".members-person")];
  const bruno = rows.find((r) => r.textContent?.includes("Bruno Lima")) as HTMLElement;
  expect(bruno.querySelector(".members-roles .ac-chip")?.textContent).toBe("Externo");
  expect(bruno.querySelector(".members-roles__of")?.textContent).toBe(LONG_OF);
  // Nobody else carries it.
  const walter = rows.find((r) => r.textContent?.includes("Walter")) as HTMLElement;
  expect(walter.querySelector(".members-roles__of")).toBeNull();
  expect(walter.textContent).not.toContain("Externo");
});

test("Dono: an outside collaborator is never offered as an owner", async () => {
  const state = seedState();
  state.members.push(outsider(), outsider({ userId: "u-carla", name: "Carla Dias", outsideOf: null }));
  await renderApp(`/org/${ORG_ID}/settings/roles/owner`, { api: createFakeApi(state) });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar donos" }));
  await settle(2);
  const dialog = screen().getByRole("dialog", { name: "Adicionar a Dono" });
  expect(dialog.textContent).toContain("Carla Dias");
  expect(dialog.textContent).not.toContain("Bruno Lima");
});

test("the admins' notice of an outside collaborator's request says for whom and that they take no seat", async () => {
  const state = seedState({
    notifications: [
      notification({
        id: "n-join",
        kind: "join_request",
        waiting: true,
        count: 1,
        source: { label: "Acme" },
        latest: { title: "Bruno Lima", names: ["Bruno Lima"], outsideOf: "Northwind Consulting" },
      }),
    ],
  });
  await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(6);
  const row = document.querySelector('[data-n="n-join"]') as HTMLElement;
  expect(row.querySelector(".nt-what")?.textContent).toContain(
    "Bruno Lima pede para entrar como colaborador externo de Northwind Consulting, sem ocupar vaga",
  );
});
