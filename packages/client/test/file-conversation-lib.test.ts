import { expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { createHttpApi, fileConversationOf, liveRefOf, liveSelectionOf, messageLiveRef } from "../src/index";
import { openTarget } from "../src/lib/notifications";

/**
 * A live file's conversation as the apps read it (ADR 0199): its root, what a message points at in the file, the
 * routes that open it and count it, and where a notice about it opens.
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
