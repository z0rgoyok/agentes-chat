import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyUnreadEvent, readConversationListsNow, UNREAD_REFRESH_MS, UNREAD_SPREAD_MS } from "../src/api/queries";
import type { ActivityLine, Channel, DirectMessage, ThreadInfo } from "../src/api/types";
import { looksUnread, titledWithUnread, unreadTotal } from "../src/lib/unread";

const channel = (id: string, extra: Partial<Channel> = {}) =>
  ({ id, name: id, isMember: true, unreadCount: 0, mentionCount: 0, muted: false, ...extra }) as Channel;
const dm = (channelId: string, unread: number) =>
  ({
    channelId,
    unread,
    with: { type: "agent", id: `a-${channelId}`, name: "Atlas", handle: "atlas" },
  }) as DirectMessage;

describe("what looks unread", () => {
  test("something new I haven't muted, in a channel I'm in", () => {
    expect(looksUnread(channel("c", { unreadCount: 3 }))).toBe(true);
    expect(looksUnread(channel("c", { unreadCount: 3, muted: true }))).toBe(false);
    expect(looksUnread(channel("c", { unreadCount: 3, isMember: false }))).toBe(false);
    expect(looksUnread(channel("c"))).toBe(false);
  });

  test("the total is DM messages plus mentions of me (muted channels' too), never plain channel messages", () => {
    const channels = [
      channel("busy", { unreadCount: 40 }),
      channel("named", { unreadCount: 5, mentionCount: 2 }),
      channel("quiet", { unreadCount: 1, mentionCount: 1, muted: true }),
      channel("left", { isMember: false, mentionCount: 9 }),
    ];
    expect(unreadTotal(channels, [dm("d1", 3), dm("d2", 0)])).toBe(6);
  });

  test("DMs with agents my lists hide add nothing (the web title and the phone icon agree)", () => {
    expect(unreadTotal([], [dm("d1", 4), dm("d2", 1)], new Set(["a-d1"]))).toBe(1);
  });

  test("the tab title carries the total in front, replaced, gone at zero, 99+ past 99", () => {
    expect(titledWithUnread("agentes.chat", 3)).toEqual({ title: "(3) agentes.chat", prefix: "(3) " });
    expect(titledWithUnread("(3) agentes.chat", 5, "(3) ").title).toBe("(5) agentes.chat");
    expect(titledWithUnread("(99+) #geral", 0, "(99+) ").title).toBe("#geral");
    expect(titledWithUnread("#geral", 120).title).toBe("(99+) #geral");
    // A page's own count (the Notifications page) stays, whatever the total.
    expect(titledWithUnread("(3) Notificações", 0, "(5) ")).toEqual({ title: "(3) Notificações", prefix: "" });
    expect(titledWithUnread("(3) Notificações", 7).title).toBe("(3) Notificações");
  });
});

describe("live unread on my own topic", () => {
  const ORG = "org-1";
  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.channels(ORG), [channel("c1", { unreadCount: 4, mentionCount: 1 })]);
    qc.setQueryData(keys.dms(ORG), [dm("d1", 2)]);
    qc.setQueryData(keys.threadInfo(ORG, "t1"), { id: "t1", unread: 3 } as ThreadInfo);
    return qc;
  };
  const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true;
  /** Past the longest wait of a burst's read. */
  const pastBurst = () => jest.advanceTimersByTime(UNREAD_REFRESH_MS + UNREAD_SPREAD_MS);
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runAllTimers();
    jest.useRealTimers();
  });

  test("a read on another device clears the conversation at once", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: "" } as never);
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "d1", userId: "me", lastReadAt: "" } as never);
    expect(qc.getQueryData<Channel[]>(keys.channels(ORG))?.[0]).toMatchObject({ unreadCount: 0, mentionCount: 0 });
    expect(qc.getQueryData<DirectMessage[]>(keys.dms(ORG))?.[0]?.unread).toBe(0);
  });

  test("a mute from another device, and a thread read there", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.muted", channelId: "c1", muted: true } as never);
    expect(qc.getQueryData<Channel[]>(keys.channels(ORG))?.[0]?.muted).toBe(true);
    applyUnreadEvent(qc, ORG, { type: "thread.read", threadId: "t1", channelId: "c1", lastReadAt: "" } as never);
    expect(qc.getQueryData<ThreadInfo>(keys.threadInfo(ORG, "t1"))?.unread).toBe(0);
  });

  test("a thread read has the channels and the DMs read again (its replies count in both)", () => {
    const qc = seeded();
    expect(stale(qc, keys.dms(ORG))).toBe(false);
    applyUnreadEvent(qc, ORG, { type: "thread.read", threadId: "t1", channelId: "d1", lastReadAt: "" } as never);
    expect(stale(qc, keys.dms(ORG))).toBe(true);
    expect(stale(qc, keys.channels(ORG))).toBe(true);
  });

  test("a thread's reply in a DM reads the DMs again, as its other messages do", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "d1", threadId: "t1", dm: true } as never);
    pastBurst();
    expect(stale(qc, keys.dms(ORG))).toBe(true);
    expect(stale(qc, keys.channels(ORG))).toBe(false);
  });

  test("new messages have the lists read again once per burst", () => {
    const qc = seeded();
    for (let i = 0; i < 5; i++)
      applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "c1", threadId: null } as never);
    expect(stale(qc, keys.channels(ORG))).toBe(false);
    pastBurst();
    expect(stale(qc, keys.channels(ORG))).toBe(true);
    // Only the list that moved reads again.
    expect(stale(qc, keys.dms(ORG))).toBe(false);
  });

  test("a DM's message reads only the DMs again", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "d1", threadId: null, dm: true } as never);
    pastBurst();
    expect(stale(qc, keys.dms(ORG))).toBe(true);
    expect(stale(qc, keys.channels(ORG))).toBe(false);
  });

  test("each member's read waits a random part of the spread on top, so their reads don't land at once", () => {
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const qc = seeded();
      applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "c1", threadId: null } as never);
      jest.advanceTimersByTime(UNREAD_REFRESH_MS + UNREAD_SPREAD_MS / 2 - 1);
      expect(stale(qc, keys.channels(ORG))).toBe(false);
      jest.advanceTimersByTime(1);
      expect(stale(qc, keys.channels(ORG))).toBe(true);
    } finally {
      random.mockRestore();
    }
  });
});

describe("a message's line patches its row instead of reading the list again", () => {
  const ORG = "org-1";
  const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 10, 0, s)).toISOString();
  const shown = (id: string, createdAt: string) => ({
    id,
    authorType: "agent" as const,
    authorId: "a1",
    authorName: "Atlas",
    preview: "antes",
    createdAt,
  });
  const line = (id: string, createdAt: string, extra: Partial<ActivityLine> = {}): ActivityLine => ({
    id,
    createdAt,
    counts: true,
    last: {
      authorType: "agent",
      authorId: "a1",
      preview: "Pronto",
      body: "Pronto, **feito**",
      meta: null,
      mediaKind: null,
    },
    ...extra,
  });
  const heard = (channelId: string, message: ActivityLine, extra: Record<string, unknown> = {}) =>
    ({ type: "channel.activity", channelId, threadId: null, message, ...extra }) as never;
  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.channels(ORG), [
      channel("c1", { unreadCount: 1, lastMessage: shown("m0", at(0)), lastReadAt: at(0) }),
    ]);
    qc.setQueryData(keys.dms(ORG), [
      { ...dm("d1", 0), lastMessage: { id: "m0", body: "oi", createdAt: at(0), authorType: "person" } },
    ]);
    return qc;
  };
  const row = (qc: QueryClient) => qc.getQueryData<Channel[]>(keys.channels(ORG))?.[0];
  const dmRow = (qc: QueryClient) => qc.getQueryData<DirectMessage[]>(keys.dms(ORG))?.[0];
  const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true;
  const pastBurst = () => jest.advanceTimersByTime(UNREAD_REFRESH_MS + UNREAD_SPREAD_MS);
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runAllTimers();
    jest.useRealTimers();
  });

  test("a channel's row takes the line, one more unread and a mention of me, and the list isn't read again", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5)), { mentioned: true }));
    expect(row(qc)).toMatchObject({
      unreadCount: 2,
      mentionCount: 1,
      lastMessage: {
        id: "m1",
        authorType: "agent",
        authorId: "a1",
        authorName: null,
        preview: "Pronto",
        createdAt: at(5),
      },
    });
    pastBurst();
    expect(stale(qc, keys.channels(ORG))).toBe(false);
  });

  test("a patched row keeps its list's age: what no event carries (a new channel, a name) still reads on schedule", () => {
    const qc = seeded();
    const read = qc.getQueryState(keys.channels(ORG))?.dataUpdatedAt;
    jest.advanceTimersByTime(60_000);
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5))));
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: at(9) } as never);
    expect(row(qc)?.lastMessage?.id).toBe("m1");
    expect(qc.getQueryState(keys.channels(ORG))?.dataUpdatedAt).toBe(read);
  });

  test("a DM's row takes the line as its body", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("d1", line("m1", at(5)), { dm: true }));
    expect(dmRow(qc)).toMatchObject({
      unread: 1,
      lastMessage: { id: "m1", body: "Pronto, **feito**", createdAt: at(5), authorType: "agent" },
    });
    pastBurst();
    expect(stale(qc, keys.dms(ORG))).toBe(false);
  });

  test("a line the list already holds changes nothing: its read came after the message", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("c1", line("m0", at(0))));
    applyUnreadEvent(qc, ORG, heard("c1", line("m-older", at(-5))));
    expect(row(qc)).toMatchObject({ unreadCount: 1, lastMessage: { id: "m0" } });
  });

  test("read past it already (its `channel.read` heard first): the line goes in, nothing unread", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: at(9) } as never);
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5))));
    expect(row(qc)).toMatchObject({ unreadCount: 0, lastReadAt: at(9), lastMessage: { id: "m1" } });
  });

  test("what isn't news, or a routine's call, counts as the server says: no unread, or no line", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5), { counts: false })));
    expect(row(qc)).toMatchObject({ unreadCount: 1, lastMessage: { id: "m1" } });
    jest.advanceTimersByTime(10_000);
    applyUnreadEvent(qc, ORG, heard("c1", line("m2", at(6), { last: undefined })));
    expect(row(qc)).toMatchObject({ unreadCount: 2, lastMessage: { id: "m1" } });
  });

  test("a thread's reply counts in its channel but is never its line; right after a read of the list, that reads again", () => {
    const qc = seeded();
    const reply = { type: "channel.activity", channelId: "c1", threadId: "t1", message: line("r1", at(5)) } as never;
    // The list was read a moment ago: it may hold the reply already, and nothing tells.
    applyUnreadEvent(qc, ORG, reply);
    expect(row(qc)).toMatchObject({ unreadCount: 1, lastMessage: { id: "m0" } });
    pastBurst();
    expect(stale(qc, keys.channels(ORG))).toBe(true);
    // Read a while ago: counted at once.
    const later = seeded();
    jest.advanceTimersByTime(10_000);
    applyUnreadEvent(later, ORG, reply);
    expect(row(later)).toMatchObject({ unreadCount: 2, lastMessage: { id: "m0" } });
  });

  test("a conversation the list doesn't hold, or one I'm not in there, has the list read again", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("c-new", line("m1", at(5))));
    pastBurst();
    expect(stale(qc, keys.channels(ORG))).toBe(true);
    const outside = new QueryClient();
    outside.setQueryData(keys.channels(ORG), [channel("c1", { isMember: false })]);
    applyUnreadEvent(outside, ORG, heard("c1", line("m1", at(5))));
    pastBurst();
    expect(stale(outside, keys.channels(ORG))).toBe(true);
  });

  test("a read clears the row and sets where it starts: the lists read again only for a last line after it", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: at(3) } as never);
    expect(row(qc)).toMatchObject({ unreadCount: 0, mentionCount: 0, lastReadAt: at(3) });
    expect(stale(qc, keys.channels(ORG))).toBe(false);
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "d1", userId: "me", lastReadAt: at(3) } as never);
    expect(dmRow(qc)).toMatchObject({ unread: 0, lastReadAt: at(3), everRead: true });
    expect(stale(qc, keys.dms(ORG))).toBe(false);
    // Read up to before the last line, which came on another device: what's after may be unread.
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5))));
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: at(4) } as never);
    expect(stale(qc, keys.channels(ORG))).toBe(true);
  });

  // A UUIDv7 as the server makes it: its first 48 bits are when it was posted.
  const posted = (s: number, tail = "7000-8000-000000000000") => {
    const hex = Date.parse(at(s)).toString(16).padStart(12, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8)}-${tail}`;
  };

  test("an agent's reply placed before the shown line but posted after the list's read counts, under that line", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.channels(ORG), [
      channel("c1", { unreadCount: 0, lastMessage: shown(posted(30), at(30)), lastReadAt: at(0) }),
    ]);
    jest.advanceTimersByTime(10_000);
    // Its place is where its status line showed (20 s), its post after the person's line (40 s).
    applyUnreadEvent(qc, ORG, heard("c1", line(posted(40), at(20))));
    expect(row(qc)).toMatchObject({ unreadCount: 1, lastMessage: { id: posted(30) } });
    pastBurst();
    expect(stale(qc, keys.channels(ORG))).toBe(false);
    // One posted before the shown line: that read holds it already.
    applyUnreadEvent(qc, ORG, heard("c1", line(posted(25), at(10))));
    expect(row(qc)?.unreadCount).toBe(1);
  });

  test("a reply placed before my read but posted after it is unread, as the server counts it", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.channels(ORG), [
      channel("c1", { unreadCount: 0, lastMessage: shown(posted(0), at(0)), lastReadAt: at(30) }),
    ]);
    jest.advanceTimersByTime(10_000);
    applyUnreadEvent(qc, ORG, heard("c1", line(posted(60), at(20))));
    expect(row(qc)).toMatchObject({ unreadCount: 1, lastMessage: { id: posted(60) } });
    // My read on another device, past its place but before its post: the list reads again.
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: at(50) } as never);
    expect(stale(qc, keys.channels(ORG))).toBe(true);
  });

  test("a notice about a message whose line is in already reads nothing; one about anything else reads at once", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, heard("c1", line("m1", at(5))));
    readConversationListsNow(qc, ORG, "m1");
    expect(stale(qc, keys.channels(ORG))).toBe(false);
    expect(stale(qc, keys.dms(ORG))).toBe(false);
    readConversationListsNow(qc, ORG, "m-unheard");
    expect(stale(qc, keys.channels(ORG))).toBe(true);
    expect(stale(qc, keys.dms(ORG))).toBe(true);
  });
});
