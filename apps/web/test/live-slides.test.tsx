import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Artifact, closeAllLiveRooms, LiveRoom, type LiveRoomView, liveSocketUrl } from "@agenteschat/client";
import { SYSTEM } from "@agenteschat/live";
import type { PeerState } from "@agenteschat/live/awareness";
import { addSlide, deckTheme, deleteSlides, readSlide, slideIdsOf } from "@agenteschat/live/slides";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { TextSelection } from "prosemirror-state";
import { useState } from "react";
import type * as Y from "yjs";
import type { LiveEditorSearch, LiveSelection } from "@/components/live/editor";
import { richViewOf } from "@/components/live/rich";
import { DeckView, Slides, SlideThumb } from "@/components/live/slides";
import { useLiveRoomWeb } from "@/components/live/useLiveRoomWeb";
import { useOrg } from "@/components/org-context";
import { createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen } from "./render";

/**
 * The presentation editor (ADR 0196 §2, §5): slides added, reordered and deleted from the toolbar and the rail, text
 * typed through ProseMirror into the shared document, the theme, presenting with the keys (and the presenter's
 * presence), following someone who presents, a read-only file, and the read-only drawings (thumbnail, uploaded deck).
 */

let rooms: LiveRoom[] = [];
afterEach(() => {
  cleanup();
  for (const room of rooms) room.destroy();
  rooms = [];
  closeAllLiveRooms();
});

interface Seen {
  room: LiveRoomView["room"];
  search: LiveEditorSearch;
  selection: LiveSelection | null;
  stopped: number;
}

function Harness({
  artifact,
  seen,
  readOnly = false,
  initial = {},
}: {
  artifact: Artifact;
  seen: Seen;
  readOnly?: boolean;
  initial?: LiveEditorSearch;
}) {
  const { org } = useOrg();
  const live = useLiveRoomWeb(org.id, artifact.id, { kind: "slides" });
  const [search, setSearch] = useState<LiveEditorSearch>(initial);
  seen.room = live.room;
  seen.search = search;
  if (!live.room || !live.loaded) return <p>…</p>;
  return (
    <div className="lf-page">
      <Slides
        room={live.room}
        orgId={org.id}
        artifact={artifact}
        readOnly={readOnly}
        locale="pt-BR"
        search={search}
        onSearch={(patch) => setSearch((s) => ({ ...s, ...patch }))}
        following={null}
        onStopFollowing={() => {
          seen.stopped++;
        }}
        onSelection={(selection) => {
          seen.selection = selection;
        }}
      />
    </div>
  );
}

/** Three slides in place of a new file's one: "Um" (a title slide), "Dois" (title and text), "Três". */
function threeSlides(doc: Y.Doc) {
  const first = slideIdsOf(doc)[0];
  addSlide(doc, { layout: "title", title: "Um" }, SYSTEM);
  addSlide(doc, { layout: "title-body", title: "Dois", body: "Texto" }, SYSTEM);
  addSlide(doc, { layout: "title-only", title: "Três" }, SYSTEM);
  if (first) deleteSlides(doc, [first], SYSTEM);
}

async function setup(options: { readOnly?: boolean; initial?: LiveEditorSearch } = {}) {
  const api = createFakeApi(seedState());
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("no live fake");
  const file = await live.addFile(ORG_ID, { kind: "slides", title: "Pitch", init: threeSlides });
  const seen: Seen = { room: null, search: {}, selection: null, stopped: 0 };
  await renderPage(<Harness artifact={file} seen={seen} readOnly={options.readOnly} initial={options.initial} />, {
    api,
    org: true,
  });
  await waitFor(() => expect(document.querySelector(".sl-editor")).toBeTruthy());
  const room = () => {
    if (!seen.room) throw new Error("no room");
    return seen.room;
  };
  return { api, live, file, seen, room, doc: () => room().doc };
}

/**
 * Lets presence travel: it is sent at most every 60 ms and redrawn at most every 100 ms (ADR 0196 §5), so the timers
 * run inside `act` and React draws what arrived.
 */
async function presenceGoes(server: { settle(): Promise<void> }) {
  await act(async () => {
    await server.settle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await server.settle();
  });
}

const rail = () => within(screen().getByRole("navigation", { name: "Slides" }));
const thumbs = () => rail().getAllByRole("button", { name: /^Slide \d+/ });
const titleOf = (doc: Y.Doc, id: string) =>
  readSlide(doc, id)
    ?.elements.filter((el) => el.role === "title")
    .map((el) => (el.text ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n"))[0];
const titles = (doc: Y.Doc) => slideIdsOf(doc).map((id) => titleOf(doc, id));
const tool = (name: string) =>
  screen()
    .getByRole("toolbar", { name: "Ferramentas da apresentação" })
    .querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

describe("slides", () => {
  test("adds, reorders and deletes slides; undo takes each back", async () => {
    const { doc, seen } = await setup();
    expect(thumbs()).toHaveLength(3);
    expect(thumbs()[0]?.getAttribute("aria-current")).toBe("true");
    expect(seen.selection).toMatchObject({ label: "Slide 1" });

    // "Novo slide": after the current one, with the layout that follows a title slide.
    await act(async () => tool("Novo slide")?.click());
    await waitFor(() => expect(thumbs()).toHaveLength(4));
    const added = slideIdsOf(doc())[1] as string;
    expect(readSlide(doc(), added)?.layout).toBe("title-body");
    expect(thumbs()[1]?.getAttribute("aria-current")).toBe("true");
    expect(seen.search.slide).toBe(added);
    expect(seen.selection).toMatchObject({ label: "Slide 2", slide: added });

    // Alt+↓ on its thumbnail moves it down one.
    await act(async () => fireEvent.keyDown(thumbs()[1] as HTMLElement, { key: "ArrowDown", altKey: true }));
    expect(slideIdsOf(doc())[2]).toBe(added);
    expect(titles(doc())).toEqual(["Um", "Dois", "", "Três"]);

    // Delete on a thumbnail deletes that slide; the one now in its place is shown.
    await act(async () => fireEvent.keyDown(thumbs()[2] as HTMLElement, { key: "Delete" }));
    expect(slideIdsOf(doc())).not.toContain(added);
    expect(thumbs()).toHaveLength(3);
    expect(await screen().findByText("Slide excluído")).toBeTruthy();

    // Undo brings the slide back, then puts it back where it was.
    await act(async () => tool("Desfazer")?.click());
    expect(slideIdsOf(doc())).toContain(added);
    await act(async () => tool("Desfazer")?.click());
    expect(slideIdsOf(doc())[1]).toBe(added);
  });

  test("a new slide with a layout from the picker, and the slide's layout changed in place", async () => {
    const { doc } = await setup();
    await act(async () => tool("Novo slide com layout")?.click());
    const picker = await screen().findByRole("group", { name: "Layout do slide" });
    await act(async () => within(picker).getByRole("button", { name: "Duas colunas" }).click());
    const made = slideIdsOf(doc())[1] as string;
    expect(readSlide(doc(), made)?.layout).toBe("two-columns");

    await act(async () => screen().getByRole("button", { name: "Layout" }).click());
    const again = await screen().findByRole("group", { name: "Layout do slide" });
    expect(within(again).getByRole("button", { name: "Duas colunas" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => within(again).getByRole("button", { name: "Citação" }).click());
    expect(readSlide(doc(), made)?.layout).toBe("quote");
  });

  test("text typed through ProseMirror lands in the slide; formatting and undo", async () => {
    const { doc } = await setup();
    const first = slideIdsOf(doc())[0] as string;
    const title = readSlide(doc(), first)?.elements.find((el) => el.role === "title");
    const box = document.querySelector<HTMLElement>(`.sl-el[data-el="${title?.id}"]`);
    if (!box) throw new Error("no title box");
    await act(async () => fireEvent.doubleClick(box));
    const editor = await waitFor(() => {
      const el = document.querySelector(".sl-el.is-editing .rt-editor");
      if (!el) throw new Error("not open");
      return el;
    });
    const view = richViewOf(editor);
    if (!view) throw new Error("no view");
    expect(editor.textContent).toBe("Um");

    await act(async () => {
      view.dispatch(view.state.tr.insertText(" milhão", view.state.doc.content.size - 1));
    });
    expect(titleOf(doc(), first)).toBe("Um milhão");

    // The text group shows while a text is open; bold applies to the words chosen.
    await act(async () => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    });
    await act(async () => tool("Negrito")?.click());
    const rich = () => {
      const fragment = readSlide(doc(), first)?.elements.find((el) => el.role === "title");
      return fragment?.text ?? [];
    };
    expect(rich()[0]?.runs[0]).toEqual({ text: "Um", bold: true });
    expect(tool("Negrito")?.getAttribute("aria-pressed")).toBe("true");

    // Esc closes the text; undo takes back the bold, then the words.
    await act(async () => fireEvent.keyDown(editor, { key: "Escape" }));
    await waitFor(() => expect(document.querySelector(".sl-el.is-editing")).toBeNull());
    await act(async () => tool("Desfazer")?.click());
    expect(rich()[0]?.runs[0]?.bold).toBeUndefined();
    await act(async () => tool("Desfazer")?.click());
    expect(titleOf(doc(), first)).toBe("Um");
  });

  test("the font list and the text style menu change a chosen box whole (ADR 0220 §8)", async () => {
    const { doc } = await setup();
    const first = slideIdsOf(doc())[0] as string;
    const title = () => readSlide(doc(), first)?.elements.find((el) => el.role === "title");
    const box = document.querySelector<HTMLElement>(`.sl-el[data-el="${title()?.id}"]`);
    if (!box) throw new Error("no title box");
    await act(async () => {
      fireEvent.pointerDown(box, { button: 0 });
      fireEvent.pointerUp(box, { button: 0 });
    });
    const font = await waitFor(() => screen().getByRole("combobox", { name: "Fonte" }));
    font.focus();
    await act(async () => fireEvent.keyDown(font, { key: "Enter" }));
    await act(async () => screen().getByRole("option", { name: "Inter" }).click());
    expect(title()?.style?.font).toBe("inter");

    const aa = tool("Estilo do texto");
    if (!aa) throw new Error("no text style menu");
    aa.focus();
    await act(async () => {
      fireEvent.keyDown(aa, { key: "Enter" });
      fireEvent.keyUp(aa, { key: "Enter" });
    });
    await act(async () => screen().getByRole("menuitemradio", { name: "Negrito" }).click());
    expect(title()?.style?.weight).toBe(700);
  });

  test("a new text box opens to type in; left empty it goes", async () => {
    const { doc } = await setup();
    const first = slideIdsOf(doc())[0] as string;
    const before = readSlide(doc(), first)?.elements.length ?? 0;
    await act(async () => tool("Caixa de texto")?.click());
    const editor = await waitFor(() => {
      const el = document.querySelector(".sl-el.is-editing .rt-editor");
      if (!el) throw new Error("not open");
      return el;
    });
    expect(readSlide(doc(), first)?.elements).toHaveLength(before + 1);
    await act(async () => fireEvent.keyDown(editor, { key: "Escape" }));
    await waitFor(() => expect(readSlide(doc(), first)?.elements).toHaveLength(before));

    // With words in it, it stays; chosen, Delete takes it out.
    await act(async () => tool("Caixa de texto")?.click());
    const second = await waitFor(() => {
      const el = document.querySelector(".sl-el.is-editing .rt-editor");
      if (!el) throw new Error("not open");
      return el;
    });
    const view = richViewOf(second);
    await act(async () => {
      view?.dispatch(view.state.tr.insertText("Meta do trimestre"));
    });
    await act(async () => fireEvent.keyDown(second, { key: "Escape" }));
    await waitFor(() => expect(document.querySelector(".sl-el.is-editing")).toBeNull());
    const els = readSlide(doc(), first)?.elements ?? [];
    expect(els).toHaveLength(before + 1);
    const made = els.at(-1);
    expect(made?.text?.[0]?.runs[0]?.text).toBe("Meta do trimestre");
    const stage = screen().getByRole("application", { name: /Slide 1 de 3/ });
    await act(async () => fireEvent.keyDown(stage, { key: "Delete" }));
    expect(readSlide(doc(), first)?.elements).toHaveLength(before);
  });

  test("the theme changes for everyone in the file", async () => {
    const { doc, live, file } = await setup();
    await act(async () => screen().getByRole("button", { name: "Tema" }).click());
    const themes = await screen().findByRole("group", { name: "Tema" });
    expect(within(themes).getByRole("button", { name: "Céu" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => within(themes).getByRole("button", { name: "Noite" }).click());
    expect(deckTheme(doc())).toBe("night");
    await waitFor(() => expect(deckTheme(live.server.file(file.id).doc)).toBe("night"));
    // The slide on the stage takes the theme's background.
    const body = document.querySelector<HTMLElement>(".sl-stage .sl-body");
    expect(body?.getAttribute("style")).toMatch(/#0b1426|rgb\(11, 20, 38\)/);
  });

  test("presenting: the keys move through the slides, the presence says which, Esc ends it", async () => {
    const { doc, seen, room } = await setup({ initial: { present: true } });
    const ids = slideIdsOf(doc());
    const show = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".sl-present[aria-label='Apresentação']");
      if (!el) throw new Error("not presenting");
      return el;
    });
    expect(within(show).getByText("1 / 3")).toBeTruthy();
    await waitFor(() =>
      expect((room().awareness.getLocalState() as PeerState).presenting?.slide).toBe(ids[0] as string),
    );
    await act(async () => fireEvent.keyDown(show, { key: "ArrowRight" }));
    expect(within(show).getByText("2 / 3")).toBeTruthy();
    await act(async () => fireEvent.keyDown(show, { key: "End" }));
    expect(within(show).getByText("3 / 3")).toBeTruthy();
    await act(async () => fireEvent.keyDown(show, { key: "PageUp" }));
    expect(within(show).getByText("2 / 3")).toBeTruthy();
    expect((room().awareness.getLocalState() as PeerState).presenting?.slide).toBe(ids[1] as string);
    await act(async () => fireEvent.keyDown(show, { key: "Escape" }));
    await waitFor(() => expect(document.querySelector(".sl-present")).toBeNull());
    expect(seen.search.present).toBeUndefined();
    expect(seen.search.slide).toBe(ids[1]);
    expect((room().awareness.getLocalState() as PeerState).presenting).toBeUndefined();
  });

  test("someone else presenting: 'João está apresentando · Seguir', and following moves with them", async () => {
    const { doc, live, file } = await setup();
    const ids = slideIdsOf(doc());
    const joao = new LiveRoom({
      orgId: ORG_ID,
      fileId: file.id,
      me: { kind: "person", id: "u-joao" },
      kind: "slides",
      url: liveSocketUrl("https://other.example.com", ORG_ID, file.id),
      createSocket: live.server.socketFactory(),
      loadState: async () => live.server.loadState(file.id),
    });
    rooms.push(joao);
    await presenceGoes(live.server);
    await waitFor(() => expect(joao.status).toBe("live"));
    joao.setLocal({ at: { slide: ids[0] as string }, presenting: { slide: ids[0] as string, since: Date.now() } });
    await presenceGoes(live.server);
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".sl-presenting");
      if (!el?.textContent?.includes("João está apresentando")) throw new Error("no bar yet");
      return el;
    });
    await act(async () => within(bar).getByRole("button", { name: "Seguir" }).click());
    const show = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".sl-present[aria-label='Apresentação']");
      if (!el) throw new Error("not presenting");
      return el;
    });
    expect(show.textContent).toContain("Seguindo João");
    expect(show.textContent).toContain("Um");
    // While following, the bar over the editor goes (the presentation is on screen).
    expect(document.querySelector(".sl-presenting")).toBeNull();
    joao.setLocal({ at: { slide: ids[1] as string }, presenting: { slide: ids[1] as string, since: Date.now() } });
    await presenceGoes(live.server);
    await waitFor(() => expect(show.textContent).toContain("Dois"));
    // They stop presenting: the presentation closes here too.
    joao.setLocal({ presenting: undefined });
    await presenceGoes(live.server);
    await waitFor(() => expect(document.querySelector(".sl-present")).toBeNull());
  });

  test("read-only: no toolbar, nothing opens to type, the rail and notes don't change the file", async () => {
    const { doc } = await setup({ readOnly: true });
    expect(screen().queryByRole("toolbar", { name: "Ferramentas da apresentação" })).toBeNull();
    const first = slideIdsOf(doc())[0] as string;
    const title = readSlide(doc(), first)?.elements.find((el) => el.role === "title");
    const box = document.querySelector<HTMLElement>(`.sl-stage .sl-el[data-type="text"]`);
    if (box) await act(async () => fireEvent.doubleClick(box));
    expect(document.querySelector(".sl-el.is-editing")).toBeNull();
    expect(title).toBeTruthy();
    await act(async () => fireEvent.keyDown(thumbs()[0] as HTMLElement, { key: "Delete" }));
    expect(slideIdsOf(doc())).toHaveLength(3);
    const notes = screen().getByRole("textbox", { name: "Notas do orador" }) as HTMLTextAreaElement;
    expect(notes.readOnly).toBe(true);
    // Moving between slides still works.
    await act(async () => thumbs()[2]?.click());
    expect(thumbs()[2]?.getAttribute("aria-current")).toBe("true");
  });

  test("speaker notes are the slide's shared text", async () => {
    const { doc, live, file } = await setup();
    const first = slideIdsOf(doc())[0] as string;
    const notes = screen().getByRole("textbox", { name: "Notas do orador" }) as HTMLTextAreaElement;
    await act(async () => {
      notes.value = "Abrir com o número";
      fireEvent.input(notes);
    });
    expect(readSlide(doc(), first)?.notes).toBe("Abrir com o número");
    await waitFor(() => expect(readSlide(live.server.file(file.id).doc, first)?.notes).toBe("Abrir com o número"));
    // What someone else types comes in.
    await act(async () => {
      live.server.edit(file.id, (d) => {
        const text = d.getMap<Y.Map<unknown>>("slides").get(first)?.get("notes") as Y.Text;
        text.insert(text.length, " do trimestre");
      });
      await live.server.settle();
    });
    await waitFor(() => expect(notes.value).toBe("Abrir com o número do trimestre"));
  });
});

describe("drawn slides", () => {
  test("a thumbnail draws the slide small, without editing hints", async () => {
    const api = createFakeApi(seedState());
    const live = fakeLiveOf.get(api);
    const file = await live?.addFile(ORG_ID, { kind: "slides", title: "Pitch", init: threeSlides });
    const doc = live?.server.file(file?.id ?? "").doc;
    const slide = doc ? readSlide(doc, slideIdsOf(doc)[1] as string) : null;
    if (!slide) throw new Error("no slide");
    await renderPage(<SlideThumb slide={slide} theme="forest" width={176} />, { api, org: true });
    const thumb = document.querySelector<HTMLElement>(".sl-thumb");
    expect(thumb?.style.width).toBe("176px");
    expect(thumb?.textContent).toContain("Dois");
    expect(thumb?.querySelector(".rt-empty")).toBeNull();
  });

  test("an uploaded deck shows every slide numbered, hidden ones marked", async () => {
    const api = createFakeApi(seedState());
    await renderPage(
      <DeckView
        deck={{
          w: 1280,
          h: 720,
          slides: [
            {
              elements: [
                { type: "text", x: 80, y: 80, w: 800, h: 120, role: "title", text: [{ runs: [{ text: "Acme" }] }] },
              ],
            },
            { hidden: true, elements: [] },
          ],
          media: {},
        }}
      />,
      { api, org: true },
    );
    expect(screen().getByLabelText("Apresentação com 2 slides")).toBeTruthy();
    expect(screen().getByText("Slide 1")).toBeTruthy();
    expect(screen().getByText("Slide 2 · oculto")).toBeTruthy();
  });
});
