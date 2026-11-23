import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LiveEditorProps } from "@/components/live/editor";

/**
 * The live file's page (ADR 0196 §9, ADR 0199): a page of the app, the sidebar beside it, and its header (where it
 * lives, how it's saved, who is here, Share, Present, ⋯ with Download, the kind and the title to rename, who made it,
 * when it was edited and who sees it), the editor it draws for the file's kind, versions beside it and shown in place,
 * following someone, and its states (loading, offline, read-only, not found). The editors are stand-ins here (each has
 * its own tests): one that shows what the page hands it. The file's conversation has its own tests
 * (`live-conversation.test.tsx`).
 */

function EditorStub(props: LiveEditorProps) {
  return (
    <div
      data-testid="editor"
      data-kind={props.room.kind ?? ""}
      data-readonly={String(props.readOnly)}
      data-locale={props.locale}
      data-following={props.following ? props.following.user.id : ""}
    >
      <button type="button" onClick={() => props.onSelection({ label: "Planilha 1!B2:C3", range: "B2:C3" })}>
        select cells
      </button>
      <button type="button" onClick={() => props.onStopFollowing()}>
        my own scroll
      </button>
    </div>
  );
}
mock.module("../src/components/live/spreadsheet", () => ({
  Spreadsheet: EditorStub,
  WorkbookView: () => <div data-testid="workbook" />,
}));
mock.module("../src/components/live/slides", () => ({
  Slides: EditorStub,
  SlideThumb: () => <span data-testid="slide-thumb" />,
  DeckView: () => <div data-testid="deck" />,
}));
mock.module("../src/components/live/canvas", () => ({
  Canvas: EditorStub,
  CanvasMini: () => <span data-testid="canvas-mini" />,
}));

const { agentClientId, colIds, rowIds, sheetIds } = await import("@agenteschat/live");
const { closeAllLiveRooms } = await import("@agenteschat/client");
const { act, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { fileSaver } = await import("@/components/artifacts/ArtifactViewer");
const { ADA_ID, createFakeApi, fakeLiveOf, ORG_ID, seedState } = await import("./fake-api");
const { renderApp, screen, settle } = await import("./render");

const saved: { url: string; name: string }[] = [];
const realSave = fileSaver.save;
beforeAll(() => {
  fileSaver.save = (url, name) => void saved.push({ url, name });
});
afterAll(() => {
  fileSaver.save = realSave;
});
afterEach(() => {
  cleanup();
  closeAllLiveRooms();
  saved.length = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** Opens a dropdown (Radix: keyboard). */
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  return within(screen().getByRole("menu"));
};
async function setup(kind: "spreadsheet" | "slides" | "canvas" = "spreadsheet", title = "Orçamento") {
  const state = seedState();
  const api = createFakeApi(state);
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  const file = await live.addFile(ORG_ID, { kind, title });
  const app = await renderApp(`/org/${ORG_ID}/drive/${file.id}`, { api });
  await live.server.settle();
  await settle(4);
  const methods = () => state.calls.map((c) => c.method);
  return { api, state, live, file, app, methods };
}

const editor = () => screen().getByTestId("editor");
const header = () => within(document.querySelector(".lf-head") as HTMLElement);

describe("the live file's page", () => {
  test("opens as a page of the app: the sidebar, Drive / where it lives, the title, Saved, and the kind's editor", async () => {
    const { app } = await setup();
    await waitFor(() => expect(editor().dataset.kind).toBe("spreadsheet"));
    expect(editor().dataset.readonly).toBe("false");
    expect(editor().dataset.locale).toBe("pt-BR");
    // The app's sidebar stays: the file is a page of the workspace, not the whole window.
    expect(document.querySelector(".sidebar")).toBeTruthy();
    expect(document.querySelector(".shell__work--bare")).toBeNull();
    // The trail: the Drive (a way back), then where the file lives (made in the Drive: no conversation).
    const crumbs = within(header().getByRole("navigation", { name: "Onde está" }));
    expect(crumbs.getByRole("link", { name: "Drive" }).getAttribute("href")).toBe(`/org/${ORG_ID}/drive`);
    expect(crumbs.getByText("Sem canal")).toBeTruthy();
    expect((header().getByRole("textbox", { name: "Nome do arquivo" }) as HTMLTextAreaElement).value).toBe("Orçamento");
    await waitFor(() => expect(header().getByRole("status").textContent).toBe("Salvo"));
    // The browser tab and the desktop app's window are named after the file.
    expect(document.title).toBe("Orçamento");
    // A spreadsheet has no Present.
    expect(header().queryByRole("button", { name: "Apresentar" })).toBeNull();
    expect(app.router.state.location.pathname).toMatch(/\/drive\/[^/]+$/);
  });

  test("renames where it is: Enter renames, Esc puts the name back", async () => {
    const { methods } = await setup();
    const field = header().getByRole("textbox", { name: "Nome do arquivo" }) as HTMLInputElement;
    await act(async () => field.focus());
    await type(field, "Orçamento 2027");
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    expect(methods()).toContain("live.rename");
    await waitFor(() => expect(document.title).toBe("Orçamento 2027"));

    await act(async () => field.focus());
    await type(field, "Nome errado");
    await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
    await settle(4);
    expect(field.value).toBe("Orçamento 2027");
    expect(methods().filter((m) => m === "live.rename")).toHaveLength(1);
  });

  test("who is here: faces, where each one is, an agent's work, and Follow", async () => {
    const { live, file } = await setup();
    const doc = live.server.file(file.id).doc;
    const sheet = sheetIds(doc)[0] as string;
    const rows = rowIds(doc, sheet);
    const cols = colIds(doc, sheet);
    await act(async () => {
      live.server.setPeer(file.id, 7001, {
        user: { kind: "person", id: "u-joao" },
        mode: "editing",
        sel: { sheet: { sheet, r1: rows[1], c1: cols[1], r2: rows[2], c2: cols[2] } },
      });
      live.server.setPeer(file.id, agentClientId("run-1", ADA_ID), {
        user: { kind: "agent", id: ADA_ID },
        mode: "editing",
        activity: { key: "writingCells", params: { range: "B2:C40" } },
      });
      await live.server.settle();
    });
    await settle(6);
    const stack = await waitFor(() => header().getByRole("button", { name: /Neste arquivo/ }));
    expect(stack.getAttribute("aria-label")).toContain("João");
    expect(stack.getAttribute("aria-label")).toContain("Ada");
    await click(stack);
    await settle(2);
    const list = within(screen().getByRole("dialog", { name: "Quem está aqui" }));
    // This person first, as "Você".
    expect(list.getAllByRole("listitem")[0]?.textContent).toContain("Você");
    expect(list.getByText("editando B2:C3")).toBeTruthy();
    expect(list.getByText("escrevendo em B2:C40")).toBeTruthy();

    const joao = list.getAllByRole("listitem").find((li) => li.textContent?.includes("João")) as HTMLElement;
    await click(within(joao).getByRole("button", { name: "Seguir" }));
    await settle(2);
    await waitFor(() => expect(editor().dataset.following).toBe("u-joao"));
    expect(screen().getByText("Seguindo João")).toBeTruthy();
    // Moving the view oneself stops following.
    await click(within(editor()).getByRole("button", { name: "my own scroll" }));
    await waitFor(() => expect(editor().dataset.following).toBe(""));
    expect(screen().queryByText("Seguindo João")).toBeNull();
  });

  test("follows until Esc, and says when the one followed left", async () => {
    const { live, file } = await setup();
    await act(async () => {
      live.server.setPeer(file.id, 7002, { user: { kind: "person", id: "u-joao" }, mode: "viewing" });
      await live.server.settle();
    });
    await settle(6);
    await click(await waitFor(() => header().getByRole("button", { name: /Neste arquivo/ })));
    await settle(2);
    await click(
      within(screen().getByRole("dialog", { name: "Quem está aqui" })).getByRole("button", { name: "Seguir" }),
    );
    await waitFor(() => expect(editor().dataset.following).toBe("u-joao"));
    // Esc closes the list first; the next one stops following.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Quem está aqui" })).toBeNull();
    expect(editor().dataset.following).toBe("u-joao");
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await waitFor(() => expect(editor().dataset.following).toBe(""));

    await click(header().getByRole("button", { name: /Neste arquivo/ }));
    await settle(2);
    await click(
      within(screen().getByRole("dialog", { name: "Quem está aqui" })).getByRole("button", { name: "Seguir" }),
    );
    await waitFor(() => expect(editor().dataset.following).toBe("u-joao"));
    await act(async () => {
      live.server.setPeer(file.id, 7002, null);
      await live.server.settle();
    });
    await settle(6);
    await waitFor(() => expect(editor().dataset.following).toBe(""));
    expect(screen().getByText("João saiu do arquivo.")).toBeTruthy();
  });

  test("the line under the title: who made it, edited when (the versions); sharing is the header's Share alone", async () => {
    await setup();
    const meta = within(document.querySelector(".lf-meta") as HTMLElement);
    // Made in the Drive by this person: no conversation to name.
    expect(meta.getByText("Walter")).toBeTruthy();
    expect((document.querySelector(".lf-meta") as HTMLElement).textContent).toContain("Walter criou");
    // "editado agora" opens the versions beside the file.
    await click(meta.getByRole("button", { name: "editado agora" }));
    await settle(4);
    expect(screen().getByRole("complementary", { name: "Versões" })).toBeTruthy();
    // One way to the sharing: no audience chip on the line; the header's "Share" opens it.
    expect(meta.getAllByRole("button").map((b) => b.textContent)).toEqual(["editado agora"]);
    await click(header().getByRole("button", { name: "Compartilhar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: /Compartilhar/ })).toBeTruthy();
    // No "Pedir a um agente" popover any more: the file's conversation takes its place.
    expect(header().queryByRole("button", { name: "Pedir a um agente" })).toBeNull();
  });

  test("versions: ⌘S saves a named one, the list shows it, a version opens read-only in place and comes back", async () => {
    const { live, file, app, methods } = await setup();
    // Something changed since the first version.
    await act(async () => {
      live.server.edit(file.id, (doc) => doc.getMap("meta").set("touched", 1));
      await live.server.settle();
    });
    await act(async () => fireEvent.keyDown(window, { key: "s", metaKey: true }));
    await settle(2);
    const dialog = within(screen().getByRole("dialog", { name: "Salvar uma versão" }));
    await type(dialog.getByRole("textbox", { name: "Nome" }), "Antes da revisão");
    await click(dialog.getByRole("button", { name: "Salvar versão" }));
    await settle(6);
    expect(methods()).toContain("live.saveVersion");
    expect(screen().getByText("Versão salva.")).toBeTruthy();

    await openMenu(header().getByRole("button", { name: "Mais" })).then((menu) =>
      click(menu.getByRole("menuitem", { name: "Versões" })),
    );
    await settle(4);
    const column = within(screen().getByRole("complementary", { name: "Versões" }));
    const named = await waitFor(() => column.getByText("Antes da revisão"));
    await click(named.closest("button") as HTMLElement);
    await settle(6);
    await live.server.settle();
    await settle(4);
    expect(String(app.router.state.location.search.v)).toMatch(/^\d+$/);
    await waitFor(() => expect(editor().dataset.readonly).toBe("true"));
    expect(screen().getByRole("button", { name: "Restaurar esta versão" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Voltar à atual" }));
    await settle(6);
    expect(app.router.state.location.search.v).toBeUndefined();
    await waitFor(() => expect(editor().dataset.readonly).toBe("false"));
  });

  test("offline: the changes are kept, and the words say so", async () => {
    const { live, file } = await setup();
    await act(async () => {
      live.server.offline = true;
      live.server.closeSockets(file.id, 1006);
      await live.server.settle();
    });
    await settle(6);
    await waitFor(() =>
      expect(header().getByRole("status").textContent).toBe(
        "Sem conexão. Suas alterações ficam guardadas e vão assim que voltar.",
      ),
    );
  });

  test("read-only: the words, a title that can't be renamed, an editor that can't change", async () => {
    const { live, file } = await setup();
    await act(async () => {
      live.server.setMode(file.id, "view");
      await live.server.settle();
    });
    await settle(6);
    await waitFor(() => expect(header().getByRole("status").textContent).toBe("Só leitura"));
    expect(editor().dataset.readonly).toBe("true");
    expect(header().queryByRole("textbox", { name: "Nome do arquivo" })).toBeNull();
    expect(header().getByRole("heading", { name: "Orçamento" })).toBeTruthy();
  });

  test("a presentation has Present as its primary, which presents from the address", async () => {
    const { app } = await setup("slides", "Pitch");
    await waitFor(() => expect(editor().dataset.kind).toBe("slides"));
    const present = header().getByRole("button", { name: "Apresentar" });
    expect(present.className).toContain("primary");
    await click(present);
    await settle(4);
    expect(app.router.state.location.search.present).toBe(true);
    // Presenting, the header and the sidebar step aside: the slide has the window.
    expect(document.querySelector(".lf-head")).toBeNull();
    expect(document.querySelector(".sidebar")).toBeNull();
  });

  test("the header's controls: Compartilhar, Apresentar, Conversa, then ⋯ last, wide and narrow alike", async () => {
    const button = (name: string | RegExp) => header().getByRole("button", { name });
    const follows = (a: HTMLElement, b: HTMLElement) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const inOrder = (els: HTMLElement[]) => els.every((el, i) => i === 0 || follows(els[i - 1] as HTMLElement, el));
    const last = () => [...document.querySelectorAll(".lf-top__acts button")].at(-1);
    await setup("slides", "Pitch");
    await waitFor(() => expect(editor().dataset.kind).toBe("slides"));
    expect(inOrder([button("Compartilhar"), button("Apresentar"), button(/^Conversa/), button("Mais")])).toBe(true);
    expect(last()).toBe(button("Mais"));
    cleanup();
    closeAllLiveRooms();
    // Narrow (a phone, or the conversation beside a small window): Compartilhar goes into ⋯, which stays last.
    const real = window.matchMedia.bind(window);
    const narrow = { matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList;
    const impl = (query: string) => (query === "(max-width: 760px)" ? narrow : real(query));
    const media = spyOn(window, "matchMedia").mockImplementation(impl);
    try {
      await setup("slides", "Pitch");
      await waitFor(() => expect(document.querySelector(".lf-page[data-compact]")).toBeTruthy());
      expect(header().queryByRole("button", { name: "Compartilhar" })).toBeNull();
      expect(inOrder([button("Apresentar"), button(/^Conversa/), button("Mais")])).toBe(true);
      expect(last()).toBe(button("Mais"));
      const menu = await openMenu(button("Mais"));
      expect(menu.getByRole("menuitem", { name: "Compartilhar" })).toBeTruthy();
    } finally {
      media.mockRestore();
    }
  });

  test("the header's right click has the file's actions (the desktop app's menu)", async () => {
    await setup();
    await act(async () =>
      fireEvent.contextMenu(document.querySelector(".lf-head") as HTMLElement, { clientX: 400, clientY: 20 }),
    );
    await settle(2);
    const menu = within(screen().getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Versões" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Duplicar" })).toBeTruthy();
    await click(menu.getByRole("menuitem", { name: "Versões" }));
    await settle(2);
    expect(screen().getByRole("complementary", { name: "Versões" })).toBeTruthy();
  });

  test("⋯ › Download offers the kind's formats", async () => {
    await setup();
    /** ⋯, then Baixar's own menu beside it (→ from the item). */
    const formats = async () => {
      const menu = await openMenu(header().getByRole("button", { name: "Mais" }));
      menu.getByRole("menuitem", { name: "Baixar" }).focus();
      await act(async () => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowRight" });
        fireEvent.keyUp(document.activeElement ?? document.body, { key: "ArrowRight" });
      });
      await settle(2);
      return within(screen().getAllByRole("menu").at(-1) as HTMLElement);
    };
    await click((await formats()).getByRole("menuitem", { name: "Excel (.xlsx)" }));
    expect(saved.at(-1)?.url).toContain("format=xlsx");
    expect(saved.at(-1)?.name).toBe("orcamento.xlsx");
    // A spreadsheet also goes as CSV; never as a canvas's JSON.
    const again = await formats();
    expect(again.getByRole("menuitem", { name: "CSV (.csv, primeira aba)" })).toBeTruthy();
    expect(again.queryByRole("menuitem", { name: "JSON (.json)" })).toBeNull();
  });

  test("a file that doesn't exist (or isn't shared) says so, with the way back to the Drive", async () => {
    const api = createFakeApi(seedState());
    const app = await renderApp(`/org/${ORG_ID}/drive/00000000-0000-4000-8000-00000000f404`, { api });
    await settle(6);
    expect(
      await waitFor(() => screen().getByText("Este arquivo não existe ou não foi compartilhado com você")),
    ).toBeTruthy();
    await click(screen().getByRole("button", { name: "Voltar ao Drive" }));
    await settle(4);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
  });
});
