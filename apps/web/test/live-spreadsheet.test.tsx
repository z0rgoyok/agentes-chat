import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Artifact, closeAllLiveRooms, type LiveRoom, useLivePeers } from "@agenteschat/client";
import { agentClientId, LOCAL } from "@agenteschat/live";
import {
  colIds,
  getCell,
  rowIds,
  type SheetData,
  setValues,
  sheetIds,
  sheetLocale,
  sheetName,
} from "@agenteschat/live/spreadsheet";
import { isApple } from "@agenteschat/ui";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import type * as Y from "yjs";
import type { LiveEditorSearch, LiveSelection } from "@/components/live/editor";
import { Spreadsheet, WorkbookView } from "@/components/live/spreadsheet";
import { useLiveRoomWeb } from "@/components/live/useLiveRoomWeb";
import { type OpenMenu, setMenuHost } from "@/lib/context-menu";
import { createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen } from "./render";

/**
 * The spreadsheet editor of a live file (ADR 0196) on the fake live server, in Portuguese: typing values and formulas
 * as a person in Brazil does, the keys that move the selection, the clipboard with our own cells and other apps'
 * text, the fill handle and ⌘D, rows from the menu, the toolbar, sheet tabs, people and agents in the file, and the
 * read-only states, plus an uploaded workbook drawn read-only (ADR 0198). The canvas draws nothing here: what the
 * cells hold is read from the document and the formula bar, and the drawing is tested on its own.
 */

const EN = sheetLocale("en-US");
const MOD = isApple() ? { metaKey: true } : { ctrlKey: true };

// happy-dom lays nothing out: the grid's scroller gets a size, alone; canvases draw nothing.
const realSize = ["clientWidth", "clientHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);
let canvasProto: HTMLCanvasElement | null = null;
let realGetContext: HTMLCanvasElement["getContext"] | null = null;
let menu: OpenMenu | null = null;
beforeEach(() => {
  setMenuHost((open) => {
    menu = open;
  });
});
beforeAll(() => {
  canvasProto = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement;
  realGetContext = canvasProto.getContext;
  for (const [k, d] of realSize) {
    const size = k === "clientWidth" ? 1000 : 600;
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains("sheet-grid__scroller") ? size : (d?.get?.call(this) ?? 0);
      },
    });
  }
  canvasProto.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});
afterAll(() => {
  for (const [k, d] of realSize) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
  if (canvasProto && realGetContext) canvasProto.getContext = realGetContext;
});
afterEach(() => {
  setMenuHost(null);
  cleanup();
  closeAllLiveRooms();
  menu = null;
});

/** The page's part: the room, and the editor once it loaded. */
function Harness({
  artifact,
  readOnly = false,
  follow,
  onRoom,
  onSelection,
  onSearch,
}: {
  artifact: Artifact;
  readOnly?: boolean;
  follow?: number;
  onRoom: (room: LiveRoom) => void;
  onSelection: (selection: LiveSelection | null) => void;
  onSearch: (patch: Partial<LiveEditorSearch>) => void;
}) {
  const view = useLiveRoomWeb(ORG_ID, artifact.id);
  const peers = useLivePeers(view.room);
  const [search, setSearch] = useState<LiveEditorSearch>({});
  if (!view.room || !view.loaded) return <p>carregando</p>;
  onRoom(view.room);
  return (
    <Spreadsheet
      room={view.room}
      orgId={ORG_ID}
      artifact={artifact}
      readOnly={readOnly}
      locale="pt-BR"
      search={search}
      onSearch={(patch) => {
        onSearch(patch);
        setSearch((s) => ({ ...s, ...patch }));
      }}
      following={peers.find((p) => p.clientId === follow) ?? null}
      onStopFollowing={() => {}}
      onSelection={onSelection}
    />
  );
}

async function open(
  rows: (string | number | null)[][] = [],
  options: { readOnly?: boolean; follow?: number; init?: (doc: Y.Doc) => void } = {},
) {
  const api = createFakeApi(seedState());
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("no live fake");
  const file = await live.addFile(ORG_ID, {
    kind: "spreadsheet",
    title: "Orçamento",
    init: (doc) => {
      const sheet = sheetIds(doc)[0] as string;
      if (rows.length) setValues(doc, { sheet, row: 0, col: 0 }, rows, EN, LOCAL);
      options.init?.(doc);
    },
  });
  let room: LiveRoom | null = null;
  const selections: (LiveSelection | null)[] = [];
  const searches: Partial<LiveEditorSearch>[] = [];
  const page = await renderPage(
    <Harness
      artifact={file}
      readOnly={options.readOnly}
      follow={options.follow}
      onRoom={(r) => {
        room = r;
      }}
      onSelection={(s) => selections.push(s)}
      onSearch={(s) => searches.push(s)}
    />,
    { api, org: true },
  );
  await waitFor(() => expect(document.querySelector(".sheet-grid")).not.toBeNull());
  const theRoom = () => {
    if (!room) throw new Error("no room");
    return room as LiveRoom;
  };
  const doc = () => theRoom().doc;
  const sheet = () => sheetIds(doc())[0] as string;
  return {
    api,
    live,
    file,
    page,
    room: theRoom,
    doc,
    sheet,
    selections,
    searches,
    /** What a cell holds (value, formula, style), by row and column index. */
    cell: (r: number, c: number, on = sheet()) => getCell(doc(), on, r, c),
    /** What a cell computes. */
    value: (r: number, c: number, on = sheet()) => theRoom().engine().valueAt(on, r, c),
  };
}

const field = () => document.querySelector<HTMLTextAreaElement>(".sheet-editor__input") as HTMLTextAreaElement;
const nameBox = () => document.querySelector<HTMLInputElement>(".sheet-bar__name") as HTMLInputElement;
const bar = () => document.querySelector<HTMLTextAreaElement>(".sheet-bar__input") as HTMLTextAreaElement;
const scroller = () => document.querySelector<HTMLElement>(".sheet-grid__scroller") as HTMLElement;
const editing = () => document.querySelector(".sheet-grid__editor")?.getAttribute("data-editing") === "true";

const key = (k: string, extra: Record<string, unknown> = {}) =>
  act(() => {
    fireEvent.keyDown(field(), { key: k, ...extra });
  });

/** Types into the selected cell (replacing what it holds) or into the cell being edited. */
const type = (text: string) =>
  act(() => {
    field().focus();
    fireEvent.change(field(), { target: { value: text } });
  });

/** Goes to a cell or range through the name box. */
const go = (a1: string) =>
  act(() => {
    fireEvent.focus(nameBox());
    fireEvent.change(nameBox(), { target: { value: a1 } });
    fireEvent.keyDown(nameBox(), { key: "Enter" });
  });

/** A clipboard as the copy and paste events carry it. */
function clipboard(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? "",
  };
}

/** A point over a cell (the grid sits at the window's top-left; headers 48 wide and 24 tall, cells 100 × 24). */
const over = (r: number, c: number) => ({ clientX: 48 + c * 100 + 30, clientY: 24 + r * 24 + 10 });

describe("the spreadsheet editor", () => {
  test("typing numbers and formulas in Portuguese: decimal comma, SOMA and the semicolon", async () => {
    const s = await open();
    expect(nameBox().value).toBe("A1");
    await type("1234,5");
    expect(editing()).toBe(true);
    await key("Enter");
    expect(s.cell(0, 0)?.v).toBe(1234.5);
    expect(nameBox().value).toBe("A2");

    await type("=SOMA(A1;10)");
    await key("Enter");
    expect(s.value(1, 0)).toBe(1244.5);
    // Stored by ids, in English: the formula reads in any language.
    expect(s.cell(1, 0)?.f).toContain("SUM(");
    await key("ArrowUp");
    expect(bar().value).toBe("=SOMA(A1;10)");
    // The bar on one line, no boxes: the address as text (a field only while it holds the focus), a hairline, fx, and
    // a formula in the code face (its field says it holds one); a plain value doesn't.
    expect(nameBox().classList.contains("ac-input")).toBe(false);
    expect(document.querySelector(".sheet-bar__sep")).toBeTruthy();
    expect(bar().closest(".sheet-fx")?.classList.contains("sheet-fx--formula")).toBe(true);
    await key("ArrowUp");
    expect(bar().value).toBe("1234,5");
    expect(bar().closest(".sheet-fx")?.classList.contains("sheet-fx--formula")).toBe(false);
    // A screen reader hears the cell and what it shows.
    expect(field().getAttribute("aria-label")).toBe("Célula A1, 1234,5");

    // Text, a date and a percent, as typed in Brazil.
    await go("B1");
    await type("Aluguel");
    await key("Tab");
    expect(nameBox().value).toBe("C1");
    await type("17/11/2026");
    await key("Enter");
    // Enter after Tab goes back under where the row started, as in other spreadsheets.
    expect(nameBox().value).toBe("B2");
    expect(s.cell(0, 1)?.v).toBe("Aluguel");
    expect(typeof s.cell(0, 2)?.v).toBe("number");
    await go("C1");
    expect(bar().value).toBe("17/11/2026");

    // The server has it all.
    await act(() => s.live.server.settle());
    const served = s.live.server.file(s.file.id).doc;
    expect(getCell(served, s.sheet(), 0, 0)?.v).toBe(1234.5);
  });

  test("a formula that can't be read stays open and says why; Esc leaves the cell as it was", async () => {
    const s = await open([[5]]);
    await go("B1");
    await type("=SOMA(A1");
    await key("Enter");
    expect(editing()).toBe(true);
    expect(screen().getByRole("alert").textContent).toBe("Falta fechar um parêntese");
    await key("Escape");
    expect(editing()).toBe(false);
    expect(s.cell(0, 1)).toBeUndefined();
  });

  test("the formula bar suggests functions by their Portuguese names and shows the signature", async () => {
    await open([[1], [2]]);
    await go("A3");
    await type("=som");
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.querySelector(".sheet-assist__name")?.textContent);
    expect(options.slice(0, 2)).toEqual(["SOMA", "SOMASE"]);
    expect(screen().getByText("Os números somados")).toBeTruthy();
    // Tab puts the highlighted one in, with its parenthesis; the signature follows the cursor.
    await key("Tab");
    expect(field().value).toBe("=SOMA(");
    expect(document.querySelector(".sheet-assist__sig")?.textContent).toBe("SOMA(núm1; [núm2]; …)");
    expect(document.querySelector(".sheet-assist__sig b")?.textContent).toBe("núm1");
  });

  test("keys move the selection: arrows, Shift, ⌘ jumps, Tab, Home, PageDown, F2 and Esc", async () => {
    const s = await open([[1], [2], [3], [4], [5]]);
    act(() => field().focus());
    await key("ArrowRight");
    expect(nameBox().value).toBe("B1");
    await key("ArrowDown", { shiftKey: true });
    await key("ArrowDown", { shiftKey: true });
    expect(nameBox().value).toBe("B1:B3");
    expect(s.selections.at(-1)).toMatchObject({ label: "Planilha 1!B1:B3", range: "B1:B3", sheet: s.sheet() });
    await key("ArrowLeft");
    expect(nameBox().value).toBe("A1");
    await key("ArrowDown", MOD);
    expect(nameBox().value).toBe("A5");
    await key("Tab");
    expect(nameBox().value).toBe("B5");
    await key("Home");
    expect(nameBox().value).toBe("A5");
    await key("PageDown");
    expect(nameBox().value).toBe("A28");
    await key("ArrowUp", MOD);
    expect(nameBox().value).toBe("A5");
    await key("F2");
    expect(editing()).toBe(true);
    expect(field().value).toBe("5");
    await key("Escape");
    expect(editing()).toBe(false);
    // Delete clears what the selection holds.
    await go("A4:A5");
    await key("Delete");
    expect(s.cell(3, 0)).toBeUndefined();
    expect(s.cell(4, 0)).toBeUndefined();
    expect(s.cell(2, 0)?.v).toBe(3);
  });

  test("the mouse: click, drag a range, Shift-click, a whole column from its header", async () => {
    await open();
    const el = scroller();
    // Each event on its own, as a browser delivers them.
    const pointer = (kind: "pointerDown" | "pointerMove" | "pointerUp", at: object, extra: object = {}) =>
      act(() => {
        fireEvent[kind](el, { ...at, button: 0, pointerId: 1, pointerType: "mouse", ...extra });
      });
    await pointer("pointerDown", over(1, 1));
    await pointer("pointerMove", over(2, 2));
    await pointer("pointerMove", over(3, 2));
    await pointer("pointerUp", over(3, 2));
    expect(nameBox().value).toBe("B2:C4");
    await pointer("pointerDown", over(0, 0));
    await pointer("pointerUp", over(0, 0));
    await pointer("pointerDown", over(1, 1), { shiftKey: true });
    await pointer("pointerUp", over(1, 1));
    expect(nameBox().value).toBe("A1:B2");
    await pointer("pointerDown", { clientX: 48 + 230, clientY: 10 });
    await pointer("pointerUp", { clientX: 48 + 230, clientY: 10 });
    expect(nameBox().value).toBe("C:C");
  });

  test("copy and paste: our cells keep formulas moving, other apps' text lands as typed, cut moves", async () => {
    const s = await open([
      [1, "=A1*10"],
      [2, null],
    ]);
    await go("A1:B2");
    const copied = clipboard();
    await act(() => {
      fireEvent.copy(field(), { clipboardData: copied });
    });
    expect(copied.data.get("text/plain")).toContain("1\t10");
    expect(copied.data.get("text/html")).toContain("<table");

    // Into E5: the formula points at its own row's E, as copies do.
    await go("E5");
    await act(() => {
      fireEvent.paste(field(), { clipboardData: copied });
    });
    expect(s.value(4, 4)).toBe(1);
    expect(s.value(5, 4)).toBe(2);
    expect(s.value(4, 5)).toBe(10);
    expect(s.cell(4, 5)?.f).toBeDefined();

    // Values only (⇧⌘V): what the cells showed.
    await go("H1");
    await key("v", { ...MOD, shiftKey: true });
    await act(() => {
      fireEvent.paste(field(), { clipboardData: copied });
    });
    expect(s.cell(0, 8)?.v).toBe(10);
    expect(s.cell(0, 8)?.f).toBeUndefined();

    // Tab-separated text from Excel or Google Sheets, read as typed in Portuguese.
    await go("A10");
    await act(() => {
      fireEvent.paste(field(), { clipboardData: clipboard({ "text/plain": "Mês\tValor\njan\t1.234,5" }) });
    });
    expect(s.cell(9, 0)?.v).toBe("Mês");
    expect(s.cell(10, 1)?.v).toBe(1234.5);
    expect(nameBox().value).toBe("A10:B11");

    // Cut and paste moves the cell; the formula pointing at it follows.
    await go("A1");
    const cut = clipboard();
    await act(() => {
      fireEvent.cut(field(), { clipboardData: cut });
    });
    await go("J1");
    await act(() => {
      fireEvent.paste(field(), { clipboardData: cut });
    });
    expect(s.cell(0, 0)).toBeUndefined();
    expect(s.value(0, 9)).toBe(1);
    expect(s.value(0, 1)).toBe(10);
  });

  test("fill: the handle continues a series, ⌘D copies the top row down", async () => {
    const s = await open([
      [1, 7],
      [2, null],
    ]);
    await go("A1:A2");
    const el = scroller();
    // The handle sits on the selection's bottom-right corner.
    await act(() => {
      fireEvent.pointerDown(el, { clientX: 48 + 100, clientY: 24 + 48, button: 0, pointerId: 1, pointerType: "mouse" });
      fireEvent.pointerMove(el, { ...over(4, 0), pointerId: 1, pointerType: "mouse" });
      fireEvent.pointerUp(el, { ...over(4, 0), pointerId: 1, pointerType: "mouse" });
    });
    expect([2, 3, 4].map((r) => s.value(r, 0))).toEqual([3, 4, 5]);
    expect(nameBox().value).toBe("A1:A5");

    await go("B1:B3");
    await key("d", MOD);
    expect([0, 1, 2].map((r) => s.value(r, 1))).toEqual([7, 7, 7]);
  });

  test("rows and columns from the right-click menu: insert above, delete", async () => {
    const s = await open([["a"], ["b"]]);
    await go("A2");
    await act(() => {
      fireEvent.contextMenu(scroller(), over(1, 0));
    });
    await waitFor(() => expect(menu).not.toBeNull());
    const labels = (menu?.entries ?? []).flatMap((e) => (e.kind === "item" ? [e.label] : []));
    expect(labels).toContain("Inserir linha acima");
    expect(labels).toContain("Excluir linha");
    expect(labels).toContain("Colar só valores");
    const run = (label: string) => {
      const entry = menu?.entries.find((e) => e.kind === "item" && e.label === label);
      if (entry?.kind !== "item") throw new Error(`no ${label}`);
      act(() => entry.run());
    };
    const rowsBefore = rowIds(s.doc(), s.sheet()).length;
    run("Inserir linha acima");
    expect(rowIds(s.doc(), s.sheet()).length).toBe(rowsBefore + 1);
    expect(s.cell(1, 0)).toBeUndefined();
    expect(s.cell(2, 0)?.v).toBe("b");

    menu = null;
    await go("A2");
    await act(() => {
      fireEvent.contextMenu(scroller(), over(1, 0));
    });
    await waitFor(() => expect(menu).not.toBeNull());
    run("Excluir linha");
    expect(rowIds(s.doc(), s.sheet()).length).toBe(rowsBefore);
    expect(s.cell(1, 0)?.v).toBe("b");

    // A column from its header's menu.
    menu = null;
    await act(() => {
      fireEvent.contextMenu(scroller(), { clientX: 48 + 30, clientY: 10 });
    });
    await waitFor(() => expect(menu).not.toBeNull());
    expect(nameBox().value).toBe("A:A");
    run("Inserir coluna à esquerda");
    expect(s.cell(0, 1)?.v).toBe("a");
  });

  test("the toolbar formats the selection and undo takes back only this person's change", async () => {
    const s = await open([[1], [2]]);
    await go("A1:A2");
    await act(() => {
      fireEvent.click(screen().getByRole("button", { name: "Negrito" }));
    });
    expect(s.cell(0, 0)?.s?.b).toBe(1);
    expect(s.cell(1, 0)?.s?.b).toBe(1);
    expect(screen().getByRole("button", { name: "Negrito" }).getAttribute("aria-pressed")).toBe("true");
    // Someone else types meanwhile: undo leaves their change.
    await act(async () => {
      s.live.server.edit(s.file.id, (doc) =>
        setValues(doc, { sheet: s.sheet(), row: 5, col: 0 }, [["Bea"]], EN, LOCAL),
      );
      await s.live.server.settle();
    });
    await waitFor(() => expect(s.cell(5, 0)?.v).toBe("Bea"));
    await act(() => {
      fireEvent.click(screen().getByRole("button", { name: "Desfazer" }));
    });
    expect(s.cell(0, 0)?.s?.b).toBeUndefined();
    expect(s.cell(5, 0)?.v).toBe("Bea");
    // ⌘I on the keys.
    act(() => field().focus());
    await key("i", MOD);
    expect(s.cell(0, 0)?.s?.i).toBe(1);
  });

  test("sheet tabs: add one, rename it in place, delete it after confirming", async () => {
    const s = await open([[1]]);
    await act(() => {
      fireEvent.click(screen().getByRole("button", { name: "Nova aba" }));
    });
    const tab = await waitFor(() => screen().getByRole("tab", { name: "Planilha 2" }));
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const second = sheetIds(s.doc())[1] as string;
    expect(s.searches.at(-1)).toEqual({ sheet: second });
    await act(() => {
      fireEvent.doubleClick(tab);
    });
    const rename = screen().getByRole("textbox", { name: "Nome da aba" });
    await act(() => {
      fireEvent.change(rename, { target: { value: "Custos" } });
      fireEvent.keyDown(rename, { key: "Enter" });
    });
    expect(sheetName(s.doc(), second)).toBe("Custos");
    await act(() => {
      fireEvent.contextMenu(screen().getByRole("tab", { name: "Custos" }), { clientX: 10, clientY: 10 });
    });
    const remove = menu?.entries.find((e) => e.kind === "item" && e.label === "Excluir");
    if (remove?.kind !== "item") throw new Error("no Excluir");
    act(() => remove.run());
    await act(() => {
      fireEvent.click(screen().getByRole("button", { name: "Excluir aba" }));
    });
    expect(sheetIds(s.doc())).toHaveLength(1);
    expect(screen().queryByRole("tab", { name: "Custos" })).toBeNull();
  });

  test("people and agents: their ranges and names, this person's own presence, following one", async () => {
    let target = { rows: [] as string[], cols: [] as string[], sheet: "" };
    const s = await open([[1]], {
      init: (doc) => {
        const sheet = sheetIds(doc)[0] as string;
        target = { rows: rowIds(doc, sheet), cols: colIds(doc, sheet), sheet };
      },
    });
    const sel = (r1: number, c1: number, r2: number, c2: number, editingNow = false) => ({
      sheet: {
        sheet: target.sheet,
        r1: target.rows[r1],
        c1: target.cols[c1],
        r2: target.rows[r2],
        c2: target.cols[c2],
        ...(editingNow ? { editing: true } : {}),
      },
    });
    // This person's selection and typing go out as their presence.
    await go("B2:C3");
    expect(s.room().awareness.getLocalState()?.sel?.sheet).toMatchObject({ r1: target.rows[1], c2: target.cols[2] });
    await type("x");
    expect(s.room().awareness.getLocalState()).toMatchObject({ mode: "editing", sel: { sheet: { editing: true } } });
    await key("Escape");

    await act(async () => {
      s.live.server.setPeer(s.file.id, 41, {
        user: { kind: "person", id: "bea" },
        mode: "editing",
        at: { sheet: target.sheet },
        sel: sel(4, 0, 6, 1, true),
      });
      s.live.server.setPeer(s.file.id, agentClientId("run-1", "atlas"), {
        user: { kind: "agent", id: "atlas" },
        mode: "editing",
        at: { sheet: target.sheet },
        sel: sel(9, 2, 12, 3),
        activity: { key: "writingCells", params: { range: "C10:C13" } },
      });
      await s.live.server.settle();
    });
    // A person: a name tag over their range, shown while they type.
    await waitFor(() => expect(document.querySelector(".sheet-grid__tag")?.getAttribute("data-shown")).toBe("true"));
    // An agent: its cursor over the cells.
    await waitFor(() => expect(document.querySelector(".sheet-grid__cursors .lf-cur--agent")).not.toBeNull());
    expect(document.querySelectorAll(".sheet-grid__tag")).toHaveLength(1);
  });

  test("following someone who goes to another sheet opens that sheet", async () => {
    const s = await open([[1]], { follow: 41 });
    await act(() => {
      fireEvent.click(screen().getByRole("button", { name: "Nova aba" }));
    });
    const other = sheetIds(s.doc())[1] as string;
    // Back on the first sheet, then Bea (followed) goes to the second.
    await act(() => {
      fireEvent.click(screen().getByRole("tab", { name: "Planilha 1" }));
    });
    expect(screen().getByRole("tab", { name: "Planilha 1" }).getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      s.live.server.setPeer(s.file.id, 41, {
        user: { kind: "person", id: "bea" },
        mode: "viewing",
        at: { sheet: other },
      });
      await s.live.server.settle();
    });
    await waitFor(() =>
      expect(screen().getByRole("tab", { name: "Planilha 2" }).getAttribute("aria-selected")).toBe("true"),
    );
    expect(s.searches.at(-1)).toEqual({ sheet: other });
  });

  test("read-only: the same grid to look at and copy from, nothing typed or pasted lands", async () => {
    const s = await open([[1, 2]], { readOnly: true });
    expect(screen().queryByRole("toolbar")).toBeNull();
    expect(screen().getByText("Só leitura")).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Nova aba" })).toBeNull();
    act(() => field().focus());
    await type("9");
    expect(editing()).toBe(false);
    // Enter only moves on.
    await key("Enter");
    expect(nameBox().value).toBe("A2");
    expect(s.cell(0, 0)?.v).toBe(1);
    await go("A1");
    await key("Delete");
    expect(s.cell(0, 0)?.v).toBe(1);
    await act(() => {
      fireEvent.paste(field(), { clipboardData: clipboard({ "text/plain": "8" }) });
    });
    expect(s.cell(0, 0)?.v).toBe(1);
    // Moving and copying still work.
    await key("ArrowRight", { shiftKey: true });
    expect(nameBox().value).toBe("A1:B1");
    const copied = clipboard();
    await act(() => {
      fireEvent.copy(field(), { clipboardData: copied });
    });
    expect(copied.data.get("text/plain")).toBe("1\t2");
  });

  test("a file the server turns read-only (in the trash) stops taking changes at once", async () => {
    const s = await open([[1]]);
    expect(screen().getByRole("toolbar")).toBeTruthy();
    await act(async () => {
      s.live.server.setMode(s.file.id, "view");
      await s.live.server.settle();
    });
    await waitFor(() => expect(screen().queryByRole("toolbar")).toBeNull());
    await type("5");
    await key("Enter");
    expect(s.cell(0, 0)?.v).toBe(1);
  });
});

describe("an uploaded workbook, read-only", () => {
  const workbook: { sheets: SheetData[] } = {
    sheets: [
      {
        name: "Vendas",
        rows: 4,
        cols: 3,
        cells: [
          { r: 0, c: 0, v: "Mês" },
          { r: 0, c: 1, v: "Total" },
          { r: 1, c: 0, v: "jan" },
          { r: 1, c: 1, v: 1234.5, s: { nf: "#,##0.00" } },
          { r: 2, c: 0, v: "fev" },
          { r: 2, c: 1, v: 99, s: { nf: "#,##0.00" } },
          { r: 3, c: 1, f: "SUM(B2:B3)", v: 1333.5, s: { nf: "#,##0.00" } },
        ],
      },
      { name: "Notas", rows: 2, cols: 2, cells: [{ r: 0, c: 0, v: "ok" }] },
    ],
  };

  test("cells shown in the reader's formats, walked with the keys, copied; sheets as tabs", async () => {
    const api = createFakeApi(seedState());
    await renderPage(<WorkbookView workbook={workbook} notice={<span>Arquivo do Excel</span>} />, { api });
    expect(screen().getByText("Arquivo do Excel")).toBeTruthy();
    expect(nameBox().value).toBe("A1");
    expect(bar().value).toBe("Mês");
    act(() => field().focus());
    await key("ArrowDown");
    await key("ArrowRight");
    expect(nameBox().value).toBe("B2");
    expect(bar().value).toBe("1.234,50");
    await key("ArrowDown", MOD);
    expect(nameBox().value).toBe("B4");
    expect(bar().value).toBe("=SUM(B2:B3)");
    // Nothing typed lands.
    await type("1");
    expect(bar().value).toBe("=SUM(B2:B3)");
    // A range and its numbers.
    await key("ArrowUp", { shiftKey: true });
    await key("ArrowUp", { shiftKey: true });
    expect(nameBox().value).toBe("B2:B4");
    expect(document.querySelector(".sheet-tabs__status")?.textContent).toBe(
      "Soma 2.667,00 · Média 889,00 · Contagem 3",
    );
    const copied = clipboard();
    await act(() => {
      fireEvent.copy(field(), { clipboardData: copied });
    });
    expect(copied.data.get("text/plain")).toBe("1.234,50\n99,00\n1.333,50");
    await act(() => {
      fireEvent.click(screen().getByRole("tab", { name: "Notas" }));
    });
    expect(bar().value).toBe("ok");
  });

  test("a workbook with no sheets says it is empty", async () => {
    const api = createFakeApi(seedState());
    await renderPage(<WorkbookView workbook={{ sheets: [] }} />, { api });
    expect(screen().getByText("Esta planilha está vazia")).toBeTruthy();
  });
});
