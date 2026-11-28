import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ApiClient, ImportFileInput, ImportInput, ImportItemResult, ImportPlan } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ImportFlow, useImportFlow } from "@/components/ImportFlow";
import { EXPORT_PROMPT } from "@/lib/import";
import { zip } from "./archives";
import { createFakeApi, fakeAppsOf, ORG_ID, seedState } from "./fake-api";
import { type FakeApps, SERVER_URL } from "./fakes/apps";
import { renderApp, renderPage, screen, settle } from "./render";

const realSave = fileSaver.save;
afterEach(() => {
  cleanup();
  fileSaver.save = realSave;
});

const FIXTURES = join(import.meta.dir, "fixtures", "agent-import");
type State = ReturnType<typeof seedState>;

const go = async (state: State = seedState(), api: ApiClient = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/settings/import`, { api });
  await settle(6);
  return { ...r, state, api };
};
const button = (name: string | RegExp) => screen().getByRole("button", { name });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const applies = (state: State) => calls(state, "imports.apply").map((c) => c.args[1] as ImportInput);
const text = () => document.body.textContent ?? "";

/** The sheet that is open, by its title. */
const sheetOf = (name: string) => screen().getByRole("dialog", { name });
/** Closes the open sheet with its ×. */
const closeSheet = async () => {
  const sheet = screen().getByRole("dialog");
  await click(within(sheet).getAllByRole("button", { name: "Fechar" })[0] as HTMLElement, 4);
};
/** "Tenho um arquivo ou link": the sheet with the drop zone, the pickers and the paste field, unless one is open. */
const openFile = async () => {
  if (!screen().queryByRole("dialog")) await click(button("Tenho um arquivo ou link"), 4);
};
/**
 * From the sheet's steps to the page's full preview: its × closes it, leaving the plan on the page. A sheet still
 * reading, or saying what went wrong, stays.
 */
const toPreview = async () => {
  const sheet = screen().queryByRole("dialog");
  if (!sheet) return;
  if (sheet.querySelector(".imp-choice") || !sheet.querySelector("input, .imp-reading")) await closeSheet();
};
/** Files into one of the file sheet's pickers ("Arquivos para importar", "Pasta para importar"), on to the preview. */
const pick = async (label: string, files: File[]) => {
  await openFile();
  const input = screen().getByLabelText(label) as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => fireEvent.change(input));
  await settle(10);
  await toPreview();
};
/** A fixture folder as the folder picker gives it: every path under the folder's name. */
const folder = (name: string): File[] => {
  const root = join(FIXTURES, name);
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  return walk(root).map((path) => {
    const file = new File([readFileSync(path)], basename(path));
    Object.defineProperty(file, "webkitRelativePath", { value: `${name}/${relative(root, path)}` });
    return file;
  });
};
const fixture = (name: string) => new File([readFileSync(join(FIXTURES, name))], name);
/** A fixture folder as a drag-and-drop hands it over: a directory entry walked with its reader. */
const folderEntry = (dir: string, path: string): unknown => {
  const abs = join(FIXTURES, dir);
  if (!statSync(abs).isDirectory()) {
    return { isFile: true, isDirectory: false, fullPath: path, file: (ok: (f: File) => void) => ok(fixture(dir)) };
  }
  const children = readdirSync(abs)
    .sort()
    .map((n) => folderEntry(join(dir, n), `${path}/${n}`));
  return {
    isFile: false,
    isDirectory: true,
    fullPath: path,
    createReader: () => {
      let read = false;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          ok(read ? [] : children);
          read = true;
        },
      };
    },
  };
};
/** Drags `dt` over the import page and drops it: the file sheet opens reading it, then on to the preview. */
const drop = async (dt: { files: File[]; items: unknown[] }) => {
  const zone = document.querySelector(".imp-pick") as HTMLElement;
  const dataTransfer = { ...dt, types: ["Files"], dropEffect: "none" };
  await act(async () => fireEvent.dragOver(zone, { dataTransfer }));
  expect(text()).toContain("Pode soltar");
  await act(async () => fireEvent.drop(zone, { dataTransfer }));
  await settle(10);
  await toPreview();
};
/** The plan row whose title is `title`. */
const row = (title: string) => {
  const found = [...document.querySelectorAll(".imp-row")].find(
    (r) => r.querySelector(".imp-row__title")?.textContent === title,
  );
  if (!found) throw new Error(`no row ${title}`);
  return found as HTMLElement;
};
const chipOf = (title: string) => row(title).querySelector(".imp-row__chip")?.textContent;
/** A line led by an icon that `.ac-iconline` puts on the line's first row. */
const iconLine = (line: Element | null) =>
  !!line?.classList.contains("ac-iconline") && !!line.firstElementChild?.matches("svg.ac-icon");
/** What an app given `EXPORT_PROMPT` writes, naming itself `app`. */
const exportReply = (app: string, name: string) => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app, ref: "my-bots", name, files: [] },
  agents: [
    {
      key: "news",
      name: "Newsy",
      handle: "news",
      role: "Notícias do dia",
      instructions: "Resume as notícias do dia em cinco tópicos.",
      model: null,
      appearance: {},
      skills: [],
    },
  ],
  skills: [],
  channels: [],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
});
/**
 * A reply pasted as an app answers in its chat (some words, then the JSON in a code block), in the open sheet's field
 * `label` (the file sheet's, opened if none is), on to the preview.
 */
const pasteReply = async (reply: object, label = "Ou cole um link do GitHub ou a resposta do outro app") => {
  await openFile();
  const field = screen().getByLabelText(label);
  const pasted = `Aqui está:\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
  await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => pasted } }));
  await settle(10);
  await toPreview();
};
/** `imports.apply` answering with `plan` for the dry run (and the default fake otherwise). */
const withPlan = (api: ApiClient, state: State, plan: (input: ImportInput) => ImportItemResult[]) => {
  const fake = api.imports.apply;
  api.imports = {
    ...api.imports,
    apply: async (orgId, input) => {
      if (!input.dryRun) return fake(orgId, input);
      state.calls.push({ method: "imports.apply", args: [orgId, input] });
      return { items: plan(input) };
    },
  };
};

describe("Configurações → Importar e exportar", () => {
  test("admins find it in the nav; the export downloads the bundle, says in one line what never goes, and links the rest", async () => {
    const saved: [string, string][] = [];
    fileSaver.save = (url, name) => saved.push([url, name]);
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Importar e exportar" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("heading", { level: 2, name: "Importar e exportar" })).toBeTruthy();

    // The import card's title alone: the page's subtitle says what importing is for.
    const imports = screen().getByRole("region", { name: "Importar" });
    expect(imports.querySelector(".ac-card__sub")).toBeNull();

    const card = screen().getByRole("region", { name: "Exportar" });
    expect(card.querySelector(".ac-card__sub, ul, .ac-card__foot")).toBeNull();
    // Whoever shares the file needs to know what never goes in it: one line. The full list is on the help page.
    expect(card.querySelector(".imp-note")?.textContent).toBe("Nunca leva chaves, senhas, logins nem conversas.");
    const whatsIn = within(card).getByRole("link", { name: "O que vai no arquivo" });
    expect(whatsIn.getAttribute("href")).toBe("https://agentes.chat/pt/docs/import#export");
    expect(whatsIn.className).toBe("ac-link ac-link--muted");
    expect([whatsIn.getAttribute("target"), whatsIn.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    await click(within(card).getByRole("button", { name: "Baixar o arquivo" }));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[0]).toBe(`/api/app/organizations/${ORG_ID}/export`);
    expect(saved[0]?.[1]).toMatch(/^agentes-chat-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).queryByRole("link", { name: "Importar e exportar" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Exportar" })).toBeNull();
  });

  test("the most used apps first, each by its official logo, in the maker's own dark file when the app (not the system) is dark", async () => {
    const device = domWindow().happyDOM.settings.device;
    const logos = () =>
      [...document.querySelectorAll(".imp-source")].map((card) => [
        card.querySelector(".ac-option__title")?.textContent,
        card.querySelector(".imp-mark img")?.getAttribute("src") ?? null,
      ]);
    try {
      // The system is dark, but the app is set to light: the light files.
      device.prefersColorScheme = "dark";
      localStorage.setItem("agentes.theme", "light");
      await go();
      expect(logos()).toEqual([
        ["Grok Bot", "/brands/grok-bot.svg"],
        ["ChatGPT dots", "/brands/chatgpt-dots.svg"],
        ["OpenBot.run", "/brands/openbotrun.svg"],
        ["OpenMausBot", "/brands/openmausbot.svg"],
        ["Hermes Agent", "/brands/hermes.svg"],
        ["OpenClaw", "/brands/openclaw.svg"],
        ["Paperclip", "/brands/paperclip.svg"],
        ["agentes.chat", "/favicon.svg"],
        // It names many apps: no one maker's logo fits.
        ["Outro app", null],
      ]);
      cleanup();
      // The app set to dark: Grok Bot, Hermes and Paperclip by their dark files, the others read on both.
      localStorage.setItem("agentes.theme", "dark");
      await go();
      expect(logos()).toEqual([
        ["Grok Bot", "/brands/grok-bot-dark.svg"],
        ["ChatGPT dots", "/brands/chatgpt-dots.svg"],
        ["OpenBot.run", "/brands/openbotrun.svg"],
        ["OpenMausBot", "/brands/openmausbot.svg"],
        ["Hermes Agent", "/brands/hermes-dark.svg"],
        ["OpenClaw", "/brands/openclaw.svg"],
        ["Paperclip", "/brands/paperclip-dark.svg"],
        ["agentes.chat", "/favicon.svg"],
        ["Outro app", null],
      ]);
    } finally {
      device.prefersColorScheme = "light";
      localStorage.removeItem("agentes.theme");
    }
  });

  test("the page: each app by its mark and name alone, and one button for a file or link, whose sheet has the drop zone, the paste field and the lock line", async () => {
    await go();
    expect(document.querySelector(".imp-source .ac-option__desc")).toBeNull();
    expect(button("OpenClaw").textContent).toBe("OpenClaw");
    // Nothing to drop or paste on the page itself: that is the button's sheet.
    expect(document.querySelector(".imp-drop")).toBeNull();
    expect(screen().queryByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeNull();
    await click(button("Tenho um arquivo ou link"), 4);
    const sheet = sheetOf("Trazer de um arquivo ou link");
    expect(sheet.querySelector(".imp-drop__area")?.textContent).toBe(
      "Solte aqui a pasta, o arquivo ou o .zipou clique para escolher",
    );
    expect(within(sheet).getByLabelText("Ou cole um link do GitHub ou a resposta do outro app")).toBeTruthy();
    // Read before anything is dropped, by whoever is about to drop a folder that holds keys.
    const lock = sheet.querySelector(".imp-sheet__body > .imp-note") as HTMLElement;
    expect(iconLine(lock)).toBe(true);
    expect(lock.querySelector(".ac-hintline > span")?.textContent).toBe(
      "Lido no seu navegador. Arquivos de chaves e de login nunca são abertos.",
    );
    // Named by its subject, so a screen reader doesn't read the line's sentence a second time.
    const about = within(lock).getByRole("button", { name: "Sobre Privacidade" });
    const more = "Um link do GitHub passa pelo servidor do workspace. Nada muda aqui até você confirmar.";
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(more);
  });

  test("Grok Bot: its sheet has the bot's own steps to connect MCP, numbered, then the request; nothing to drop or paste", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void writes.push(s) },
    });
    await go();
    await click(button("Grok Bot"), 4);
    const sheet = sheetOf("Trazer o time do Grok Bot");
    expect(sheet.querySelector(".imp-sheet__text")?.textContent).toBe(
      "O MCP deixa o Grok Bot acessar este workspace, e ele cria os agentes aqui sozinho.",
    );
    // In order: the access is picked where the sign-in asks, and the server is attached before the request.
    const steps = () => [...sheet.querySelectorAll(".imp-do .ac-mediarow__head")].map((b) => b.textContent);
    expect(steps()).toEqual([
      "Na conversa com o seu bot, mande:",
      "Clique em Add it e depois em Authorize.",
      "Entre com sua conta do agentes.chat na página que abrir e escolha Criar e editar agentes, rotinas e skills.",
      "Na conversa, digite @ e escolha agentes.",
      "Cole este pedido no app:",
    ]);
    expect([...sheet.querySelectorAll(".imp-do__n")].map((n) => n.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect([...sheet.querySelectorAll(".machine-command__code")].map((c) => c.textContent)).toEqual([
      `Add a custom MCP server called agentes at ${SERVER_URL}`,
    ]);
    const prompt = `Use o servidor MCP do agentes.chat que você acabou de conectar (${SERVER_URL}) para trazer o que você tem para o agentes.chat. Primeiro chame import_summary para ver o que já existe lá e não duplicar nada. Depois, para cada agente, instrução, skill e rotina que você tem, crie o equivalente com create_agent, create_skill e create_routine, e guarde o que cada agente deve lembrar com add_memory.`;
    expect((within(sheet).getByLabelText("Pedido para o seu app de IA") as HTMLTextAreaElement).value).toBe(prompt);
    await click(within(sheet).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(writes).toEqual([prompt]);
    expect(sheet.textContent).toContain("Esperando os agentes chegarem…");
    // What to check shows only once a while passes with nothing.
    expect(sheet.textContent).not.toContain("Nada depois de alguns minutos?");
    // Grok Bot's steps say where: no help link, and nothing here to drop or paste.
    expect(within(sheet).queryByRole("link")).toBeNull();
    expect(sheet.querySelector(".imp-drop")).toBeNull();
    expect(sheet.querySelector("input")).toBeNull();

    // The request and the answer, in two steps: the answer pasted, never a file.
    await click(within(sheet).getByRole("button", { name: "Prefiro colar o pedido e trazer a resposta" }), 2);
    expect(steps()).toEqual(["Cole na conversa com o seu bot", "Cole aqui a resposta inteira"]);
    expect((within(sheet).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    expect(within(sheet).getByLabelText("Cole aqui a resposta inteira")).toBeTruthy();
    expect(sheet.querySelector(".imp-drop")).toBeNull();
    expect(sheet.textContent).not.toContain("Esperando os agentes chegarem…");
    // The pick stays with its source: another card has its own default, and Grok Bot keeps the request.
    await closeSheet();
    await click(button("Outro app"), 4);
    expect(sheetOf("Trazer de outro app").textContent).toContain("Esperando os agentes chegarem…");
    await closeSheet();
    await click(button("Grok Bot"), 4);
    expect(within(sheetOf("Trazer o time do Grok Bot")).getByLabelText("Cole aqui a resposta inteira")).toBeTruthy();
    await click(button("Voltar para o MCP"), 4);
    expect(sheetOf("Trazer o time do Grok Bot").textContent).toContain("Esperando os agentes chegarem…");
  });

  test("ChatGPT dots: the request by default, its file dropped; Conectar com MCP shows ChatGPT's own steps and its notes", async () => {
    await go();
    await click(button("ChatGPT dots"), 4);
    const sheet = sheetOf("Trazer o time do ChatGPT dots");
    expect([...sheet.querySelectorAll(".imp-do .ac-mediarow__head")].map((b) => b.textContent)).toEqual([
      "Cole num chat novo",
      "Solte aqui o arquivo que ele criar",
    ]);
    expect(sheet.querySelector(".imp-drop")).toBeTruthy();
    expect(within(sheet).queryByLabelText("Cole aqui a resposta inteira")).toBeNull();
    await click(within(sheet).getByRole("button", { name: "Conectar com MCP" }), 4);
    expect(sheet.querySelector(".imp-sheet__text")?.textContent).toBe(
      "O MCP deixa o seu dot acessar este workspace por um plugin que você adiciona no ChatGPT, e ele cria os agentes aqui sozinho.",
    );
    const open = within(sheet).getByRole("link", { name: "Abrir o ChatGPT" });
    expect([open.getAttribute("href"), open.getAttribute("target")]).toEqual(["https://chatgpt.com/plugins", "_blank"]);
    expect(within(sheet).getByText(SERVER_URL)).toBeTruthy();
    expect(sheet.textContent).toContain("Não dá para adicionar pelo app do celular.");
    expect(sheet.textContent).toContain(
      "Entre com sua conta do agentes.chat na página que abrir e escolha Criar e editar agentes, rotinas e skills.",
    );
  });

  test("a server apps on the internet can't reach: the request alone, no MCP to switch to, and one line saying why", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    (fakeAppsOf.get(api) as FakeApps).serverPublic = false;
    await go(state, api);
    await click(button("Grok Bot"), 4);
    const sheet = sheetOf("Trazer o time do Grok Bot");
    expect(within(sheet).getByLabelText("Cole aqui a resposta inteira")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Voltar para o MCP" })).toBeNull();
    expect(sheet.textContent).toContain(
      "Conectar com MCP não está disponível neste servidor, porque apps na internet só alcançam um endereço https público.",
    );
  });

  test("the agents the app creates arrive live: only mine made after the sheet opened, each linked to its page", async () => {
    const state = seedState();
    const me = state.me?.user.id as string;
    const base = state.agents[0] as State["agents"][number];
    // Mine, but here before the sheet opened.
    state.agents.push({ ...base, id: "a-old", name: "Velho", handle: "velho", ownerUserId: me });
    const r = await go(state);
    await act(async () => r.sockets.last().open());
    await click(button("Grok Bot"), 4);
    expect(text()).toContain("Esperando os agentes chegarem…");
    state.agents.push(
      { ...base, id: "a-nina", name: "Nina", handle: "nina", ownerUserId: me },
      { ...base, id: "a-otto", name: "Otto", handle: "otto", ownerUserId: "u-someone-else" },
    );
    await act(async () => r.sockets.last().push({ type: "event", scope: "org", event: { type: "agents.changed" } }));
    await settle(6);
    const sheet = sheetOf("1 agente chegou");
    expect(
      within(sheet)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]),
    ).toEqual([
      ["Nina", `/org/${ORG_ID}/agents/a-nina`],
      ["Ver o que chegou", `/org/${ORG_ID}/team`],
    ]);
    // More may come: it keeps watching, and the team stands on the green side.
    expect(sheet.textContent).toContain("Esperando os próximos…");
    expect(sheet.textContent).not.toContain("Esperando os agentes chegarem…");
    expect(sheet.querySelector(".ac-journey")?.getAttribute("data-journey")).toBe("here");
    // In place: nothing here moved the page.
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/import`);
  });

  test("embedded (as onboarding places it): outside the workspace's pages, it never links out or moves the page", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const me = state.me?.user.id as string;
    const base = state.agents[0] as State["agents"][number];
    function Embedded() {
      const flow = useImportFlow(ORG_ID);
      return <ImportFlow flow={flow} orgId={ORG_ID} />;
    }
    const r = await renderPage(<Embedded />, { api, path: "/onboarding" });
    await settle(6);
    await click(button("Grok Bot"), 4);
    expect(text()).toContain("Esperando os agentes chegarem…");
    state.agents.push({ ...base, id: "a-nina", name: "Nina", handle: "nina", ownerUserId: me });
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: ["org", ORG_ID, "agents"] }));
    await settle(6);
    const sheet = sheetOf("1 agente chegou");
    expect(sheet.textContent).toContain("Nina");
    expect(within(sheet).queryByRole("link")).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Continuar" })).toBeTruthy();
    expect(r.router.state.location.pathname).toBe("/onboarding");
  });

  test("the flow's own imports never count as arrived: the request, Importar outro arquivo, then MCP waits again", async () => {
    const { state } = await go();
    await click(button("Grok Bot"), 4);
    expect(text()).toContain("Esperando os agentes chegarem…");
    await click(button("Prefiro colar o pedido e trazer a resposta"), 2);
    await pasteReply(exportReply("grok-bot", "Minhas automações"), "Cole aqui a resposta inteira");
    await click(button(/^Importar \d+ ite/), 8);
    expect(state.agents.some((a) => a.name === "Newsy")).toBe(true);
    await click(button("Importar outro arquivo"), 4);
    await click(button("Grok Bot"), 4);
    await click(button("Voltar para o MCP"), 6);
    const line = () => document.querySelector(".imp-arrivals__line")?.textContent;
    expect(line()).toBe("Esperando os agentes chegarem…");
    // Another source's MCP steps count from when they opened, not from the first one's.
    await closeSheet();
    await click(button("Outro app"), 6);
    expect(line()).toBe("Esperando os agentes chegarem…");
  });

  test("the apps list fails: Grok Bot keeps its request, with no MCP to switch to", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.apps = {
      ...api.apps,
      list: async () => {
        throw new ApiError(500, "internal", "boom");
      },
    };
    await go(state, api);
    await click(button("Grok Bot"), 6);
    const sheet = sheetOf("Trazer o time do Grok Bot");
    expect(within(sheet).getByLabelText("Cole aqui a resposta inteira")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Voltar para o MCP" })).toBeNull();
  });

  test("the agents can't be read when the MCP steps open: it says why and reads them again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const list = api.agents.list;
    let fail = true;
    api.agents = {
      ...api.agents,
      list: async (orgId) => {
        if (fail) throw new ApiError(500, "internal", "boom");
        return list(orgId);
      },
    };
    await go(state, api);
    await click(button("Grok Bot"), 8);
    const sheet = () => sheetOf("Trazer o time do Grok Bot");
    expect(sheet().textContent).not.toContain("Esperando os agentes chegarem…");
    expect(within(sheet()).getByRole("alert")).toBeTruthy();
    fail = false;
    await click(within(sheet()).getByRole("button", { name: "Tentar de novo" }), 8);
    expect(sheet().textContent).toContain("Esperando os agentes chegarem…");
  });

  test("its notes and lists lead each line with an icon on the line's first row", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // The import leaves the routine out, so the report lists what didn't come.
    const fake = api.imports.apply;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const { items } = await fake(orgId, input);
        if (input.dryRun) return { items };
        const left = (i: ImportItemResult): ImportItemResult => ({
          ...i,
          action: "skip",
          reason: "schedule_unsupported",
        });
        return { items: items.map((i) => (i.kind === "routine" ? left(i) : i)) };
      },
    };
    await go(state, api);
    const seen: [string, Element[]][] = [];
    const take = (...selectors: string[]) => {
      for (const s of selectors) seen.push([s, [...document.querySelectorAll(s)]]);
    };
    await openFile();
    take(".imp-note");
    await pick("Pasta para importar", folder("paperclip-company"));
    take(".imp-note");
    await click(button(/^Importar \d+ itens/), 8);
    take(".imp-missed li", ".imp-todo li");
    for (const [selector, lines] of seen) {
      expect([selector, lines.length > 0]).toEqual([selector, true]);
      for (const line of lines) expect([selector, iconLine(line)]).toEqual([selector, true]);
    }
  });

  test("agentes.chat: where its file is, and with one other workspace on this server, a link to it", async () => {
    const state = seedState();
    state.me?.organizations.push({ id: "org-north", name: "Estúdio Norte", role: "owner", showActivity: true });
    await go(state);
    await click(button(/^agentes\.chat$/), 4);
    const sheet = sheetOf("Trazer de outro workspace");
    expect([...sheet.querySelectorAll(".imp-do .ac-mediarow__head")].map((b) => b.textContent)).toEqual([
      "Baixe o arquivo do outro workspace",
      "Solte aqui o .json",
    ]);
    expect(sheet.textContent).toContain(
      "Lá, em Configurações\u00a0›\u00a0Importar e exportar\u00a0›\u00a0Baixar o arquivo.",
    );
    const link = within(sheet).getByRole("link", { name: "Abrir Estúdio Norte numa aba nova" });
    expect(link.getAttribute("href")).toBe("/org/org-north/settings/import");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(sheet.querySelector(".imp-drop")).toBeTruthy();
  });

  test("a folder is recognized and planned on the server; unchecking an agent holds back what needs it; Importar applies and reports", async () => {
    const { state } = await go();
    // Each app the parsers read has a card, but OpenBot, which few use: the file sheet reads any of them, and the help
    // behind Outro app says where OpenBot's files are.
    for (const name of ["OpenBot.run", "OpenMausBot", "Hermes Agent", "OpenClaw", "Paperclip"]) {
      expect(button(new RegExp(`^${name.replace(".", "\\.")}$`))).toBeTruthy();
    }
    expect(screen().queryByRole("button", { name: /^OpenBot$/ })).toBeNull();

    await pick("Pasta para importar", folder("paperclip-company"));
    // Read here, planned there: nothing is written before Importar.
    expect(applies(state).map((i) => i.dryRun)).toEqual([true]);
    const title = screen().getByRole("heading", { name: "Corner Studio" });
    expect(document.activeElement === title).toBe(true);
    expect(text()).toContain("Veio do Paperclip");
    for (const group of ["Agentes", "Skills", "Rotinas", "Memória"]) {
      expect(screen().getByRole("region", { name: group })).toBeTruthy();
    }
    // A new row says nothing: no chip.
    expect(chipOf("Linus · Chief Technology Officer")).toBeUndefined();
    const routines = screen().getByRole("region", { name: "Rotinas" });
    // Skills arrive on and routines active: nothing to say, nothing to switch.
    expect(text()).not.toContain("Chegam");
    expect(screen().queryByRole("switch", { name: /^Ligar para/ })).toBeNull();

    const bring = (name: string) => screen().getByRole("checkbox", { name: `Trazer ${name}` });
    await click(bring("Ada"), 2);
    expect(bring("Ada").getAttribute("aria-checked")).toBe("false");
    // Her routines can't come without her, and say so.
    expect(within(routines).queryAllByRole("checkbox")).toHaveLength(0);
    expect(chipOf("Heartbeat")).toBe("pulado");
    expect(row("Heartbeat").textContent).toContain("O agente dela não vem.");

    // What to set up comes after the import; what doesn't come along isn't listed.
    expect(screen().queryByRole("list", { name: "Para configurar" })).toBeNull();
    expect(text()).not.toContain("O que não vem junto");
    expect(text()).not.toContain("gpt-imaginary-2");

    await click(button("Importar 3 itens"), 8);
    const applied = applies(state).filter((i) => !i.dryRun);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.pick).toEqual(["skill:review", "agent:cto", "note:COMPANY.md"]);
    expect("enableSkills" in (applied[0] ?? {})).toBe(false);
    // Every agent goes along, so the handles new ones get don't depend on the pick; only the picked one comes.
    expect(applied[0]?.bundle.agents.map((a) => a.key)).toEqual(["ceo", "cto"]);

    // The report: what came, with links, and focus on it.
    expect(document.activeElement === screen().getByRole("heading", { name: "Chegou tudo" })).toBe(true);
    const report = screen().getByRole("region", { name: "Chegou tudo" });
    expect(report.textContent).toContain("1 agente");
    expect(report.textContent).toContain("1 memória");
    const linus = within(report)
      .getAllByRole("link")
      .find((l) => l.textContent?.includes("Linus"));
    expect(linus?.getAttribute("href")).toStartWith(`/org/${ORG_ID}/agents/`);
    expect(within(report).getByRole("link", { name: "Abrir Skills" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/skills`,
    );
    const todo = screen().getByRole("list", { name: "Para configurar" });
    expect(
      within(todo)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Ada usa GH_TOKEN. Não vem no arquivo: o agente pede no chat.",
      "Ada e Linus usam OPENAI_API_KEY. Não vem no arquivo: os agentes pedem no chat.",
    ]);
    await click(button("Importar outro arquivo"), 2);
    expect(document.activeElement).toBe(button("Tenho um arquivo ou link"));
  });

  test("routines that arrived paused at their agent's limit are counted in the report", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const apply = api.imports.apply;
    api.imports.apply = async (orgId, input) => {
      const plan = await apply(orgId, input);
      if (input.dryRun) return plan;
      const items = plan.items.map((i) => (i.kind === "routine" ? { ...i, reason: "too_many_routines" as const } : i));
      return { ...plan, items };
    };
    await go(state, api);
    await pick("Pasta para importar", folder("paperclip-company"));
    const importIt = screen()
      .getAllByRole("button")
      .find((b) => /^Importar \d+ itens$/.test(b.textContent ?? ""));
    if (!importIt) throw new Error("no Importar");
    await click(importIt, 8);
    const report = screen().getByRole("region", { name: "Chegou tudo" });
    expect(report.textContent).toMatch(/\d+ rotinas? cheg(ou|aram) pausadas?: /);
  });

  test("dropping a file, or a whole folder (walked through its entries), reads it the same way", async () => {
    await go();
    await drop({ files: [fixture("sales-desk.openmaus.json")], items: [] });
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenMausBot");

    await click(button("Trocar arquivo"), 2);
    await drop({
      files: [],
      items: [{ webkitGetAsEntry: () => folderEntry("openclaw-workspace", "/openclaw-workspace") }],
    });
    expect(screen().getByRole("heading", { name: "Pinch" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenClaw");
    expect(screen().getByRole("checkbox", { name: "Trazer Pinch" }).getAttribute("aria-checked")).toBe("true");
  });

  test("each row says what happens: already here, will update, joins a channel, renamed, skipped and why, cut to fit", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    withPlan(api, state, () => [
      { kind: "skill", key: "pricing-policy", label: "pricing-policy", action: "unchanged" },
      { kind: "skill", key: "research-brief", label: "research-brief", action: "skip", reason: "exists" },
      { kind: "skill", key: "objection-handling", label: "objection-handling", action: "create" },
      { kind: "agent", key: "lead", label: "Morgan", action: "create", renamedTo: "lead2" },
      { kind: "agent", key: "scout", label: "Scout", action: "update" },
      { kind: "agent", key: "writer", label: "Quill", action: "create", reason: "model_not_in_catalog" },
      { kind: "channel", key: "desk", label: "deal-desk", action: "update", reason: "exists" },
      { kind: "channel", key: "room", label: "vendas", action: "update" },
      { kind: "routine", key: "daily-digest", label: "Daily digest", action: "skip", reason: "schedule_unsupported" },
      { kind: "routine", key: "weekly-review", label: "Weekly pipeline review", action: "create" },
      {
        kind: "note",
        key: "lead/MEMORY.md",
        label: "- The team prefers short summaries.",
        action: "skip",
        reason: "secret_like",
      },
      { kind: "note", key: "lead/memory/pricing.md", label: "# Pricing", action: "create", trimmed: ["content"] },
    ]);
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);

    expect(chipOf("pricing-policy")).toBe("já está aqui");
    expect(chipOf("research-brief")).toBe("pulado");
    expect(row("research-brief").textContent).toContain("Já existe uma skill com esse nome aqui. Ela fica como está.");
    expect(chipOf("Morgan · Sales lead")).toBeUndefined();
    expect(row("Morgan · Sales lead").textContent).toContain("Vira @lead2: o @lead já existe aqui.");
    expect(chipOf("Scout · Prospect researcher")).toBe("vai atualizar");
    expect(row("Scout · Prospect researcher").textContent).toContain("Mudou no outro app desde a última importação");
    expect(row("Quill · Outreach writer").textContent).toContain("usa o padrão do workspace");
    expect(chipOf("#deal-desk")).toBe("já existe");
    expect(row("#deal-desk").textContent).toContain("Os agentes entram no #deal-desk que já existe.");
    // One an earlier import made: the agents come in, nothing of it "gives way".
    expect(chipOf("#vendas")).toBe("vai atualizar");
    expect(row("#vendas").textContent).toContain("Os agentes entram no #vendas que já existe.");
    expect(row("#vendas").textContent).not.toContain("Mudou no outro app");
    expect(chipOf("Daily digest")).toBe("pulado");
    expect(row("Daily digest").textContent).toContain("Esse horário não dá para agendar aqui.");
    expect(row("The team prefers short summaries.").textContent).toContain("parecido com uma chave ou senha");
    expect(row("Pricing").textContent).toContain("Cortado para caber: texto.");
    // What is already here or skipped isn't a choice; the rest is, checked.
    expect(screen().queryByRole("checkbox", { name: "Trazer pricing-policy" })).toBeNull();
    expect(screen().queryByRole("checkbox", { name: "Trazer Daily digest" })).toBeNull();
    expect(screen().getByRole("checkbox", { name: "Trazer Scout" }).getAttribute("aria-checked")).toBe("true");
    // Skipped rows go last in their group.
    const skills = screen().getByRole("region", { name: "Skills" });
    expect([...skills.querySelectorAll(".imp-row__title")].map((t) => t.textContent)).toEqual([
      "objection-handling",
      "pricing-policy",
      "research-brief",
    ]);
    expect(button("Importar 8 itens")).toBeTruthy();
  });

  test("an OpenBot.run export whose agents are ids: each row shows the @ the agent gets, never the id", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // The server names an agent whose handle is an id after the agent.
    const named = ["otavioofertas", "newagent"];
    withPlan(api, state, (input) =>
      input.bundle.agents.map((a, i) => ({
        kind: "agent",
        key: a.key,
        label: a.name,
        action: "create",
        renamedTo: named[i],
      })),
    );
    await go(state, api);
    const file = {
      format: "openbot-agent-import",
      version: 1,
      source: { app: "grok-bot" },
      agents: [
        { key: "agent-e9665a97-c8d5-423f-ae59-257f9ab85263", name: "Otávio Ofertas", title: "Vendas" },
        { key: "agent-925ca021-21e4-4053-9e0a-230b9e8c127a", name: "New agent" },
      ],
    };
    await pick("Arquivos para importar", [new File([JSON.stringify(file)], "openbot-import.json")]);

    expect(row("Otávio Ofertas · Vendas").textContent).toContain("@otavioofertas");
    expect(row("New agent").textContent).toContain("@newagent");
    expect(text()).not.toContain("@agent-");
    // Not a rename: the id was never a handle here.
    expect(text()).not.toContain("já existe aqui");
    // The bundle keeps the ids, so a file imported before still matches what it made.
    expect(applies(state)[0]?.bundle.agents.map((a) => a.handle)).toEqual([
      "agent-e9665a97-c8d5-423f-ae59-25",
      "agent-925ca021-21e4-4053-9e0a-23",
    ]);
  });

  test("nothing new, or nothing that can come: it says so instead of offering Importar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let action: ImportItemResult["action"] = "unchanged";
    withPlan(api, state, (input) =>
      input.bundle.agents.map((a) => ({
        kind: "agent",
        key: a.key,
        label: a.name,
        action,
        ...(action === "skip" ? { reason: "secret_like" as const } : {}),
      })),
    );
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Tudo isso já está aqui.");
    expect(iconLine(document.querySelector(".imp-apply__none"))).toBe(true);
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();

    action = "skip";
    await click(button("Trocar arquivo"), 2);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Nada daqui pode vir. O motivo está em cada item.");
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();
  });

  test("Outro app: the export request to copy, a link to where each app answers, and a pasted reply read at once", async () => {
    const writes: string[] = [];
    let copyWorks = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          if (!copyWorks) throw new Error("denied");
          writes.push(s);
        },
      },
    });
    await go();
    await click(button(/^Outro app/), 4);
    await click(button("Prefiro colar o pedido e trazer a resposta"), 2);
    const other = sheetOf("Trazer de outro app");
    expect((within(other).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    // Where each app puts its file is on the help page, one link under the request.
    const where = within(other).getByRole("link", { name: "Onde cada app entrega" });
    expect(where.getAttribute("href")).toBe("https://agentes.chat/pt/docs/import#other-apps");
    expect(where.className).toBe("ac-link ac-link--muted");
    // What it gives back: a file to drop, or its answer to paste.
    expect(other.querySelector(".imp-drop")).toBeTruthy();

    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(within(other).getByRole("status").textContent).toContain("Não deu para copiar.");
    copyWorks = true;
    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(writes).toEqual([EXPORT_PROMPT]);
    expect(within(other).getByRole("button", { name: "Copiado" })).toBeTruthy();
    expect(within(other).getByRole("status").textContent).toBe("Agora é só colar no outro app.");

    await pasteReply(
      exportReply("claude", "Minhas automações"),
      "Solte o arquivo que ele devolver, ou cole a resposta",
    );
    expect(screen().getByRole("heading", { name: "Minhas automações" })).toBeTruthy();
    expect(text()).toContain("Veio do Claude");
    expect(document.querySelector(".imp-head .imp-mark img")).toBeNull();
    expect(screen().getByRole("checkbox", { name: "Trazer Newsy" }).getAttribute("aria-checked")).toBe("true");
    await click(button("Trocar arquivo"), 2);
    expect(button("Tenho um arquivo ou link")).toBeTruthy();
  });

  test("Grok Bot and ChatGPT dots: the same request in each app's own words, and a reply is known by its app wherever it lands", async () => {
    await go();
    await click(button("Grok Bot"), 4);
    await click(button("Prefiro colar o pedido e trazer a resposta"), 2);
    const grok = sheetOf("Trazer o time do Grok Bot");
    expect(grok.querySelector(".imp-sheet__text")?.textContent).toBe(
      "O bot escreve tudo o que tem num JSON. Você cola aqui e confere antes de criar.",
    );
    expect((within(grok).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    // Its steps say where: the help page's list is for any other app.
    expect(within(grok).queryByRole("link")).toBeNull();
    await closeSheet();

    await click(button("ChatGPT dots"), 4);
    const dots = sheetOf("Trazer o time do ChatGPT dots");
    expect(dots.querySelector(".imp-sheet__text")?.textContent).toBe(
      "O seu dot escreve tudo o que tem num arquivo. Você solta aqui e confere antes de criar.",
    );
    expect((within(dots).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    await closeSheet();

    // A Grok Bot reply pasted in the file sheet: from Grok Bot, by its logo.
    await pasteReply(exportReply("grok-bot", "Minhas automações"));
    expect(text()).toContain("Veio do Grok Bot");
    expect(document.querySelector(".imp-head .imp-mark img")?.getAttribute("src")).toBe("/brands/grok-bot.svg");
    await click(button("Trocar arquivo"), 2);

    // The file a dot makes, dropped on the page.
    const file = new File([JSON.stringify(exportReply("chatgpt-dots", "Meu dot"))], "agentes-chat-export.json");
    await drop({ files: [file], items: [] });
    expect(text()).toContain("Veio do ChatGPT dots");
    expect(document.querySelector(".imp-head .imp-mark img")?.getAttribute("src")).toBe("/brands/chatgpt-dots.svg");
  });

  test("what went wrong says what to do next, with Tentar de novo only where trying again helps", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let fail: ApiError | null = null;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const error = fail;
        fail = null;
        if (error) throw error;
        return fake(orgId, input);
      },
    };
    await go(state, api);
    const alert = () => screen().getByRole("alert").textContent ?? "";
    const retry = () => screen().queryByRole("button", { name: "Tentar de novo" });

    await pick("Arquivos para importar", [new File(["Lista de compras: café, pão."], "notas.txt")]);
    expect(alert()).toContain("Não reconhecemos esses arquivos");
    expect(retry()).toBeNull();

    const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
    await act(async () => fireEvent.change(field, { target: { value: "https://gitlab.com/acme/agents" } }));
    await click(button("Ler"), 6);
    expect(alert()).toContain("só lê links do GitHub");
    expect(calls(state, "agents.importFromGithub")).toHaveLength(0);

    await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => "oi, tudo bem?" } }));
    await settle(6);
    // No card named: Grok Bot, ChatGPT dots and Outro app each show the request.
    expect(alert()).toContain(
      "Não reconhecemos esse texto. Cole a resposta inteira do outro app, com o JSON, ou copie o pedido de novo e peça outra vez.",
    );

    fail = new ApiError(500, "internal", "boom");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("Lemos os arquivos, mas não deu para comparar com o workspace.");
    await click(retry() as HTMLElement, 10);
    await toPreview();
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();

    await click(button("Trocar arquivo"), 2);
    fail = new ApiError(413, "import.too_large", "The import is too large (max 32 MB)");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("É coisa demais para uma importação só (até 32 MB).");
    expect(retry()).toBeNull();
  });

  test("Cancelar stops waiting for a slow plan, and its answer is dropped", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let answer: (plan: ImportPlan) => void = () => {};
    api.imports = { ...api.imports, apply: () => new Promise<ImportPlan>((resolve) => (answer = resolve)) };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    await click(button("Cancelar"), 2);
    expect(document.activeElement?.textContent).toContain("Solte aqui a pasta, o arquivo ou o .zip");
    await act(async () => answer({ items: [{ kind: "agent", key: "lead", label: "Morgan", action: "create" }] }));
    await settle(4);
    expect(screen().queryByRole("heading", { name: "Sales desk" })).toBeNull();
  });

  test("a file dropped while another is being read is caught (never opened by the browser) and not read", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let asked = 0;
    api.imports = {
      ...api.imports,
      apply: () => {
        asked++;
        return new Promise<ImportPlan>(() => {});
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    const zone = document.querySelector(".imp-pick") as HTMLElement;
    const dataTransfer = {
      files: [fixture("sales-desk.openmaus.json")],
      items: [],
      types: ["Files"],
      dropEffect: "copy",
    };
    let over = true;
    let dropped = true;
    await act(async () => {
      over = fireEvent.dragOver(zone, { dataTransfer });
    });
    expect(text()).not.toContain("Pode soltar");
    await act(async () => {
      dropped = fireEvent.drop(zone, { dataTransfer });
    });
    await settle(6);
    // Default prevented: the browser doesn't navigate to the file.
    expect([over, dropped]).toEqual([false, false]);
    expect(asked).toBe(1);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
  });

  test("an apply that fails keeps what came, says so, and Importar again brings the rest", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let failures = 1;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        if (!input.dryRun && failures-- > 0) throw new TypeError("Failed to fetch");
        return fake(orgId, input);
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("alert").textContent).toContain("Sem internet");
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
    expect(text()).toContain("3 agentes");
    expect(text()).not.toContain("pausadas");
    // What to set up: one plain line each, with where it's done.
    const hubspot = within(screen().getByRole("list", { name: "Para configurar" }))
      .getAllByRole("listitem")
      .find((li) => li.textContent?.startsWith("Esta importação usa o HubSpot."));
    expect(
      within(hubspot as HTMLElement)
        .getByRole("link", { name: "Conectar" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/settings/connectors`);
  });

  describe("an app that keeps its agents on the person's computer", () => {
    /** What `agentes-runner migrate --from openbot` writes: OpenBot's own transfer file, a skill and a workspace. */
    const migrated = () =>
      new File(
        [
          zip({
            "openbot-transfer.json": JSON.stringify({
              format: "openbot-instance-transfer",
              version: 1,
              source: { appVersion: "", exportedAt: "2026-11-16T12:00:00.000Z" },
              agents: [
                {
                  key: "scout",
                  name: "Scout",
                  title: "Pesquisa de mercado",
                  description: "You look things up.",
                  avatarSeed: "s1",
                  avatarHue: 120,
                  avatar: null,
                  provider: "claude",
                  model: "claude-opus",
                  reasoningEffort: "high",
                  notifications: true,
                  skills: ["agents/scout/skills/research"],
                  files: "agents/scout/workspace",
                  routines: [
                    {
                      key: "r1",
                      name: "Daily",
                      instruction: "Check prices",
                      active: false,
                      timezone: "America/Sao_Paulo",
                      schedule: { kind: "daily", time: "09:00" },
                    },
                  ],
                  webhookRoutines: [{ key: "r2", name: "On push", instruction: "x", active: true, timezone: "" }],
                  memories: [{ text: "Likes short answers" }],
                },
              ],
              settings: {
                mcpServers: [],
                customProviders: [],
                customAgents: [],
                sidebarSections: [],
                routineFlows: [],
                workflows: [
                  {
                    title: "Weekly prices",
                    graph: {
                      nodes: [
                        {
                          id: "t",
                          kind: "trigger",
                          at: { x: 0, y: 0 },
                          fields: { trigger: "schedule", timezone: "UTC" },
                          schedule: { kind: "weekly", weekday: 1, time: "09:00" },
                        },
                        {
                          id: "a",
                          kind: "agent",
                          at: { x: 1, y: 0 },
                          fields: { agentId: "scout", task: "Research prices" },
                        },
                        {
                          id: "o",
                          kind: "output",
                          at: { x: 2, y: 0 },
                          fields: { target: "chat-channel", channelId: "launch" },
                        },
                      ],
                      edges: [
                        { id: "e1", from: "t", to: "a", type: "text" },
                        { id: "e2", from: "a", to: "o", type: "text" },
                      ],
                      strokes: [],
                    },
                  },
                ],
              },
              shared: null,
              signedIn: [],
              channels: [
                {
                  key: "launch",
                  name: "Launch",
                  title: "",
                  instructions: "",
                  members: ["scout"],
                  lead: null,
                  image: null,
                  archived: false,
                  memories: [],
                  routines: [],
                },
                {
                  key: "old",
                  name: "Old",
                  title: "",
                  instructions: "",
                  members: ["scout"],
                  lead: null,
                  image: null,
                  archived: true,
                  memories: [],
                  routines: [],
                },
              ],
            }),
            "agents/scout/skills/research/SKILL.md": "---\nname: research\ndescription: Look it up\n---\n\nLook it up.",
            "agents/scout/workspace/reports/week.md": "# Week\n",
          }).slice(),
        ],
        "agentes-chat-import-openbot.zip",
      );
    const field = (sheet: HTMLElement, label: string) => within(sheet).getByLabelText(label) as HTMLTextAreaElement;

    test("its card opens its ways, the command first: each one's steps, and Back to them; the pick stays", async () => {
      await go();
      await click(button("OpenBot.run"), 6);
      const ways = sheetOf("Trazer o time do OpenBot");
      const rows = [...ways.querySelectorAll(".imp-paths .ac-optrow")].map((b) => b.textContent);
      expect(rows).toEqual([
        "Com um comandoO mais completoTraz tudo, até arquivos e workflows. Pelo assistente de código ou terminal",
        "Conectando o OpenBotEle cria os agentes aqui pelo MCP. Sem arquivos nem workflows",
        "Pedindo ao OpenBotEle escreve o que sabe, você cola aqui. Sem arquivos nem workflows",
      ]);
      expect(ways.textContent).toContain("Chaves, senhas e sessões do OpenBot nunca vêm, por nenhum caminho.");
      // Nothing to drop before a way is picked.
      expect(ways.querySelector(".imp-drop")).toBeNull();

      // Its own agent creates them here through MCP: the app's steps, the request, and the wait.
      await click(within(ways).getByRole("button", { name: /^Conectando o OpenBot/ }), 4);
      const mcp = sheetOf("Conectando o OpenBot");
      expect(mcp.querySelector(".imp-sheet__text")?.textContent).toBe(
        "O MCP deixa o OpenBot acessar este workspace, e ele cria os agentes aqui sozinho.",
      );
      expect(within(mcp).getByLabelText("Pedido para o seu app de IA")).toBeTruthy();
      expect(mcp.textContent).toContain("Esperando os agentes chegarem…");
      await click(within(mcp).getByRole("button", { name: "Voltar" }), 4);

      // Its agent writes the export: the request, then the file or the answer.
      await click(within(sheetOf("Trazer o time do OpenBot")).getByRole("button", { name: /^Pedindo ao OpenBot/ }), 4);
      const ask = sheetOf("Pedindo ao OpenBot");
      expect(ask.textContent).toContain("Numa conversa com um agente do OpenBot, cole este pedido");
      expect((within(ask).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
      expect(within(ask).getByLabelText("Solte o arquivo que ele criar, ou cole a resposta")).toBeTruthy();
      expect(ask.querySelector(".imp-drop")).toBeTruthy();
      // Closed and opened again, the card is where it was left.
      await closeSheet();
      await click(button("OpenBot.run"), 6);
      expect(sheetOf("Pedindo ao OpenBot")).toBeTruthy();
      await click(within(sheetOf("Pedindo ao OpenBot")).getByRole("button", { name: "Voltar" }), 4);

      await click(within(sheetOf("Trazer o time do OpenBot")).getByRole("button", { name: /^Com um comando/ }), 4);
      const sheet = sheetOf("Com um comando");
      const request = field(sheet, "Pedido para o assistente de código").value;
      expect(request).toContain("Move my OpenBot agents to agentes.chat.");
      expect(request).toContain("Ask me where to save the export file.");
      expect(request).toContain('/migrate.sh | sh -s -- --from openbot --out "<folder>" --json');
      expect(request).toContain("agentes-chat-import-openbot.zip");
      expect(sheet.textContent).toContain("Só leitura. Chaves, senhas e sessões do OpenBot nunca são lidas.");
      expect(sheet.textContent).toContain("agentes-chat-import-openbot.zip, na pasta que você escolheu");

      await click(within(sheet).getByRole("radio", { name: "Windows" }), 2);
      expect(field(sheet, "Pedido para o assistente de código").value).toContain(
        '/migrate.ps1))) -From openbot -Out "<folder>" -Json',
      );
      await click(within(sheet).getByRole("button", { name: "Prefiro rodar o comando eu mesmo" }), 2);
      expect(sheet.textContent).toContain("Cole no PowerShell");
      expect(field(sheet, "Comando").value).toMatch(
        /^& \(\[scriptblock\]::Create\(\(irm \S+\/migrate\.ps1\)\)\) -From openbot$/,
      );
      await click(within(sheet).getByRole("radio", { name: "Mac ou Linux" }), 2);
      expect(sheet.textContent).toContain("Cole no terminal");
      expect(field(sheet, "Comando").value).toMatch(/^curl -fsSL \S+\/migrate\.sh \| sh -s -- --from openbot$/);

      // Each app on a computer has the same sheet, in its own name.
      await closeSheet();
      // No card stays picked under it: the page is back to the cards and the file button.
      expect(button("OpenBot.run").getAttribute("aria-pressed")).toBe("false");
      expect(button("Tenho um arquivo ou link")).toBeTruthy();
      await click(button("Hermes Agent"), 6);
      await click(within(sheetOf("Trazer o time do Hermes")).getByRole("button", { name: /^Com um comando/ }), 4);
      expect(field(sheetOf("Com um comando"), "Pedido para o assistente de código").value).toContain("--from hermes");
      await closeSheet();
      // Paperclip has no chat to ask in nor MCP: the command is its only way, with nothing to go back to.
      await click(button("Paperclip"), 6);
      const paperclip = sheetOf("Trazer o time do Paperclip");
      expect(field(paperclip, "Pedido para o assistente de código").value).toContain("--from paperclip");
      expect(within(paperclip).queryByRole("button", { name: "Voltar" })).toBeNull();
    });

    test("the file dropped there: who comes, what comes with them, the workflows; then they arrive", async () => {
      const { state } = await go();
      await click(button("OpenBot.run"), 6);
      await click(within(sheetOf("Trazer o time do OpenBot")).getByRole("button", { name: /^Com um comando/ }), 4);
      const input = within(sheetOf("Com um comando")).getByLabelText("Arquivos para importar");
      Object.defineProperty(input, "files", { configurable: true, value: [migrated()] });
      await act(async () => fireEvent.change(input));
      await settle(12);

      // Who comes: a title and a line each.
      const who = sheetOf("Quem vem");
      expect(who.textContent).toContain("Scout");
      expect(who.textContent).toContain("Pesquisa de mercado");
      await click(within(who).getByRole("button", { name: "Continuar" }), 6);

      // What comes with them, a row a kind; the archived channel stays behind.
      const kinds = sheetOf("O que vem com eles");
      for (const text of ["2 rotinas", "Uma chega pausada, como estava lá", "1 memória", "1 skill", "1 canal"])
        expect(kinds.textContent).toContain(text);
      expect(kinds.textContent).toContain("1 arquivo para o Drive");
      // A kind's arrow opens its list; one unchecked there, the kind says how many of how many.
      await click(within(kinds).getByRole("button", { name: /^2 rotinas/ }), 6);
      const list = sheetOf("2 rotinas");
      expect(list.textContent).toContain("Daily");
      expect(list.textContent).toContain("Scout · endereço novo");
      await click(within(list).getByRole("checkbox", { name: "Trazer On push" }), 4);
      await click(within(list).getByRole("button", { name: "Voltar" }), 6);
      expect(sheetOf("O que vem com eles").textContent).toContain("1 de 2 rotinas");
      await click(within(sheetOf("O que vem com eles")).getByRole("button", { name: "Continuar" }), 6);

      // The workflows: what each becomes, its steps behind its arrow.
      const flows = sheetOf("Os workflows");
      expect(flows.textContent).toContain("Rotina · Scout");
      await click(within(flows).getByRole("button", { name: /^Weekly prices/ }), 6);
      const steps = sheetOf("Weekly prices");
      expect(steps.textContent).toContain("Research prices");
      expect(steps.textContent).toContain("Posta em #launch");
      await click(within(steps).getByRole("button", { name: "Voltar" }), 6);

      // Nothing is made before the last step's button. The routine that was off comes off; the webhook one gets a
      // new address; the workflow is a routine posting in its channel.
      expect(applies(state).every((a) => a.dryRun)).toBe(true);
      const [plan] = applies(state);
      expect(plan?.bundle.routines).toMatchObject([
        { name: "Daily", paused: true },
        { name: "On push", trigger: { webhook: true } },
        { name: "Weekly prices", channel: "launch", trigger: { cron: "0 9 * * 1", timezone: "UTC" } },
      ]);
      expect(plan?.bundle.channels.map((c) => c.name)).toEqual(["launch"]);
      expect(plan?.bundle.todo).toContainEqual({ kind: "webhook", label: "On push", agents: ["scout"] });
      expect(sheetOf("Os workflows").textContent).toContain("ganha um endereço novo aqui");

      await click(within(sheetOf("Os workflows")).getByRole("button", { name: /^Trazer 1 agente e mais / }), 30);
      const here = sheetOf("O time chegou");
      expect(here.textContent).toContain("Scout já está aqui.");
      expect(state.agents.some((a) => a.name === "Scout")).toBe(true);
      const made = applies(state).filter((a) => !a.dryRun);
      expect(made.flatMap((a) => a.pick ?? [])).not.toContain("routine:scout/r2");
      expect(calls(state, "imports.copyFile")).toHaveLength(1);

      // Closing it leaves the import's own report on the page.
      await click(within(here).getByRole("button", { name: "Ver o que chegou" }), 6);
      expect(screen().queryByRole("dialog")).toBeNull();
      expect(screen().getByRole("region", { name: "Chegou tudo" })).toBeTruthy();
    });

    test("closing the sheet at a step leaves the full preview, with nothing made", async () => {
      const { state } = await go();
      await click(button("OpenBot.run"), 6);
      await click(within(sheetOf("Trazer o time do OpenBot")).getByRole("button", { name: /^Com um comando/ }), 4);
      const input = within(sheetOf("Com um comando")).getByLabelText("Arquivos para importar");
      Object.defineProperty(input, "files", { configurable: true, value: [migrated()] });
      await act(async () => fireEvent.change(input));
      await settle(12);
      await click(within(sheetOf("Quem vem")).getByRole("button", { name: "Continuar" }), 6);
      await closeSheet();
      expect(screen().queryByRole("dialog")).toBeNull();
      expect(screen().getByRole("checkbox", { name: "Trazer Scout" })).toBeTruthy();
      expect(applies(state).every((a) => a.dryRun)).toBe(true);
    });
  });

  describe("an OpenBot.run export with the agents' own files", () => {
    const openbot = (name: string) => readFileSync(join(FIXTURES, "openbot-run", name), "utf8");
    /** As the OpenBot.run export comes: a .zip with its folder inside, made on a Mac. */
    const exported = () =>
      new File(
        [
          zip({
            "openbot-export/openbot-import.json": openbot("openbot-import.json"),
            "openbot-export/agents/scout/skills/price-watch/SKILL.md": openbot(
              "agents/scout/skills/price-watch/SKILL.md",
            ),
            "openbot-export/agents/scout/files/INSTRUCTIONS.md": openbot("agents/scout/files/INSTRUCTIONS.md"),
            "openbot-export/agents/scout/files/rivals.txt": "northwind.example\ncontoso.example\n",
            "openbot-export/agents/scout/files/notes/pricing.md": "# Pricing",
            "openbot-export/agents/scout/files/charts/q3.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
            "openbot-export/agents/scout/files/.env": "NORTHWIND_TOKEN=fixture-never-read",
            "openbot-export/agents/scout/files/.DS_Store": "junk",
            "__MACOSX/openbot-export/agents/scout/files/._rivals.txt": "junk",
          }).slice(),
        ],
        "openbot-export-2026-10-18.zip",
      );
    const copies = (state: State) =>
      calls(state, "imports.copyFile").map((c) => c.args[1] as Omit<ImportFileInput, "file">);
    const driveTitles = async (api: ApiClient) =>
      (await api.artifacts.list(ORG_ID, { q: "Scout/" })).map((a) => a.title).sort();
    const importIt = async () => {
      const go = screen()
        .getAllByRole("button")
        .find((b) => /^Importar \d+ itens$/.test(b.textContent ?? ""));
      if (!go) throw new Error("no Importar");
      await click(go, 30);
    };

    test("the preview says how many and how big, copying on; Importar puts them in the agent's folder, says what stayed behind, and the agent knows where they are", async () => {
      const { state, api } = await go();
      await pick("Arquivos para importar", [exported()]);
      const files = screen().getByRole("region", { name: "Copiar os arquivos para o Drive" });
      expect(
        within(files).getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(files.textContent).toContain("Drive\u00a0›\u00a0Scout");
      expect(files.textContent).toContain("3 arquivos · 51 bytes");
      // What stays behind: system files here; keys aren't even listed.
      expect(files.textContent).toContain("Arquivos do sistema");
      expect(files.textContent).toContain(".DS_Store, ._rivals.txt");
      expect(text()).not.toContain("agents/scout/files/.env");
      // The system files the reader dropped, counted once, with what they are behind an ⓘ.
      const system = [...document.querySelectorAll(".imp-note")].find((n) =>
        n.textContent?.includes("arquivos de sistema ficaram de fora"),
      );
      expect(system?.querySelector(".ac-hintline > span")?.textContent).toBe("2 arquivos de sistema ficaram de fora");
      expect(system?.querySelector("button.ac-hint")?.getAttribute("aria-label")).toBe(
        "Sobre 2 arquivos de sistema ficaram de fora",
      );
      expect(copies(state)).toEqual([]);

      await importIt();
      const scout = state.agents.find((a) => a.name === "Scout");
      if (!scout) throw new Error("Scout didn't come");
      expect(copies(state)).toEqual([
        { agentId: scout.id, path: "rivals.txt", name: "rivals.txt", note: "Trazido do OpenBot.run" },
        { agentId: scout.id, path: "notes/pricing.md", name: "pricing.md", note: "Trazido do OpenBot.run" },
        { agentId: scout.id, path: "charts/q3.png", name: "q3.png", note: "Trazido do OpenBot.run" },
      ]);
      expect(await driveTitles(api)).toEqual(["Scout/charts/q3.png", "Scout/notes/pricing.md", "Scout/rivals.txt"]);
      const report = screen().getByRole("region", { name: "Chegou tudo" });
      expect(report.textContent).toContain("3 arquivos no Drive");
      expect(within(report).getByRole("link", { name: "Drive › Scout" }).getAttribute("href")).toBe(
        `/org/${ORG_ID}/agents/${scout.id}?tab=files`,
      );
      const left = screen().getByRole("region", { name: "Arquivos que ficaram de fora" });
      expect(left.textContent).toContain("Chaves e logins nunca vão para o Drive.env");
      expect(left.textContent).toContain("Arquivos do sistema.DS_Store, ._rivals.txt");
      expect(text()).toContain("3 arquivos copiados para o Drive.");
      // One line in Scout's memory says where its files are.
      const pointer = applies(state).find((i) => i.pick?.[0] === "note:scout/drive-files");
      expect(pointer?.pick).toEqual(["note:scout/drive-files"]);
      expect(pointer?.bundle.notes).toEqual([
        {
          key: "scout/drive-files",
          agent: "scout",
          kind: "fact",
          content: "Seus arquivos do OpenBot.run estão em Drive\u00a0›\u00a0Scout.",
        },
      ]);

      // The same export again: what the folder has stays as it was.
      await click(button("Importar outro arquivo"), 2);
      await pick("Arquivos para importar", [exported()]);
      await importIt();
      expect(copies(state)).toHaveLength(6);
      expect(await driveTitles(api)).toEqual(["Scout/charts/q3.png", "Scout/notes/pricing.md", "Scout/rivals.txt"]);
      expect(screen().getByRole("region", { name: "Chegou tudo" }).textContent).toContain(
        "Nenhum arquivo novo no Drive",
      );
      expect(screen().getByRole("region", { name: "Arquivos que ficaram de fora" }).textContent).toContain(
        "Já estavam no Driverivals.txt, notes/pricing.md, charts/q3.png",
      );
    });

    test("past 500 files, copying starts off and says why", async () => {
      const { state } = await go();
      const files: Record<string, string> = {
        "openbot-export/openbot-import.json": openbot("openbot-import.json"),
      };
      for (let i = 0; i < 501; i++) files[`openbot-export/agents/scout/files/data/${i}.csv`] = `${i}`;
      await pick("Arquivos para importar", [new File([zip(files).slice()], "openbot-export.zip")]);
      const group = screen().getByRole("region", { name: "Copiar os arquivos para o Drive" });
      expect(
        within(group).getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("false");
      expect(group.textContent).toContain("São 501 arquivos, então a cópia começa desligada.");
      await importIt();
      expect(copies(state)).toEqual([]);
    });

    test("turned off, nothing is copied", async () => {
      const { state, api } = await go();
      await pick("Arquivos para importar", [exported()]);
      await click(screen().getByRole("switch", { name: "Copiar os arquivos para o Drive" }), 2);
      expect(
        screen().getByRole("switch", { name: "Copiar os arquivos para o Drive" }).getAttribute("aria-checked"),
      ).toBe("false");
      await importIt();
      expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
      expect(copies(state)).toEqual([]);
      expect(await driveTitles(api)).toEqual([]);
      expect(text()).not.toContain("arquivos no Drive");
      expect(text()).not.toContain("Copiando os arquivos");
      expect(applies(state).some((i) => i.pick?.[0] === "note:scout/drive-files")).toBe(false);
    });
  });
});
