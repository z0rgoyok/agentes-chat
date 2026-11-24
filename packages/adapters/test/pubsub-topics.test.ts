import { expect, test } from "bun:test";
import { createPostgresPubSub, type PgNotifier, topicOf } from "../src/pubsub";

test("a payload's topic is read off its start, as publish writes it; anything else is parsed whole", () => {
  expect(topicOf(JSON.stringify({ t: "org:1234", e: { type: "x" } }))).toBe("org:1234");
  expect(topicOf(JSON.stringify({ e: { type: "x" }, t: "org:1234" }))).toBeNull();
  expect(topicOf(JSON.stringify({ t: 'a"b', e: {} }))).toBeNull();
  expect(topicOf("not json")).toBeNull();
});

test("an event whose topic nobody here listens to is skipped unparsed; one it does reaches its handlers", async () => {
  const listeners: ((payload: string) => void)[] = [];
  const notifier: PgNotifier = {
    listen: async (_channel, on, onListen) => {
      listeners.push(on);
      onListen?.();
      return async () => {};
    },
    notify: async (_channel, payload) => {
      for (const on of listeners) on(payload);
    },
  };
  const pubsub = await createPostgresPubSub(notifier, { heartbeatMs: 60_000 });
  const heard: unknown[] = [];
  pubsub.subscribe("org:mine", (event) => heard.push(event));
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    parsed++;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  try {
    for (const on of listeners) on(JSON.stringify({ t: "org:other", e: { type: "x" } }));
    expect(parsed).toBe(0);
    for (const on of listeners) on(JSON.stringify({ t: "org:mine", e: { type: "y" } }));
    expect(parsed).toBe(1);
  } finally {
    JSON.parse = parse;
    await pubsub.close?.();
  }
  expect(heard).toEqual([{ type: "y" }]);
});
