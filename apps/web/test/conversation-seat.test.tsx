import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { resetHeldPlaces } from "@agenteschat/client";
import { SHARED_SEAT } from "@agenteschat/client/lib/seat";
import { ConversationSeat } from "@agenteschat/client/lib/seat-context";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { BrowserCard } from "@/components/browser/BrowserCard";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, renderPage, settle } from "./render";

afterEach(() => {
  cleanup();
  resetHeldPlaces();
});

const OWN_DM = `dm-${ADA_ID}`;

/**
 * Ada's browser card in a conversation where `rightHandId` is the workspace's built-in agent. Answers which place
 * each read of its screen asked for.
 */
async function cardIn(channelId: string, rightHandId: string, dm = false) {
  const state = seedState();
  state.dms.push({ channelId: OWN_DM, with: { type: "agent", id: ADA_ID, name: "Ada", handle: "ada" } });
  const api = createFakeApi(state);
  fakeBrowserOf.get(api)?.desktops.set(ADA_ID, { available: true, reason: null, running: true, canControl: true });
  await renderPage(
    <ConversationSeat orgId={ORG_ID} channelId={channelId} rightHandId={rightHandId} dm={dm}>
      <BrowserCard agentId={ADA_ID} name="Ada" />
    </ConversationSeat>,
    { api, org: true },
  );
  await settle(8);
  const seats = (method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args[2]);
  return [...seats("desktop.status"), ...seats("browser.agentHandoff")];
}

test("in a channel, the built-in agent's card reads its shared place, never the viewer's own", async () => {
  const asked = await cardIn(ENG_ID, ADA_ID);
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.every((seat) => seat === SHARED_SEAT)).toBe(true);
});

test("in the viewer's own DM with it, the card reads the viewer's own place", async () => {
  const asked = await cardIn(OWN_DM, ADA_ID, true);
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.every((seat) => seat === undefined)).toBe(true);
});

test("any other agent's card in a channel reads its one screen", async () => {
  const asked = await cardIn(ENG_ID, "another-agent");
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.every((seat) => seat === undefined)).toBe(true);
});

test("on a channel's page: taking over from the built-in agent's live card takes its shared place, another agent's its one screen", async () => {
  const state = withRightHand(seedState());
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  const works = async (agentId: string, runId: string) => {
    for (const event of [{ type: "agent.thinking" }, { type: "agent.tool", tool: "browser_open" }]) {
      await act(async () =>
        socket.push({
          type: "event",
          channelId: ENG_ID,
          event: { channelId: ENG_ID, threadId: null, runId, agentId, ...event },
        }),
      );
    }
    await settle();
  };
  await works(LODI_ID, "r-lodi");
  await works(ADA_ID, "r-ada");
  const cards = [...document.querySelectorAll<HTMLElement>(".brw-ac")];
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Assumir" })));
    await settle(3);
  }
  const taken = state.calls.filter((c) => c.method === "browser.takeover").map((c) => c.args);
  expect(taken).toContainEqual([ORG_ID, LODI_ID, "r-lodi", SHARED_SEAT]);
  expect(taken).toContainEqual([ORG_ID, ADA_ID, "r-ada"]);
  // Every read of the built-in agent's screen from this page asked for that place too.
  const asked = state.calls.filter((c) => c.method === "browser.agentHandoff" && c.args[1] === LODI_ID);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((c) => c.args[2] === SHARED_SEAT)).toBe(true);
});
