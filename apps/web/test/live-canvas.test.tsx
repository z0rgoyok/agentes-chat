import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type ApiClient,
  type Artifact,
  closeAllLiveRooms,
  LiveRoom,
  liveSocketUrl,
  useLiveRoom,
} from "@agenteschat/client";
import type { FakeLiveServer } from "@agenteschat/client/live/testing";
import { addShape, canvasPreview, initLiveDoc, readShapes, type ShapeView } from "@agenteschat/live";
import type { Peer, PeerUser } from "@agenteschat/live/awareness";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { Canvas, CanvasMini } from "@/components/live/canvas";
import type { LiveReveal, LiveSelection } from "@/components/live/editor";
import { createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

/**
 * The canvas editor ("Quadro", ADR 0196 §2, ADR 0197) on a live file of the fake server: the tools add notes and
 * frames, a drag moves and its handles resize, Delete and ⌘Z, a frame carries what was drawn around it, pictures asked
 * for show as placeholders that turn into pictures (or say why they failed, with Try again), others' selections and
 * pointers show, Follow moves the view, a message's line about some shapes chooses them (ADR 0199), and a read-only
 * canvas changes nothing.
 */

afterEach(() => {
  cleanup();
  closeAllLiveRooms();
});

const ME: PeerUser = { kind: "person", id: "u-walter" };
const JOAO: PeerUser = { kind: "person", id: "u-joao" };

/** João, in another app of his own, on the same server. */
function joaoIn(server: FakeLiveServer, fileId: string) {
  return new LiveRoom({
    orgId: ORG_ID,
    fileId,
    me: JOAO,
    kind: "canvas",
    url: liveSocketUrl("https://other.example.com", ORG_ID, fileId),
    createSocket: server.socketFactory(),
  });
}

function Harness({
  file,
  socketFactory,
  readOnly = false,
  following = null,
  onRoom,
  onSelection,
  reveal = null,
}: {
  file: Artifact;
  socketFactory: Parameters<typeof useLiveRoom>[2]["socketFactory"];
  readOnly?: boolean;
  following?: Peer | null;
  onRoom?: (room: LiveRoom) => void;
  onSelection?: (selection: LiveSelection | null) => void;
  reveal?: LiveReveal | null;
}) {
  const live = useLiveRoom(ORG_ID, file.id, { socketFactory, baseUrl: "https://app.example.com", me: ME });
  if (!live.room || !live.loaded) return null;
  onRoom?.(live.room);
  return (
    <Canvas
      room={live.room}
      orgId={ORG_ID}
      artifact={file}
      readOnly={readOnly}
      locale="pt-BR"
      search={{}}
      onSearch={() => {}}
      following={following}
      onStopFollowing={() => {}}
      onSelection={onSelection ?? (() => {})}
      reveal={reveal}
    />
  );
}

async function open(
  options: {
    init?: (doc: Y.Doc) => void;
    readOnly?: boolean;
    following?: Peer | null;
    api?: ApiClient;
    models?: "none";
    reveal?: LiveReveal | null;
  } = {},
) {
  const state = seedState();
  const api = options.api ?? createFakeApi(state);
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  if (options.models === "none") live.imageModels = [];
  const file = await live.addFile(ORG_ID, {
    kind: "canvas",
    title: "Ideias",
    ...(options.init ? { init: options.init } : {}),
  });
  let room: LiveRoom | null = null;
  const selections: (LiveSelection | null)[] = [];
  const view = await renderPage(
    <Harness
      file={file}
      socketFactory={live.server.socketFactory()}
      readOnly={options.readOnly}
      following={options.following ?? null}
      onRoom={(r) => {
        room = r;
      }}
      onSelection={(s) => selections.push(s)}
      reveal={options.reveal ?? null}
    />,
    { api, org: true },
  );
  const plane = await waitFor(() => screen().getByRole("application", { name: "Quadro" }));
  const roomNow = () => {
    if (!room) throw new Error("the canvas has no room");
    return room as LiveRoom;
  };
  /** The shapes as the server keeps them, once everything sent has arrived. */
  const onServer = async () => {
    await act(async () => {
      await live.server.settle();
    });
    const doc = live.server.files.get(file.id)?.doc;
    if (!doc) throw new Error("the server lost the file");
    return readShapes(doc);
  };
  return { api, state, live, file, view, plane, room: roomNow, selections, onServer };
}

/** The camera as the world layer draws it. */
function camera() {
  const world = document.querySelector(".cnv__world") as HTMLElement;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform);
  if (!m) throw new Error(`no camera in "${world.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** A world point on screen (the plane sits at the page's top left in the test's page). */
function screenOf(p: { x: number; y: number }) {
  const cam = camera();
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

let pointer = 1;
const at = (p: { x: number; y: number }, extra: Record<string, unknown> = {}) => ({
  clientX: p.x,
  clientY: p.y,
  pointerId: pointer,
  pointerType: "mouse",
  button: 0,
  buttons: 1,
  ...extra,
});

/** A press, a move in two steps and a release, as a mouse does it. */
async function drag(
  plane: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { on?: Element; extra?: Record<string, unknown> } = {},
) {
  pointer += 1;
  await act(async () => void fireEvent.pointerDown(options.on ?? plane, at(from, options.extra)));
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  await act(async () => void fireEvent.pointerMove(plane, at(mid, options.extra)));
  await act(async () => void fireEvent.pointerMove(plane, at(to, options.extra)));
  await act(async () => void fireEvent.pointerUp(plane, at(to, options.extra)));
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

const only = (shapes: ShapeView[], type: ShapeView["type"]) => {
  const found = shapes.filter((s) => s.type === type);
  expect(found).toHaveLength(1);
  return found[0] as ShapeView;
};

describe("the canvas editor", () => {
  test("Note adds a note where the person clicks, open for typing; Esc ends it, still chosen", async () => {
    const { plane, room, selections, onServer } = await open();
    expect(screen().getByText("Quadro em branco")).toBeTruthy();
    const dock = screen().getByRole("toolbar", { name: "Ferramentas" });
    await act(async () => void fireEvent.click(within(dock).getByRole("button", { name: "Nota" })));
    expect(plane.getAttribute("data-tool")).toBe("note");

    // The view starts on the world's origin, in the middle of the plane.
    await click(plane, screenOf({ x: 0, y: 0 }));
    const note = only(readShapes(room().doc), "note");
    expect(note).toMatchObject({ x: -100, y: -100, w: 200, h: 200, color: "yellow" });
    expect(plane.getAttribute("data-tool")).toBe("select");
    await waitFor(() => expect(document.querySelector(`[data-shape="${note.id}"] [role="textbox"]`)).toBeTruthy());
    expect(selections.at(-1)).toEqual({ label: "1 nota", shapes: [note.id] });
    expect(screen().queryByText("Quadro em branco")).toBeNull();

    const box = document.querySelector(`[data-shape="${note.id}"] [role="textbox"]`) as HTMLElement;
    await key(box, "Escape");
    await waitFor(() => expect(document.querySelector(`[data-shape="${note.id}"] [role="textbox"]`)).toBeNull());
    expect(selections.at(-1)?.shapes).toEqual([note.id]);
    // Everyone else gets it.
    expect(only(await onServer(), "note").id).toBe(note.id);
  });

  test("a drag moves a note, its corner resizes it, Delete removes it and ⌘Z brings each step back", async () => {
    const { plane, room, onServer } = await open({
      init: (doc) => void addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200, text: "Olá" }, null),
    });
    await waitFor(() => expect(screen().getByText("Olá")).toBeTruthy());
    const id = only(readShapes(room().doc), "note").id;

    await drag(plane, screenOf({ x: 100, y: 100 }), screenOf({ x: 150, y: 130 }));
    expect(only(readShapes(room().doc), "note")).toMatchObject({ x: 50, y: 30, w: 200, h: 200 });

    // Chosen by the drag: its handles show once it rests.
    const corner = await waitFor(() => {
      const handle = document.querySelector('[data-handle="se"]');
      if (!handle) throw new Error("no handles yet");
      return handle;
    });
    await drag(plane, screenOf({ x: 250, y: 230 }), screenOf({ x: 350, y: 330 }), { on: corner });
    expect(only(readShapes(room().doc), "note")).toMatchObject({ x: 50, y: 30, w: 300, h: 300 });
    expect(only(await onServer(), "note")).toMatchObject({ x: 50, y: 30, w: 300, h: 300 });

    await key(plane, "Delete");
    expect(readShapes(room().doc)).toHaveLength(0);
    await waitFor(() => expect(document.querySelector(`[data-shape="${id}"]`)).toBeNull());

    await key(plane, "z", { metaKey: true });
    expect(only(readShapes(room().doc), "note")).toMatchObject({ id, w: 300, h: 300 });
    await key(plane, "z", { metaKey: true });
    expect(only(readShapes(room().doc), "note")).toMatchObject({ x: 50, y: 30, w: 200, h: 200 });
    await key(plane, "z", { metaKey: true, shiftKey: true });
    expect(only(readShapes(room().doc), "note")).toMatchObject({ w: 300, h: 300 });
    await waitFor(() => expect(document.querySelector(`[data-shape="${id}"]`)).toBeTruthy());
  });

  test("a frame drawn around a note takes it; moving the frame carries the note", async () => {
    const { plane, room } = await open({
      init: (doc) => void addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200 }, null),
    });
    await waitFor(() => expect(document.querySelector('[data-type="note"]')).toBeTruthy());
    await key(plane, "f");
    expect(plane.getAttribute("data-tool")).toBe("frame");
    await drag(plane, screenOf({ x: -100, y: -100 }), screenOf({ x: 400, y: 400 }));

    // The new frame's name is open for typing; Esc keeps the name it came with.
    const name = await waitFor(() => screen().getByRole("textbox", { name: "Nome da seção" }));
    await key(name, "Escape");
    const frame = only(readShapes(room().doc), "frame");
    expect(frame).toMatchObject({ x: -100, y: -100, w: 500, h: 500, name: "Seção" });
    expect(only(readShapes(room().doc), "note").parent).toBe(frame.id);
    await waitFor(() => expect(document.querySelector(`[data-frame-label="${frame.id}"]`)?.textContent).toBe("Seção"));

    // The frame is chosen: a drag inside it moves it, and what's in it.
    await drag(plane, screenOf({ x: -50, y: 350 }), screenOf({ x: 50, y: 350 }));
    expect(only(readShapes(room().doc), "frame")).toMatchObject({ x: 0, y: -100 });
    expect(only(readShapes(room().doc), "note")).toMatchObject({ x: 100, y: 0, parent: frame.id });
  });

  test("pictures asked for show as placeholders in a frame near the view's middle; they turn into pictures", async () => {
    const { file, live, onServer } = await open();
    // An agent asked in the file's conversation (ADR 0199).
    await act(async () => {
      await live.askImages(ORG_ID, file.id, {
        prompt: "Uma raposa na neve",
        count: 2,
        aspect: "1:1",
        model: "fake-image",
        at: { x: 0, y: 0 },
      });
      await live.server.settle();
    });
    await settle();
    // The placeholders show at once, with who asked and the prompt, in a frame named with it.
    await waitFor(() => expect(document.querySelectorAll(".cnv-pending")).toHaveLength(2));
    expect(screen().getAllByText("Na fila…")).toHaveLength(2);
    expect(screen().getAllByText("Pedida por Walter")).toHaveLength(2);
    await waitFor(() =>
      expect([...document.querySelectorAll(".cnv-over__name")].map((n) => n.textContent)).toEqual([
        "Uma raposa na neve",
      ]),
    );

    const request = live.requests[0];
    if (!request) throw new Error("no request");
    await act(async () => live.finishImages(request.id));
    await waitFor(() => expect(document.querySelectorAll(".cnv-img img")).toHaveLength(2));
    expect(document.querySelectorAll(".cnv-pending")).toHaveLength(0);
    for (const img of document.querySelectorAll(".cnv-img img")) {
      expect(img.getAttribute("src")).toContain(`/artifacts/${request.fileId}/assets/`);
      expect(img.getAttribute("alt")).toBe("Uma raposa na neve");
    }
    const images = (await onServer()).filter((s) => s.type === "image");
    expect(images.map((s) => s.id).sort()).toEqual([...request.shapeIds].sort());
  });

  test("a failed request says why and tries again", async () => {
    const { file, state, live } = await open();
    await act(async () => {
      await live.askImages(ORG_ID, file.id, { prompt: "Um farol", count: 1, at: { x: 0, y: 0 } });
      await live.server.settle();
    });
    await settle();
    const request = live.requests[0];
    if (!request) throw new Error("no request");
    await act(async () => live.finishImages(request.id, { error: "budget" }));
    await waitFor(() => expect(screen().getByText("Seu orçamento acabou")).toBeTruthy());
    await act(async () => void fireEvent.click(screen().getByRole("button", { name: "Tentar de novo" })));
    await settle();
    expect(state.calls.some((c) => c.method === "live.retryImages" && c.args[2] === request.id)).toBe(true);
    await waitFor(() => expect(screen().getByText("Na fila…")).toBeTruthy());
  });

  test("the dock has no prompt bar of its own: pictures are asked for in the file's conversation", async () => {
    const { plane } = await open();
    const dock = screen().getByRole("toolbar", { name: "Ferramentas" });
    expect(within(dock).queryByRole("button", { name: /Gerar imagem/ })).toBeNull();
    // G no longer opens a bar.
    await key(plane, "g");
    await settle();
    expect(screen().queryByRole("group", { name: "Gerar imagem" })).toBeNull();
  });

  test("a message's line about some shapes chooses them (ADR 0199)", async () => {
    // The note's id is known once the file is made (`init` runs first); the reveal reads the same list.
    const shapes: string[] = [];
    const { selections } = await open({
      init: (doc) => void shapes.push(addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200 }, null)),
      reveal: { selection: { label: "1 nota", shapes }, key: 1 },
    });
    await waitFor(() => expect(selections.at(-1)?.shapes).toEqual(shapes));
    expect(document.querySelector("[data-handle]")).toBeTruthy();
  });

  test("others' selections and pointers show in their color; this person's choice reaches them", async () => {
    const { live, file, plane, room } = await open({
      init: (doc) => void addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200 }, null),
    });
    const id = await waitFor(() => only(readShapes(room().doc), "note").id);
    const joao = joaoIn(live.server, file.id);
    try {
      await waitFor(() => expect(joao.getState().status).toBe("live"));
      await act(async () =>
        joao.setLocal({ mode: "editing", sel: { canvas: [id] }, cursor: { x: 50, y: 50, space: "canvas" } }),
      );
      await waitFor(() => expect(document.querySelector(".cnv-over__psel")).toBeTruthy());
      // His name on his selection and on his pointer.
      expect(screen().getAllByText("João").length).toBeGreaterThanOrEqual(2);
      await waitFor(() => expect(document.querySelectorAll(".lf-cursors > *").length).toBeGreaterThan(0));

      await click(plane, screenOf({ x: 100, y: 100 }));
      await waitFor(() => expect(joao.peers().find((p) => p.user.id === ME.id)?.state.sel?.canvas).toEqual([id]));
    } finally {
      joao.destroy();
    }
  });

  test("following someone moves the view to what they see", async () => {
    const view = { x: 1000, y: 1000, w: 600, h: 400, zoom: 2 };
    const peer: Peer = { clientId: 7, user: JOAO, state: { user: JOAO, mode: "viewing", view }, self: false };
    const { live, file } = await open({ following: peer });
    const joao = joaoIn(live.server, file.id);
    try {
      await waitFor(() => expect(joao.getState().status).toBe("live"));
      await act(async () => joao.setLocal({ view }));
      // Their 600×400 box fills this 1200×800 plane.
      await waitFor(() => expect(camera().z).toBeCloseTo(2, 3), { timeout: 3000 });
      const middle = screenOf({ x: 1300, y: 1200 });
      expect(middle.x).toBeCloseTo(600, 0);
      expect(middle.y).toBeCloseTo(400, 0);
    } finally {
      joao.destroy();
    }
  });

  test("a read-only canvas only looks: two tools, no handles, keys change nothing", async () => {
    const { plane, room } = await open({
      readOnly: true,
      init: (doc) => void addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200 }, null),
    });
    await waitFor(() => expect(document.querySelector('[data-type="note"]')).toBeTruthy());
    const dock = screen().getByRole("toolbar", { name: "Ferramentas" });
    expect(
      within(dock)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Selecionar", "Mover a tela"]);
    expect(screen().queryByRole("button", { name: /Gerar imagem/ })).toBeNull();

    await click(plane, screenOf({ x: 100, y: 100 }));
    await settle();
    expect(document.querySelector("[data-handle]")).toBeNull();
    await key(plane, "Delete");
    await key(plane, "n");
    await drag(plane, screenOf({ x: 100, y: 100 }), screenOf({ x: 300, y: 300 }));
    await act(async () => void fireEvent.doubleClick(plane, { clientX: 1100, clientY: 700 }));
    expect(readShapes(room().doc)).toEqual([expect.objectContaining({ type: "note", x: 0, y: 0 })]);
    expect(plane.getAttribute("data-tool")).toBe("select");
  });

  test("the small map on cards draws the preview: frames, notes in their color, the file's pictures", async () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "canvas");
    addShape(doc, { type: "frame", x: 0, y: 0, w: 600, h: 400, name: "Ideias" }, null);
    addShape(doc, { type: "note", x: 40, y: 40, w: 200, h: 200, color: "pink" }, null);
    addShape(doc, { type: "image", asset: "asset-1", nw: 800, nh: 600, x: 300, y: 40, w: 240, h: 180 }, null);
    const api = createFakeApi(seedState());
    await renderPage(
      <>
        <CanvasMini preview={canvasPreview(doc)} fileId="file-1" />
        <CanvasMini preview={canvasPreview(new Y.Doc())} />
      </>,
      { api, org: true },
    );
    expect(document.querySelectorAll(".cnv-mini__frame")).toHaveLength(1);
    expect(document.querySelector('rect[fill="#fbd8e3"]')).toBeTruthy();
    expect(document.querySelector(".cnv-mini image")?.getAttribute("href")).toBe(
      `/api/app/organizations/${ORG_ID}/artifacts/file-1/assets/asset-1`,
    );
    // A canvas with nothing on it: the dotted plane alone.
    expect(document.querySelectorAll(".cnv-mini--empty")).toHaveLength(1);
  });
});
