import { afterEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type Agent,
  type ApiClient,
  type Artifact,
  closeAllLiveRooms,
  type LiveRoom,
  useLiveRoom,
} from "@agenteschat/client";
import { addShape, readShapes, type ShapeView } from "@agenteschat/live";
import type { PeerUser } from "@agenteschat/live/awareness";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type * as Y from "yjs";
import { Canvas } from "@/components/live/canvas";
import { layerRows } from "@/components/live/canvas/layers";
import type { LiveAskRequest, LiveEditorSearch, LiveSelection } from "@/components/live/editor";
import { FileAgentContext } from "@/components/live/talk";
import { ADA_ID, createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

/**
 * The canvas's tools (ADR 0196 §2, ADR 0199) on a live file of the fake server: the dock switches tools by press and
 * by key, the Shapes menu draws each form (and the line), the pen draws strokes said to be the person's, the layers
 * list every shape and hide one from the plane, the bars over a selection change it and ask the file's agent, a crop
 * keeps part of a picture, a comment asks about a spot, and the conversation's messages about spots are pins.
 */

afterEach(() => {
  cleanup();
  closeAllLiveRooms();
});

const ME: PeerUser = { kind: "person", id: "u-walter" };
const ADA = { id: ADA_ID, name: "Ada", handle: "ada" } as Agent;

function Harness({
  file,
  socketFactory,
  onRoom,
  onSelection,
  onAsk,
  onSearch,
  search = {},
  agent = null,
}: {
  file: Artifact;
  socketFactory: Parameters<typeof useLiveRoom>[2]["socketFactory"];
  onRoom: (room: LiveRoom) => void;
  onSelection: (selection: LiveSelection | null) => void;
  onAsk?: (request?: LiveAskRequest) => void;
  onSearch: (patch: Partial<LiveEditorSearch>) => void;
  search?: LiveEditorSearch;
  agent?: Agent | null;
}) {
  const live = useLiveRoom(ORG_ID, file.id, { socketFactory, baseUrl: "https://app.example.com", me: ME });
  if (!live.room || !live.loaded) return null;
  onRoom(live.room);
  return (
    <FileAgentContext.Provider value={agent}>
      <Canvas
        room={live.room}
        orgId={ORG_ID}
        artifact={file}
        readOnly={false}
        locale="pt-BR"
        search={search}
        onSearch={onSearch}
        following={null}
        onStopFollowing={() => {}}
        onSelection={onSelection}
        onAsk={onAsk}
      />
    </FileAgentContext.Provider>
  );
}

async function open(options: { init?: (doc: Y.Doc) => void; ask?: boolean; agent?: Agent | null } = {}) {
  const state = seedState();
  const api: ApiClient = createFakeApi(state);
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  const made = await live.addFile(ORG_ID, {
    kind: "canvas",
    title: "Ideias",
    ...(options.init ? { init: options.init } : {}),
  });
  const file: Artifact = made;
  let room: LiveRoom | null = null;
  const selections: (LiveSelection | null)[] = [];
  const asks: (LiveAskRequest | undefined)[] = [];
  const view = await renderPage(
    <Harness
      file={file}
      socketFactory={live.server.socketFactory()}
      onRoom={(r) => {
        room = r;
      }}
      onSelection={(s) => selections.push(s)}
      onAsk={options.ask === false ? undefined : (r) => asks.push(r)}
      onSearch={() => {}}
      agent={options.agent ?? null}
    />,
    { api, org: true },
  );
  const plane = await waitFor(() => screen().getByRole("application", { name: "Quadro" }));
  const doc = () => {
    if (!room) throw new Error("the canvas has no room");
    return (room as LiveRoom).doc;
  };
  return { view, plane, doc, file, selections, asks };
}

/** The camera as the world layer draws it. */
function camera() {
  const world = document.querySelector(".cnv__world") as HTMLElement;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform);
  if (!m) throw new Error(`no camera in "${world.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function screenOf(p: { x: number; y: number }) {
  const cam = camera();
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

let pointer = 1;
const at = (p: { x: number; y: number }) => ({
  clientX: p.x,
  clientY: p.y,
  pointerId: pointer,
  pointerType: "mouse",
  button: 0,
  buttons: 1,
});

async function drag(on: Element, from: { x: number; y: number }, to: { x: number; y: number }, moveOn = on) {
  pointer += 1;
  await act(async () => void fireEvent.pointerDown(on, at(from)));
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  await act(async () => void fireEvent.pointerMove(moveOn, at(mid)));
  await act(async () => void fireEvent.pointerMove(moveOn, at(to)));
  await act(async () => void fireEvent.pointerUp(moveOn, at(to)));
  await settle();
}

async function click(plane: Element, p: { x: number; y: number }) {
  pointer += 1;
  await act(async () => void fireEvent.pointerDown(plane, at(p)));
  await act(async () => void fireEvent.pointerUp(plane, at(p)));
  await settle();
}

const key = (el: Element, k: string, extra: Record<string, unknown> = {}) =>
  act(async () => void fireEvent.keyDown(el, { key: k, ...extra }));
const press = (el: Element) => act(async () => void fireEvent.click(el));
const dock = () => within(screen().getByRole("toolbar", { name: "Ferramentas" }));
const bar = () => within(screen().getByRole("toolbar", { name: "Opções" }));

const only = (shapes: ShapeView[], type: ShapeView["type"]) => {
  const found = shapes.filter((s) => s.type === type);
  expect(found).toHaveLength(1);
  return found[0] as ShapeView;
};

describe("the canvas's tools", () => {
  test("the dock: the tools in order, each by press and by its key; Esc goes back to Select", async () => {
    const { plane } = await open({ agent: ADA });
    const names = dock()
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names.slice(0, 11)).toEqual([
      "Selecionar",
      "Mover a tela",
      "Seção",
      "Formas",
      "Seta",
      "Caneta",
      "Texto",
      "Nota",
      "Enviar imagem",
      "Comentar",
      expect.stringMatching(/Pedir (ao|à) Ada$/),
    ]);
    await press(dock().getByRole("button", { name: "Caneta" }));
    expect(plane.getAttribute("data-tool")).toBe("draw");
    for (const [k, tool] of [
      ["v", "select"],
      ["h", "hand"],
      ["f", "frame"],
      ["r", "shape"],
      ["l", "line"],
      ["a", "arrow"],
      ["p", "draw"],
      ["t", "text"],
      ["n", "note"],
      ["c", "comment"],
    ] as const) {
      await key(plane, k);
      expect(plane.getAttribute("data-tool")).toBe(tool);
    }
    await key(plane, "Escape");
    expect(plane.getAttribute("data-tool")).toBe("select");
    // The zoom island sits at the top right, Layers first.
    const zoom = within(screen().getByRole("toolbar", { name: "Zoom do quadro" }));
    expect(zoom.getAllByRole("button")[0]?.getAttribute("aria-label")).toBe("Camadas");
  });

  test("the Shapes menu draws each form, ⇧T a triangle, L a line (an arrow with no heads); all of them the person's", async () => {
    const { plane, doc } = await open();
    const formas = dock().getByRole("button", { name: "Formas" });
    await act(async () => void fireEvent.pointerDown(formas, { button: 0, ctrlKey: false }));
    const menu = within(await waitFor(() => screen().getByRole("menu")));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent?.replace(/[⇧A-Z]+$/, ""))).toEqual([
      "Retângulo",
      "Elipse",
      "Losango",
      "Triângulo",
      "Estrela",
      "Linha",
    ]);
    await press(menu.getByRole("menuitem", { name: /Elipse/ }));
    expect(plane.getAttribute("data-tool")).toBe("shape");
    await drag(plane, screenOf({ x: 0, y: 0 }), screenOf({ x: 120, y: 80 }));
    expect(only(readShapes(doc()), "shape")).toMatchObject({ kind: "ellipse", w: 120, h: 80, by: ME });

    await key(plane, "T", { shiftKey: true });
    expect(plane.getAttribute("data-tool")).toBe("shape");
    await drag(plane, screenOf({ x: 300, y: 0 }), screenOf({ x: 400, y: 100 }));
    expect(readShapes(doc()).find((s) => s.kind === "triangle")).toMatchObject({ by: ME });

    await key(plane, "l");
    await drag(plane, screenOf({ x: 0, y: 300 }), screenOf({ x: 200, y: 300 }));
    expect(only(readShapes(doc()), "arrow")).toMatchObject({ heads: { start: "none", end: "none" }, by: ME });
  });

  test("the pen draws a stroke of the person's in its color and size; the highlighter is wide; Esc leaves it", async () => {
    const { plane, doc } = await open();
    await key(plane, "p");
    const penBar = within(screen().getByRole("toolbar", { name: "Caneta" }));
    expect(penBar.getByRole("radio", { name: "Vermelho" }).getAttribute("aria-checked")).toBe("true");
    await drag(plane, screenOf({ x: 10, y: 10 }), screenOf({ x: 110, y: 60 }));
    const stroke = only(readShapes(doc()), "draw");
    expect(stroke).toMatchObject({ stroke: "#e5484d", strokeWidth: 4, by: ME, x: 10, y: 10 });
    expect(stroke.points?.slice(0, 2)).toEqual([0, 0]);
    expect(stroke.points?.slice(-2)).toEqual([100, 50]);

    await press(penBar.getByRole("button", { name: "Marca-texto" }));
    await press(penBar.getByRole("radio", { name: "Azul" }));
    await press(penBar.getByRole("radio", { name: "Grossa" }));
    await drag(plane, screenOf({ x: 10, y: 200 }), screenOf({ x: 210, y: 200 }));
    const marker = readShapes(doc()).find((s) => s.type === "draw" && s.tool === "marker");
    expect(marker).toMatchObject({ stroke: "#0063d1", strokeWidth: 24, by: ME });

    await key(plane, "Escape");
    expect(plane.getAttribute("data-tool")).toBe("select");
    expect(screen().queryByRole("toolbar", { name: "Caneta" })).toBeNull();
  });

  test("layers: each frame with what is in it, who made it; the eye hides a shape from the plane, a row still chooses it", async () => {
    const ids: string[] = [];
    const { plane, doc, selections } = await open({
      init: (d) => {
        const frame = addShape(d, { type: "frame", x: 0, y: 0, w: 400, h: 300, name: "Banner" }, null);
        ids.push(frame);
        ids.push(addShape(d, { type: "note", x: 40, y: 40, w: 100, h: 100, text: "Dentro", parent: frame }, null));
        ids.push(addShape(d, { type: "note", x: 600, y: 0, w: 200, h: 200, text: "Olá", by: ME }, null));
      },
    });
    await waitFor(() => expect(document.querySelectorAll('[data-type="note"]')).toHaveLength(2));
    await press(screen().getByRole("button", { name: "Camadas" }));
    const panel = within(screen().getByRole("complementary", { name: "Camadas" }));
    const rows = [...document.querySelectorAll(".cnv-layer")].map((li) => [
      li.querySelector(".cnv-layer__name")?.textContent,
      (li as HTMLElement).style.getPropertyValue("--depth"),
    ]);
    expect(rows).toEqual([
      ["Banner", "0"],
      ["Dentro", "1"],
      ["Olá", "0"],
    ]);
    // Who made the last note: its face.
    expect(document.querySelectorAll(".cnv-layer")[2]?.querySelector(".cnv-layer__who")).toBeTruthy();

    const olá = ids[2] as string;
    await press(panel.getByRole("button", { name: "Esconder Olá" }));
    expect(readShapes(doc()).find((s) => s.id === olá)?.hidden).toBe(true);
    await waitFor(() => expect(document.querySelector(`[data-shape="${olá}"]`)).toBeNull());
    // Not there to press on the plane…
    await click(plane, screenOf({ x: 700, y: 100 }));
    expect(selections.at(-1)?.shapes ?? []).not.toContain(olá);
    // …but its row chooses it, and its eye brings it back.
    await press(panel.getByRole("button", { name: "Olá" }));
    await waitFor(() => expect(selections.at(-1)?.shapes).toEqual([olá]));
    await press(panel.getByRole("button", { name: "Mostrar Olá" }));
    expect(readShapes(doc()).find((s) => s.id === olá)?.hidden).toBeUndefined();
  });

  test("a shape's bar: its form, its size under it; an image's bar asks for variations and the agent", async () => {
    const ids: string[] = [];
    const { plane, doc, asks } = await open({
      agent: ADA,
      init: (d) => {
        ids.push(addShape(d, { type: "shape", kind: "rect", x: 0, y: 0, w: 200, h: 140 }, null));
        ids.push(addShape(d, { type: "image", asset: "a1", nw: 1024, nh: 1024, x: 400, y: 0, w: 200, h: 200 }, null));
      },
    });
    await waitFor(() => expect(document.querySelector('[data-type="image"]')).toBeTruthy());
    await click(plane, screenOf({ x: 100, y: 70 }));
    await waitFor(() => expect(document.querySelector(".cnv-sizetag")?.textContent).toBe("200 × 140"));
    await press(bar().getByRole("button", { name: "Estrela" }));
    expect(readShapes(doc()).find((s) => s.id === ids[0])?.kind).toBe("star");

    await click(plane, screenOf({ x: 500, y: 100 }));
    // A picture's size is its own pixels.
    await waitFor(() => expect(document.querySelector(".cnv-sizetag")?.textContent).toBe("1.024 × 1.024"));
    await press(bar().getByRole("button", { name: "Variações" }));
    expect(asks.at(-1)).toEqual({
      text: "faz variações desta imagem",
      selection: { label: "1 imagem", shapes: [ids[1] as string] },
    });
    await press(bar().getByRole("button", { name: /^Pedir (ao|à) Ada$/ }));
    expect(asks.at(-1)).toBeUndefined();
    expect(asks).toHaveLength(2);
  });

  test("Crop keeps the part the window holds (Enter); Esc leaves the picture as it was", async () => {
    const ids: string[] = [];
    const { plane, doc, selections } = await open({
      init: (d) => {
        ids.push(addShape(d, { type: "image", asset: "a1", nw: 400, nh: 400, x: 0, y: 0, w: 200, h: 200 }, null));
      },
    });
    await waitFor(() => expect(document.querySelector('[data-type="image"]')).toBeTruthy());
    await click(plane, screenOf({ x: 100, y: 100 }));
    await press(bar().getByRole("button", { name: "Recortar" }));
    const east = await waitFor(() => {
      const handle = document.querySelector('[data-crop-part="e"]');
      if (!handle) throw new Error("no crop yet");
      return handle;
    });
    const z = camera().z;
    await drag(east, screenOf({ x: 200, y: 100 }), screenOf({ x: 150, y: 100 }));
    await key(plane, "Enter");
    const image = only(readShapes(doc()), "image");
    expect(image.w).toBeCloseTo(150, 3);
    expect(image).toMatchObject({ x: 0, y: 0, h: 200 });
    expect(image.crop?.w).toBeCloseTo(0.75, 3);
    expect(image.crop).toMatchObject({ x: 0, y: 0, h: 1 });
    expect(z).toBeGreaterThan(0);
    // A cropped picture still takes a press.
    await click(plane, screenOf({ x: 300, y: 300 }));
    expect(selections.at(-1)).toBeNull();
    await click(plane, screenOf({ x: 75, y: 100 }));
    await waitFor(() => expect(selections.at(-1)?.shapes).toEqual(ids));

    // Again, cancelled: nothing changes.
    await press(bar().getByRole("button", { name: "Recortar" }));
    const west = await waitFor(() => document.querySelector('[data-crop-part="w"]') as Element);
    await drag(west, screenOf({ x: 0, y: 100 }), screenOf({ x: 50, y: 100 }));
    await key(plane, "Escape");
    expect(only(readShapes(doc()), "image").w).toBeCloseTo(150, 3);
    expect(document.querySelector("[data-crop-part]")).toBeNull();
  });

  test("Comment asks about the spot pressed, with no agent called, then goes back to Select", async () => {
    const { plane, asks } = await open({ agent: ADA });
    await press(dock().getByRole("button", { name: "Comentar" }));
    expect(plane.getAttribute("data-tool")).toBe("comment");
    await click(plane, screenOf({ x: 120, y: 80 }));
    expect(asks.at(-1)).toEqual({ agentId: null, selection: { label: "Comentário", point: { x: 120, y: 80 } } });
    expect(plane.getAttribute("data-tool")).toBe("select");
    // G asks the file's agent about what is selected.
    await key(plane, "g");
    expect(asks).toHaveLength(2);
    expect(asks.at(-1)).toBeUndefined();
  });
});

// The pins read the file's own id from the message, which only exists once the file is made: a second pass.
describe("comment pins", () => {
  test("each message pointing at a spot of this file is a pin (face and number); a press opens the conversation there", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const live = fakeLiveOf.get(api);
    if (!live) throw new Error("no live fake");
    const made = await live.addFile(ORG_ID, { kind: "canvas", title: "Ideias" });
    const channelId = `file-conversation-${made.id}`;
    const rootId = `file-root-${made.id}`;
    const at = new Date(Date.now() - 60_000).toISOString();
    const base = { channelId, mentionedAgentIds: [], agentRunId: null, clientId: null, createdAt: at };
    const point = (id: string, p: { x: number; y: number }, artifactId = made.id) => ({
      ...base,
      id,
      threadId: rootId,
      author: { type: "person" as const, id: "u-walter" },
      body: "Olha aqui",
      meta: {
        liveRef: { artifactId, kind: "canvas", title: "Ideias", selection: { label: "Comentário", point: p } },
      },
    });
    state.messages.push(
      {
        ...base,
        id: rootId,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body: "Ideias",
        meta: { fileConversation: { artifactId: made.id, kind: "canvas", title: "Ideias" } },
      },
      point("m1", { x: 40, y: 30 }),
      { ...base, id: "m2", threadId: rootId, author: { type: "person", id: "u-walter" }, body: "Sem ponto" },
      point("m3", { x: 300, y: 200 }),
      point("m4", { x: 0, y: 0 }, "another-file"),
    );
    const file: Artifact = {
      ...made,
      conversation: { channelId, rootId, count: 4, lastAt: at, participants: [], working: false },
    };
    const searches: Partial<LiveEditorSearch>[] = [];
    const onSearch = mock((patch: Partial<LiveEditorSearch>) => void searches.push(patch));
    await renderPage(
      <Harness
        file={file}
        socketFactory={live.server.socketFactory()}
        onRoom={() => {}}
        onSelection={() => {}}
        onAsk={() => {}}
        onSearch={onSearch}
      />,
      { api, org: true },
    );
    const pins = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>(".cnv-pin")];
      if (found.length !== 2) throw new Error(`${found.length} pins`);
      return found;
    });
    expect(pins.map((p) => p.querySelector(".cnv-pin__n")?.textContent)).toEqual(["1", "2"]);
    expect(pins[0]?.getAttribute("aria-label")).toBe("Comentário 1 de Walter");
    expect(pins[0]?.querySelector(".ac-avatar")).toBeTruthy();
    // In world units: the second pin is further right and down, by the camera's zoom.
    const left = (el: HTMLElement | undefined) => Number.parseFloat(el?.style.left ?? "0");
    const top = (el: HTMLElement | undefined) => Number.parseFloat(el?.style.top ?? "0");
    const z = camera().z;
    expect(left(pins[1]) - left(pins[0])).toBeCloseTo(260 * z, 3);
    expect(top(pins[1]) - top(pins[0])).toBeCloseTo(170 * z, 3);
    await press(pins[1] as HTMLElement);
    expect(searches.at(-1)).toEqual({ m: "m3" });
  });
});

describe("the layers list", () => {
  test("each frame first with what is in it one step in; each level top of the stack first", () => {
    const shape = (id: string, type: ShapeView["type"], z: string, parent?: string): ShapeView => ({
      id,
      type,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      z,
      ...(parent ? { parent } : {}),
    });
    const rows = layerRows([
      shape("f", "frame", "a0"),
      shape("a", "note", "a1", "f"),
      shape("b", "note", "a2", "f"),
      shape("c", "image", "a3"),
      shape("d", "note", "a4"),
      // Its frame is gone: it shows at the top level.
      shape("e", "note", "a5", "gone"),
    ]);
    expect(rows.map((r) => [r.shape.id, r.depth])).toEqual([
      ["f", 0],
      ["b", 1],
      ["a", 1],
      ["e", 0],
      ["d", 0],
      ["c", 0],
    ]);
  });
});
