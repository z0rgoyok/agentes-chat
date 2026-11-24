import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keys, type Message, openConversation } from "@agenteschat/client";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { QueryObserver } from "@tanstack/react-query";
import { message } from "./fixtures";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

/** The phone's query client as `createQueryClient` (providers/query.ts) makes it. */
const phoneClient = () =>
  new LiveQueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }, mutations: { retry: 0 } },
  });

const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};
const settled = (qc: LiveQueryClient, key: readonly unknown[]) =>
  until(() => qc.getQueryState(key)?.fetchStatus === "idle");

test("the phone's query client: fresh for 30 s; coming back to the app, the socket's catch-up reads, not the focus", () => {
  const query = src("providers/query.ts");
  expect(query).toContain("staleTime: 30_000");
  expect(query).toContain("refetchOnWindowFocus: false");
});

test("back from the background, the same socket starts again and its catch-up reads what it may have missed", () => {
  const provider = src("providers/realtime.tsx").replace(/\s+/g, " ");
  expect(provider).toContain("const offActive = keepWhileActive(c, readCookie);");
  expect(provider).toContain("c.onCatchUp((full) => void catchUpQueries(queryClient, full))");
});

test("a chat screen listens while open, and its closing marks the conversation stale", () => {
  const live = src("features/chat/live.ts").replace(/\s+/g, " ");
  expect(live).toContain("const close = openConversation(qc, orgId, channelId);");
  expect(live).toContain("return () => { off(); close(); };");
});

test("a chat opened again within 30 s reads again; one still open under a thread doesn't", async () => {
  const qc = phoneClient();
  const key = keys.messages("o1", "c1");
  let reads = 0;
  const options = {
    queryKey: key,
    queryFn: async () => {
      reads++;
      return [message({ id: "m-1", channelId: "c1" })];
    },
  };
  const channel = openConversation(qc, "o1", "c1");
  const first = new QueryObserver(qc, options);
  const offFirst = first.subscribe(() => {});
  await settled(qc, key);
  // A thread pushed over the chat: the chat stays open under it.
  const thread = openConversation(qc, "o1", "c1");
  thread();
  const again = new QueryObserver(qc, options);
  const offAgain = again.subscribe(() => {});
  await settled(qc, key);
  expect(reads).toBe(1);
  offAgain();
  // Back out of the chat, then into it again.
  offFirst();
  channel();
  const reopened = new QueryObserver(qc, options);
  const offReopened = reopened.subscribe(() => {});
  await settled(qc, key);
  expect(reads).toBe(2);
  offReopened();
});
