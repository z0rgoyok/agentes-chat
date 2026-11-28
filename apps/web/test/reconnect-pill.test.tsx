import { afterEach, expect, jest, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ConnectionStatus, RECONNECT_QUIET_MS, reconnectCause, useReconnectCause } from "@agenteschat/client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen } from "./render";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

const wait = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));
const pill = () => document.querySelector(".reconnect-pill");

test("a dropped connection shows nothing for two minutes, then the pill with its cause and one way out; it leaves on reconnect", async () => {
  const api = createFakeApi(seedState());
  const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await act(async () => sockets.last().open());
  jest.useFakeTimers();
  await act(async () => sockets.last().drop());
  await wait(119_000);
  expect(pill()).toBeNull();
  // The app's own screen stays: no offline page for a socket drop.
  expect(document.querySelector(".channel__messages")).not.toBeNull();
  await wait(1_000);
  await act(async () => {});
  expect(pill()?.textContent).toContain("O servidor não responde ou está reiniciando");
  expect(screen().getByRole("button", { name: "Tentar agora" })).not.toBeNull();
  expect(pill()?.querySelectorAll("button")).toHaveLength(1);

  // No internet on this device: said as such, read again while it shows.
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await wait(15_000);
  await act(async () => {});
  expect(pill()?.textContent).toContain("Sem internet neste aparelho");

  // Back: gone by itself.
  await act(async () => sockets.last().open());
  expect(pill()).toBeNull();
});

test("signed out while it was down: the pill says so and offers Entrar", async () => {
  const api = createFakeApi(seedState());
  const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await act(async () => sockets.last().open());
  api.account.me = async () => null;
  jest.useFakeTimers();
  await act(async () => sockets.last().drop());
  await wait(120_000);
  await act(async () => {});
  expect(pill()?.textContent).toContain("Sua sessão terminou.");
  expect(screen().getByRole("button", { name: "Entrar" })).not.toBeNull();
});

// The rule itself, shared by the web and the phone (`apps/mobile/src/features/shared/ReconnectPill.tsx`).
test("the cause: no internet on the device first, then signed out (nobody is), else the server", async () => {
  const me = async () => ({ id: "u1" });
  expect(await reconnectCause(true, me)).toBe("device");
  expect(await reconnectCause(false, async () => null)).toBe("signedOut");
  expect(await reconnectCause(false, me)).toBe("server");
  expect(
    await reconnectCause(false, async () => {
      throw new TypeError("Network request failed");
    }),
  ).toBe("server");
});

test("nothing for the first two minutes of a drop, then the cause, read again while it shows; gone once open", async () => {
  jest.useFakeTimers();
  let cause: "device" | "server" | "signedOut" = "server";
  let asked = 0;
  const check = async () => {
    asked++;
    return cause;
  };
  const view = renderHook(({ status }: { status: ConnectionStatus }) => useReconnectCause(status, check), {
    initialProps: { status: "open" as ConnectionStatus },
  });
  view.rerender({ status: "reconnecting" });
  await wait(RECONNECT_QUIET_MS - 1);
  expect(view.result.current.cause).toBeNull();
  expect(asked).toBe(0);
  await wait(1);
  expect(view.result.current.cause).toBe("server");
  cause = "device";
  await wait(15_000);
  expect(view.result.current.cause).toBe("device");
  view.rerender({ status: "open" });
  expect(view.result.current.cause).toBeNull();
  // A new drop starts its two quiet minutes over.
  view.rerender({ status: "reconnecting" });
  await wait(60_000);
  expect(view.result.current.cause).toBeNull();
});
