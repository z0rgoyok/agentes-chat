import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Artifact } from "@agenteschat/client";
import { onlyItsConversation } from "@agenteschat/client/lib/drive";
import { filePath, parseFileLink } from "@agenteschat/client/lib/message-links";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (v: string) => void copied.push(v) },
  });
});
afterAll(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});
afterEach(() => {
  cleanup();
  copied.length = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
/** Opens a dropdown (Radix: keyboard) and picks an item. */
const pick = async (scope: HTMLElement, trigger: string | RegExp, item: string) => {
  const button = within(scope).getByRole("button", { name: trigger });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: item }));
};

/**
 * A report Atlas left in its DM with me, a manual I made in the Drive itself (the whole workspace's until I choose,
 * ADR 0157 amendment 2026-11-17), and minutes in #general, a public channel.
 */
async function drive() {
  const state = seedState();
  state.dms.push({ channelId: "dm-atlas", with: { type: "agent", id: ATLAS_ID, name: "Atlas", handle: "atlas" } });
  const api = createFakeApi(state);
  const report = await api.artifacts.create(ORG_ID, {
    title: "Relatório de visitas",
    channelId: "dm-atlas",
    content: { kind: "table", columns: ["Dia", "Visitas"], rows: [["Segunda", "3"]] },
  });
  const manual = await api.artifacts.create(ORG_ID, {
    title: "Manual do time",
    content: { kind: "table", columns: ["Passo", "Quem"], rows: [["Abrir o turno", "Walter"]] },
  });
  const minutes = await api.artifacts.create(ORG_ID, {
    title: "Ata da reunião",
    channelId: GENERAL_ID,
    content: { kind: "table", columns: ["Tema", "Quem"], rows: [["Escala", "Walter"]] },
  });
  const r = await renderApp(`/org/${ORG_ID}/drive`, { api });
  await settle(8);
  return { ...r, api, state, report, manual, minutes };
}

/** The Drive's details of a file, then its "…" › an item. */
async function fromDetails(title: string, item: string) {
  await click(screen().getByRole("button", { name: title }));
  await settle(4);
  const panel = screen().getByRole("dialog", { name: title });
  await pick(panel, /^Mais ações: /, item);
  await settle(3);
  return panel;
}

const shareDialog = (title: string) => screen().getByRole("dialog", { name: `Compartilhar ${title}` });
const names = (dialog: HTMLElement) => [...dialog.querySelectorAll(".ac-access__name")].map((n) => n.textContent);
const levelBox = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("combobox", { name: `O que ${name} pode fazer` });
const levelOf = (dialog: HTMLElement, name: string) => levelBox(dialog, name).textContent;
const setAccessCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "artifacts.setAccess").map((c) => c.args.slice(1));

/** Opens one of the access dialog's dropdowns (a row's level, or Adicionar) and waits for its options. */
const openList = async (dialog: HTMLElement, select: string) => {
  // The dialog and the last dropdown hand focus back first: a list opened before that closes on it.
  await act(() => new Promise((r) => setTimeout(r, 30)));
  const trigger = within(dialog).getByRole("combobox", { name: select });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  for (let i = 0; i < 50; i++) {
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    if (options.length) return options;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(`no options in ${select}`);
};
/** An option's own words: a person's or an agent's name comes after their avatar's initials. */
const labelOf = (o: HTMLElement) => o.querySelector(".ac-menu__label > span")?.textContent ?? o.textContent ?? "";
/** Picks an option of one of the access dialog's dropdowns by the start of its words. */
const pickLevel = async (dialog: HTMLElement, select: string, option: string) => {
  const row = (await openList(dialog, select)).find((o) => labelOf(o).startsWith(option));
  if (!row) throw new Error(`no ${option} in ${select}`);
  await click(row);
  await settle(1);
};

describe("Compartilhar (ADR 0157, 0202)", () => {
  test("a DM's file: one list with a level for each row; the link's warning beside Copiar link, which copies the app's address", async () => {
    const { report } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    // Always there: who reads it where it lives, the whole workspace and the agents there.
    expect(names(dialog)).toEqual(["A DM com Atlas", "Todos no workspace", "Agentes desta conversa"]);
    expect(levelOf(dialog, "A DM com Atlas")).toBe("Editar");
    expect(levelOf(dialog, "Todos no workspace")).toBe("Sem acesso");
    expect(levelOf(dialog, "Agentes desta conversa")).toBe("Editar");
    expect(dialog.textContent).toContain("Quem não está nesta conversa não vai abrir o link.");
    await click(within(dialog).getByRole("button", { name: "Copiar link" }));
    await settle(2);
    expect(copied).toEqual([`http://localhost:3000${filePath(ORG_ID, report.id)}`]);
    expect(copied[0]).not.toContain("/api/");
  });

  test("everyone views, João edits, one agent only views and the others nothing: Salvar keeps it", async () => {
    const { state, report } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    await pickLevel(dialog, "O que Todos no workspace pode fazer", "Ver");
    // With everyone viewing, adding someone is "this one edits too".
    await pickLevel(dialog, "Adicionar pessoa, cargo ou agente", "João");
    expect(levelOf(dialog, "João")).toBe("Editar");
    await pickLevel(dialog, "O que Agentes desta conversa pode fazer", "Sem acesso");
    await pickLevel(dialog, "Adicionar pessoa, cargo ou agente", "Ada");
    await pickLevel(dialog, "O que Ada pode fazer", "Ver");
    expect(names(dialog)).toEqual(["A DM com Atlas", "Todos no workspace", "Agentes desta conversa", "João", "Ada"]);
    // Nothing is kept until Salvar.
    expect(setAccessCalls(state)).toEqual([]);
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(setAccessCalls(state)).toEqual([
      [
        report.id,
        {
          place: "edit",
          workspace: "view",
          users: [{ id: "u-joao", level: "edit" }],
          roles: [],
          agents: "none",
          agentRows: [{ id: ADA_ID, level: "view" }],
        },
      ],
    ]);
    expect(screen().getByText("Acesso salvo.")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Compartilhar Relatório de visitas" })).toBeNull();
  });

  test("Tirar takes a row out, and Cancelar keeps nothing", async () => {
    const { state } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    await pickLevel(dialog, "Adicionar pessoa, cargo ou agente", "João");
    expect(names(dialog)).toContain("João");
    await click(within(dialog).getByRole("button", { name: "Tirar João" }));
    await settle(1);
    expect(names(dialog)).not.toContain("João");
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(setAccessCalls(state)).toEqual([]);
  });

  test("a public channel's file: the whole workspace sees it already, no row for it", async () => {
    await drive();
    await fromDetails("Ata da reunião", "Compartilhar");
    const dialog = shareDialog("Ata da reunião");
    expect(names(dialog)).toEqual(["Membros de #general", "Agentes desta conversa"]);
    expect(dialog.textContent).not.toContain("não vai abrir o link");
  });

  test("a file of the Drive itself I made: my row always edits; everyone edits it until I limit it", async () => {
    const { state, manual } = await drive();
    await fromDetails("Manual do time", "Compartilhar");
    const dialog = shareDialog("Manual do time");
    expect(names(dialog)).toEqual(["Walter (você)", "Todos no workspace", "Todos os agentes"]);
    expect(dialog.textContent).toContain("Criou o arquivo");
    expect(levelOf(dialog, "Walter (você)")).toBe("Editar");
    expect(levelBox(dialog, "Walter (você)").hasAttribute("disabled")).toBe(true);
    expect(levelOf(dialog, "Todos no workspace")).toBe("Editar");
    expect(levelOf(dialog, "Todos os agentes")).toBe("Editar");
    // I'm its maker: I'm not one to add.
    const options = await openList(dialog, "Adicionar pessoa, cargo ou agente");
    expect(options.some((o) => labelOf(o).startsWith("Walter"))).toBe(false);
    const joao = options.find((o) => labelOf(o).startsWith("João"));
    if (!joao) throw new Error("no João");
    await click(joao);
    await settle(1);
    // Adding someone while everyone edits limits it, in plain sight, until Salvar.
    expect(levelOf(dialog, "Todos no workspace")).toBe("Sem acesso");
    expect(levelOf(dialog, "João")).toBe("Editar");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(setAccessCalls(state)).toEqual([
      [
        manual.id,
        {
          place: "edit",
          workspace: "none",
          users: [{ id: "u-joao", level: "edit" }],
          roles: [],
          agents: "edit",
          agentRows: [],
        },
      ],
    ]);
  });

  test("Copiar link of a Drive file only its maker sees opens the dialog, which says so", async () => {
    const { api, manual } = await drive();
    await api.artifacts.setAccess(ORG_ID, manual.id, {
      place: "edit",
      workspace: "none",
      users: [],
      roles: [],
      agents: "none",
      agentRows: [],
    });
    cleanup();
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    await fromDetails("Manual do time", "Copiar link");
    expect(copied).toEqual([]);
    expect(shareDialog("Manual do time").textContent).toContain("Só você abre este link.");
  });

  test("someone else's Drive file I only view: the list as it is, and changing it is its maker's (or an administrator's)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const plan = await api.artifacts.create(ORG_ID, {
      title: "Plano de férias",
      content: { kind: "table", columns: ["Quem", "Quando"], rows: [["João", "Julho"]] },
    });
    // As the server answers about João's own Drive file he let me view (ADR 0202).
    const joaos = <T extends Artifact>(a: T): T =>
      a.id === plan.id
        ? {
            ...a,
            createdBy: { type: "person", id: "u-joao" },
            sharing: { mode: "people", userIds: ["u-walter"], roleIds: [] },
            access: {
              place: "edit",
              workspace: "none",
              users: [{ id: "u-walter", level: "view" }],
              roles: [],
              agents: "none",
              agentRows: [],
              limited: true,
            },
            myAccess: "view",
            canShare: false,
          }
        : a;
    const list = api.artifacts.list;
    api.artifacts.list = async (...args) => (await list(...args)).map(joaos);
    const page = api.artifacts.page;
    api.artifacts.page = async (...args) => {
      const got = await page(...args);
      return { ...got, artifacts: got.artifacts.map(joaos) };
    };
    const get = api.artifacts.get;
    api.artifacts.get = async (...args) => joaos(await get(...args));
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    await fromDetails("Plano de férias", "Compartilhar");
    const dialog = shareDialog("Plano de férias");
    expect(names(dialog)).toEqual(["João", "Todos no workspace", "Todos os agentes", "Walter (você)"]);
    expect(levelOf(dialog, "Walter (você)")).toBe("Ver");
    expect(dialog.textContent).toContain("Só quem criou o arquivo e os administradores mudam quem vê.");
    const boxes = within(dialog).getAllByRole("combobox");
    expect(boxes.length).toBe(4);
    expect(boxes.every((b) => b.hasAttribute("disabled"))).toBe(true);
    expect(within(dialog).queryByRole("button", { name: /^Tirar/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Salvar" })).toBeNull();
  });

  test("Copiar link of a file only its conversation sees opens the dialog; of an open one, copies the app's address", async () => {
    await drive();
    await fromDetails("Relatório de visitas", "Copiar link");
    expect(copied).toEqual([]);
    expect(shareDialog("Relatório de visitas").textContent).toContain("não vai abrir o link");
    cleanup();
    const again = await drive();
    await fromDetails("Manual do time", "Copiar link");
    expect(copied).toEqual([`http://localhost:3000${filePath(ORG_ID, again.manual.id)}`]);
  });

  test("the viewer's header has Compartilhar beside Baixar", async () => {
    const { report } = await drive();
    await click(screen().getByRole("button", { name: "Relatório de visitas" }));
    await settle(6);
    const viewer = screen().getByRole("dialog", { name: "Relatório de visitas" });
    const share = within(viewer).getByRole("button", { name: "Compartilhar" });
    const download = within(viewer).getByRole("button", { name: "Baixar" });
    expect(download.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(share);
    await settle(3);
    expect(shareDialog("Relatório de visitas")).toBeTruthy();
    expect(report.id).toBeTruthy();
  });

  test("shared with me from a DM I'm not in: whose DM it is, no way into it, and the sharing isn't mine to change", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const report = await api.artifacts.create(ORG_ID, {
      title: "Relatório de visitas",
      channelId: GENERAL_ID,
      content: { kind: "table", columns: ["Dia", "Visitas"], rows: [["Segunda", "3"]] },
    });
    // As the server answers someone João's DM with Atlas was shared with (ADR 0157).
    const outsider = <T extends Artifact>(a: T): T =>
      a.id === report.id
        ? {
            ...a,
            channelId: "dm-joao-atlas",
            audience: {
              kind: "dm",
              with: null,
              between: [
                { type: "person", id: "u-joao" },
                { type: "agent", id: ATLAS_ID },
              ],
            },
            sharing: { mode: "people", userIds: ["u-walter"], roleIds: [] },
            access: {
              place: "edit",
              workspace: "none",
              users: [{ id: "u-walter", level: "edit" }],
              roles: [],
              agents: "edit",
              agentRows: [],
              limited: false,
            },
            canShare: false,
          }
        : a;
    const list = api.artifacts.list;
    api.artifacts.list = async (...args) => (await list(...args)).map(outsider);
    const page = api.artifacts.page;
    api.artifacts.page = async (...args) => {
      const got = await page(...args);
      return { ...got, artifacts: got.artifacts.map(outsider) };
    };
    const get = api.artifacts.get;
    api.artifacts.get = async (...args) => outsider(await get(...args));
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Relatório de visitas" }));
    await settle(6);
    // The file opens in the viewer; who sees it is in its "Compartilhar".
    const panel = screen().getByRole("dialog", { name: "Relatório de visitas" });
    await pick(panel, /^Mais ações: /, "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    expect(names(dialog)).toEqual([
      "A DM entre João e Atlas",
      "Todos no workspace",
      "Agentes desta conversa",
      "Walter (você)",
    ]);
    expect(dialog.textContent).toContain("Só quem está na conversa muda quem vê.");
    expect(
      within(dialog)
        .getAllByRole("combobox")
        .every((b) => b.hasAttribute("disabled")),
    ).toBe(true);
    // Who may only look closes it: Fechar is the footer's only button.
    const close = within(dialog).getAllByRole("button", { name: "Fechar" });
    await click(close[close.length - 1] as HTMLElement);
    await settle(2);
    // Its "…" has no way into a DM I'm not in (neither mine with Atlas nor mine with João).
    const more = within(panel).getByRole("button", { name: /^Mais ações: / });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const menu = screen().getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Compartilhar" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Abrir a conversa" })).toBeNull();
  });
});

describe("a file's link pasted in a message", () => {
  test("the API's address and the app's both show as the file's pill, never the raw address", async () => {
    const state = seedState();
    const api: ApiClient = createFakeApi(state);
    // A file the viewer opens (a document is a live file with a page of its own, ADR 0200).
    const doc = (await api.artifacts.list(ORG_ID)).find((a) => a.kind === "table") as Artifact;
    // The server's ids are UUIDs (and only those parse as a file's link); the fake's aren't.
    const id = "00000000-0000-4000-8000-0000000000f2";
    const get = api.artifacts.get;
    api.artifacts.get = (orgId, wanted, version) => get(orgId, wanted === id ? doc.id : wanted, version);
    state.messages.push({
      id: "m-link",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: `olha http://localhost:3000/api/app/organizations/${ORG_ID}/artifacts/${id}/file?version=1&format=pdf`,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {},
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const pill = screen().getByRole("link", { name: `Arquivo ${doc.title}` });
    expect(pill.textContent).toBe(doc.title);
    expect(document.body.textContent).not.toContain("/api/app/organizations");
    await click(pill);
    await settle(6);
    expect(screen().getByRole("dialog", { name: doc.title })).toBeTruthy();
  });
});

describe("the link rules, as the apps share them", () => {
  test("parseFileLink reads the app's and the API's addresses of this server only", () => {
    const id = "00000000-0000-4000-8000-0000000000f1";
    const origins = ["http://localhost:3000"];
    expect(parseFileLink(`http://localhost:3000${filePath(ORG_ID, id, 3)}`, origins)).toEqual({
      orgId: ORG_ID,
      artifactId: id,
      version: 3,
    });
    expect(
      parseFileLink(
        `http://localhost:3000/api/app/organizations/${ORG_ID}/artifacts/${id}/file?version=2&format=pdf`,
        origins,
      ),
    ).toEqual({ orgId: ORG_ID, artifactId: id, version: 2 });
    expect(parseFileLink(`/api/app/organizations/${ORG_ID}/artifacts/${id}/file`)).toEqual({
      orgId: ORG_ID,
      artifactId: id,
      version: null,
    });
    expect(parseFileLink(`https://elsewhere.test${filePath(ORG_ID, id)}`, origins)).toBeNull();
    expect(parseFileLink(`http://localhost:3000/org/${ORG_ID}/drive`, origins)).toBeNull();
  });

  test("onlyItsConversation", () => {
    const dm = { audience: { kind: "dm" as const, with: null } };
    expect(onlyItsConversation({ ...dm, sharing: { mode: "conversation", userIds: [], roleIds: [] } })).toBe(true);
    expect(onlyItsConversation({ ...dm, sharing: { mode: "people", userIds: ["u"], roleIds: [] } })).toBe(false);
    expect(onlyItsConversation({ audience: { kind: "workspace" } })).toBe(false);
    // A file of the Drive itself: only its maker sees it until shared (ADR 0157, amendment 2026-11-17).
    const drive = { audience: { kind: "workspace" as const } };
    expect(onlyItsConversation({ ...drive, sharing: { mode: "conversation", userIds: [], roleIds: [] } })).toBe(true);
    expect(onlyItsConversation({ ...drive, sharing: { mode: "everyone", userIds: [], roleIds: [] } })).toBe(false);
  });
});
