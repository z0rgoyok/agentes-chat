import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type ApiClient,
  applyLiveEvent,
  closeAllLiveRooms,
  liveRoomsOpen,
  useCreateLiveFile,
  useLiveDocVersion,
  useLivePeers,
  useLivePresence,
  useLiveRoom,
  useLiveSelector,
  useSaveLiveVersion,
} from "@agenteschat/client";
import { readShapes } from "@agenteschat/live";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type * as Y from "yjs";
import { AppProviders } from "@/app/providers";
import { createFakeApi, fakeLiveOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { makeServices } from "./render";

/**
 * The live files' client layer in React (ADR 0196): rooms opened by `useLiveRoom` sync through the fake API's live
 * server like the real one, and the hooks around them (presence, the document, selectors) and the queries (making a
 * file, versions, who is in it, generated pictures) work as the screens use them.
 */

afterEach(() => {
  cleanup();
  closeAllLiveRooms();
});

const ADA = { kind: "person" as const, id: "ada" };
const BEA = { kind: "person" as const, id: "bea" };

function setup() {
  const api: ApiClient = createFakeApi(seedState());
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  const services = makeServices(api);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders services={services}>{children}</AppProviders>
  );
  const roomOptions = (me = ADA) => ({
    socketFactory: live.server.socketFactory(),
    baseUrl: "https://app.example.com",
    me,
  });
  return { api, live, services, wrapper, roomOptions };
}

/** How many sheets: what a selector should read, a primitive out of the document. */
const sheetCount = (doc: Y.Doc) => doc.getArray<string>("sheetOrder").length;

describe("live files in React", () => {
  test("a new file opens live; two screens share one room; another person's change shows", async () => {
    const { api, live, wrapper, roomOptions } = setup();
    const made = renderHook(() => useCreateLiveFile(ORG_ID), { wrapper });
    let fileId = "";
    await act(async () => {
      fileId = (await made.result.current.mutateAsync({ kind: "spreadsheet", title: "Budget" })).id;
    });
    // In the Drive too.
    expect((await api.artifacts.get(ORG_ID, fileId)).kind).toBe("spreadsheet");

    const first = renderHook(() => useLiveRoom(ORG_ID, fileId, roomOptions()), { wrapper });
    const second = renderHook(() => useLiveRoom(ORG_ID, fileId, roomOptions()), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe("live"));
    expect(first.result.current).toMatchObject({ mode: "edit", loaded: true, unsent: false, error: null });
    expect(second.result.current.room).toBe(first.result.current.room);
    expect(liveRoomsOpen()).toBe(1);
    const room = first.result.current.room;
    if (!room) throw new Error("no room");

    const count = renderHook(() => useLiveSelector(room, sheetCount), { wrapper });
    const version = renderHook(() => useLiveDocVersion(room), { wrapper });
    expect(count.result.current).toBe(1);
    const before = version.result.current;
    // Another person adds a sheet, through the server.
    await act(async () => {
      live.server.edit(fileId, (doc) => doc.getArray<string>("sheetOrder").push(["s2"]));
      await live.server.settle();
    });
    await waitFor(() => expect(count.result.current).toBe(2));
    expect(version.result.current).toBeGreaterThan(before);
  });

  test("presence: who is in the file, redrawn as they move; the cards' summary", async () => {
    const { live, services, wrapper, roomOptions } = setup();
    const file = await live.addFile(ORG_ID, { kind: "canvas", title: "Ideas" });
    const ada = renderHook(() => useLiveRoom(ORG_ID, file.id, roomOptions(ADA)), { wrapper });
    await waitFor(() => expect(ada.result.current.status).toBe("live"));
    // Bea, in another app (her own room, by hand, on the same server).
    const bea = renderHook(
      () =>
        useLiveRoom(ORG_ID, file.id, {
          ...roomOptions(BEA),
          baseUrl: "https://other.example.com",
        }),
      { wrapper },
    );
    await waitFor(() => expect(bea.result.current.status).toBe("live"));
    const peers = renderHook(() => useLivePeers(ada.result.current.room), { wrapper });
    act(() => bea.result.current.room?.setLocal({ mode: "editing", sel: { canvas: ["shape1"] } }));
    await waitFor(() =>
      expect(peers.result.current.map((p) => [p.user.id, p.self, p.state.mode])).toEqual([
        ["ada", true, "viewing"],
        ["bea", false, "editing"],
      ]),
    );
    const presence = renderHook(() => useLivePresence(ORG_ID, [file.id]), { wrapper });
    await waitFor(() =>
      expect(presence.result.current.data?.[file.id]).toEqual([
        { kind: "person", id: "ada", mode: "viewing" },
        { kind: "person", id: "bea", mode: "editing" },
      ]),
    );
    // Bea stops editing; the conversation's `live.presence` event has the cards ask again.
    act(() => bea.result.current.room?.setLocal({ mode: "viewing" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      applyLiveEvent(services.queryClient, ORG_ID, { type: "live.presence", artifactId: file.id } as { type: string });
    });
    await waitFor(() =>
      expect(presence.result.current.data?.[file.id]?.find((p) => p.id === "bea")?.mode).toBe("viewing"),
    );
  });

  test("versions: one now, none when nothing changed", async () => {
    const { live, wrapper } = setup();
    const file = await live.addFile(ORG_ID, { kind: "slides", title: "Pitch" });
    const save = renderHook(() => useSaveLiveVersion(ORG_ID, file.id), { wrapper });
    const saved: (number | null)[] = [];
    await act(async () => {
      saved.push((await save.result.current.mutateAsync("Before the review")).version);
    });
    act(() => live.server.edit(file.id, (doc) => doc.getMap("deck").set("theme", "night")));
    await act(async () => {
      saved.push((await save.result.current.mutateAsync("Night theme")).version);
    });
    // Nothing changed since it was made (version 1), then the theme did.
    expect(saved).toEqual([null, 2]);
  });

  test("pictures an agent asked for: placeholders at once, pictures when they come", async () => {
    const { live, wrapper, roomOptions } = setup();
    const file = await live.addFile(ORG_ID, { kind: "canvas", title: "Campaign" });
    const view = renderHook(() => useLiveRoom(ORG_ID, file.id, roomOptions()), { wrapper });
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    const room = view.result.current.room;
    if (!room) throw new Error("no room");
    const shapes = renderHook(
      () =>
        useLiveSelector(room, (doc) =>
          readShapes(doc)
            .map((s) => s.type)
            .join(","),
        ),
      { wrapper },
    );
    let requestId = "";
    await act(async () => {
      const made = await live.askImages(ORG_ID, file.id, { prompt: "A fox in the snow", count: 2, aspect: "16:9" });
      requestId = made.requestId;
      expect(made.shapeIds).toHaveLength(2);
      expect(made.frameId).not.toBeNull();
    });
    await waitFor(() => expect(shapes.result.current).toBe("frame,pending,pending"));
    act(() => live.finishImages(requestId));
    await waitFor(() => expect(shapes.result.current).toBe("frame,image,image"));
    expect(live.assets.size).toBe(2);
  });

  test("switching to another file never hands back the previous file's room", async () => {
    const { live, wrapper, roomOptions } = setup();
    const one = await live.addFile(ORG_ID, { kind: "spreadsheet", title: "One" });
    const two = await live.addFile(ORG_ID, { kind: "spreadsheet", title: "Two" });
    const seen: [asked: string, got: string | null][] = [];
    const view = renderHook(
      ({ fileId }: { fileId: string }) => {
        const opened = useLiveRoom(ORG_ID, fileId, roomOptions());
        seen.push([fileId, opened.room?.fileId ?? null]);
        return opened;
      },
      { wrapper, initialProps: { fileId: one.id } },
    );
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    view.rerender({ fileId: two.id });
    await waitFor(() => expect(view.result.current.room?.fileId).toBe(two.id));
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    expect(seen.filter(([asked, got]) => got !== null && got !== asked)).toEqual([]);
  });

  test("closing the screens lets the room go after the delay", async () => {
    const { live, wrapper, roomOptions } = setup();
    const file = await live.addFile(ORG_ID, { kind: "spreadsheet", title: "Tracker" });
    const view = renderHook(() => useLiveRoom(ORG_ID, file.id, roomOptions()), { wrapper });
    await waitFor(() => expect(view.result.current.status).toBe("live"));
    const room = view.result.current.room;
    view.unmount();
    expect(room?.destroyed).toBe(false);
    await waitFor(() => expect(room?.destroyed).toBe(true), { timeout: 3000 });
    expect(liveRoomsOpen()).toBe(0);
  });

  test("the test sockets: a live file's reaches the fake API's live server, the rest stay the test's", async () => {
    const { api, live } = setup();
    const file = await live.addFile(ORG_ID, { kind: "slides", title: "Deck" });
    const sockets = fakeSockets({ live: fakeLiveOf.get(api)?.server });
    const realtime = sockets.factory(`wss://app.example.com/api/ws?orgId=${ORG_ID}`);
    const own = sockets.factory(`wss://app.example.com/api/live?orgId=${ORG_ID}&fileId=${file.id}`);
    expect(realtime).toBe(sockets.last());
    expect(live.server.sockets).toHaveLength(1);
    expect(live.server.sockets[0]).toBe(own as never);
    // Bytes on a plain fake socket are kept apart from its JSON frames.
    sockets.last().send(new Uint8Array([1, 2]));
    sockets.last().send('{"type":"ping"}');
    expect(sockets.last().binary).toEqual([new Uint8Array([1, 2])]);
    expect(sockets.last().sent).toEqual([{ type: "ping" }]);
  });
});
