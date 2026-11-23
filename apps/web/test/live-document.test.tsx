import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Artifact, type ArtifactDetail, closeAllLiveRooms, type LiveRoomView } from "@agenteschat/client";
import { agentClientId, SYSTEM } from "@agenteschat/live";
import {
  DOC_BODY,
  type DocBlock,
  type DocTable,
  insertBlocks,
  readDocument,
  writeDocument,
} from "@agenteschat/live/document";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useState } from "react";
import * as Y from "yjs";
import { DocumentEditor, docSchema, docViewOf, tableAt } from "@/components/live/document";
import { DocCover } from "@/components/live/document/DocCover";
import { pastedText } from "@/components/live/document/input";
import type { LiveReveal, LiveSelection } from "@/components/live/editor";
import { LiveCover } from "@/components/live/LiveCover";
import { LiveMeta } from "@/components/live/LiveHeader";
import { FileAgentContext } from "@/components/live/talk";
import { useLiveRoomWeb } from "@/components/live/useLiveRoomWeb";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ATLAS_ID, createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

/**
 * Documents on the web (ADR 0200): the editor bound to the document's body (typing, Enter and the ids of blocks, the
 * typed shortcuts, the toolbar's style menu and marks, tables, pasted Markdown, undo of only this person's own
 * changes), read-only, others' carets from presence (a person's name, an agent's face on the blocks it writes), the
 * selection that goes to the file's conversation, "Ask Atlas" over it, a message's line shown in place, the cover and
 * where an imported document came from.
 */

afterEach(() => {
  cleanup();
  closeAllLiveRooms();
});

interface Seen {
  room: LiveRoomView["room"];
  selection: LiveSelection | null;
  asked: number;
  reveal: (reveal: LiveReveal | null) => void;
}

function Harness({
  artifact,
  seen,
  readOnly = false,
  ask = false,
}: {
  artifact: Artifact;
  seen: Seen;
  readOnly?: boolean;
  ask?: boolean;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const live = useLiveRoomWeb(org.id, artifact.id, { kind: "document" });
  const [reveal, setReveal] = useState<LiveReveal | null>(null);
  seen.room = live.room;
  seen.reveal = setReveal;
  if (!live.room || !live.loaded) return <p>…</p>;
  return (
    <FileAgentContext.Provider value={ask ? (dir.agentById.get(ATLAS_ID) ?? null) : null}>
      <div className="lf-page">
        <DocumentEditor
          room={live.room}
          orgId={org.id}
          artifact={artifact}
          readOnly={readOnly}
          locale="pt-BR"
          search={{}}
          onSearch={() => {}}
          following={null}
          onStopFollowing={() => {}}
          onSelection={(selection) => {
            seen.selection = selection;
          }}
          onAsk={
            ask
              ? () => {
                  seen.asked++;
                }
              : undefined
          }
          reveal={reveal}
        />
      </div>
    </FileAgentContext.Provider>
  );
}

/**
 * Positions (ProseMirror's): the heading's words 1–8, the paragraph's 10–33 ("Pessoas" 10–17), the list item's 35–51.
 */
const BLOCKS: DocBlock[] = [
  { type: "heading", id: "h1aaaaaaaa", level: 1, runs: [{ text: "Público" }] },
  { type: "paragraph", id: "p1aaaaaaaa", runs: [{ text: "Pessoas de 25 a 40 anos" }] },
  { type: "paragraph", id: "p2aaaaaaaa", list: "bullet", runs: [{ text: "Banner principal" }] },
];

async function setup(options: { blocks?: DocBlock[]; readOnly?: boolean; ask?: boolean } = {}) {
  const api = createFakeApi(seedState());
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("no live fake");
  const blocks = options.blocks ?? BLOCKS;
  const file = await live.addFile(ORG_ID, {
    kind: "document",
    title: "Campanha de verão",
    init: (doc) => void writeDocument(doc, blocks, SYSTEM),
  });
  const seen: Seen = { room: null, selection: null, asked: 0, reveal: () => {} };
  await renderPage(<Harness artifact={file} seen={seen} readOnly={options.readOnly} ask={options.ask} />, {
    api,
    org: true,
  });
  const view = (): EditorView => {
    const v = docViewOf(document.querySelector(".lf-doc__body"));
    if (!v) throw new Error("no editor");
    return v;
  };
  // The document's content reaches the editor a moment after it opens (y-prosemirror's first render).
  const first = blocks.find((b) => b.type === "heading" || b.type === "paragraph");
  const words = first && "runs" in first ? (first.runs[0]?.text ?? "") : "";
  await waitFor(() => expect(view().state.doc.textContent).toContain(words));
  const room = () => {
    if (!seen.room) throw new Error("no room");
    return seen.room;
  };
  return { api, live, file, seen, view, room, doc: () => room().doc };
}

/** Selects from `from` to `to` (ProseMirror positions). */
function select(view: EditorView, from: number, to = from) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Types as the keyboard does, so the typed shortcuts run ("# " makes a heading). */
function typeText(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** Where a top-level block's words start, by its id. */
function wordsOf(view: EditorView, id: string): number {
  let at = -1;
  view.state.doc.forEach((node, offset) => {
    if (node.attrs.id === id) at = offset + 1;
  });
  if (at < 0) throw new Error(`no block ${id}`);
  return at;
}

/** A key through the editor's keymaps (Enter, Tab). */
function press(view: EditorView, key: string, opts: { shiftKey?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  const handled = view.someProp("handleKeyDown", (f) => f(view, event));
  if (!handled) throw new Error(`${key} did nothing`);
}

/** Opens a dropdown (Radix: keyboard). */
async function openMenu(trigger: HTMLElement) {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  return within(screen().getByRole("menu"));
}

const ids = (blocks: DocBlock[]) => blocks.map((b) => b.id);

describe("typing", () => {
  test("words land in the document; Enter makes a block of its own, the words before keep their id", async () => {
    const { view, doc } = await setup();
    act(() => {
      select(view(), 33);
      typeText(view(), " e famílias");
    });
    expect(readDocument(doc())[1]).toMatchObject({
      id: "p1aaaaaaaa",
      runs: [{ text: "Pessoas de 25 a 40 anos e famílias" }],
    });
    act(() => {
      select(view(), 17);
      press(view(), "Enter");
    });
    const blocks = readDocument(doc());
    expect(blocks[1]).toMatchObject({ id: "p1aaaaaaaa", runs: [{ text: "Pessoas" }] });
    expect(blocks[2]).toMatchObject({ type: "paragraph", runs: [{ text: " de 25 a 40 anos e famílias" }] });
    expect(blocks[2]?.id).toBeTruthy();
    expect(new Set(ids(blocks)).size).toBe(blocks.length);
    // Enter at the start of words: the empty block goes above, the words keep their block's id.
    act(() => {
      select(view(), wordsOf(view(), "p2aaaaaaaa"));
      press(view(), "Enter");
    });
    const after = readDocument(doc());
    const list = after.find((b) => b.type === "paragraph" && b.runs[0]?.text === "Banner principal");
    expect(list?.id).toBe("p2aaaaaaaa");
    expect(new Set(ids(after)).size).toBe(after.length);
  });

  test("typed shortcuts: '## ' a heading (the same block), '- ' a list Enter keeps, '> ' a quote", async () => {
    const { view, doc } = await setup({ blocks: [{ type: "paragraph", id: "p0aaaaaaaa", runs: [] }] });
    act(() => {
      select(view(), 1);
      typeText(view(), "## Plano");
    });
    expect(readDocument(doc())[0]).toEqual({ type: "heading", id: "p0aaaaaaaa", level: 2, runs: [{ text: "Plano" }] });
    act(() => {
      press(view(), "Enter");
      typeText(view(), "- Leite");
      press(view(), "Enter");
      typeText(view(), "Pão");
    });
    const blocks = readDocument(doc());
    expect(blocks.slice(1).map((b) => (b.type === "paragraph" ? b.list : b.type))).toEqual(["bullet", "bullet"]);
    act(() => {
      // An empty item: Enter leaves the list.
      press(view(), "Enter");
      press(view(), "Enter");
      typeText(view(), "> Citação");
    });
    const last = readDocument(doc()).at(-1);
    expect(last?.type).toBe("blockquote");
    expect(last?.type === "blockquote" && last.blocks[0]).toMatchObject({
      type: "paragraph",
      runs: [{ text: "Citação" }],
    });
    // The quote is a block of its own, named; what it holds isn't.
    expect(last?.id).toBeTruthy();
    expect(last?.type === "blockquote" && last.blocks[0]?.id).toBeFalsy();
    expect(new Set(ids(readDocument(doc()))).size).toBe(readDocument(doc()).length);
  });

  test("**words** become bold, `words` code", async () => {
    const { view, doc } = await setup();
    act(() => {
      select(view(), 33);
      typeText(view(), " **já** e `x`");
    });
    expect(readDocument(doc())[1]).toMatchObject({
      runs: [
        { text: "Pessoas de 25 a 40 anos " },
        { text: "já", bold: true },
        { text: " e " },
        { text: "x", code: true },
      ],
    });
  });

  test("undo takes back only this person's own typing, never what came from someone else", async () => {
    const { view, doc, live, file, room } = await setup();
    act(() => {
      view().focus();
      select(view(), 33);
      typeText(view(), " e famílias");
    });
    await act(async () => {
      live.server.edit(file.id, (d) =>
        insertBlocks(d, [{ type: "paragraph", runs: [{ text: "Do Atlas" }] }], { after: "p2aaaaaaaa" }, SYSTEM),
      );
      await live.server.settle();
    });
    await waitFor(() => expect(readDocument(doc()).at(-1)).toMatchObject({ runs: [{ text: "Do Atlas" }] }));
    act(() => {
      room().undo.undo();
    });
    const blocks = readDocument(doc());
    expect(blocks[1]).toMatchObject({ runs: [{ text: "Pessoas de 25 a 40 anos" }] });
    expect(blocks.at(-1)).toMatchObject({ runs: [{ text: "Do Atlas" }] });
  });
});

describe("the toolbar", () => {
  test("the style menu makes a heading of the block (keeping its id); Bold marks the selection", async () => {
    const { view, doc } = await setup();
    act(() => select(view(), 12));
    const toolbar = within(screen().getByRole("toolbar", { name: "Ferramentas do documento" }));
    const menu = await openMenu(toolbar.getByRole("button", { name: "Estilo do texto: Texto" }));
    await act(async () => fireEvent.click(menu.getByRole("menuitem", { name: /Título 2/ })));
    expect(readDocument(doc())[1]).toMatchObject({ type: "heading", id: "p1aaaaaaaa", level: 2 });
    await waitFor(() => expect(toolbar.getByRole("button", { name: "Estilo do texto: Título 2" })).toBeTruthy());
    act(() => select(view(), 10, 17));
    await act(async () => fireEvent.click(toolbar.getByRole("button", { name: "Negrito" })));
    expect(readDocument(doc())[1]).toMatchObject({
      runs: [{ text: "Pessoas", bold: true }, { text: " de 25 a 40 anos" }],
    });
    expect(toolbar.getByRole("button", { name: "Negrito" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a table: inserted with a header row and a paragraph after it; rows from its menu; Tab goes cell to cell", async () => {
    const { view, doc } = await setup();
    act(() => select(view(), 51));
    const toolbar = within(screen().getByRole("toolbar", { name: "Ferramentas do documento" }));
    await act(async () => fireEvent.click(toolbar.getByRole("button", { name: "Tabela" })));
    const blocks = readDocument(doc());
    const table = blocks[3] as DocTable;
    expect(table.type).toBe("table");
    expect(table.header).toBe(true);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toHaveLength(3);
    expect(table.id).toBeTruthy();
    // Something to type under it.
    expect(blocks[4]?.type).toBe("paragraph");
    expect(tableAt(view().state)).toMatchObject({ row: 0, col: 0 });
    act(() => typeText(view(), "Semana"));
    act(() => press(view(), "Tab"));
    expect(tableAt(view().state)).toMatchObject({ row: 0, col: 1 });
    act(() => typeText(view(), "Entrega"));
    const menu = await openMenu(toolbar.getByRole("button", { name: "Tabela" }));
    await act(async () => fireEvent.click(menu.getByRole("menuitem", { name: "Inserir linha abaixo" })));
    const grown = readDocument(doc())[3] as DocTable;
    expect(grown.rows).toHaveLength(4);
    expect(grown.rows[0]?.map((c) => c.blocks[0]?.runs[0]?.text ?? "")).toEqual(["Semana", "Entrega", ""]);
  });

  test("Tab in a table's last cell adds a row; Shift-Tab goes back", async () => {
    const cell = (text: string) => ({ blocks: [{ type: "paragraph" as const, runs: [{ text }] }] });
    const { view, doc } = await setup({
      blocks: [
        { type: "paragraph", id: "p0aaaaaaaa", runs: [{ text: "Cronograma" }] },
        { type: "table", id: "t0aaaaaaaa", rows: [[cell("a"), cell("b")]] },
      ],
    });
    // After "b": the table's last cell.
    act(() => select(view(), 22));
    expect(tableAt(view().state)).toMatchObject({ row: 0, col: 1 });
    act(() => press(view(), "Tab"));
    expect((readDocument(doc())[1] as DocTable).rows).toHaveLength(2);
    expect(tableAt(view().state)).toMatchObject({ row: 1, col: 0 });
    act(() => press(view(), "Tab", { shiftKey: true }));
    expect(tableAt(view().state)).toMatchObject({ row: 0, col: 1 });
  });
});

describe("pasting", () => {
  test("Markdown pasted as text becomes the document's blocks; one line goes in as words; code stays as is", () => {
    const doc = docSchema.node("doc", null, [docSchema.node("paragraph")]);
    const slice = pastedText("# Plano\n\n- um\n- dois\n\n| A | B |\n|---|---|\n| 1 | 2 |", doc.resolve(1), false);
    const types: string[] = [];
    slice.content.forEach((n) => void types.push(n.type.name));
    expect(types).toEqual(["heading", "paragraph", "paragraph", "table"]);
    expect(slice.content.child(1).attrs.list).toBe("bullet");
    // No ids come with a paste: they are new blocks.
    expect(slice.content.child(0).attrs.id).toBeNull();
    const line = pastedText("só isto", doc.resolve(1), false);
    expect(line.openStart).toBe(1);
    expect(line.content.firstChild?.textContent).toBe("só isto");
    const code = docSchema.node("doc", null, [docSchema.node("code_block")]);
    expect(pastedText("# não é título", code.resolve(1), false).content.firstChild?.text).toBe("# não é título");
  });

  test("pasted blocks get ids of their own", async () => {
    const { view, doc } = await setup();
    act(() => {
      select(view(), 51);
      const slice = pastedText("## Peças\n\n- Banner\n- Posts", view().state.selection.$from, false);
      view().dispatch(view().state.tr.replaceSelection(slice));
    });
    const blocks = readDocument(doc());
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.every((b) => b.id)).toBe(true);
    expect(new Set(ids(blocks)).size).toBe(blocks.length);
  });
});

describe("read-only", () => {
  test("no toolbar, the text can't be typed in, the title is only a heading", async () => {
    await setup({ readOnly: true });
    expect(screen().queryByRole("toolbar", { name: "Ferramentas do documento" })).toBeNull();
    const body = document.querySelector(".lf-doc__body");
    expect(body?.getAttribute("contenteditable")).toBe("false");
    expect(body?.getAttribute("aria-readonly")).toBe("true");
    expect(screen().queryByRole("textbox", { name: "Título do documento" })).toBeNull();
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Campanha de verão");
  });
});

describe("others in the document", () => {
  test("a person's caret with their name; an agent's face and name on the blocks it writes", async () => {
    const { live, file, doc } = await setup();
    const paragraph = doc().getXmlFragment(DOC_BODY).get(1) as Y.XmlElement;
    const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(paragraph.get(0) as Y.XmlText, 7));
    await act(async () => {
      live.server.setPeer(file.id, 7001, {
        user: { kind: "person", id: "u-joao" },
        mode: "editing",
        cursorPm: { anchor: at, head: at },
      });
      live.server.setPeer(file.id, agentClientId("run-1", ATLAS_ID), {
        user: { kind: "agent", id: ATLAS_ID },
        mode: "editing",
        sel: { document: ["p2aaaaaaaa"] },
        activity: { key: "writingDocument" },
      });
      await live.server.settle();
    });
    await waitFor(() => expect(document.querySelector(".lf-doc-caret__tag")?.textContent).toBe("João"));
    const who = await waitFor(() => {
      const el = document.querySelector(".lf-doc-caret--agent .lf-doc-caret__who");
      if (!el) throw new Error("no agent caret yet");
      return el;
    });
    expect(who.textContent).toContain("Atlas");
    const block = document.querySelector(".lf-doc-agent-block");
    expect(block?.textContent).toContain("Banner principal");
    // It stops writing: its blocks go quiet, its caret goes with its presence.
    await act(async () => {
      live.server.setPeer(file.id, agentClientId("run-1", ATLAS_ID), null);
      await live.server.settle();
    });
    await waitFor(() => expect(document.querySelector(".lf-doc-agent-block")).toBeNull());
  });
});

describe("the file's conversation", () => {
  test("the selection goes as its words (at most 200) and its block; a caret alone is the whole file", async () => {
    const { view, seen } = await setup({
      blocks: [...BLOCKS, { type: "paragraph", id: "p3aaaaaaaa", runs: [{ text: "x".repeat(300) }] }],
    });
    act(() => select(view(), 10, 17));
    expect(seen.selection).toEqual({ label: "Trecho selecionado", text: "Pessoas", block: "p1aaaaaaaa" });
    act(() => select(view(), 12));
    expect(seen.selection).toBeNull();
    act(() => select(view(), 53, 53 + 300));
    expect(seen.selection?.text?.length).toBe(200);
    expect(seen.selection?.block).toBe("p3aaaaaaaa");
  });

  test("Ask Atlas floats over a selection and asks in the conversation", async () => {
    const { view, seen } = await setup({ ask: true });
    act(() => {
      view().focus();
      select(view(), 10, 17);
    });
    const ask = await waitFor(() => screen().getByRole("button", { name: "Pedir ao Atlas" }));
    await act(async () => fireEvent.click(ask));
    expect(seen.asked).toBe(1);
  });

  test("a message's line about the document: its words selected and lit", async () => {
    const { view, seen } = await setup();
    act(() =>
      seen.reveal({ selection: { label: "Trecho selecionado", text: "25 a 40", block: "p1aaaaaaaa" }, key: 1 }),
    );
    await waitFor(() => expect(document.querySelector(".lf-doc__reveal")?.textContent).toBe("25 a 40"));
    const { from, to } = view().state.selection;
    expect(view().state.doc.textBetween(from, to)).toBe("25 a 40");
    // A block named alone (a picture, a table): the whole block.
    act(() => seen.reveal({ selection: { label: "Trecho selecionado", block: "h1aaaaaaaa" }, key: 2 }));
    await waitFor(() => expect(document.querySelector(".lf-doc__reveal")?.textContent).toBe("Público"));
  });
});

describe("covers and the meta line", () => {
  const preview = {
    blocks: [
      { type: "heading", level: 1, runs: [{ text: "Campanha de verão" }] },
      { type: "paragraph", runs: [{ text: "Proposta para março." }] },
      { type: "paragraph", list: "bullet", runs: [{ text: "Banner principal" }] },
      {
        type: "table",
        header: true,
        rows: [
          [{ blocks: [{ type: "paragraph", runs: [{ text: "Semana" }] }] }],
          [{ blocks: [{ type: "paragraph", runs: [{ text: "1" }] }] }],
        ],
      },
    ] as DocBlock[],
    count: 4,
    chars: 60,
  };

  test("a document's cover is its first page drawn small", async () => {
    const api = createFakeApi(seedState());
    await renderPage(<LiveCover content={{ kind: "document", markdown: "", preview }} fileId="f-doc" size="md" />, {
      api,
      org: true,
    });
    const cover = document.querySelector(".lf-cover--doc") as HTMLElement;
    expect(cover.querySelector(".lf-doc-mini__h")?.textContent).toBe("Campanha de verão");
    expect(cover.querySelector(".lf-doc-mini__p[data-list='bullet']")?.textContent).toBe("Banner principal");
    expect([...cover.querySelectorAll(".lf-doc-mini__cell")].map((c) => c.textContent)).toEqual(["Semana", "1"]);
  });

  test("without a preview it reads the Markdown; the list's thumbnail draws lines only", async () => {
    const api = createFakeApi(seedState());
    await renderPage(
      <>
        <DocCover markdown={"# Plano\n\nUm texto."} fileId="f-doc" />
        <DocCover preview={preview} fileId="f-doc" tiny />
      </>,
      { api, org: true },
    );
    expect(document.querySelector(".lf-doc-mini__h")?.textContent).toBe("Plano");
    expect(document.querySelector(".lf-doc-mini--tiny")?.textContent).toBe("");
  });

  test("an imported document says where it came from", async () => {
    const api = createFakeApi(seedState());
    const now = new Date().toISOString();
    const artifact: ArtifactDetail = {
      id: "f-doc",
      kind: "document",
      title: "Campanha de verão",
      version: 1,
      shownVersion: 1,
      channelId: null,
      threadId: null,
      createdBy: { type: "person", id: "u-joao" },
      updatedBy: { type: "person", id: "u-joao" },
      createdAt: now,
      updatedAt: now,
      canEdit: false,
      untrusted: false,
      audience: { kind: "workspace" },
      content: { kind: "document", markdown: "", preview: { ...preview, source: { name: "Campanha.docx" } } },
    };
    await renderPage(<LiveMeta artifact={artifact} onVersions={() => {}} />, { api, org: true });
    await settle(2);
    expect(document.querySelector(".lf-meta")?.textContent).toContain("João importou de Campanha.docx");
  });
});
