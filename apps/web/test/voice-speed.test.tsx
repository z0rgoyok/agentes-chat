import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { STORAGE_KEYS } from "@/lib/storage";
import { createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

const voiceMessage = (id: string, minutesAgo: number) => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "person" as const, id: "u-joao" },
  body: "",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { voice: { clipId: `clip-${id}`, durationMs: 9000, peaks: [0.2, 0.7, 0.4] } },
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
});

/** This browser's storage now holds `value`, handed over as a page load or another tab of this browser would. */
const keep = (value: string | null) => {
  if (value === null) localStorage.clear();
  else localStorage.setItem(STORAGE_KEYS.voiceSpeed, value);
  window.dispatchEvent(new StorageEvent("storage", { key: value === null ? null : STORAGE_KEYS.voiceSpeed }));
};
/** The channel with two voice messages, once this browser keeps `kept`. */
const open = async (kept: string | null = null) => {
  const state = seedState();
  state.messages.push(voiceMessage("m-voice-1", 30), voiceMessage("m-voice-2", 20));
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => r.sockets.last().open());
  await settle(2);
  await act(async () => keep(kept));
};
/** Runs `check` with this browser's storage swapped for `area`. */
const withStorage = async (area: Partial<Storage>, check: () => Promise<void>) => {
  const real = globalThis.localStorage;
  globalThis.localStorage = area as Storage;
  try {
    await check();
  } finally {
    globalThis.localStorage = real;
  }
};
const speeds = () => [...document.querySelectorAll(".ac-voice__speed")].map((b) => b.textContent);
const pickOnFirst = () => act(async () => fireEvent.click(document.querySelector(".ac-voice__speed") as HTMLElement));

afterEach(() => cleanup());

describe("voice messages remember the speed picked on this device", () => {
  test("picked on one, every voice message on screen plays at it, and it is kept in this browser", async () => {
    await open();
    expect(speeds()).toEqual(["1×", "1×"]);
    await pickOnFirst();
    expect(speeds()).toEqual(["1.5×", "1.5×"]);
    expect(localStorage.getItem(STORAGE_KEYS.voiceSpeed)).toBe("1.5");
  });

  test("a speed kept in this browser, from before a reload or picked in another tab, is the one they play at", async () => {
    await open("2");
    expect(speeds()).toEqual(["2×", "2×"]);
  });

  test("a kept value the player doesn't offer plays at 1x", async () => {
    await open("3");
    expect(speeds()).toEqual(["1×", "1×"]);
  });

  test("with storage blocked the players work at 1x and still change speed together", async () => {
    await open("2");
    const fail = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    await withStorage({ getItem: fail, setItem: fail }, async () => {
      await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
      expect(speeds()).toEqual(["1×", "1×"]);
      await pickOnFirst();
      expect(speeds()).toEqual(["1.5×", "1.5×"]);
    });
  });

  test("when storage keeps an old speed but takes no new one, a pick still changes every player", async () => {
    await open("2");
    const full = {
      getItem: (key: string) => (key === STORAGE_KEYS.voiceSpeed ? "2" : null),
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    await withStorage(full, async () => {
      await pickOnFirst();
      expect(speeds()).toEqual(["1×", "1×"]);
    });
  });
});
