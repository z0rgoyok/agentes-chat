import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  ApiError,
  applyUnreadEvent,
  keys,
  steerStore,
  useMarkChannelRead,
  useMarkThreadRead,
  useThreadActivity,
} from "@agenteschat/client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppProviders } from "@/app/providers";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { makeServices, renderApp, settle } from "./render";

afterEach(() => {
  steerStore.reset();
  cleanup();
  Reflect.deleteProperty(document, "visibilityState");
});

const THREAD_ID = "0198f000-0000-7000-8000-000000000001";

/** A failed write goes again at once, not after the client's usual wait. */
function retryAtOnce(services: ReturnType<typeof makeServices>) {
  const defaults = services.queryClient.getDefaultOptions();
  services.queryClient.setDefaultOptions({ ...defaults, mutations: { ...defaults.mutations, retryDelay: 0 } });
}

describe("the open conversation reads itself again on a thread's reply", () => {
  const open = async () => {
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(3);
    /** An event on my own topic, as the server sends a conversation's activity. */
    const mine = async (event: Record<string, unknown>) => {
      await act(async () => socket.push({ type: "event", scope: "user", event }));
      await settle(3);
    };
    const reads = (channelId = ENG_ID) =>
      state.calls.filter((c) => c.method === "dms.markRead" && c.args[1] === channelId).length;
    return { mine, reads };
  };
  const visibility = (value: "hidden" | "visible") =>
    act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    });

  test("a reply in one of its threads marks the channel read again", async () => {
    const { mine, reads } = await open();
    const before = reads();
    expect(before).toBeGreaterThan(0);
    await mine({ type: "channel.activity", channelId: ENG_ID, threadId: THREAD_ID });
    expect(reads()).toBe(before + 1);
    await mine({ type: "channel.activity", channelId: ENG_ID, threadId: THREAD_ID });
    expect(reads()).toBe(before + 2);
  });

  test("a reply in another channel's thread, or activity outside a thread, marks nothing", async () => {
    const { mine, reads } = await open();
    const before = reads();
    await mine({ type: "channel.activity", channelId: GENERAL_ID, threadId: THREAD_ID });
    await mine({ type: "channel.activity", channelId: ENG_ID, threadId: null });
    expect(reads()).toBe(before);
    expect(reads(GENERAL_ID)).toBe(0);
  });

  test("with the tab hidden nothing is marked until it is in view again", async () => {
    const { mine, reads } = await open();
    await visibility("hidden");
    const before = reads();
    await mine({ type: "channel.activity", channelId: ENG_ID, threadId: THREAD_ID });
    expect(reads()).toBe(before);
    await visibility("visible");
    await settle(3);
    expect(reads()).toBeGreaterThan(before);
  });
});

describe("replies heard in a conversation's threads (useThreadActivity)", () => {
  test("changes for the conversation whose thread got a reply, and only for it", () => {
    const services = makeServices(createFakeApi(seedState()));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppProviders services={services}>{children}</AppProviders>
    );
    const here = renderHook(() => useThreadActivity(ORG_ID, ENG_ID), { wrapper });
    const elsewhere = renderHook(() => useThreadActivity(ORG_ID, GENERAL_ID), { wrapper });
    const otherOrg = renderHook(() => useThreadActivity("another-org", ENG_ID), { wrapper });
    const hear = (event: Record<string, unknown>, orgId = ORG_ID) =>
      act(() => applyUnreadEvent(services.queryClient, orgId, { type: "channel.activity", ...event } as never));
    const start = here.result.current;

    hear({ channelId: ENG_ID, threadId: null });
    expect(here.result.current).toBe(start);

    hear({ channelId: ENG_ID, threadId: THREAD_ID });
    const once = here.result.current;
    expect(once).not.toBe(start);
    hear({ channelId: ENG_ID, threadId: THREAD_ID });
    expect(here.result.current).not.toBe(once);

    expect(elsewhere.result.current).toBe(start);
    expect(otherOrg.result.current).toBe(start);
    // A reply heard before a screen opens is there when it does.
    expect(renderHook(() => useThreadActivity(ORG_ID, ENG_ID), { wrapper }).result.current).toBe(here.result.current);
  });

  test("another app (its own query client) hears nothing of it", () => {
    const one = makeServices(createFakeApi(seedState()));
    const other = makeServices(createFakeApi(seedState()));
    const seen = renderHook(() => useThreadActivity(ORG_ID, ENG_ID), {
      wrapper: ({ children }: { children: ReactNode }) => <AppProviders services={other}>{children}</AppProviders>,
    });
    const start = seen.result.current;
    act(() =>
      applyUnreadEvent(one.queryClient, ORG_ID, {
        type: "channel.activity",
        channelId: ENG_ID,
        threadId: THREAD_ID,
      } as never),
    );
    expect(seen.result.current).toBe(start);
  });
});

describe("a read that didn't reach the server", () => {
  /** The mark-read hooks over an API whose reads end as `fail` says, counting every request sent. */
  const marking = (fail: (attempt: number) => Error | null) => {
    const state = seedState();
    const api = createFakeApi(state);
    const sent = { channel: 0, thread: 0 };
    const answer = (attempt: number) => {
      const error = fail(attempt);
      if (error) throw error;
    };
    const services = makeServices({
      ...api,
      dms: {
        ...api.dms,
        markRead: async () => answer(++sent.channel),
      },
      reads: {
        ...api.reads,
        markThreadRead: async () => answer(++sent.thread),
      },
    } as typeof api);
    retryAtOnce(services);
    const hooks = renderHook(() => ({ channel: useMarkChannelRead(ORG_ID), thread: useMarkThreadRead(ORG_ID) }), {
      wrapper: ({ children }: { children: ReactNode }) => <AppProviders services={services}>{children}</AppProviders>,
    });
    return { sent, hooks, qc: services.queryClient };
  };
  /** The lists a channel's read touches, cached: whether each was set to be read again. */
  const lists = [keys.channels(ORG_ID), keys.dms(ORG_ID), keys.unreadThreads(ORG_ID)];
  const seedLists = (qc: ReturnType<typeof makeServices>["queryClient"]) => {
    for (const key of lists) qc.setQueryData(key, key === lists[2] ? 0 : []);
  };
  const readAgain = (qc: ReturnType<typeof makeServices>["queryClient"]) =>
    lists.map((key) => qc.getQueryState(key)?.isInvalidated === true);
  const offline = () => new TypeError("Failed to fetch");

  test("is sent again, for a channel and for a thread", async () => {
    const { sent, hooks } = marking((attempt) => (attempt === 1 ? offline() : null));
    act(() => hooks.result.current.channel.mutate(ENG_ID));
    await waitFor(() => expect(hooks.result.current.channel.isSuccess).toBe(true));
    expect(sent.channel).toBe(2);
    act(() => hooks.result.current.thread.mutate(THREAD_ID));
    await waitFor(() => expect(hooks.result.current.thread.isSuccess).toBe(true));
    expect(sent.thread).toBe(2);
  });

  test("a server error is tried again too", async () => {
    const { sent, hooks } = marking((attempt) => (attempt === 1 ? new ApiError(503, "unavailable", "Down") : null));
    act(() => hooks.result.current.channel.mutate(ENG_ID));
    await waitFor(() => expect(hooks.result.current.channel.isSuccess).toBe(true));
    expect(sent.channel).toBe(2);
  });

  test("is given up after three more tries", async () => {
    const { sent, hooks } = marking(offline);
    act(() => hooks.result.current.channel.mutate(ENG_ID));
    await waitFor(() => expect(hooks.result.current.channel.isError).toBe(true));
    expect(sent.channel).toBe(4);
  });

  test("one that reached it reads no list again: its own `channel.read` sets the rows, and threads keep their unread", async () => {
    const { hooks, qc } = marking(() => null);
    seedLists(qc);
    act(() => hooks.result.current.channel.mutate(ENG_ID));
    await waitFor(() => expect(hooks.result.current.channel.isSuccess).toBe(true));
    expect(readAgain(qc)).toEqual([false, false, false]);
  });

  test("a refusal is final: nothing is sent again", async () => {
    const { sent, hooks, qc } = marking(() => new ApiError(403, "forbidden", "Not a member"));
    seedLists(qc);
    act(() => hooks.result.current.channel.mutate(ENG_ID));
    await waitFor(() => expect(hooks.result.current.channel.isError).toBe(true));
    // The rows were cleared ahead of the answer: the lists read again for the truth.
    expect(readAgain(qc)).toEqual([true, true, false]);
    act(() => hooks.result.current.thread.mutate(THREAD_ID));
    await waitFor(() => expect(hooks.result.current.thread.isError).toBe(true));
    await settle(3);
    expect(sent).toEqual({ channel: 1, thread: 1 });
  });
});
