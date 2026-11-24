import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiProvider, type Channel, keys, useChannelName } from "@agenteschat/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";

afterEach(() => cleanup());

/** The query client tells its observers on the next turn. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

test("a row naming a channel draws again when that name changes, not at every unread count in the list", async () => {
  const qc = new QueryClient();
  const api = createFakeApi(seedState());
  const channels = await api.chat.channels(ORG_ID);
  qc.setQueryData(keys.channels(ORG_ID), channels);
  let draws = 0;
  function Row() {
    const name = useChannelName(ORG_ID, ENG_ID);
    draws++;
    return <span>{name}</span>;
  }
  const view = render(
    <QueryClientProvider client={qc}>
      <ApiProvider client={api}>
        <Row />
      </ApiProvider>
    </QueryClientProvider>,
  );
  const first = draws;
  const eng = channels.find((c) => c.id === ENG_ID)?.name;
  expect(view.container.textContent).toBe(eng ?? "");
  // A message elsewhere: the list moves, the name doesn't.
  await act(async () =>
    qc.setQueryData<Channel[]>(keys.channels(ORG_ID), (list) =>
      list?.map((c) => (c.id === GENERAL_ID ? { ...c, unreadCount: (c.unreadCount ?? 0) + 1 } : c)),
    ),
  );
  await settle();
  expect(draws).toBe(first);
  await act(async () =>
    qc.setQueryData<Channel[]>(keys.channels(ORG_ID), (list) =>
      list?.map((c) => (c.id === ENG_ID ? { ...c, name: "engenharia" } : c)),
    ),
  );
  await settle();
  expect(view.container.textContent).toBe("engenharia");
});
