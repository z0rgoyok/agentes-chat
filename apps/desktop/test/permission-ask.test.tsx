import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PermissionNeed } from "@agenteschat/adapters/machine-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import { PERMISSION_ASK_PREF } from "../src/control/permissions";
import { DesktopStore, pairedHomes } from "../src/control/store";
import { readPref, writePref } from "../src/hooks";
import { createFakeHost, type FakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { WindowView } from "../src/WindowView";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => writePref(PERMISSION_ASK_PREF, false));

const need = (permission: PermissionNeed["permission"], trigger: string): PermissionNeed => ({
  permission,
  trigger,
  agentId: "ag_dev",
  since: "2026-11-26T18:00:00.000Z",
});

async function welcome(check: (el: HTMLElement, host: FakeHost, store: DesktopStore) => Promise<void>) {
  const host = createFakeHost("welcome", "selfhost");
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <WindowView name="welcome" />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    await until(() => pairedHomes(store.getSnapshot()).length > 0);
    await check(el, host, store);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const firstRunner = (host: FakeHost) => [...host.runners.values()][0];

test("Full Disk Access an agent's command waits on: what, why, who asked, its Settings pane; on when back, the wait ends", () =>
  welcome(async (el, host) => {
    const runner = firstRunner(host);
    host.mac.disk = false;
    await act(async () => runner?.setPermissions([need("disk", "ls ~/Desktop")]));
    writePref(PERMISSION_ASK_PREF, true);
    await act(async () => host.showWindow("welcome"));
    await until(() => el.querySelector("h1")?.textContent === "agentes.chat needs Full Disk Access");
    expect(readPref(PERMISSION_ASK_PREF, true)).toBe(false);
    const sheet = el.querySelector(".dk-fr__sheet") as HTMLElement;
    expect([...sheet.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Agents need it to open your files without macOS asking for each folder.",
      "Asked by Dev to run ls ~/Desktop",
      "In Settings, turn on agentes.chat in the list, or add it with +.",
      "When macOS asks to Quit & Reopen, choose it. agentes.chat opens again right here.",
    ]);
    // macOS says whether it is on: no "I allowed it" to press.
    expect(button(el, "I allowed it")).toBeUndefined();
    await act(async () => button(el, "Open Settings")?.click());
    expect(host.mac.panes).toEqual(["disk"]);
    // Turned on in System Settings: back in front, the wait ends here and on the server, and the sheet goes.
    host.mac.disk = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => runner?.permissions.length === 0);
    await until(() => el.querySelector("h1")?.textContent !== "agentes.chat needs Full Disk Access");
  }));

test("Automation, which macOS never tells: its pane, and I allowed it ends the wait", () =>
  welcome(async (el, host) => {
    const runner = firstRunner(host);
    await act(async () => runner?.setPermissions([need("automation", "osascript -e 'tell app \"Finder\" to quit'")]));
    writePref(PERMISSION_ASK_PREF, true);
    await act(async () => host.showWindow("welcome"));
    await until(() => el.querySelector("h1")?.textContent === "agentes.chat needs Automation");
    expect(el.textContent).toContain("Agents need it to control other apps on this Mac.");
    expect(el.textContent).not.toContain("Quit & Reopen");
    await act(async () => button(el, "Open Settings")?.click());
    expect(host.mac.panes).toEqual(["automation"]);
    await act(async () => button(el, "I allowed it")?.click());
    await until(() => runner?.permissions.length === 0);
  }));
