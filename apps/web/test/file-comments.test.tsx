import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Actor, ApiClient, LiveSelection, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Comments on a picture (ADR 0208), in the viewer: "Comentários N" in its header and its open comments pinned on the
 * picture with who wrote them (their words on hover, the resolved ones hidden until asked for); the button opens the
 * file's conversation (ADR 0199) as the viewer's right column, and with it open a click marks a point and a drag an
 * area, which go in the composer as "Sobre o ponto N da imagem" and ride on the message; Resolver on a pinned comment
 * and who resolved it under it; a link to a comment and the line under a picture posted in a chat open the viewer
 * there. Videos and PDFs share all of this but their stages (a PDF's draws with pdf.js, kept out of these tests).
 */

/** The zoom's stage: a size, as a browser lays it out (happy-dom doesn't). A 1200×800 picture fits it at 1000×666⅔. */
const STAGE = { w: 1000, h: 700 };
/** Where the fitted picture's box starts on the stage (centered: (700 − 666⅔) / 2). */
const TOP = 50 / 3;
const BOX_H = 2000 / 3;
/** A spot on the fitted picture, in fractions of it, as screen coordinates. */
const on = (x: number, y: number) => ({ clientX: x * STAGE.w, clientY: TOP + y * BOX_H });
const sized = (el: Element) => el.classList?.contains("izoom__stage");
const realRect = Element.prototype.getBoundingClientRect;
const realSize = ["clientWidth", "clientHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);
const realSave = fileSaver.save;
const realCreate = objectUrls.create;
const realRevoke = objectUrls.revoke;
let urls = 0;
beforeAll(() => {
  fileSaver.save = () => {};
  objectUrls.create = () => `blob:picture-${++urls}`;
  objectUrls.revoke = () => {};
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!sized(this)) return realRect.call(this);
    const rect = { left: 0, top: 0, width: STAGE.w, height: STAGE.h, right: STAGE.w, bottom: STAGE.h, x: 0, y: 0 };
    return { ...rect, toJSON: () => rect } as DOMRect;
  };
  for (const [k, d] of realSize) {
    const size = k === "clientWidth" ? STAGE.w : STAGE.h;
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get(this: HTMLElement) {
        return sized(this) ? size : (d?.get?.call(this) ?? 0);
      },
    });
  }
});
afterAll(() => {
  fileSaver.save = realSave;
  objectUrls.create = realCreate;
  objectUrls.revoke = realRevoke;
  Element.prototype.getBoundingClientRect = realRect;
  for (const [k, d] of realSize) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
});
afterEach(() => {
  cleanup();
  // The conversation's width is kept in the browser: each test starts fresh.
  window.localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const panel = () => document.querySelector("aside.viewer-talk") as HTMLElement | null;
const pins = () => [...document.querySelectorAll<HTMLElement>(".izoom__overlay .mf-pins .mf-pin")];
const pinNames = () => pins().map((p) => p.getAttribute("aria-label"));
const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], name, { type: "image/png" });

/** A comment in the picture's conversation: who wrote it, its words, where it points, and its `meta.resolved`. */
interface Comment {
  id: string;
  by: Actor;
  body: string;
  selection?: LiveSelection;
  resolved?: { by: Actor; at: string };
}

/**
 * A picture uploaded in #eng whose conversation the fake server already made (its root stands for the file), with
 * `comments` in it; the file says how many (`count`) and who wrote there, as the server's would.
 */
async function pictureWithTalk({
  comments = [],
  count = comments.length,
}: {
  comments?: Comment[];
  count?: number;
} = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const file = await api.artifacts.upload(ORG_ID, png("banner.png"), { channelId: ENG_ID });
  const channelId = `file-conversation-${file.id}`;
  const rootId = `file-root-${file.id}`;
  const at = (minutes: number) => new Date(Date.now() - (60 - minutes) * 60_000).toISOString();
  state.messages.push({
    id: rootId,
    channelId,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "banner.png",
    mentionedAgentIds: [],
    agentRunId: null,
    clientId: null,
    meta: { fileConversation: { artifactId: file.id, kind: "image", title: "banner.png" } },
    createdAt: at(0),
  });
  for (const [i, c] of comments.entries()) {
    const meta: Record<string, unknown> = {};
    if (c.selection) meta.liveRef = { artifactId: file.id, kind: "image", title: "banner.png", selection: c.selection };
    if (c.resolved) meta.resolved = c.resolved;
    state.messages.push({
      id: c.id,
      channelId,
      threadId: rootId,
      author: c.by,
      body: c.body,
      mentionedAgentIds: [],
      agentRunId: null,
      clientId: null,
      meta,
      createdAt: at(i + 1),
    } as Message);
  }
  // The file as the server sends it: its size read on upload, and its conversation once it has messages.
  const get = api.artifacts.get;
  api.artifacts.get = async (...args) => {
    const detail = await get(...args);
    if (detail.id !== file.id || detail.content.kind !== "file") return detail;
    return {
      ...detail,
      content: { ...detail.content, width: 1200, height: 800 },
      conversation:
        count > 0
          ? {
              channelId,
              rootId,
              count,
              lastAt: at(comments.length),
              participants: [
                ...new Map<string, Actor>(comments.map((c) => [`${c.by.type}:${c.by.id}`, c.by])).values(),
              ],
              working: false,
            }
          : null,
    };
  };
  return { api, state, file, channelId, rootId };
}

const point = (n: number, x: number, y: number): LiveSelection => ({ label: String(n), mark: { x, y }, version: 1 });
const area = (n: number, x: number, y: number, w: number, h: number): LiveSelection => ({
  label: String(n),
  mark: { x, y, w, h },
  version: 1,
});
const joao: Actor = { type: "person", id: "u-joao" };
const ada: Actor = { type: "agent", id: ADA_ID };
/** Two open comments and one Ada resolved. */
const THREE: Comment[] = [
  { id: "c-1", by: joao, body: "O título está cortado aqui.", selection: point(1, 0.2, 0.3) },
  { id: "c-2", by: ada, body: "Aumentei a margem do logo.", selection: area(2, 0.5, 0.1, 0.25, 0.2) },
  {
    id: "c-3",
    by: joao,
    body: "Cor do botão mais escura.",
    selection: point(3, 0.8, 0.8),
    resolved: { by: ada, at: new Date().toISOString() },
  },
];

/** The viewer's picture has loaded at its size: fitted, its box placed, the pins with it. */
async function load(dialog: HTMLElement) {
  const img = await waitFor(() => {
    const found = dialog.querySelector<HTMLImageElement>(".izoom__img");
    if (!found) throw new Error("no picture in the viewer yet");
    return found;
  });
  Object.defineProperty(img, "naturalWidth", { value: 1200 });
  Object.defineProperty(img, "naturalHeight", { value: 800 });
  await act(async () => fireEvent.load(img));
  await settle(2);
}

/** The Drive's link to the picture (`?artifact=`, and `&m=` at a comment): the viewer, its picture loaded. */
async function openViewer(api: ApiClient, fileId: string, search = "") {
  const app = await renderApp(`/org/${ORG_ID}/drive?artifact=${fileId}${search}`, { api });
  await settle(8);
  const dialog = screen().getByRole("dialog", { name: "banner.png" });
  await load(dialog);
  return { app, dialog };
}
const comments = (dialog: HTMLElement) =>
  within(dialog.querySelector(".ac-details__actions") as HTMLElement).getByRole("button", { name: /^Comentários/ });
const openComments = async (dialog: HTMLElement) => {
  // A picture that has comments opens with them already beside it.
  if (comments(dialog).getAttribute("aria-pressed") !== "true") await click(comments(dialog));
  await settle(8);
  return await waitFor(() => {
    const open = panel();
    if (!open) throw new Error("the comments aren't open yet");
    return open;
  });
};
/** Comentários pressed again: the picture alone, as one with no comments opens. */
const closeComments = async (dialog: HTMLElement) => {
  await waitFor(() => expect(comments(dialog).getAttribute("aria-pressed")).toBe("true"));
  await click(comments(dialog));
  await settle(4);
  expect(panel()).toBeNull();
};
const press = async (from: { clientX: number; clientY: number }, to = from) => {
  const stage = document.querySelector(".izoom__stage") as HTMLElement;
  const base = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 };
  await act(async () => fireEvent.pointerDown(stage, { ...base, ...from }));
  if (to !== from) await act(async () => fireEvent.pointerMove(stage, { ...base, ...to }));
  await act(async () => fireEvent.pointerUp(stage, { ...base, ...to, buttons: 0 }));
  await settle(8);
};

describe("a picture's comments in the viewer", () => {
  test("Comentários N in its header and its open comments pinned with who wrote them, their words on hover", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    const actions = within(dialog.querySelector(".ac-details__actions") as HTMLElement);
    // One button for them: no Comentar and Conversa beside it.
    expect(comments(dialog).textContent).toBe("Comentários3");
    expect(actions.queryByRole("button", { name: "Comentar" })).toBeNull();
    expect(actions.queryByRole("button", { name: /^Conversa/ })).toBeNull();
    // It has comments: they open beside it; Comentários closes them.
    await waitFor(() => expect(panel()).toBeTruthy());
    await closeComments(dialog);
    expect(comments(dialog).getAttribute("aria-pressed")).toBe("false");
    // Its open comments, numbered oldest first with who wrote them; the resolved one is gone.
    await waitFor(() => expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada"]));
    expect(pins().map((p) => p.querySelector(".mf-pin__n")?.textContent)).toEqual(["1", "2"]);
    // A point's pin stands on it; an area's on its top right corner.
    expect([pins()[0]?.style.left, pins()[0]?.style.top]).toEqual(["20%", "30%"]);
    expect([pins()[1]?.style.left, pins()[1]?.style.top]).toEqual(["75%", "10%"]);
    // Closed, the words show on hover, with where a click goes.
    const first = pins()[0] as HTMLElement;
    expect(first.getAttribute("title")).toBeNull();
    await act(async () => fireEvent.pointerEnter(first));
    const peek = dialog.querySelector(".mf-peek")?.textContent;
    expect(peek).toContain("O título está cortado aqui.");
    expect(peek).toContain("Clique para abrir na conversa");
  });

  test("Comentários opens the conversation beside it; a click marks a point and the message carries it", async () => {
    const { api, state, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    const talk = await openComments(dialog);
    expect(comments(dialog).getAttribute("aria-pressed")).toBe("true");
    expect(dialog.querySelector(".artifact-viewer--talk")).toBeTruthy();
    // Its own header is the viewer's: none inside the column. Its left edge sizes it.
    expect(talk.querySelector(".thread-head")).toBeNull();
    expect(within(dialog).getByRole("separator", { name: "Largura da conversa" })).toBeTruthy();
    // The bar says what a click does now.
    expect(dialog.querySelector(".izoom__hint")?.textContent).toBe(
      "Clique para marcar um ponto ou arraste para marcar uma área",
    );
    // A press and its release a quarter of the way into the picture.
    await press(on(0.25, 0.25));
    // The draft's pin takes the next number, with my face.
    const draft = document.querySelector<HTMLElement>(".mf-pin--draft");
    expect(draft?.querySelector(".mf-pin__n")?.textContent).toBe("4");
    expect([draft?.style.left, draft?.style.top]).toEqual(["25%", "25%"]);
    const quote = await waitFor(() => talk.querySelector(".lf-quote") as HTMLElement);
    expect(quote.textContent).toBe("Sobre o ponto 4 da imagem");
    const composer = within(talk).getByRole("combobox", {
      name: "Escrever sobre a imagem · use @ para chamar um agente",
    });
    await type(composer, "Esse ícone está borrado");
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    await settle(8);
    const post = await waitFor(() => {
      const found = state.calls.filter((c) => c.method === "chat.post").at(-1);
      if (!found) throw new Error("not posted yet");
      return found;
    });
    expect((post.args[2] as { liveRef?: unknown }).liveRef).toEqual({
      artifactId: file.id,
      selection: { label: "4", mark: { x: 0.25, y: 0.25 }, version: 1 },
    });
    // Sent: the quote and the draft's pin go.
    expect(document.querySelector(".lf-quote")).toBeNull();
    expect(document.querySelector(".mf-pin--draft")).toBeNull();
  });

  test("a drag marks an area; × on the quote drops it, and closing the comments too", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    const talk = await openComments(dialog);
    await press(on(0.1, 0.1), on(0.6, 0.4));
    const quote = await waitFor(() => talk.querySelector(".lf-quote") as HTMLElement);
    expect(quote.textContent).toBe("Sobre a área 4 da imagem");
    expect(document.querySelector<HTMLElement>(".mf-area--draft")?.style.width).toBe("50%");
    await click(within(talk).getByRole("button", { name: "Não mandar a seleção" }));
    await settle(2);
    expect(document.querySelector(".lf-quote")).toBeNull();
    expect(document.querySelector(".mf-area--draft")).toBeNull();
    // Another, then Comentários closes them: it goes with them, and a click zooms again.
    await press(on(0.5, 0.5));
    await waitFor(() => expect(document.querySelector(".mf-pin--draft")).toBeTruthy());
    await click(comments(dialog));
    await settle(4);
    expect(panel()).toBeNull();
    expect(document.querySelector(".mf-pin--draft")).toBeNull();
    expect(dialog.querySelector(".izoom__hint")?.textContent).not.toContain("marcar");
  });

  test("Marcar off: a click no longer marks with the comments open; on again, it does", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    await openComments(dialog);
    const mark = within(dialog).getByRole("button", { name: "Marcar" });
    expect(mark.getAttribute("aria-pressed")).toBe("true");
    await click(mark);
    expect(within(dialog).getByRole("button", { name: "Marcar" }).getAttribute("aria-pressed")).toBe("false");
    expect(dialog.querySelector(".izoom__hint")?.textContent).not.toContain("marcar");
    await press(on(0.25, 0.25));
    expect(document.querySelector(".mf-pin--draft")).toBeNull();
    expect(document.querySelector(".lf-quote")).toBeNull();
    expect(panel()).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Marcar" }));
    await press(on(0.5, 0.5));
    await waitFor(() => expect(document.querySelector(".mf-pin--draft")).toBeTruthy());
  });

  test("the resolved ones come back faded with 1 resolvido, and go again", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    await closeComments(dialog);
    await waitFor(() => expect(pins()).toHaveLength(2));
    const show = within(dialog).getByRole("button", { name: "1 resolvido" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    expect(show.getAttribute("title")).toBe("Mostrar os resolvidos");
    await click(show);
    await settle(2);
    expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada", "Comentário 3 de João"]);
    expect(pins().map((p) => p.classList.contains("mf-pin--faded"))).toEqual([false, false, true]);
    await click(show);
    await settle(2);
    expect(pins()).toHaveLength(2);
  });

  test("a pin opens the comments at its message, its area outlined", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    await closeComments(dialog);
    await waitFor(() => expect(pins()).toHaveLength(2));
    await click(pins()[1] as HTMLElement);
    await settle(8);
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(comments(dialog).getAttribute("aria-pressed")).toBe("true");
    expect(pins()[1]?.classList.contains("mf-pin--on")).toBe(true);
    expect(document.querySelector<HTMLElement>(".mf-pins .mf-area")?.style.width).toBe("25%");
  });

  test("a link to a comment opens the viewer there, the old page's address too", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { app, dialog } = await openViewer(api, file.id, "&m=c-2");
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(comments(dialog).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(pins()[1]?.classList.contains("mf-pin--on")).toBe(true));
    app.unmount();
    cleanup();
    // The file's own page was a picture's page: its address goes to the Drive's viewer, at the comment.
    const again = await renderApp(`/org/${ORG_ID}/drive/${file.id}?m=c-1`, { api });
    await settle(10);
    await waitFor(() => expect(again.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`));
    expect(again.router.state.location.search).toMatchObject({ artifact: file.id, m: "c-1" });
    await waitFor(() => expect(screen().getByRole("dialog", { name: "banner.png" })).toBeTruthy());
    await waitFor(() => expect(panel()).toBeTruthy());
  });

  test("one with no comments opens alone, Comentários not pressed", async () => {
    const { api, file } = await pictureWithTalk({ comments: [] });
    const { dialog } = await openViewer(api, file.id);
    expect(comments(dialog).getAttribute("aria-pressed")).toBe("false");
    expect(panel()).toBeNull();
  });

  test("a file that isn't a picture, a video or a PDF has no Comentários", async () => {
    const api = createFakeApi(seedState());
    const zip = await api.artifacts.upload(ORG_ID, new File([new Uint8Array([80, 75, 3, 4])], "notas.zip"));
    await renderApp(`/org/${ORG_ID}/drive?artifact=${zip.id}`, { api });
    await settle(8);
    const dialog = within(screen().getByRole("dialog", { name: "notas.zip" }));
    expect(dialog.queryByRole("button", { name: /^Comentários/ })).toBeNull();
    expect(dialog.queryByRole("button", { name: "Comentar" })).toBeNull();
  });
});

describe("Resolver in a picture's comments", () => {
  test("a pinned comment has Resolver; resolved, it says who and when, and Reabrir puts it back", async () => {
    const list: Comment[] = [
      ...THREE,
      // About the picture, with no place in it: nothing to resolve.
      { id: "c-plain", by: joao, body: "Ficou ótima.", selection: { label: "banner.png" } },
    ];
    const { api, state, file } = await pictureWithTalk({ comments: list });
    const { dialog } = await openViewer(api, file.id);
    const talk = await openComments(dialog);
    const row = async (id: string) =>
      within(
        await waitFor(() => {
          const el = talk.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
          if (!el) throw new Error(`no message ${id} yet`);
          return el;
        }),
      );
    const first = await row("c-1");
    const resolve = first.getByRole("button", { name: "Resolver" });
    expect(resolve.getAttribute("aria-pressed")).toBe("false");
    expect(first.queryByText(/^Resolvido por/)).toBeNull();
    // The comment that was resolved says by whom; Ada's own comment has Resolver on her bar too.
    expect((await row("c-3")).getByText(/^Resolvido por Ada · \d{1,2}:\d{2}/)).toBeTruthy();
    expect((await row("c-3")).getByRole("button", { name: "Reabrir" }).getAttribute("aria-pressed")).toBe("true");
    expect((await row("c-2")).getByRole("button", { name: "Resolver" })).toBeTruthy();
    expect((await row("c-plain")).queryByRole("button", { name: "Resolver" })).toBeNull();

    await click(resolve);
    await settle(6);
    expect(state.calls.find((c) => c.method === "live.resolveComment")?.args).toEqual([ORG_ID, "c-1", true]);
    await waitFor(() => expect(first.getByText(/^Resolvido por Walter · \d{1,2}:\d{2}/)).toBeTruthy());
    expect(first.getByRole("button", { name: "Reabrir" }).getAttribute("aria-pressed")).toBe("true");
    // Its pin leaves the picture.
    await waitFor(() => expect(pinNames()).toEqual(["Comentário 2 de Ada"]));

    await click(first.getByRole("button", { name: "Reabrir" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "live.resolveComment").at(-1)?.args).toEqual([ORG_ID, "c-1", false]);
    await waitFor(() => expect(first.queryByText(/^Resolvido por/)).toBeNull());
    expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada"]);
  });

  test("a message about part of the picture has its line; a click opens its pin", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const { dialog } = await openViewer(api, file.id);
    const talk = await openComments(dialog);
    const line = await waitFor(() =>
      within(talk).getByRole("button", { name: "Mostrar Área 2 (na imagem) no arquivo" }),
    );
    expect(line.querySelector(".msg-quote__who")?.textContent).toBe("Área 2");
    await click(line);
    await settle(2);
    expect(pins()[1]?.classList.contains("mf-pin--on")).toBe(true);
  });
});

describe("a picture posted in a chat", () => {
  async function postedIn(list: Comment[], count = list.length) {
    const made = await pictureWithTalk({ comments: list, count });
    made.state.messages.push({
      id: "m-picture",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "A arte nova do banner.",
      mentionedAgentIds: [],
      agentRunId: "r-picture",
      meta: { artifacts: [{ id: made.file.id, version: 1 }] },
      createdAt: new Date().toISOString(),
    });
    const app = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: made.api });
    await settle(10);
    return { ...made, app };
  }
  const row = () => document.querySelector(`article[data-message-id="m-picture"]`) as HTMLElement;

  test("once it has comments: who commented and 3 comentários na imagem; a press opens them in the viewer", async () => {
    const { app } = await postedIn(THREE);
    const line = await waitFor(() => row().querySelector(".mf-chatline") as HTMLElement);
    expect(line.querySelector("b")?.textContent).toBe("3 comentários na imagem");
    expect(line.classList.contains("thread-line")).toBe(true);
    await click(line);
    await settle(8);
    // The chat stays; the viewer opens over it with the comments open.
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("dialog", { name: "banner.png" })).toBeTruthy();
    await waitFor(() => expect(panel()).toBeTruthy());
  });

  test("one comment is said in the singular; none, no line", async () => {
    await postedIn(THREE.slice(0, 1));
    const line = await waitFor(() => row().querySelector(".mf-chatline") as HTMLElement);
    expect(line.querySelector("b")?.textContent).toBe("1 comentário na imagem");
    cleanup();
    await postedIn([]);
    await waitFor(() => expect(row()).toBeTruthy());
    expect(row().querySelector(".mf-chatline")).toBeNull();
  });
});
