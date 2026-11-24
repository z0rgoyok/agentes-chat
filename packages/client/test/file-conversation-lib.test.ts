import { expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import {
  createHttpApi,
  fileConversationOf,
  isPinnedSelection,
  isTalkKind,
  liveRefOf,
  liveSelectionOf,
  messageLiveRef,
  resolvedOf,
} from "../src/index";
import { mediaKindOfArtifact, mediaKindOfType } from "../src/lib/files";
import { openTarget } from "../src/lib/notifications";

/**
 * A live file's conversation as the apps read it (ADR 0199): its root, what a message points at in the file, the
 * routes that open it and count it, and where a notice about it opens. A picture's, a video's or a PDF's too (ADR
 * 0208): a comment's place, its pictures and who resolved it.
 */

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responses[`${init.method} ${url.split("?")[0]}`];
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const ORG = "/api/app/organizations/o1";

test("the root names the file and its kind; any other message is no root", () => {
  expect(fileConversationOf({ fileConversation: { artifactId: "f1", kind: "canvas", title: "Campanha" } })).toEqual({
    artifactId: "f1",
    kind: "canvas",
    title: "Campanha",
  });
  expect(fileConversationOf({ fileConversation: { artifactId: "f1", kind: "document", title: "Plano" } })?.kind).toBe(
    "document",
  );
  expect(fileConversationOf({ fileConversation: { artifactId: "f1", kind: "poster" } })).toBeNull();
  expect(fileConversationOf({ taskConversation: { issueId: "i1" } })).toBeNull();
  expect(fileConversationOf(undefined)).toBeNull();
});

test("a selection keeps a canvas pin, a document's quote and its block", () => {
  expect(
    liveSelectionOf({ label: "Comentário", point: { x: 12.5, y: -3 }, text: "o trecho", block: "b1", extra: 1 }),
  ).toEqual({ label: "Comentário", point: { x: 12.5, y: -3 }, text: "o trecho", block: "b1" });
  expect(liveSelectionOf({ label: "Pin", point: { x: "1", y: 2 } })).toEqual({ label: "Pin" });
  expect(liveSelectionOf({ label: "Longo", text: "x".repeat(300) })?.text).toHaveLength(200);
});

test("a message's reference: the server's, else its meta's", () => {
  const ref = { artifactId: "f1", kind: "spreadsheet" as const, title: "Custos", selection: { label: "C2:D6" } };
  expect(messageLiveRef({ liveRef: ref })).toBe(ref);
  expect(messageLiveRef({ meta: { liveRef: ref } })).toEqual(ref);
  expect(liveRefOf({ liveRef: { ...ref, kind: "document" } })?.kind).toBe("document");
  expect(messageLiveRef({ meta: {} })).toBeNull();
});

test("the conversation is opened with a POST, the unread files read, and a message carries its liveRef", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${ORG}/artifacts/f1/conversation`]: { channelId: "c1", rootId: "r1" },
    [`GET ${ORG}/unread-files`]: { files: [{ artifactId: "f1", unread: 2, mentions: 1 }] },
    [`POST ${ORG}/channels/c1/messages`]: { id: "m1" },
  });
  const api = createHttpApi({ fetch });
  expect(await api.artifacts.conversation("o1", "f1")).toEqual({ channelId: "c1", rootId: "r1" });
  expect(await api.reads?.unreadFiles?.("o1")).toEqual([{ artifactId: "f1", unread: 2, mentions: 1 }]);
  await api.chat.post("o1", "c1", {
    body: "Revisa",
    threadId: "r1",
    liveRef: { artifactId: "f1", selection: { label: "C2:D6 em Custos", range: "C2:D6" } },
  });
  expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
    `POST ${ORG}/artifacts/f1/conversation`,
    `GET ${ORG}/unread-files`,
    `POST ${ORG}/channels/c1/messages`,
  ]);
  expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({
    liveRef: { artifactId: "f1", selection: { label: "C2:D6 em Custos", range: "C2:D6" } },
  });
});

test("a notice from a file's conversation opens the file at that message", () => {
  const notice = {
    id: "n1",
    kind: "thread_reply",
    waiting: false,
    actors: [{ type: "user", id: "u2" }],
    count: 1,
    source: { channelId: "c1", threadId: "r1", messageId: "m1", artifactId: "f1", label: "Campanha" },
    latest: { text: "Vi aqui" },
  } as unknown as AppNotification;
  expect(openTarget(notice)).toEqual({
    to: "/org/$orgId/drive/$fileId",
    params: { fileId: "f1" },
    search: { m: "m1" },
  });
});

test("a picture's, a video's or a PDF's root and references read as theirs", () => {
  for (const kind of ["image", "video", "pdf"] as const) {
    expect(fileConversationOf({ fileConversation: { artifactId: "f1", kind, title: "Logo" } })).toEqual({
      artifactId: "f1",
      kind,
      title: "Logo",
    });
    expect(liveRefOf({ liveRef: { artifactId: "f1", kind, title: "Logo" } })?.kind).toBe(kind);
    expect(isTalkKind(kind)).toBe(true);
  }
  expect(isTalkKind("canvas")).toBe(true);
  expect(isTalkKind("file")).toBe(false);
  expect(fileConversationOf({ fileConversation: { artifactId: "f1", kind: "audio", title: "Nota" } })).toBeNull();
  expect(liveRefOf({ liveRef: { artifactId: "f1", kind: "file", title: "notas.txt" } })).toBeNull();
});

test("a selection keeps a comment's mark, moment, page, version and pictures", () => {
  const crop = "0196f2a4-1b2c-7d3e-8f40-123456789abc";
  const frame = "0196f2a4-1b2c-7d3e-8f40-cba987654321";
  const selection = {
    label: "2",
    mark: { x: 0.25, y: 0.5, w: 0.3, h: 0.2 },
    time: 12.3,
    page: 4,
    version: 2,
    crop,
    frame,
  };
  expect(liveSelectionOf({ ...selection, extra: 1 })).toEqual(selection);
  // A side of zero, or one missing, makes a point; what is off the file or isn't a number is left out.
  expect(liveSelectionOf({ label: "1", mark: { x: 0.3, y: 0.4, w: 0, h: 0.2 } })?.mark).toEqual({ x: 0.3, y: 0.4 });
  expect(liveSelectionOf({ label: "1", mark: { x: 0.3, y: 0.4, w: 0.2 } })?.mark).toEqual({ x: 0.3, y: 0.4 });
  expect(liveSelectionOf({ label: "1", mark: { x: 1.5, y: 0.4 }, time: -1, page: 0, version: 1.5 })).toEqual({
    label: "1",
  });
  expect(liveSelectionOf({ label: "1", mark: { x: "0.1", y: 0.4 }, time: "3", page: "2", crop: 7 })).toEqual({
    label: "1",
  });
  // A pin is a place: a mark, a moment (the first one too) or a page; the pictures alone are none.
  expect(isPinnedSelection({ label: "1", time: 0 })).toBe(true);
  expect(isPinnedSelection({ label: "1", page: 1 })).toBe(true);
  expect(isPinnedSelection({ label: "1", mark: { x: 0, y: 0 } })).toBe(true);
  expect(isPinnedSelection({ label: "1", crop, frame })).toBe(false);
  expect(isPinnedSelection(null)).toBe(false);
  // As a message carries it.
  const ref = { artifactId: "f1", kind: "image" as const, title: "Logo", selection };
  expect(messageLiveRef({ meta: { liveRef: ref } })).toEqual(ref);
});

test("who resolved a comment and when; null while it's open", () => {
  const resolved = { by: { type: "agent" as const, id: "a1" }, at: "2026-11-20T10:00:00.000Z" };
  expect(resolvedOf({ resolved })).toEqual(resolved);
  expect(resolvedOf({ resolved: { ...resolved, by: { ...resolved.by, extra: 1 }, extra: 1 } })).toEqual(resolved);
  expect(resolvedOf({ resolved: { by: { type: "person", id: "u1" }, at: resolved.at } })?.by.type).toBe("person");
  expect(resolvedOf({ resolved: { by: { type: "bot", id: "a1" }, at: resolved.at } })).toBeNull();
  expect(resolvedOf({ resolved: { by: resolved.by } })).toBeNull();
  expect(resolvedOf({ resolved: { at: resolved.at } })).toBeNull();
  expect(resolvedOf({ resolved: [resolved] })).toBeNull();
  expect(resolvedOf({})).toBeNull();
  expect(resolvedOf(undefined)).toBeNull();
});

test("a picture, a video or a PDF by its type, the same list the server reads", () => {
  expect(mediaKindOfType("image/png")).toBe("image");
  expect(mediaKindOfType("IMAGE/JPEG; charset=binary")).toBe("image");
  expect(mediaKindOfType("image/gif")).toBe("image");
  expect(mediaKindOfType("image/webp")).toBe("image");
  expect(mediaKindOfType("video/mp4")).toBe("video");
  expect(mediaKindOfType("video/webm")).toBe("video");
  expect(mediaKindOfType("video/quicktime")).toBe("video");
  expect(mediaKindOfType("application/pdf")).toBe("pdf");
  for (const other of [
    "image/svg+xml",
    "text/plain",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "audio/mpeg",
    "",
    null,
    undefined,
  ]) {
    expect(mediaKindOfType(other)).toBeNull();
  }
  expect(mediaKindOfArtifact({ kind: "file", content: { kind: "file", contentType: "video/mp4" } })).toBe("video");
  expect(mediaKindOfArtifact({ kind: "file", content: { kind: "file", contentType: "text/plain" } })).toBeNull();
  expect(mediaKindOfArtifact({ kind: "file" })).toBeNull();
  expect(mediaKindOfArtifact({ kind: "canvas", content: { kind: "file", contentType: "image/png" } })).toBeNull();
  expect(mediaKindOfArtifact(null)).toBeNull();
});

test("a comment's picture goes up as a file, and resolving sends the state", async () => {
  const { fetch, calls } = fakeFetch({
    [`POST ${ORG}/artifacts/f1/marks`]: { id: "a1", contentType: "image/png", size: 3, width: 1, height: 1 },
    [`POST ${ORG}/messages/m1/resolve`]: { resolved: null },
  });
  const api = createHttpApi({ fetch });
  const picture = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  expect(await api.live.uploadMark("o1", "f1", picture)).toMatchObject({ id: "a1" });
  expect(await api.live.resolveComment("o1", "m1", false)).toEqual({ resolved: null });
  expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
    `POST ${ORG}/artifacts/f1/marks`,
    `POST ${ORG}/messages/m1/resolve`,
  ]);
  const body = calls[0]?.init.body;
  expect(body).toBeInstanceOf(FormData);
  const part = (body as FormData).get("file") as File;
  expect(part.name).toBe("mark.png");
  expect(part.type).toBe("image/png");
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ resolved: false });
});
