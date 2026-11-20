import { afterEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { WorkbookViewProps } from "@/components/live/spreadsheet";

/**
 * Live files in the Drive (ADR 0196 §9, ADR 0198): "Novo" makes a spreadsheet, a presentation or a canvas and opens
 * its page with the title ready to be named; cards draw a live file's preview and the faces of who is in it; a click or
 * a link opens its own page instead of the viewer; an uploaded Office file shows in the viewer, drawn from the server's
 * reading of it, with "Edit as spreadsheet". The editors and their small views are stand-ins here (each has its own
 * tests).
 */

function Stub() {
  return <div data-testid="editor" />;
}
mock.module("../src/components/live/spreadsheet", () => ({
  Spreadsheet: Stub,
  WorkbookView: (props: WorkbookViewProps) => (
    <div data-testid="workbook">
      <div className="sheet-quiet">{props.notice}</div>
      {props.workbook.sheets.map((s) => s.name).join(", ")}
    </div>
  ),
}));
mock.module("../src/components/live/slides", () => ({
  Slides: Stub,
  SlideThumb: () => <span data-testid="slide-thumb" />,
  DeckView: () => <div data-testid="deck" />,
}));
mock.module("../src/components/live/canvas", () => ({
  Canvas: Stub,
  CanvasMini: () => <span data-testid="canvas-mini" />,
}));

const { setValues, SYSTEM, sheetIds } = await import("@agenteschat/live");
const { sheetLocale } = await import("@agenteschat/live/spreadsheet");
const { closeAllLiveRooms } = await import("@agenteschat/client");
const { act, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { relocalize } = await import("@/components/live/LiveCover");
const { ADA_ID, createFakeApi, fakeLiveOf, ORG_ID, seedState } = await import("./fake-api");
const { renderApp, renderPage, screen, settle } = await import("./render");
const { ArtifactCard } = await import("@/components/artifacts/ArtifactCard");
const { ArtifactViewerProvider } = await import("@/components/artifacts/ArtifactViewer");

const nativeObserver = globalThis.IntersectionObserver;
afterEach(() => {
  cleanup();
  closeAllLiveRooms();
  globalThis.IntersectionObserver = nativeObserver;
});

/** Every card on screen at once (happy-dom's observer never answers): the Drive loads their previews when seen. */
function everythingInView() {
  globalThis.IntersectionObserver = class {
    constructor(readonly answer: IntersectionObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.answer([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

const click = (el: Element) => act(async () => fireEvent.click(el));
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  return within(screen().getByRole("menu"));
};

function setup() {
  const state = seedState();
  const api = createFakeApi(state);
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  return { state, api, live, methods: () => state.calls.map((c) => c.method) };
}

const pageOf = (path: string) => /\/org\/[^/]+\/drive\/([^/?]+)$/.exec(path)?.[1] ?? null;
const cardOf = (title: string) =>
  (screen().getByRole("button", { name: title }).closest(".drive-card") as HTMLElement | null) ??
  (() => {
    throw new Error(`no card for ${title}`);
  })();

describe("live files in the Drive", () => {
  test("New makes a spreadsheet and opens its page, the title selected to be named", async () => {
    const { api, methods } = setup();
    const app = await renderApp(`/org/${ORG_ID}/drive`, { api });
    const menu = await openMenu(screen().getByRole("button", { name: "Novo" }));
    // Each kind with a quiet line on what it is for.
    expect(menu.getByRole("menuitem", { name: /Apresentação/ }).textContent).toContain("Slides para mostrar");
    expect(menu.getByRole("menuitem", { name: /Quadro/ }).textContent).toContain("Imagens, notas e ideias soltas");
    await click(menu.getByRole("menuitem", { name: /Planilha/ }));
    await settle(8);
    expect(methods()).toContain("live.create");
    const id = pageOf(app.router.state.location.pathname);
    expect(id).toBeTruthy();
    expect((await api.artifacts.get(ORG_ID, id as string)).title).toBe("Planilha sem título");
    const field = await waitFor(() => screen().getByRole("textbox", { name: "Nome do arquivo" }) as HTMLInputElement);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.value).toBe("Planilha sem título");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
  });

  test("an empty Drive offers New beside Upload", async () => {
    const { api } = setup();
    const page = await api.artifacts.list(ORG_ID);
    for (const a of page) await api.artifacts.remove(ORG_ID, a.id);
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    const empty = within(document.querySelector(".ac-empty") as HTMLElement);
    expect(empty.getByRole("button", { name: "Novo" })).toBeTruthy();
  });

  test("cards draw a live file's preview and who is in it; a click opens its own page", async () => {
    const { api, live } = setup();
    const sheet = await live.addFile(ORG_ID, {
      kind: "spreadsheet",
      title: "Receitas",
      init: (doc) => {
        const id = sheetIds(doc)[0] as string;
        const rows = [
          ["Mês", "Receita"],
          ["Jan", 1234.5],
        ];
        setValues(doc, { sheet: id, row: 0, col: 0 }, rows, sheetLocale("en-US"), SYSTEM);
      },
    });
    await live.addFile(ORG_ID, { kind: "canvas", title: "Ideias" });
    await live.addFile(ORG_ID, { kind: "slides", title: "Pitch" });
    live.presence.set(sheet.id, [
      { kind: "person", id: "u-joao", mode: "editing" },
      { kind: "agent", id: ADA_ID, mode: "editing" },
    ]);
    everythingInView();
    const app = await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(6);
    const card = await waitFor(() => cardOf("Receitas"));
    // Its first cells on their grid, the numbers as the reader writes them.
    await waitFor(() => expect(card.querySelector(".lf-mini-grid")).toBeTruthy());
    expect(within(card).getByText("Receita")).toBeTruthy();
    expect(within(card).getByText("1234,5")).toBeTruthy();
    // Who is in it now (on the cover, which is a picture of the file: the title's button is what a reader hears).
    const here = await waitFor(() => within(card).getByRole("img", { name: "Aqui agora: João e Ada", hidden: true }));
    expect(here.querySelectorAll(".ac-avatar")).toHaveLength(2);
    await waitFor(() => expect(within(cardOf("Ideias")).getByTestId("canvas-mini")).toBeTruthy());
    expect(cardOf("Pitch").querySelector(".lf-cover--slides")).toBeTruthy();

    await click(within(card).getByRole("button", { name: "Receitas" }));
    await settle(6);
    expect(pageOf(app.router.state.location.pathname)).toBe(sheet.id);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("a link to a live file (the Drive's) opens its page in the link's place, never the viewer", async () => {
    const { api, live } = setup();
    const file = await live.addFile(ORG_ID, { kind: "slides", title: "Pitch" });
    const app = await renderApp(`/org/${ORG_ID}/drive?artifact=${file.id}`, { api });
    await settle(8);
    expect(pageOf(app.router.state.location.pathname)).toBe(file.id);
    expect(document.querySelector(".artifact-sheet")).toBeNull();
    // The link's entry was replaced: Back leaves the file, it doesn't land on the link again.
    expect(app.router.history.length).toBe(1);
  });

  test("an uploaded Excel file shows its sheets in the viewer; Edit as spreadsheet makes a live copy and opens it", async () => {
    const { api, live, methods } = setup();
    const upload = await api.artifacts.upload(
      ORG_ID,
      new File(["xlsx"], "vendas.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
    live.previews.set(upload.id, {
      kind: "workbook",
      workbook: {
        sheets: [
          {
            name: "Plan1",
            rows: 2,
            cols: 2,
            cells: [
              { r: 0, c: 0, v: "Mês" },
              { r: 1, c: 0, v: "Jan" },
            ],
          },
          { name: "Plan2", rows: 1, cols: 1, cells: [] },
        ],
      },
    });
    const app = await renderApp(`/org/${ORG_ID}/drive?artifact=${upload.id}`, { api });
    await settle(8);
    const sheet = await waitFor(() => screen().getByTestId("workbook"));
    expect(sheet.textContent).toContain("Plan1, Plan2");
    expect(within(sheet).getByText("Arquivo do Excel")).toBeTruthy();
    await click(within(sheet).getByRole("button", { name: "Editar como planilha" }));
    await settle(8);
    expect(methods()).toContain("live.openAs");
    const id = pageOf(app.router.state.location.pathname);
    expect(id).toBeTruthy();
    expect((await api.artifacts.get(ORG_ID, id as string)).kind).toBe("spreadsheet");
  });

  test("a PowerPoint shows its slides, a Word document its page; one the server can't read says so", async () => {
    const { api, live } = setup();
    const deck = await api.artifacts.upload(
      ORG_ID,
      new File(["pptx"], "pitch.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );
    live.previews.set(deck.id, { kind: "deck", deck: { w: 1920, h: 1080, slides: [], media: {} } });
    await renderApp(`/org/${ORG_ID}/drive?artifact=${deck.id}`, { api });
    await settle(8);
    await waitFor(() => expect(screen().getByTestId("deck")).toBeTruthy());
    expect(screen().getByText("Arquivo do PowerPoint")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Editar como apresentação" })).toBeTruthy();
    cleanup();

    const doc = await api.artifacts.upload(
      ORG_ID,
      new File(["docx"], "contrato.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    live.previews.set(doc.id, { kind: "document", html: "<h1>Contrato</h1><p>Entre Acme e Ada.</p>" });
    await renderApp(`/org/${ORG_ID}/drive?artifact=${doc.id}`, { api });
    await settle(8);
    await waitFor(() => expect(screen().getByText("Arquivo do Word")).toBeTruthy());
    expect(screen().getByRole("button", { name: "Editar como documento" })).toBeTruthy();
    // Never in the app's own page: the server's HTML goes only into the isolated frame.
    expect(document.body.textContent).not.toContain("Entre Acme e Ada.");
    cleanup();

    const broken = await api.artifacts.upload(
      ORG_ID,
      new File(["?"], "velho.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
    await renderApp(`/org/${ORG_ID}/drive?artifact=${broken.id}`, { api });
    await settle(8);
    await waitFor(() =>
      expect(screen().getByText("Não dá para mostrar este arquivo aqui. Baixe para abrir.")).toBeTruthy(),
    );
  });
});

describe("a live file's card in a message", () => {
  test("draws the file as it is now, says how much it holds, and opens its page", async () => {
    const { api, live } = setup();
    const deck = await live.addFile(ORG_ID, { kind: "slides", title: "Pitch" });
    const page = await renderPage(
      <ArtifactViewerProvider>
        <ArtifactCard artifact={{ id: deck.id, version: 1 }} />
      </ArtifactViewerProvider>,
      { api, org: true },
    );
    await settle(6);
    const tile = await waitFor(() => document.querySelector(".artifact-tile") as HTMLElement);
    expect(tile.querySelector(".lf-cover--slides")).toBeTruthy();
    expect(tile.textContent).toContain("Apresentação · 1 slide");
    await click(within(tile).getByRole("button", { name: "Abrir Pitch" }));
    await settle(4);
    expect(pageOf(page.router.state.location.pathname)).toBe(deck.id);
    // Never the viewer: a live file has a page of its own.
    expect(document.querySelector(".artifact-sheet")).toBeNull();
  });
});

describe("a spreadsheet's cover in the reader's language", () => {
  const pt = sheetLocale("pt-BR");
  const en = sheetLocale("en-US");
  test("numbers take the reader's separators; words and dates stay", () => {
    expect(relocalize("1,234.5", pt)).toBe("1.234,5");
    expect(relocalize("1234.5", pt)).toBe("1234,5");
    expect(relocalize("-12.25%", pt)).toBe("-12,25%");
    expect(relocalize("R$ 1,234.00", pt)).toBe("R$ 1.234,00");
    expect(relocalize("(7.25)", pt)).toBe("(7,25)");
    expect(relocalize("Receita", pt)).toBe("Receita");
    expect(relocalize("11/17/2026", pt)).toBe("11/17/2026");
    expect(relocalize("1,234.5", en)).toBe("1,234.5");
  });
  test("TRUE, FALSE and errors in the reader's words", () => {
    expect(relocalize("TRUE", pt)).toBe("VERDADEIRO");
    expect(relocalize("#N/A", pt)).toBe("#N/D");
    expect(relocalize("#DIV/0!", pt)).toBe("#DIV/0!");
    expect(relocalize("#N/A", en)).toBe("#N/A");
  });
});
