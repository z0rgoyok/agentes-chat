import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "../src/index";
import { applyChannelEvent, emptyStreams, runsInChannel } from "../src/index";
import { barEntries } from "../src/lib/activity";
import { toolItemsLive } from "../src/lib/work";
import { applyReceiptEvent, receiptTicks, receiptView, seedReceipt } from "../src/realtime/receipts";

/**
 * The line an agent says before slow work (`say_now`, ADR 0207): a message of its own in the conversation it answers,
 * with no run of its own (`agentRunId` null) and `meta.sayNow`. It answers nothing and ends nothing: the reply, which
 * comes after it, does both.
 */
describe("the line before slow work", () => {
  // Loose on purpose: the live row's events (agent.tool) live in the client stream union, not ChannelEvent.
  const ev = (e: Record<string, unknown> & { type: string }) => ({ channelId: "c1", ...e }) as unknown as ChannelEvent;
  const message = (id: string, fields: Partial<Message>) =>
    ({
      id,
      channelId: "c1",
      threadId: "m1",
      author: { type: "agent", id: "ada" },
      body: "",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {},
      createdAt: "2026-11-19T10:00:00.000Z",
      ...fields,
    }) as Message;
  // A person asks Ada in the channel; her run answers in that message's thread.
  const person = message("m1", { threadId: null, author: { type: "person", id: "u1" }, mentionedAgentIds: ["ada"] });
  const line = message("m2", { body: "Bora! Vou abrir o painel e já te mando.", meta: { sayNow: { runId: "r1" } } });
  const reply = message("m3", { body: "Pronto: o painel está no ar.", agentRunId: "r1" });
  const posted = (m: Message) => ev({ type: "message.created", messageId: m.id, message: m });

  test("never answers the person's message: it reads as being answered until the reply", () => {
    let s = seedReceipt({}, person);
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m1",
        seenBy: ["ada"],
        pickedBy: ["ada"],
        runs: [{ agentId: "ada", runId: "r1" }],
      }),
    );
    s = applyReceiptEvent(s, ev({ type: "agent.run", threadId: "m1", runId: "r1", agentId: "ada", status: "running" }));
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    // Nothing moves: no "respondeu" on the message, nor on the thread the line goes in.
    expect(applyReceiptEvent(s, posted(line))).toBe(s);
    expect(receiptTicks(s.m1)).toBe("check");
    s = applyReceiptEvent(s, posted(reply));
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "handled", agents: ["ada"] }, done: true });
    expect(receiptTicks(s.m1)).toBe("checks");
  });

  test("never marks the thread it goes in as answered, even with no receipt there yet", () => {
    expect(applyReceiptEvent({}, posted(line))).toEqual({});
  });

  test("never ends the live row: with no run of its own it ends nothing, and the reply still does", () => {
    const base = { threadId: "m1", runId: "r1", agentId: "ada" };
    let s = applyChannelEvent(emptyStreams, ev({ type: "agent.run", ...base, status: "running" }));
    s = applyChannelEvent(s, ev({ type: "agent.tool", ...base, tool: "say_now", toolUseId: "t1" }));
    // While it goes out the bar says it posts a message, as for a message posted elsewhere.
    expect(
      barEntries(
        runsInChannel(s, "c1"),
        [],
        (id) => id,
        () => undefined,
      )[0]?.activity,
    ).toEqual({
      kind: "postingMessage",
    });
    s = applyChannelEvent(s, ev({ type: "agent.tool", ...base, tool: null, toolUseId: "t1" }));
    // Heard with no call running (its event came late): the run is still at work.
    s = applyChannelEvent(s, posted(line));
    s = applyChannelEvent(s, ev({ type: "agent.tool", ...base, tool: "browser_open", toolUseId: "t2" }));
    const [row] = runsInChannel(s, "c1");
    expect(row?.runId).toBe("r1");
    // Its block lists the work only.
    expect(toolItemsLive(row?.work ?? []).map((i) => (i.kind === "call" ? i.line.kind : i.kind))).toEqual(["browsing"]);
    s = applyChannelEvent(s, ev({ type: "agent.tool", ...base, tool: null, toolUseId: "t2" }));
    s = applyChannelEvent(s, posted(reply));
    expect(runsInChannel(s, "c1")).toEqual([]);
  });
});
