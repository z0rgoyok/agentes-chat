import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/app";
import { DesktopStore } from "../src/control/store";
import { useTailnet } from "../src/hooks";
import { createFakeHost } from "../src/host/fake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => setSystemTime());

function Tailnet() {
  return <span>{useTailnet()?.state ?? "…"}</span>;
}

test("Tailscale is read as the window opens and when it comes up again, at most every 15 seconds", async () => {
  const start = new Date(2026, 10, 18, 12, 0, 0);
  setSystemTime(start);
  const host = createFakeHost("prefs", "selfhost");
  let reads = 0;
  const read = host.tailscale;
  host.tailscale = () => {
    reads++;
    return read();
  };
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <AppProvider host={host} store={new DesktopStore(host, {})}>
          <Tailnet />
        </AppProvider>,
      ),
    );
    expect(reads).toBe(1);
    // Each read runs `tailscale status`: a window brought up again and again doesn't run it each time.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads).toBe(1);
    setSystemTime(new Date(start.getTime() + 16_000));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(reads).toBe(2);
    expect(el.textContent).toBe("on");
  } finally {
    await act(async () => root.unmount());
    el.remove();
  }
});
