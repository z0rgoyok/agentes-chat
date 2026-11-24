import { expect, test } from "bun:test";
import { activityLine, type MessageView } from "../src";

const view = (over: Partial<MessageView> = {}): MessageView => ({
  id: "m1",
  channelId: "c1",
  threadId: null,
  author: { type: "agent", id: "a1" },
  body: "Pronto, **deploy** feito",
  mentionedAgentIds: [],
  mentionedUserIds: [],
  agentRunId: null,
  meta: {},
  clientId: null,
  createdAt: "2026-11-24T10:00:00.000Z",
  ...over,
});

test("a message's line is what the lists show of it: the channel's plain preview, the DM's body, counted unread", () => {
  expect(activityLine(view())).toEqual({
    id: "m1",
    createdAt: "2026-11-24T10:00:00.000Z",
    counts: true,
    last: {
      authorType: "agent",
      authorId: "a1",
      preview: "Pronto, deploy feito",
      body: "Pronto, **deploy** feito",
      meta: null,
      mediaKind: null,
    },
  });
});

test("what the lists skip stays out of the line: quiet notices, an agent's sticker after its reply, a routine's call", () => {
  // Written for the agent, in English: never a preview, never unread.
  const quiet = activityLine(view({ body: "You were stopped by Ana", meta: { notice: { kind: "run_stopped" } } }));
  expect(quiet).toEqual({ id: "m1", createdAt: "2026-11-24T10:00:00.000Z", counts: false });
  expect(JSON.stringify(quiet)).not.toContain("stopped by");
  expect(activityLine(view({ meta: { mediaAfter: "m0" } }))?.counts).toBe(false);
  // A routine's call counts, but the agent's answer will be the line.
  const routine = activityLine(view({ author: { type: "person", id: "u1" }, meta: { routine: { id: "r1" } } }));
  expect(routine).toEqual({ id: "m1", createdAt: "2026-11-24T10:00:00.000Z", counts: true });
});

test("a voice message lists what was typed beside it, never its words", () => {
  const voice = { clipId: "v1", durationMs: 4200, peaks: [], text: "ouve isso" };
  expect(activityLine(view({ body: "ouve isso\n\nwhat was said", meta: { voice } }))?.last).toMatchObject({
    preview: "ouve isso",
    body: "ouve isso",
    mediaKind: null,
  });
});

test("nothing of a confidential message, nor a line too heavy to publish: the lists read again instead", () => {
  expect(activityLine(view({ meta: { confidential: true, sealedBody: "secret" } }))).toBeNull();
  expect(activityLine(view({ meta: { bodyCode: "x", bodyParams: { big: "x".repeat(5000) } } }))).toBeNull();
});
