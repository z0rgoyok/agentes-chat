import { describe, expect, test } from "bun:test";
import type { Message } from "@agenteschat/client";
import { upsertMessage } from "@agenteschat/client/lib/timeline";
import { datedBehind } from "../../src/features/chat/send-order";
import { chatScreenSource } from "./chat-screen-source";
import { message } from "./fixtures";

const ids = (list: Message[] | undefined) => (list ?? []).map((m) => m.id);
/** A copy of mine on its way, as the send writes it (`local-<clientId>`). */
const mine = (clientId: string, createdAt: string) =>
  message({ id: `local-${clientId}`, clientId, local: "pending", createdAt });
/** A copy written again: dated now, as the send's optimistic write does when its request goes. */
const redated = (list: Message[], m: Message, createdAt: string) =>
  upsertMessage(
    list.filter((x) => x.id !== m.id),
    { ...m, createdAt },
  );

describe("what I send while my files go up", () => {
  const before = message({ id: "s1", createdAt: "2026-11-16T09:59:00.000Z" });

  test("stays under them when they go, here as on the server", () => {
    const files = mine("f", "2026-11-16T10:00:00.000Z");
    const text = mine("t", "2026-11-16T10:00:02.000Z");
    let list = upsertMessage(upsertMessage([before], files), text);
    expect(ids(list)).toEqual(["s1", "local-f", "local-t"]);
    // The files are up: their copy is written again as their request goes, dated then, after the text's.
    const going = { ...files, createdAt: "2026-11-16T10:00:09.000Z" };
    list = redated(list, files, going.createdAt);
    expect(ids(list)).toEqual(["s1", "local-t", "local-f"]);
    // The text waiting behind them is dated right after them: the order it was sent in holds.
    list = datedBehind(list, going, ["t"]) ?? [];
    expect(ids(list)).toEqual(["s1", "local-f", "local-t"]);
    // Their server copy sorts before everything still on its way, whatever the two clocks say.
    const sent = message({ id: "s2", clientId: "f", createdAt: "2026-11-16T10:00:30.000Z" });
    list = upsertMessage(
      list.filter((m) => m.id !== "local-f"),
      sent,
    );
    expect(ids(list)).toEqual(["s1", "s2", "local-t"]);
  });

  test("several waiting keep the order they were sent in, and nothing else moves", () => {
    const files = mine("f", "2026-11-16T10:00:00.000Z");
    const a = mine("a", "2026-11-16T10:00:01.000Z");
    const b = mine("b", "2026-11-16T10:00:02.000Z");
    const going = { ...files, createdAt: "2026-11-16T10:00:09.000Z" };
    let list = redated(upsertMessage(upsertMessage(upsertMessage([before], files), a), b), files, going.createdAt);
    list = datedBehind(list, going, ["a", "b"]) ?? [];
    expect(ids(list)).toEqual(["s1", "local-f", "local-a", "local-b"]);
    expect(list.find((m) => m.id === "s1")).toBe(before);
    // Nothing waiting: the very same list.
    expect(datedBehind(list, going, [])).toBe(list);
  });

  test("the screen sends behind its files while they go up, and their request goes before what waits", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("return deliverFiles(local, how);");
    expect(chat).toContain("behindFiles(() => deliverFilesRef.current(m));");
    // Words, GIFs and stickers, the summary and what another app shared all go the same way.
    expect(chat).toContain('sendText(text, how === "now" ? { ...meta, steer: "now" } : meta);');
    expect(chat).toContain('sendText("", { ...takeQuote(), media });');
    expect(chat).toContain("sendText(shareIn.text);");
    expect(chat).toContain('sendText(t("mobile.chat.summaryMessage"));');
    // The files' request is awaited, so what waits goes after its answer.
    expect(chat).toMatch(/await post\s*\.mutateAsync\(\{\s*body: local\.body,/);
    // Dated as the message ahead goes, what waits stays under it.
    expect(chat).toContain("if (waitingBehind.current.length > 0) keepBehind(local);");
  });
});
