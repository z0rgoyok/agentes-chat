import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type ComputerDevice, type PhoneDevice } from "@agenteschat/client";
import {
  ANDROID_SLOW_MS,
  ANDROID_USB_DRIVERS,
  IPHONE_RESTART_MS,
  SETUP_STALL_MS,
} from "@agenteschat/client/lib/devices";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, fakeDevicesOf, fakeMachinesOf } from "./fake-api";
import { notification } from "./fakes/notifications";
import { ANA, acmeDevices, acmeState, BUILD_PC, IMAC, IPHONE, LIA, MAC, ORG_ID, PIXEL, RUI } from "./fixtures/devices";
import { renderApp, screen, settle, showIn } from "./render";

let home: string | undefined;
/** The address this page is open at: the desktop app takes a pair link of an https server only. */
const servedAt = (url: string) => {
  home ??= domWindow().location.href;
  domWindow().happyDOM.setURL(url);
};

afterEach(() => {
  cleanup();
  setSystemTime();
  if (home) domWindow().happyDOM.setURL(home);
});

/** Each step of a checklist: its state, and its title alone when folded. */
const stepsOf = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll(".dv-step")].map(
    (s) => `${s.getAttribute("data-state")}${s.hasAttribute("data-shut") ? " folded" : ""}`,
  );
/** The clock moves past the guide's 30 s, and the dialog's 1 s tick redraws it. */
const after30s = async () => {
  setSystemTime(new Date(Date.now() + ANDROID_SLOW_MS + 1000));
  await act(() => new Promise((r) => setTimeout(r, 1100)));
  await settle(4);
};

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** What the 2 s poll or a devices event would do: ask the server again now. */
const refetch = async (services: Awaited<ReturnType<typeof renderApp>>["services"]) => {
  await act(async () => {
    await services.queryClient.invalidateQueries({ queryKey: ["org"] });
  });
  await settle(4);
};
/** A row's ⋯ (Radix opens a menu from the keyboard here): its menu. */
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
};
const calls = (state: ReturnType<typeof acmeState>, method: string) => state.calls.filter((c) => c.method === method);

async function open(
  path: string,
  setup?: (devices: NonNullable<ReturnType<typeof fakeDevicesOf.get>>) => void,
  state = acmeState(),
) {
  const api = createFakeApi(state);
  const devices = fakeDevicesOf.get(api);
  if (!devices) throw new Error("no devices fake");
  devices.set(acmeDevices());
  fakeMachinesOf.get(api)?.setRelease({
    version: "1.8.0",
    url: "/api/desktop/download/1.8.0/agentes.dmg",
    sha256: "0".repeat(64),
    publishedAt: "2026-11-01T12:00:00.000Z",
  });
  setup?.(devices);
  const app = await renderApp(path, { api });
  await settle(6);
  await showIn(app.services, "en");
  return { ...app, state, devices, api };
}

describe("Settings › Devices", () => {
  test("old Computers links land on Devices, and so does the desktop app's ?open=devices", async () => {
    const { router } = await open(`/org/${ORG_ID}/settings/computers`);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices`);
    const asked = await open("/?open=devices");
    expect(asked.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices`);
    const old = await open(`/org/${ORG_ID}/settings/computers/${MAC}`);
    expect(old.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/${MAC}`);
  });

  test("the list: computers with their phones nested, states with their detail, whose and who can use it", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    const list = screen().getByRole("list", { name: "Devices" });
    const rows = [...list.querySelectorAll(".dv-row")];
    expect(rows.map((r) => r.querySelector(".dv-row__name")?.textContent)).toEqual([
      "Workspace computer",
      "Sam's MacBook Pro",
      "Pixel 8",
      "Sam's iPhone 16",
      "Windows build PC",
      "build-box",
      "Ana's iMac",
      "Ana's iPhone 15",
    ]);
    const pixel = rows[2] as HTMLElement;
    expect(pixel.classList.contains("dv-row--child")).toBe(true);
    expect(pixel.querySelector(".dv-status")?.textContent).toBe("In use by Lia");
    expect(pixel.querySelector(".dv-row__detail")?.textContent).toMatch(/^for Rui since /);
    expect(pixel.querySelector(".dv-row__who")?.textContent).toBe("Everyone, phone only");
    const iphone = rows[3] as HTMLElement;
    expect(iphone.querySelector(".dv-status")?.getAttribute("data-status")).toBe("needs");
    expect(iphone.querySelector(".dv-row__detail")?.textContent).toBe("Turn on Developer Mode");
    expect(iphone.querySelector(".dv-row__who")?.textContent).toBe("Same as its Mac");
    expect(rows[4]?.querySelector(".dv-status")?.textContent).toBe("Busy 1/1");
    expect(rows[4]?.querySelector(".dv-row__owner")?.textContent).toBe("Workspace");
    expect(rows[6]?.querySelector(".dv-row__detail")?.textContent).toMatch(/^last seen /);
    expect(rows[7]?.querySelector(".dv-row__detail")?.textContent).toBe("with Ana's iMac");
    // The workspace computer has no menu.
    expect(rows[0]?.querySelector(".dv-row__end button")).toBeNull();
    // A computer asking to join sits on top.
    expect(screen().getByRole("list", { name: "Asking to join" }).textContent).toContain(
      "ci-runner wants to join Acme",
    );
  });

  test("filters and search", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("radio", { name: /Phones/ }));
    const names = () =>
      [...screen().getByRole("list", { name: "Devices" }).querySelectorAll(".dv-row__name")].map((n) => n.textContent);
    expect(names()).toEqual(["Pixel 8", "Sam's iPhone 16", "Ana's iPhone 15"]);
    await click(screen().getByRole("radio", { name: /All/ }));
    const search = screen().getByRole("searchbox", { name: "Search devices" });
    await act(async () => fireEvent.change(search, { target: { value: "pixel" } }));
    await settle(2);
    expect(names()).toEqual(["Sam's MacBook Pro", "Pixel 8"]);
  });

  test("a row's menu opens with Settings, its page, for computers and phones", async () => {
    const { router } = await open(`/org/${ORG_ID}/settings/devices`);
    let menu = await openMenu(screen().getByRole("button", { name: "Sam's MacBook Pro actions" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Settings", "Rename", "Remove"]);
    await click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/${MAC}`);
    await act(() =>
      router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "devices" } }),
    );
    await settle(4);
    menu = await openMenu(screen().getByRole("button", { name: "Pixel 8 actions" }));
    expect(within(menu).getAllByRole("menuitem")[0]?.textContent).toBe("Settings");
    await click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
  });

  test("a simulator's menu: Start when it's off, Shut down once it runs, and the Mac's refusal in words", async () => {
    const sim: PhoneDevice = {
      id: "p-sim",
      platform: "ios",
      phoneKind: "simulator",
      name: "iPhone 17 Pro",
      model: "iPhone 17 Pro",
      osVersion: "26.2",
      hostMachineId: MAC,
      ownerUserId: "u-sam",
      audience: null,
      status: { kind: "offline", lastSeenAt: "2026-11-09T12:00:00.000Z" },
      transport: "local",
      lastSeenAt: "2026-11-09T12:00:00.000Z",
      mayUse: true,
      mayManage: false,
    };
    const { state, devices } = await open(`/org/${ORG_ID}/settings/devices`, (d) => {
      const list = acmeDevices();
      list.devices.find((c) => c.id === MAC)?.phones.push(sim);
      d.set(list);
    });
    let menu = await openMenu(screen().getByRole("button", { name: "iPhone 17 Pro actions" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Settings", "Start"]);
    await click(within(menu).getByRole("menuitem", { name: "Start" }));
    expect(calls(state, "devices.powerPhone").map((c) => c.args)).toEqual([[ORG_ID, "p-sim", true]]);
    expect(screen().getByText("iPhone 17 Pro is starting. It's ready in a moment.")).toBeTruthy();
    menu = await openMenu(screen().getByRole("button", { name: "iPhone 17 Pro actions" }));
    expect(within(menu).getByRole("menuitem", { name: "Shut down" })).toBeTruthy();
    // The Mac without Xcode: why, and the one way out.
    devices.client.powerPhone = async () => {
      throw new ApiError(409, "device.power_tool_missing", "", { platform: "ios", computer: "Sam's MacBook Pro" });
    };
    await click(within(menu).getByRole("menuitem", { name: "Shut down" }));
    expect(
      screen().getByText(
        "Sam's MacBook Pro needs Xcode to run simulators. Install Xcode from the App Store on that Mac.",
      ),
    ).toBeTruthy();
  });

  test("a computer's page: its system, processor, size and toolchains behind Details, closed", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      const mac = list.devices.find((d) => d.id === MAC) as ComputerDevice | undefined;
      if (!mac) throw new Error("fixture");
      Object.assign(mac, { cpus: 14, cores: 14, cpuModel: "Apple M4 Pro", system: "macOS 26.1" });
      devices.set(list);
    });
    const card = screen().getByRole("heading", { name: "Sam's MacBook Pro" }).closest(".ac-card") as HTMLElement;
    expect(card.querySelector(":scope > .dv-facts")).toBeNull();
    const more = card.querySelector("details.ac-disclosure") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")?.textContent).toBe("Details");
    const facts = [...more.querySelectorAll(".dv-facts > div")].map((f) => [
      f.querySelector("dt")?.textContent,
      f.querySelector("dd")?.textContent,
    ]);
    expect(facts.slice(0, 3)).toEqual([
      ["System", "macOS 26.1"],
      // The cores in a tooltip, and for a screen reader after the name.
      ["Processor", "Apple M4 Pro, 14 cores"],
      ["Memory", "36 GB"],
    ]);
    expect(facts[3]?.[0]).toBe("Toolchains found");
  });

  test("a computer's page from an older runner: the system's family, and the processor as its threads", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`);
    const card = screen().getByRole("heading", { name: "Sam's MacBook Pro" }).closest(".ac-card") as HTMLElement;
    const facts = [...card.querySelectorAll("details .dv-facts > div")].map((f) => f.textContent);
    expect(facts.slice(0, 2)).toEqual(["SystemmacOS", "Processor12 threads"]);
  });

  test("a computer waiting on an OS permission: what, where, the one place it is allowed, and who asked for what", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      const mac = list.devices.find((d) => d.id === MAC) as ComputerDevice | undefined;
      if (!mac) throw new Error("fixture");
      mac.permissions = [
        { permission: "disk", trigger: "ls ~/Desktop", agentId: LIA, since: "2026-11-26T18:00:00.000Z" },
        { permission: "screen", trigger: "screencapture -x screen.png", since: "2026-11-26T18:01:00.000Z" },
      ];
      devices.set(list);
    });
    const card = screen().getByRole("heading", { name: "Sam's MacBook Pro" }).closest(".ac-card") as HTMLElement;
    expect([...card.querySelectorAll(".dv-permission")].map((a) => a.textContent)).toEqual([
      "Waiting for Full Disk Access on Sam's MacBook ProAllow it in the agentes.chat app there.Asked by Lia to run ls ~/Desktop",
      "Waiting for Screen Recording on Sam's MacBook ProAllow it in the agentes.chat app there.Needed to run screencapture -x screen.png",
    ]);
  });

  test("a computer whose runner is behind this server: its owner sees why and how to update it, no one else", async () => {
    const page = async (update: "command" | "installer" | null, canManage = true) => {
      cleanup();
      const app = await open(`/org/${ORG_ID}/settings/devices/${MAC}`);
      fakeMachinesOf.get(app.api)?.pair({ id: MAC, name: "Sam's MacBook Pro", update, canManage });
      await refetch(app.services);
      return screen().getByRole("heading", { name: "Sam's MacBook Pro" }).closest(".ac-card") as HTMLElement;
    };
    const behind = "The agentes.chat program on Sam's MacBook Pro is out of date, so some things don't work there.";
    let card = await page("command");
    expect(card.textContent).toContain(`${behind} To update it, run this there:`);
    expect(card.querySelector(".machine-command code")?.textContent).toBe("agentes-runner update");
    card = await page("installer");
    expect(card.textContent).toContain(`${behind} To update it, run the install command there again, as root.`);
    expect(card.querySelector(".machine-command")).toBeNull();
    for (card of [await page(null), await page("command", false)]) {
      expect(card.textContent).not.toContain(behind);
      expect(card.querySelector(".machine-command")).toBeNull();
    }
  });

  test("a busy computer's page says its tasks at once and where that changes, for its owner or anyone else", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${BUILD_PC}`);
    expect(screen().getByText("Tasks at once here: 1. The person who connected it can change that.")).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      devices.set({
        ...list,
        devices: list.devices.map((d) =>
          d.id === MAC ? { ...d, status: { kind: "busy", running: 1, max: 1 }, maxTasks: 1 } : d,
        ),
      });
    });
    expect(screen().getByText("Tasks at once here: 1. Change it below.")).toBeTruthy();
    expect(screen().getByRole("combobox", { name: "Tasks at once" })).toBeTruthy();
  });

  test("a computer whose tasks start on room: Automatic with what fits, why it's full, and its owner's Push harder", async () => {
    const room = { more: 0, freeGb: 1.4, cpuBusy: false, pushHarder: false };
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      devices.set({
        ...list,
        devices: list.devices.map((d) =>
          d.id === MAC ? { ...d, status: { kind: "busy", running: 9, max: null }, taskRoom: room } : d,
        ),
      });
    });
    expect(screen().getByText("Busy · 9 running")).toBeTruthy();
    expect(
      screen().getByText(
        "No room for another task right now: 1.4 GB of memory free. The next one starts when one ends.",
      ),
    ).toBeTruthy();
    expect(screen().getByText("Automatic · 9 running · full for now")).toBeTruthy();
    expect(screen().queryByRole("combobox", { name: "Tasks at once" })).toBeNull();
    await click(screen().getByRole("switch", { name: "Push harder" }));
    expect(calls(state, "devices.updateComputer")[0]?.args.slice(1)).toEqual([MAC, { pushHarder: true }]);
  });

  test("a computer's phones: each state a pill alone, its detail in its tip; one that needs me opens its fix", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`);
    const list = screen().getByRole("list", { name: "Phones on this computer" });
    expect(list.querySelector(".dv-row__detail")).toBeNull();
    const [pixel, iphone] = [...list.querySelectorAll(".dv-row")] as HTMLElement[];
    const used = pixel?.querySelector(".dv-status-tip") as HTMLElement;
    expect(used.tagName).toBe("SPAN");
    expect(used.textContent).toMatch(/^In use by Lia\s*for Rui since /);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      used.focus();
    });
    expect(document.querySelector(".ac-tip")?.textContent).toMatch(/^for Rui since /);
    const fix = iphone?.querySelector("button.dv-status-tip") as HTMLButtonElement;
    expect(fix.textContent).toBe("Needs youTurn on Developer Mode");
    await click(fix);
    expect(screen().getByRole("dialog", { name: "Connect an iPhone" })).toBeTruthy();
  });

  test("Let it join, from the list: only its name before, then connected with the switch that shares it", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices`);
    const ask = screen().getByRole("list", { name: "Asking to join" });
    await click(within(ask).getByRole("button", { name: "Let it join" }));
    const dialog = screen().getByRole("dialog", { name: "ci-runner wants to join Acme" });
    expect(dialog.textContent).toContain("203.0.113.7");
    // Who can use it is asked once it's in, not before.
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Let it join" }));
    expect(calls(state, "devices.approveRequest")[0]?.args.slice(1)).toEqual([
      "r-ci",
      { name: "ci-runner", audience: { mode: "owner", userIds: [], roleIds: [] } },
    ]);
    const joined = screen().getByRole("dialog", { name: "ci-runner is connected" });
    const share = within(joined).getByRole("switch", { name: "Let the whole workspace use it" });
    expect(share.getAttribute("aria-checked")).toBe("false");
    expect(joined.textContent).toContain("Only you for now");
    await click(share);
    expect(calls(state, "devices.updateComputer").at(-1)?.args).toEqual([
      ORG_ID,
      "m-r-ci",
      { audience: { mode: "everyone", userIds: [], roleIds: [] } },
    ]);
    expect(share.getAttribute("aria-checked")).toBe("true");
    expect(joined.textContent).toContain("Everyone in Acme");
  });
});

describe("Connect a device", () => {
  test("a server: the one line, then the computer asking to join, then connected", async () => {
    const { state, devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    const chooser = screen().getByRole("dialog", { name: "Connect a device" });
    expect(chooser.textContent).toContain("Android phone");
    await click(within(chooser).getByRole("button", { name: /A server or VPS/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect a server" });
    expect(dialog.querySelector("code")?.textContent).toBe("curl -fsSL https://app.agentes.chat/i/7KQ2-M9X1 | sh");
    expect(dialog.textContent).toContain("Works once, for 10 minutes");
    expect(dialog.textContent).toContain("Waiting for the server…");
    await click(within(dialog).getByRole("radio", { name: "Windows" }));
    expect(dialog.querySelector("code")?.textContent).toBe("irm https://app.agentes.chat/i/7KQ2-M9X1/ps | iex");
    devices.setLink({ status: "asking", request: acmeDevices().requests[0] });
    await refetch(services);
    const asking = screen().getByRole("dialog", { name: "ci-runner wants to join Acme" });
    expect(within(asking).queryByRole("combobox")).toBeNull();
    await click(within(asking).getByRole("button", { name: "Let it join" }));
    // A server is everyone's by default.
    expect(calls(state, "devices.approveRequest")[0]?.args[2]).toEqual({
      name: "ci-runner",
      audience: { mode: "everyone", userIds: [], roleIds: [] },
    });
    const joined = screen().getByRole("dialog", { name: "ci-runner is connected" });
    expect(
      within(joined).getByRole("switch", { name: "Let the whole workspace use it" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(joined.textContent).toContain("Everyone in Acme");
  });

  test("the computers: this one, another one, a server or VPS", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    const computers = screen().getByRole("region", { name: "Computers" });
    expect([...computers.querySelectorAll(".ac-optrow__hit")].map((n) => n.textContent)).toEqual([
      "This computer",
      "Another computer",
      "A server or VPS",
    ]);
    // Served over plain http here: the app wouldn't take a link to it, so this computer gets its one line.
    await click(screen().getByRole("button", { name: /This computer/ }));
    const line = screen().getByRole("dialog", { name: "Connect a computer" });
    expect(within(line).queryByRole("link", { name: "Open the agentes.chat app" })).toBeNull();
  });

  test("this computer, from a browser: the app opens a link to this server, asks to join, the maker lets it in", async () => {
    servedAt("https://app.agentes.chat/");
    const { state, devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /This computer/ }));
    const dialog = screen().getByRole("dialog", { name: "This computer" });
    expect(calls(state, "devices.createLink")[0]?.args).toEqual([ORG_ID, "computer"]);
    const app = within(dialog).getByRole("link", { name: "Open the agentes.chat app" });
    expect(app.getAttribute("href")).toBe("agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=7KQ2-M9X1");
    expect(dialog.textContent).toContain("Waiting for the app on this computer…");
    expect(within(dialog).getByRole("heading", { name: "Don't have the app?" })).toBeTruthy();
    expect(dialog.textContent).toContain("After installing, press Open the agentes.chat app again.");

    devices.setLink({ status: "asking", request: acmeDevices().requests[0] });
    await refetch(services);
    const asking = screen().getByRole("dialog", { name: "ci-runner wants to join Acme" });
    await click(within(asking).getByRole("button", { name: "Let it join" }));
    // This computer is the maker's own until they share it.
    expect(calls(state, "devices.approveRequest")[0]?.args[2]).toEqual({
      name: "ci-runner",
      audience: { mode: "owner", userIds: [], roleIds: [] },
    });
  });

  test("this computer without the app: one line for its terminal, or a server's", async () => {
    servedAt("https://app.agentes.chat/");
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /This computer/ }));
    await click(screen().getByRole("button", { name: "Or paste one line in its terminal" }));
    const line = screen().getByRole("dialog", { name: "Connect a computer" });
    expect(line.querySelector("code")?.textContent).toMatch(
      /^curl -fsSL https:\/\/app\.agentes\.chat\/i\/7KQ2-M9X\d \| sh$/,
    );
    await click(within(line).getByRole("button", { name: "Back" }));
    await click(screen().getByRole("button", { name: /This computer/ }));
    await click(screen().getByRole("button", { name: "A server? Use a terminal line" }));
    expect(screen().getByRole("dialog", { name: "Connect a server" })).toBeTruthy();
  });

  test("another computer: the app on it, signed in as me, then Connected once a computer of mine shows up", async () => {
    const { devices, services, state } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /Another computer/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect another computer" });
    expect(dialog.textContent).toContain("Open it and sign in as yourself.");
    expect(dialog.textContent).toContain("Click Allow when it asks to let Acme's agents use it.");
    expect(dialog.textContent).toContain("Waiting for a computer of yours…");

    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    if (!mac) throw new Error("no Mac");
    // Someone else's new computer isn't the one this dialog waits for.
    devices.set({
      ...list,
      devices: [...list.devices, { ...mac, id: "m-ana-new", name: "Ana's laptop", ownerUserId: ANA, phones: [] }],
    });
    await refetch(services);
    expect(dialog.textContent).toContain("Waiting for a computer of yours…");
    devices.set({
      ...list,
      devices: [...list.devices, { ...mac, id: "m-sam-new", name: "Sam's Mac mini", phones: [] }],
    });
    await refetch(services);
    expect(dialog.textContent).toContain("Connected: Sam's Mac mini");
    expect(within(dialog).getByRole("link", { name: "Open its page" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/devices/m-sam-new`,
    );
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
    // Private as it joined, and one switch away from the whole workspace.
    const share = within(dialog).getByRole("switch", { name: "Let the whole workspace use it" });
    expect(share.getAttribute("aria-checked")).toBe("false");
    await click(share);
    expect(calls(state, "devices.updateComputer").at(-1)?.args).toEqual([
      ORG_ID,
      "m-sam-new",
      { audience: { mode: "everyone", userIds: [], roleIds: [] } },
    ]);
    await click(within(dialog).getByRole("button", { name: "Can't install the app on it? Use a terminal line" }));
    expect(screen().getByRole("dialog", { name: "Connect a computer" })).toBeTruthy();
  });

  test("an Android phone: the computer's live checklist, Allow on the phone, then connected", async () => {
    const { devices, services, state } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /Android phone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    // Fresh: Developer options open, the rest folded to their titles. The computer can't see it, so the person ticks it.
    expect(stepsOf(dialog)).toEqual(["current", "waiting folded", "waiting folded", "waiting folded"]);
    // A step on the phone shows its number, not the live mark: the computer isn't the one working on it.
    expect(dialog.querySelector('.dv-step[data-state="current"] .dv-step__mark')?.childElementCount).toBe(0);
    // Our phone app is in no store yet: no QR that would only open this page in the phone's browser.
    expect(dialog.querySelector(".dv-qr")).toBeNull();
    // The guide asks the computer to look for a phone it has no driver for.
    expect(calls(state, "devices.lookForPhones").at(-1)?.args).toEqual([ORG_ID, MAC]);
    await click(within(dialog).getByRole("button", { name: "Done" }));
    expect(stepsOf(dialog)).toEqual(["done folded", "current", "waiting folded", "waiting folded"]);
    // Ticked by hand: opened again from its title, it may be unticked.
    await click(within(dialog).getByRole("button", { name: "Turn on Developer options" }));
    expect(stepsOf(dialog)).toEqual(["done", "current folded", "waiting folded", "waiting folded"]);
    await click(within(dialog).getByRole("button", { name: "Not done yet" }));
    expect(stepsOf(dialog)).toEqual(["current", "waiting folded", "waiting folded", "waiting folded"]);
    await click(within(dialog).getByRole("button", { name: "Done" }));
    await click(within(dialog).getByRole("button", { name: "Done" }));
    expect(stepsOf(dialog)).toEqual(["done folded", "done folded", "current", "waiting folded"]);
    expect(dialog.textContent).toContain("Looking for a phone on Sam's MacBook Pro…");
    // Before 30 s, nothing more; no old hint behind an ⓘ.
    expect(dialog.querySelector(".dv-slow")).toBeNull();
    expect(dialog.textContent).not.toContain("Phone not showing up?");
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    const pixel = mac?.phones.find((p) => p.id === PIXEL);
    if (!mac || !pixel) throw new Error("fixture");
    mac.phones.push({
      ...pixel,
      id: "p-new",
      name: "Galaxy S24",
      status: { kind: "needs_you", reason: "unauthorized" },
    });
    devices.set(list);
    await refetch(services);
    // Seen, even before Allow: every step before it ticks by itself, and none may be unticked.
    expect(stepsOf(dialog)).toEqual(["done folded", "done folded", "done folded", "needs"]);
    await click(within(dialog).getByRole("button", { name: "Turn on Developer options" }));
    expect(within(dialog).queryByRole("button", { name: "Not done yet" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Tap Allow on the phone" }));
    const allow = dialog.querySelector('.dv-step[data-state="needs"]');
    expect(allow?.textContent).toContain("Tap Allow on the phone");
    expect(allow?.textContent).toContain("Allow USB debugging?");
    const added = mac.phones.at(-1);
    if (added) added.status = { kind: "ready" };
    devices.set(list);
    await refetch(services);
    const connected = screen().getByRole("dialog", { name: "Galaxy S24 is connected" });
    // No select on the last step: the switch, saved at once.
    expect(within(connected).queryByRole("combobox")).toBeNull();
    const share = within(connected).getByRole("switch", { name: "Let the whole workspace use it" });
    expect(share.getAttribute("aria-checked")).toBe("true");
    await click(share);
    expect(calls(state, "devices.updatePhone").at(-1)?.args).toEqual([
      ORG_ID,
      "p-new",
      { audience: { mode: "owner", userIds: [], roleIds: [] } },
    ]);
    expect(connected.textContent).toContain("Only you for now");
  });

  test("Android by cable: the phone already plugged in shows up asking, and every step before Allow is done", async () => {
    const { devices, services } = await open(`/org/${ORG_ID}/settings/devices/android-setup?computer=${MAC}`);
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    const pixel = mac?.phones.find((p) => p.id === PIXEL);
    if (!mac || !pixel) throw new Error("fixture");
    mac.phones.push({
      ...pixel,
      id: "p-new",
      name: "Galaxy S24",
      status: { kind: "needs_you", reason: "unauthorized" },
    });
    devices.set(list);
    await refetch(services);
    expect(stepsOf(dialog)).toEqual(["done folded", "done folded", "done folded", "needs"]);
    expect(dialog.querySelector('.dv-step[data-state="needs"]')?.textContent).toContain("Allow USB debugging?");
  });

  test("Android by cable on Windows: after 30 s, why a phone may not show up, the maker's USB driver included", async () => {
    const { devices, services, state } = await open(
      `/org/${ORG_ID}/settings/devices/android-setup?computer=${BUILD_PC}`,
    );
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    expect(calls(state, "devices.lookForPhones").at(-1)?.args).toEqual([ORG_ID, BUILD_PC]);
    await click(within(dialog).getByRole("button", { name: "Done" }));
    await click(within(dialog).getByRole("button", { name: "Done" }));
    await after30s();
    const help = dialog.querySelector(".dv-slow");
    expect(help?.closest(".dv-step")?.getAttribute("data-state")).toBe("current");
    expect(help?.querySelector(".dv-slow__title")?.textContent).toBe("Still not showing up?");
    expect([...(help?.querySelectorAll(".dv-slow__list > li") ?? [])].map((li) => li.textContent)).toEqual([
      "A cable that carries data. Some only charge. Or try another port.",
      "The phone unlocked, with its screen on.",
      "If the phone asks how to use USB, pick File transfer.",
      "USB debugging on. See step 2",
      "On Samsung, Auto Blocker off: Settings\u00a0›\u00a0Security and privacy\u00a0›\u00a0Auto Blocker.",
      "On Windows, the phone maker's USB driver:Google, for PixelSamsungOther makers",
    ]);
    expect([...(help?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(
      Object.values(ANDROID_USB_DRIVERS),
    );
    // See step 2 opens USB debugging again.
    await click(within(dialog).getByRole("button", { name: "See step 2" }));
    expect(stepsOf(dialog)).toEqual(["done folded", "done", "current folded", "waiting folded"]);

    // The computer finds the phone with no driver: the cable step says so, with the drivers.
    const list = acmeDevices();
    const pc = list.devices.find((d) => d.id === BUILD_PC);
    const pixel = list.devices.flatMap((d) => d.phones).find((p) => p.id === PIXEL);
    if (!pc || !pixel) throw new Error("fixture");
    pc.phones.push({
      ...pixel,
      id: "p-nodriver",
      name: "Pixel 8",
      hostMachineId: BUILD_PC,
      status: { kind: "needs_you", reason: "no_driver" },
    });
    devices.set(list);
    await refetch(services);
    expect(stepsOf(dialog)).toEqual(["done folded", "done folded", "needs", "waiting folded"]);
    const cable = dialog.querySelector('.dv-step[data-state="needs"]');
    expect(cable?.querySelector(".dv-step__text")?.textContent).toBe(
      "Windows build PC sees the phone but has no USB driver for it. Install the phone maker's driver, then plug the phone in again.",
    );
    expect(cable?.querySelectorAll(".dv-links a")).toHaveLength(3);
  });

  test("Android by cable on a Mac, in German with a long computer name: the 30 s help without a driver", async () => {
    const longName = "Sams MacBook Pro aus dem Entwicklungsbüro im dritten Stock neben der Kaffeemaschine";
    const app = await open(`/org/${ORG_ID}/settings/devices/android-setup?computer=${MAC}`, (devices) => {
      const list = acmeDevices();
      const mac = list.devices.find((d) => d.id === MAC);
      if (mac) mac.name = longName;
      devices.set(list);
    });
    await showIn(app.services, "de");
    const dialog = screen().getByRole("dialog");
    for (const _ of [1, 2]) {
      const done = dialog.querySelector<HTMLButtonElement>('.dv-step[data-state="current"] .dv-step__more .ac-btn');
      if (!done) throw new Error("no Done");
      await click(done);
    }
    await after30s();
    const items = dialog.querySelectorAll(".dv-slow__list > li");
    expect(items).toHaveLength(5);
    expect(dialog.querySelector(".dv-slow a")).toBeNull();
    expect(dialog.textContent).toContain(longName);
  });

  test("an Android phone over Wi-Fi: Android's pairing QR, the computer's live line, then connected", async () => {
    const { state, devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    const ask = async () => {
      await act(async () => {
        await services.queryClient.invalidateQueries({ queryKey: ["wifi-pair-state"] });
      });
      await refetch(services);
    };
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /Android phone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    await click(within(dialog).getByRole("radio", { name: "Over Wi-Fi" }));
    expect(calls(state, "devices.startWifiPairing")[0]?.args).toEqual([ORG_ID, MAC, {}]);
    expect(dialog.querySelector('.dv-qr svg[aria-label="QR code for Wireless debugging on the phone"]')).toBeTruthy();
    expect(dialog.querySelector('.dv-step[data-state="current"]')?.textContent).toContain(
      "Waiting for the phone to scan…",
    );
    expect(dialog.querySelector(".ac-setpath")?.textContent).toBe(
      "Developer optionsWireless debuggingPair device with QR code",
    );
    expect(dialog.querySelector('.dv-step[data-state="current"] .dv-step__title')?.textContent).toBe(
      "Scan it from Wireless debugging, not the camera",
    );
    expect(dialog.querySelector(".dv-qr")?.textContent).toBe(
      "Not with the cameraIt offers a Wi-Fi network named agentes-…, which doesn't exist. Keep the phone on the computer's Wi-Fi.",
    );
    devices.setPairing({ state: "pairing" });
    await ask();
    expect(dialog.textContent).toContain("Found a phone. Pairing…");
    expect(dialog.querySelector(".dv-qr--used")).toBeTruthy();

    // Nothing in 2 minutes: the camera or a phone off the Wi-Fi, and on a Mac its Local Network setting. Try again makes a new code.
    devices.setPairing({ state: "failed", reason: "timed_out" });
    await ask();
    const failed = dialog.querySelector('.dv-step[data-state="needs"]');
    expect(failed?.textContent).toContain(
      "No phone paired in 2 minutes. If the camera scanned the code or the phone left the Wi-Fi, put it on the same Wi-Fi as Sam's MacBook Pro and scan from Wireless debugging. On that Mac, also turn on agentes.chat in System Settings › Privacy & Security › Local Network.",
    );
    await click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(calls(state, "devices.startWifiPairing")).toHaveLength(2);

    // The six-digit way: what the phone shows, typed here.
    await click(within(dialog).getByRole("button", { name: "Use a pairing code instead" }));
    expect(calls(state, "devices.cancelWifiPairing").length).toBeGreaterThan(0);
    // No pairing QR now, and no QR into a phone app that isn't out yet: the steps take the dialog's width.
    expect(dialog.querySelector(".dv-qr")).toBeNull();
    const pairButton = within(dialog).getByRole("button", { name: "Pair" }) as HTMLButtonElement;
    expect(pairButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("IP address and port"), {
        target: { value: "192.168.1.20:37099" },
      });
      fireEvent.change(within(dialog).getByLabelText("Wi-Fi pairing code"), { target: { value: "123456" } });
    });
    await click(pairButton);
    expect(calls(state, "devices.startWifiPairing").at(-1)?.args).toEqual([
      ORG_ID,
      MAC,
      { address: "192.168.1.20:37099", code: "123456" },
    ]);
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    const pixel = mac?.phones.find((p) => p.id === PIXEL);
    if (!mac || !pixel) throw new Error("fixture");
    mac.phones.push({ ...pixel, id: "p-wifi", name: "Galaxy S24", transport: "wifi", status: { kind: "ready" } });
    devices.set(list);
    devices.setPairing({ state: "connected", phoneId: "p-wifi" });
    await ask();
    expect(screen().getByRole("dialog", { name: "Galaxy S24 is connected" })).toBeTruthy();
  });

  test("over Wi-Fi in the app on that very Mac: a Local Network failure opens that setting", async () => {
    const win = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    const asked: Record<string, unknown>[] = [];
    win.__agentesDesktop = { version: "0.8.6", platform: "mac" };
    win.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { request?: Record<string, unknown> }) => {
        if (cmd !== "this_mac" || !args.request) return {};
        asked.push(args.request);
        return args.request.kind === "status"
          ? { orgs: [{ orgId: ORG_ID, machineId: MAC, connection: "online" }], agentsHere: true }
          : {};
      },
    };
    try {
      const { devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
      await click(screen().getByRole("button", { name: "Connect a device" }));
      await click(screen().getByRole("button", { name: /Android phone/ }));
      const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
      await click(within(dialog).getByRole("radio", { name: "Over Wi-Fi" }));
      devices.setPairing({ state: "failed", reason: "same_wifi" });
      await act(async () => {
        await services.queryClient.invalidateQueries({ queryKey: ["wifi-pair-state"] });
      });
      await refetch(services);
      await click(within(dialog).getByRole("button", { name: "Open Local Network" }));
      expect(asked).toContainEqual({ kind: "privacy", pane: "network" });
      // A cause that setting has nothing to do with gets no such button.
      devices.setPairing({ state: "failed", reason: "refused" });
      await act(async () => {
        await services.queryClient.invalidateQueries({ queryKey: ["wifi-pair-state"] });
      });
      await refetch(services);
      expect(within(dialog).queryByRole("button", { name: "Open Local Network" })).toBeNull();
    } finally {
      delete win.__agentesDesktop;
      delete win.__TAURI_INTERNALS__;
    }
  });

  test("the Android steps in Portuguese: Android's own prompt, where to scan, the code way", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/android-setup?computer=${MAC}`);
    await showIn(app.services, "pt-BR");
    const dialog = screen().getByRole("dialog", { name: "Conectar um celular Android" });
    expect(within(dialog).getByRole("button", { name: "Já fiz" })).toBeTruthy();
    // A later step opens from its title, to read ahead.
    await click(within(dialog).getByRole("button", { name: "Toque em Permitir no celular" }));
    expect(dialog.textContent).toContain("Permitir a depuração USB?");
    expect(dialog.textContent).toContain("Sempre permitir neste computador");
    await click(within(dialog).getByRole("radio", { name: "Por Wi-Fi" }));
    const qr = dialog.querySelector(".dv-qr")?.textContent;
    app.devices.setPairing({ state: "failed", reason: "same_wifi" });
    await act(async () => {
      await app.services.queryClient.invalidateQueries({ queryKey: ["wifi-pair-state"] });
    });
    await settle(4);
    const failed = dialog.querySelector('.dv-step[data-state="needs"] .dv-step__head .dv-step__text')?.textContent;
    await click(within(dialog).getByRole("button", { name: "Usar um código de pareamento" }));
    expect(qr).toContain("Não pela câmera");
    expect(failed).toBe(
      "Não deu para alcançar o celular. Coloque-o no mesmo Wi-Fi que Sam's MacBook Pro. Nesse Mac, ligue também o agentes.chat em Ajustes do Sistema › Privacidade e Segurança › Rede Local.",
    );
    expect(within(dialog).getByLabelText("Endereço IP e porta")).toBeTruthy();
    expect(within(dialog).getByLabelText("Código de pareamento por Wi-Fi")).toBeTruthy();
  });

  test("an iPhone: the checklist mirrors the Mac, Developer Mode as a Settings path", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /iPhone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an iPhone" });
    const states = [...dialog.querySelectorAll(".dv-step")].map((s) => s.getAttribute("data-state"));
    expect(states).toEqual(["done", "done", "done", "done", "done", "needs", "waiting", "waiting"]);
    expect(dialog.querySelector(".ac-setpath")?.textContent).toBe("SettingsPrivacy & SecurityDeveloper Mode");
  });

  test("an iPhone: Xcode installed but not in use, fixed by the Mac behind its password, or the Terminal way", async () => {
    const blocked = (xcodeBlocked: string, manage = true) => {
      const list = acmeDevices();
      const mac = list.devices.find((d) => d.id === MAC);
      if (!mac) throw new Error("fixture");
      delete mac.toolchains.xcode;
      Object.assign(mac.toolchains, { xcodeBlocked });
      mac.mayManage = manage;
      mac.phones = mac.phones.filter((p) => p.id !== IPHONE);
      return list;
    };
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`, (devices) =>
      devices.set(blocked("command_line_tools")),
    );
    await settle(6);
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="current"], .dv-step[data-state="needs"]');
    const inStep = () => within(step() as HTMLElement);
    // The button first, saying the password window opens on that Mac; no "Install Xcode".
    expect(step()?.querySelector(".dv-step__title")?.textContent).toBe("Xcode is installed but not in use");
    expect(step()?.textContent).toContain(
      "The Mac still uses the Command Line Tools. Fixing it asks for the Mac's password, in a window that opens on that Mac.",
    );
    expect(inStep().queryByRole("link", { name: "Get Xcode" })).toBeNull();
    expect(step()?.querySelector(".machine-command")).toBeNull();
    const fixIt = inStep().getByRole("button", { name: "Fix it for me" });
    const terminal = inStep().getByRole("button", { name: "I'd rather use Terminal" });
    expect(fixIt.className).toContain("ac-btn--sm");
    expect(terminal.className).toContain("ac-btn--sm");

    // The Terminal way: one paste for both causes, and the window goes on by itself.
    await click(terminal);
    expect(step()?.querySelector(".machine-command__code")?.textContent).toBe(
      "sudo xcode-select -s /Applications/Xcode.app &&\nsudo xcodebuild -license accept &&\nsudo xcodebuild -runFirstLaunch",
    );
    expect(step()?.textContent).toContain("This window moves on by itself once the Mac is done.");
    // The command leads there: the button stays, second.
    expect(inStep().getByRole("button", { name: "Fix it for me" }).className).not.toContain("ac-btn--primary");

    // Fix it: the password window on the Mac, then the three commands, then done.
    await click(inStep().getByRole("button", { name: "Fix it for me" }));
    expect(calls(app.state, "devices.startXcodeFix").at(-1)?.args).toEqual([ORG_ID, MAC, "select"]);
    expect(step()?.textContent).toContain(
      "Type the password on Sam's MacBook Pro. macOS opened its window on that Mac's screen.",
    );
    // A picture of that window, with the words macOS shows, so it's no surprise on the Mac.
    expect(step()?.querySelector(".dv-mac-ask")?.textContent).toContain(
      "agentes.chat wants to put Xcode in use to connect iPhones.",
    );
    await click(inStep().getByRole("button", { name: "Cancel" }));
    expect(calls(app.state, "devices.cancelXcodeFix")).toHaveLength(1);
    expect(step()?.textContent).toContain("The password wasn't typed on Sam's MacBook Pro. Nothing changed.");
    expect(inStep().getByRole("button", { name: "Try again" })).toBeTruthy();
    app.devices.setXcodeFix({ fix: { kind: "select", state: "running", step: 1 } });
    await refetch(app.services);
    expect(step()?.textContent).toContain("Fixing Xcode on Sam's MacBook Pro. It takes about a minute.");
    expect(
      [...(step()?.querySelectorAll(".dv-fix-phases > li") ?? [])].map((l) => l.hasAttribute("data-done")),
    ).toEqual([true, false, false]);
    // The Mac's own error line, however long and unbroken, wraps inside the step.
    const long = `xcodebuild:/Applications/Xcode.app/Contents/Developer/${"Platforms/".repeat(20)}error-69`;
    app.devices.setXcodeFix({ fix: { kind: "select", state: "failed", step: 1, message: long } });
    await refetch(app.services);
    expect(step()?.textContent).toContain(`Couldn't fix it on Sam's MacBook Pro: ${long}`);
    // Every command ran, yet the Mac still reports Xcode blocked: why, the command and Try again.
    app.devices.setXcodeFix({ fix: { kind: "select", state: "failed", step: 3, still: "command_line_tools" } });
    await refetch(app.services);
    expect(step()?.textContent).toContain(
      "The fix ran, but the Mac still uses the Command Line Tools. Try again, or run this in Terminal",
    );
    expect(step()?.querySelector(".machine-command__code")?.textContent).toContain("sudo xcode-select -s");
    expect(inStep().getByRole("button", { name: "Try again" }).className).toContain("ac-btn--sm");
    await click(inStep().getByRole("button", { name: "Try again" }));
    expect(calls(app.state, "devices.startXcodeFix").at(-1)?.args).toEqual([ORG_ID, MAC, "select"]);

    // A Mac whose app is too old: update it, or the command.
    app.devices.setXcodeFix({ fix: null, update: true });
    await refetch(app.services);
    expect(step()?.textContent).toContain("Update the agentes.chat app on Sam's MacBook Pro to fix it with one click.");
    expect(step()?.querySelector(".machine-command")).toBeTruthy();
    expect(inStep().queryByRole("button", { name: "Fix it for me" })).toBeNull();

    // Someone who doesn't manage the Mac: the cause and the command, no button.
    app.devices.setXcodeFix({ fix: null });
    app.devices.set(blocked("license", false));
    await refetch(app.services);
    expect(step()?.textContent).toContain(
      "Xcode on Sam's MacBook Pro waits for its license to be accepted. Run this in Terminal",
    );
    expect(inStep().queryByRole("button", { name: "Fix it for me" })).toBeNull();
  });

  test("an iPhone: each state has its way out, an old one ends the guide, a still step says why", async () => {
    type Status = PhoneDevice["status"];
    /** The fixture with Sam's iPhone in `status` (null: unplugged) and the Mac's toolchains topped up. */
    const iphoneAs = (status: Status | null, over: Partial<PhoneDevice> = {}, tools: Record<string, string> = {}) => {
      const list = acmeDevices();
      const mac = list.devices.find((d) => d.id === MAC);
      const iphone = mac?.phones.find((p) => p.id === IPHONE);
      if (!mac || !iphone) throw new Error("fixture");
      Object.assign(mac.toolchains, tools);
      if (status) Object.assign(iphone, { status, ...over });
      else mac.phones = mac.phones.filter((p) => p.id !== IPHONE);
      return list;
    };
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`);
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="current"], .dv-step[data-state="needs"]');
    const show = async (list: ReturnType<typeof acmeDevices>) => {
      app.devices.set(list);
      await refetch(app.services);
    };
    const team = { appleTeam: "Sam Rivera (Personal Team)" };

    await show(iphoneAs({ kind: "needs_you", reason: "ui_not_authorized" }));
    expect(step()?.textContent).toContain("Turn on UI Automation");
    expect(step()?.textContent).toContain("Agents see the iPhone's screen, but iOS refuses their taps.");

    await show(iphoneAs({ kind: "needs_you", reason: "xcode_too_old" }, {}, { xcodeSdk: "26.2" }));
    expect(step()?.textContent).toContain(
      "Sam's iPhone 16 runs iOS 27.1 and Xcode on Sam's MacBook Pro knows iOS 26.2 at most. Install Xcode 27, then run this in Terminal.",
    );
    expect(step()?.querySelector(".machine-command__code")?.textContent).toBe("xcrun devicectl manage ddis update");
    // Or the Mac gets them itself: no password, and the step says it's under way.
    await click(within(step() as HTMLElement).getByRole("button", { name: "Update it for me" }));
    expect(calls(app.state, "devices.startXcodeFix").at(-1)?.args).toEqual([ORG_ID, MAC, "update"]);
    expect(step()?.textContent).toContain("Updating Xcode on Sam's MacBook Pro.");

    // Below iOS 17: the guide ends at being connected, says why, and nothing spins.
    await show(iphoneAs({ kind: "unsupported", reason: "os_too_old" }, { osVersion: "16.7.10" }));
    expect(step()?.textContent).toContain("Sam's iPhone 16 runs iOS 16.7.10, and agents need iOS 17 or newer.");
    expect(dialog().querySelector(".dv-step__mark .ac-pixspin")).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Done" })).toBeNull();
    // devicectl names no version for some of them.
    await show(iphoneAs({ kind: "unsupported", reason: "os_too_old" }, { osVersion: "" }));
    expect(step()?.textContent).toContain("Sam's iPhone 16 runs iOS 16 or older, and agents need iOS 17 or newer.");

    // Xcode lists an account that shows no team yet: how to get one, not "sign in".
    await show(iphoneAs(null, {}, { appleAccount: "no_team" }));
    expect(step()?.textContent).toContain("Apple Account in Xcode");
    expect(step()?.textContent).toContain("Xcode is signed in but shows no team yet.");

    // Plugged in, the Mac sees no iPhone: what to check, at once.
    await show(iphoneAs(null, {}, team));
    expect(step()?.getAttribute("data-state")).toBe("current");
    await click(within(step() as HTMLElement).getByRole("button", { name: "It's plugged in" }));
    expect(step()?.querySelector(".dv-step__stall")?.textContent).toBe(
      "Sam's MacBook Pro doesn't see an iPhone yet. Use a cable that carries data, not only power, unlock the iPhone and tap Trust if it asks.",
    );

    // The Mac builds the helper: 45 s with nothing new, and it says what that waits for.
    await show(iphoneAs({ kind: "preparing", reason: "helper_missing" }, {}, team));
    expect(step()?.textContent).toContain("Test helper");
    expect(step()?.querySelector(".dv-step__stall")).toBeNull();
    try {
      setSystemTime(new Date(Date.now() + 46_000));
      await refetch(app.services);
      expect(step()?.querySelector(".dv-step__stall")?.textContent).toContain(
        "Sam's MacBook Pro builds the test helper and starts it on the iPhone",
      );
    } finally {
      setSystemTime();
    }
  });
});

describe("an iPhone at Developer Mode", () => {
  /** The fixture with Sam's iPhone at Developer Mode (gone: unplugged or restarting), and the Mac's app as given. */
  const devMode = (gone = false, mac: Partial<ComputerDevice> = {}) => {
    const list = acmeDevices();
    const host = list.devices.find((d) => d.id === MAC);
    if (!host) throw new Error("fixture");
    Object.assign(host, mac);
    Object.assign(host.toolchains, { appleTeam: "Sam Rivera (Personal Team)" });
    if (gone) host.phones = host.phones.filter((p) => p.id !== IPHONE);
    return list;
  };

  test("restarting stays on the step and says what to do once it's back; check again asks the Mac", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`, (d) => d.set(devMode()));
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="current"], .dv-step[data-state="needs"]');
    const show = async (list: ReturnType<typeof acmeDevices>) => {
      app.devices.set(list);
      await refetch(app.services);
    };
    expect(step()?.querySelector(".dv-step__title")?.textContent).toBe("Turn on Developer Mode");
    // Check again: the Mac looks now, and the button waits for its answer.
    await click(within(step() as HTMLElement).getByRole("button", { name: "I turned it on, check again" }));
    expect(calls(app.state, "devices.lookForPhones").at(-1)?.args).toEqual([ORG_ID, MAC]);
    expect(step()?.textContent).toContain("The iPhone still says Developer Mode is off.");

    // The iPhone restarts and leaves the Mac's list: the step stays, under way, and nothing asks for the cable.
    await show(devMode(true));
    expect(stepsOf(dialog())).toEqual(["done", "done", "done", "done", "done", "current", "waiting", "waiting"]);
    expect(step()?.textContent).toContain("The iPhone is restarting. When it's back, unlock it and tap Turn On.");
    expect(dialog().textContent).not.toContain("Plug the iPhone into");
    // Back, and the mode still off: unlock it and tap Turn On.
    await show(devMode());
    expect(step()?.getAttribute("data-state")).toBe("needs");
    expect(step()?.textContent).toContain("The iPhone is back. Unlock it, tap Turn On and enter your passcode.");
    // Gone for longer than a restart takes: unplugged, and the guide asks for the cable again.
    await show(devMode(true));
    try {
      setSystemTime(new Date(Date.now() + IPHONE_RESTART_MS + 1000));
      await act(() => new Promise((r) => setTimeout(r, 150)));
      await refetch(app.services);
      expect(step()?.querySelector(".dv-step__title")?.textContent).toBe("iPhone connected");
    } finally {
      setSystemTime();
    }
  });

  test("no switch there: why, each with its one way out, on its own or when asked", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`, (d) => d.set(devMode()));
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="needs"]') as HTMLElement;
    const causes = () => [...step().querySelectorAll(".dv-slow__list > li")].map((li) => li.textContent);
    expect(step().querySelector(".dv-step__stall")).toBeNull();
    expect(causes()).toEqual([]);
    await click(within(step()).getByRole("button", { name: "Don't see the option?" }));
    expect(causes()).toEqual([
      "The iPhone hides the option until Xcode asks to show it.Open Xcode",
      "Turned it on and the iPhone restarted? Unlock it. The alert with Turn On shows only after that.",
    ]);
    // The cause with an action makes one action line; the unlock cause is checked by the step's one check button.
    expect(step().querySelectorAll(".dv-slow__list .ac-actline")).toHaveLength(1);
    expect(step().querySelectorAll(".dv-slow__list button")).toHaveLength(1);
    await click(within(step()).getByRole("button", { name: "I turned it on, check again" }));
    expect(calls(app.state, "devices.lookForPhones")).toHaveLength(1);

    // A Mac whose app is too old: open Xcode there by hand, and update the app (or the Terminal way).
    app.devices.set(devMode(false, { opensXcode: false }));
    await refetch(app.services);
    expect(causes()[0]).toBe(
      "The iPhone hides the option until Xcode asks to show it. Open Xcode on Sam's MacBook Pro with the iPhone plugged in.",
    );
    expect(causes()[2]).toContain("The agentes.chat app on Sam's MacBook Pro is out of date.");
    expect(within(step()).getByRole("link", { name: "Download the app" }).getAttribute("href")).toContain("/download");
    expect(step().querySelector(".dv-slow__list .machine-command__code")?.textContent).toBe("agentes-runner update");

    app.devices.set(devMode());
    await refetch(app.services);
    await click(within(step()).getByRole("button", { name: "Open Xcode" }));
    expect(calls(app.state, "devices.openXcode").at(-1)?.args).toEqual([ORG_ID, MAC]);
    expect(causes()[0]).toBe(
      "Xcode opened on Sam's MacBook Pro. Look in the iPhone's Settings again, then close Xcode.",
    );
  });

  test("the causes open by themselves once the step sits unchanged", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`, (d) => d.set(devMode()));
    const step = () =>
      screen().getByRole("dialog", { name: "Connect an iPhone" }).querySelector('.dv-step[data-state="needs"]');
    try {
      setSystemTime(new Date(Date.now() + SETUP_STALL_MS + 1000));
      await refetch(app.services);
      expect(step()?.querySelector(".dv-slow__title")?.textContent).toBe("Don't see the option?");
      expect(step()?.querySelector(".dv-step__stall")).toBeNull();
    } finally {
      setSystemTime();
    }
  });
});

/** An iPhone on Sam's MacBook Pro's Wi-Fi that trusts it, every identifier made up. */
const NEARBY = { serial: "00008120-000A1B2C3D4E5F60", model: "iPhone 14", name: "Ana's iPhone 14", osVersion: "27.0" };

/** The fixture with Sam's iPhone over Wi-Fi in `status` (null: none on the Mac), and Xcode's team found. */
const wifiIphoneAs = (status: PhoneDevice["status"] | null, name = "Sam's iPhone 16") => {
  const list = acmeDevices();
  const mac = list.devices.find((d) => d.id === MAC);
  const iphone = mac?.phones.find((p) => p.id === IPHONE);
  if (!mac || !iphone) throw new Error("fixture");
  mac.toolchains.appleTeam = "Sam Rivera (Personal Team)";
  if (status) Object.assign(iphone, { status, transport: "wifi", name });
  else mac.phones = mac.phones.filter((p) => p.id !== IPHONE);
  return list;
};

describe("iPhones over Wi-Fi", () => {
  test("the guide offers an iPhone on the Mac's Wi-Fi that trusts it, picked with Use over Wi-Fi", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`, (devices) => {
      devices.set(wifiIphoneAs(null));
      devices.setWifi(MAC, [NEARBY]);
    });
    await settle(6);
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="current"], .dv-step[data-state="needs"]');
    expect(step()?.textContent).toContain("iPhone connected");
    const offer = within(step() as HTMLElement).getByRole("list", {
      name: "iPhones on the Wi-Fi of Sam's MacBook Pro",
    });
    expect(offer.textContent).toContain("Also on this Mac's Wi-Fi: Ana's iPhone 14");
    // Never used before it's picked: nothing asks the Mac to.
    expect(calls(app.state, "devices.pickIphoneOverWifi")).toEqual([]);
    await click(within(offer).getByRole("button", { name: "Use over Wi-Fi" }));
    expect(calls(app.state, "devices.pickIphoneOverWifi")[0]?.args).toEqual([ORG_ID, MAC, NEARBY.serial]);
    await refetch(app.services);
    expect(dialog().querySelector(".dv-wifi")).toBeNull();
    expect(step()?.textContent).toContain("Test helper");
  });

  test("an iPhone used over Wi-Fi: each state says why and the way out", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/iphone-setup?computer=${MAC}`);
    const dialog = () => screen().getByRole("dialog", { name: "Connect an iPhone" });
    const step = () => dialog().querySelector('.dv-step[data-state="current"], .dv-step[data-state="needs"]');
    const show = async (status: PhoneDevice["status"]) => {
      app.devices.set(wifiIphoneAs(status));
      await refetch(app.services);
    };
    await show({ kind: "needs_you", reason: "wifi_away" });
    expect(step()?.textContent).toContain(
      "Sam's iPhone 16 isn't on the Mac's Wi-Fi now. Join the same network on the iPhone, or plug it in.",
    );
    // A while on, no advice about the cable joins it.
    try {
      setSystemTime(new Date(Date.now() + 46_000));
      await refetch(app.services);
      expect(step()?.querySelector(".dv-step__stall")).toBeNull();
    } finally {
      setSystemTime();
    }
    await show({ kind: "needs_you", reason: "wifi_asleep" });
    expect(step()?.textContent).toContain("Sam's iPhone 16 didn't answer over Wi-Fi. Wake and unlock it");
    await show({ kind: "needs_you", reason: "tunnel_down" });
    expect(step()?.textContent).toContain("The Wi-Fi link to Sam's iPhone 16 dropped.");
    await show({ kind: "needs_you", reason: "wifi_untrusted" });
    expect(step()?.textContent).toContain("Trust this Mac");
    expect(step()?.textContent).toContain("Sam's iPhone 16 doesn't trust this Mac. Plug it in once, tap Trust");
  });

  test("the Mac's page offers it too, in German with a long name, and the list row says Wi-Fi", async () => {
    const long = { ...NEARBY, name: "Das iPhone von Maximiliane Schwarzenberger-Wittelsbach" };
    const app = await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      devices.set(wifiIphoneAs({ kind: "ready" }));
      devices.setWifi(MAC, [long]);
    });
    await settle(6);
    expect(document.querySelector(".dv-wifi")?.textContent).toContain(`Also on this Mac's Wi-Fi: ${long.name}`);
    expect(document.querySelector(".dv-list")?.textContent).toContain("iOS 27.1 · Wi-Fi");
    await showIn(app.services, "de");
    await settle(4);
    expect(document.querySelector(".dv-wifi button")?.textContent).not.toBe("Use over Wi-Fi");
    await showIn(app.services, "ru");
    await settle(4);
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("its page: connected over Wi-Fi, and Stop using over Wi-Fi lets it go after one confirmation", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/phones/${IPHONE}`, (devices) =>
      devices.set(wifiIphoneAs({ kind: "ready" })),
    );
    expect(document.querySelector(".dv-facts")?.textContent).toContain("ConnectionWi-Fi");
    await click(screen().getByRole("button", { name: "Stop using over Wi-Fi" }));
    const dialog = screen().getByRole("dialog", { name: "Stop using Sam's iPhone 16 over Wi-Fi?" });
    expect(dialog.textContent).toContain("Agents can't reach it any more. Pick it again on its Mac to use it.");
    await click(within(dialog).getByRole("button", { name: "Stop using over Wi-Fi" }));
    expect(calls(state, "devices.forgetPhone")[0]?.args).toEqual([ORG_ID, IPHONE]);
  });
});

describe("A device's page", () => {
  test("a phone in use: Stop, and who can use it", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
    // The pill sits in the header's chips, after its owner's; the line under them says the rest.
    expect(document.querySelector(".dv-headchips")?.textContent).toContain("In use by Lia");
    const line = document.querySelector(".dv-statusline");
    expect(line?.textContent).toContain("Recording a test video");
    await click(within(line as HTMLElement).getByRole("button", { name: "Stop" }));
    expect(calls(state, "devices.stopPhone")[0]?.args).toEqual([ORG_ID, PIXEL]);
  });

  test("a phone's screen: watched while Lia uses it, taken by its owner, input as frames, given back", async () => {
    const drawn = globalThis.createImageBitmap;
    globalThis.createImageBitmap = (async () => ({ width: 1080, height: 2400, close() {} })) as never;
    try {
      const { sockets } = await open(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
      const screens = () => sockets.sockets.filter((s) => s.url.includes("/api/phone-screen"));
      const watch = screens().at(-1);
      expect(watch?.url).toContain(`phoneId=${PIXEL}&mode=watch`);
      const card = screen().getByRole("region", { name: "Screen" });
      expect(card.textContent).toContain("Lia is using it for Rui");
      expect(card.textContent).toContain("Taking control pauses Lia until you give it back.");
      expect(within(card).queryByRole("button", { name: "Take control" })).toBeNull();
      // Its first picture: live, acknowledged, and Take control shows.
      const picture = async (s: (typeof sockets.sockets)[number]) => {
        await act(async () => {
          s.onmessage?.({ data: new ArrayBuffer(8) });
        });
        await settle(4);
      };
      await act(async () => watch?.open());
      await picture(watch as (typeof sockets.sockets)[number]);
      expect(watch?.sent).toEqual([{ type: "ack" }]);
      await click(within(card).getByRole("button", { name: "Take control" }));
      expect(watch?.closed).toBe(true);
      const control = screens().at(-1) as (typeof sockets.sockets)[number];
      expect(control.url).toContain("mode=control");
      await act(async () => control.open());
      // Nothing of its own until its first picture: opening, and no input goes anywhere yet.
      expect(card.textContent).toContain("Opening the screen…");
      expect(card.textContent).not.toContain("You're in control");
      await picture(control);
      expect(card.textContent).toContain("You're in control");
      const canvas = card.querySelector("canvas") as HTMLCanvasElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 }) as DOMRect;
      await act(async () => {
        fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, button: 0 });
        fireEvent.pointerUp(canvas, { clientX: 50, clientY: 50, button: 0 });
      });
      const stage = screen().getByRole("application", { name: "Pixel 8's screen, live" });
      await act(async () => {
        fireEvent.keyDown(stage, { key: "a" });
        fireEvent.keyDown(stage, { key: "Enter" });
      });
      await click(within(card).getByRole("button", { name: "Home" }));
      expect(control.sent).toEqual([
        { type: "ack" },
        { type: "tap", x: 0.5, y: 0.25 },
        { type: "text", text: "a" },
        { type: "key", key: "enter" },
        { type: "key", key: "home" },
      ]);
      await click(within(card).getByRole("button", { name: "Give back" }));
      expect(control.closed).toBe(true);
      expect(screens().at(-1)?.url).toContain("mode=watch");
    } finally {
      globalThis.createImageBitmap = drawn;
    }
  });

  test("control that doesn't start in its wait goes back to watching, says why, and Take control is there again", async () => {
    const drawn = globalThis.createImageBitmap;
    globalThis.createImageBitmap = (async () => ({ width: 1080, height: 2400, close() {} })) as never;
    try {
      const { sockets } = await open(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
      const screens = () => sockets.sockets.filter((s) => s.url.includes("/api/phone-screen"));
      const card = screen().getByRole("region", { name: "Screen" });
      const watch = screens().at(-1) as (typeof sockets.sockets)[number];
      await act(async () => watch.open());
      await act(async () => {
        watch.onmessage?.({ data: new ArrayBuffer(8) });
      });
      await settle(4);
      await click(within(card).getByRole("button", { name: "Take control" }));
      const control = screens().at(-1) as (typeof sockets.sockets)[number];
      await act(async () => control.open());
      expect(card.textContent).toContain("Opening the screen…");
      // The server's wait ran out before any picture: no new control socket behind the same spinner.
      await act(async () => control.drop(4408));
      await settle(4);
      expect(document.body.textContent).toContain(
        "Control didn't start in time. Sam's MacBook Pro is still getting Pixel 8 ready: try again in a minute.",
      );
      expect(screens().at(-1)?.url).toContain("mode=watch");
      expect(screens().filter((s) => s.url.includes("mode=control"))).toHaveLength(1);
    } finally {
      globalThis.createImageBitmap = drawn;
    }
  });

  test("an iPhone follows its Mac", async () => {
    await open(`/org/${ORG_ID}/settings/devices/phones/${IPHONE}`);
    expect(document.querySelector(".settings-rows")?.textContent).toContain("Same as Sam's MacBook Pro");
  });

  test("a brought computer offline for a known cause: plain words, the command only under Technical details", async () => {
    const page = async (app: boolean) => {
      cleanup();
      const opened = await open(`/org/${ORG_ID}/settings/devices/${IMAC}`, (devices) => {
        const list = acmeDevices();
        const imac = list.devices.find((d) => d.id === IMAC);
        if (imac?.status.kind !== "offline") throw new Error("fixture");
        imac.status = { ...imac.status, cause: "stopped" };
        devices.set(list);
      });
      fakeMachinesOf.get(opened.api)?.pair({ id: IMAC, name: "Ana's iMac", os: "linux", app, canManage: true });
      await refetch(opened.services);
      return opened;
    };
    const line = () => document.querySelector(".dv-statusline__text")?.textContent ?? "";
    const tech = () =>
      [...document.querySelectorAll("details.ac-disclosure")].find(
        (d) => d.querySelector("summary")?.textContent === "Technical details",
      );
    await page(true);
    expect(line()).toMatch(/^The agentes\.chat app stopped on this computer at .+\. Open the app again\.$/);
    expect(tech()).toBeUndefined();
    const app = await page(false);
    expect(line()).toMatch(/^agentes\.chat stopped on this computer at .+\. Start it again there\.$/);
    expect(line()).not.toContain("runner");
    const folded = tech() as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.textContent).toContain("To see why, run this on it:");
    expect(folded.querySelector(".machine-command code")?.textContent).toBe("agentes-runner doctor");
    // The longest translation says it in its words, with no command and no backticks in the line.
    await showIn(app.services, "ru");
    await settle(4);
    expect(line()).not.toContain("`");
    expect(line()).not.toContain("agentes-runner");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("a computer moving to another server: moving on its pill and its line, never offline", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`, (devices) => {
      const list = acmeDevices();
      const imac = list.devices.find((d) => d.id === IMAC);
      if (!imac) throw new Error("fixture");
      imac.status = { kind: "moving", since: new Date(Date.now() - 5 * 60_000).toISOString() };
      devices.set(list);
    });
    const line = document.querySelector(".dv-statusline__text");
    expect(line?.textContent).toContain("Moving to a new server… back in a few minutes");
    expect(document.body.textContent).toContain("Moving servers");
    expect(line?.textContent).not.toContain("offline");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("a computer we restarted because it stopped answering: restarting, about when it is back, why behind its ⓘ", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`, (devices) => {
      const list = acmeDevices();
      const imac = list.devices.find((d) => d.id === IMAC);
      if (!imac) throw new Error("fixture");
      const since = new Date(Date.now() - 60_000).toISOString();
      const maintenance = {
        kind: "restarting",
        since,
        eta: new Date(Date.now() + 2 * 60_000 + 10_000).toISOString(),
        detail: "unresponsive",
        away: true,
      };
      imac.status = { kind: "moving", since, maintenance };
      imac.maintenance = maintenance;
      devices.set(list);
    });
    const line = document.querySelector(".dv-statusline__text");
    expect(line?.textContent).toContain("Restarting… back in about 2 min");
    expect(document.body.textContent).toContain("Restarting");
    expect(document.body.textContent).toContain("It stopped answering, so we restarted it automatically.");
    expect(document.body.textContent).toContain("Messages to its agents wait and go on by themselves when it's back.");
    expect(line?.textContent).not.toMatch(/offline/i);
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("a computer's typed name in the line stays as typed: its backticks and asterisks mark nothing", async () => {
    const name = "Ana's `iMac` **<b>2</b>**";
    await open(`/org/${ORG_ID}/settings/devices/phones/p-ana-iphone`, (devices) => {
      const list = acmeDevices();
      const imac = list.devices.find((d) => d.id === IMAC);
      if (!imac) throw new Error("fixture");
      imac.name = name;
      devices.set(list);
    });
    const line = document.querySelector(".dv-statusline__text");
    expect(line?.textContent).toContain(`${name} is offline.`);
    expect(line?.querySelector("code, b")).toBeNull();
  });

  test("help on someone's computer: one switch an admin may turn off, never on, and the workspace's switch wins", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${IMAC}`);
    const help = screen().getByRole("switch", { name: "Help when the team's computer is full or away" });
    expect(help.getAttribute("aria-checked")).toBe("true");
    expect(screen().queryByRole("switch", { name: "Other people's agents can think here" })).toBeNull();
    await click(help);
    await settle(4);
    expect(calls(state, "devices.updateComputer").map((c) => c.args.at(-1))).toEqual([{ spill: { own: false } }]);
  });

  test("its owner makes one choice for its help: never, only as backup, or first for their own agents' work", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${MAC}`);
    expect(screen().queryByRole("switch", { name: "Help when the team's computer is full or away" })).toBeNull();
    const use = screen().getByRole("combobox", { name: "How it helps your agents" });
    expect(use.textContent).toBe("Only as backup");
    use.focus();
    await act(async () => fireEvent.keyDown(use, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Doesn't help", "Only as backup", "First for my agents"]);
    await click(screen().getByRole("option", { name: "First for my agents" }));
    await settle(4);
    expect(calls(state, "devices.updateComputer").map((c) => c.args.at(-1))).toEqual([
      { spill: { own: true, first: true } },
    ]);
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("someone else's computer: no choice to use it for the viewer's agents' work", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`);
    expect(screen().queryByRole("combobox", { name: "How it helps your agents" })).toBeNull();
  });

  test("agents use this computer's internet: on, says which computer they use now, picks this one, turns off", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      for (const d of list.devices) {
        if (d.id === MAC) d.shareInternet = { on: true, inUse: false };
        if (d.id === IMAC) d.shareInternet = { on: true, inUse: true };
      }
      devices.set(list);
    });
    expect(screen().getByText("Agents use Ana's iMac now")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Use this one" }));
    await settle(4);
    const internet = screen().getByRole("switch", { name: "Agents use this computer's internet" });
    expect(internet.getAttribute("aria-checked")).toBe("true");
    await click(internet);
    await settle(4);
    expect(calls(state, "devices.updateComputer").map((c) => c.args.at(-1))).toEqual([
      { shareInternet: true },
      { shareInternet: false },
    ]);
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("use only this computer's internet: nested under the switch while it lends, its owner's to turn on", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      for (const d of list.devices) if (d.id === MAC) d.shareInternet = { on: true, inUse: true, only: false };
      devices.set(list);
    });
    const only = screen().getByRole("switch", { name: "Use only this computer's internet" });
    expect(only.getAttribute("aria-checked")).toBe("false");
    expect(only.closest(".settings-row")?.classList.contains("settings-row--nested")).toBe(true);
    await click(only);
    await settle(4);
    expect(
      screen().getByRole("switch", { name: "Use only this computer's internet" }).getAttribute("aria-checked"),
    ).toBe("true");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
    // Lending off: the choice under it goes with it.
    await click(screen().getByRole("switch", { name: "Agents use this computer's internet" }));
    await settle(4);
    expect(screen().queryByRole("switch", { name: "Use only this computer's internet" })).toBeNull();
    expect(calls(state, "devices.updateComputer").map((c) => c.args.at(-1))).toEqual([
      { internetOnly: true },
      { shareInternet: false },
    ]);
  });

  test("an older server with no such choice shows none", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${MAC}`, (devices) => {
      const list = acmeDevices();
      for (const d of list.devices) if (d.id === MAC) d.shareInternet = { on: true, inUse: true };
      devices.set(list);
    });
    expect(screen().getByRole("switch", { name: "Agents use this computer's internet" })).toBeTruthy();
    expect(screen().queryByRole("switch", { name: "Use only this computer's internet" })).toBeNull();
  });

  test("on a self-hosted server: a computer that joins hears it will lend its internet, with no workspace computer", async () => {
    const line = "The agents will also go online through this computer's internet";
    // No workspace computer: nothing borrows where the server lends none (the Cloud's rule).
    const own = () => {
      const list = acmeDevices();
      return { ...list, devices: list.devices.filter((d) => d.machineKind !== "managed") };
    };
    await open(`/org/${ORG_ID}/settings/devices`, (devices) => devices.set({ ...own(), lendsInternet: false }));
    await click(
      within(screen().getByRole("list", { name: "Asking to join" })).getByRole("button", { name: "Let it join" }),
    );
    expect(screen().getByRole("dialog", { name: "ci-runner wants to join Acme" }).textContent).not.toContain(line);
    cleanup();
    await open(`/org/${ORG_ID}/settings/devices`, (devices) => devices.set({ ...own(), lendsInternet: true }));
    await click(
      within(screen().getByRole("list", { name: "Asking to join" })).getByRole("button", { name: "Let it join" }),
    );
    expect(screen().getByRole("dialog", { name: "ci-runner wants to join Acme" }).textContent).toContain(line);
  });

  test("this server's own computer says, on its page, whose internet its agents use (ADR 0237)", async () => {
    const state = acmeState();
    const api = createFakeApi(state);
    const host = fakeMachinesOf.get(api)?.pair({
      name: "Rented VPS",
      kind: "host",
      online: true,
      egressVia: { machineId: MAC, name: "Sam's MacBook", userName: "Sam Rivera" },
    });
    if (!host) throw new Error("no machines fake");
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC) as ComputerDevice;
    list.devices.push({
      ...mac,
      id: host.id,
      machineKind: "host",
      name: "Rented VPS",
      phones: [],
      shareInternet: null,
    });
    fakeDevicesOf.get(api)?.set(list);
    const app = await renderApp(`/org/${ORG_ID}/settings/devices/${host.id}`, { api });
    await settle(6);
    await showIn(app.services, "en");
    expect(domWindow().document.body.textContent).toContain("Agents use the internet of Sam's MacBook");
    expect(domWindow().document.querySelector('[title="Connected by Sam Rivera"]')?.textContent).toBe("Sam's MacBook");
  });

  test("someone else's computer that lends its internet: an admin may turn it off, never on", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`, (devices) => {
      const list = acmeDevices();
      for (const d of list.devices) if (d.id === IMAC) d.shareInternet = { on: false, inUse: false };
      devices.set(list);
    });
    const internet = screen().getByRole("switch", { name: "Agents use this computer's internet" });
    expect(internet.getAttribute("aria-checked")).toBe("false");
    expect(internet.hasAttribute("disabled")).toBe(true);
    expect(screen().queryByRole("button", { name: "Use this one" })).toBeNull();
  });

  test("an admin turns every computer's help off for the workspace from the devices list", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices`);
    const all = screen().getByRole("switch", { name: "Computers help when the team's is full or away" });
    expect(all.getAttribute("aria-checked")).toBe("true");
    await click(all);
    await settle(4);
    expect(calls(state, "devices.setHelp").map((c) => c.args.at(-1))).toEqual([false]);
    expect(all.getAttribute("aria-checked")).toBe("false");
  });

  test("Only some people or roles: the picker opens with nobody yet, and the first pick is what saves", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/${MAC}`);
    const select = screen().getByRole("combobox", { name: "Who can use it" });
    expect(select.textContent).toBe("Only the owner");
    select.focus();
    await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Only some people or roles" }));
    // Nobody picked is the owner alone on the server: nothing to save yet, and the choice stays on the page.
    expect(calls(state, "devices.updateComputer")).toEqual([]);
    expect(screen().getByRole("combobox", { name: "Who can use it" }).textContent).toBe("Only some people or roles");
    const picker = document.querySelector(".dv-picker") as HTMLElement;
    await click(within(picker).getByRole("checkbox", { name: /Ana Costa/ }));
    expect(calls(state, "devices.updateComputer").map((c) => c.args.at(-1))).toEqual([
      { audience: { mode: "people", userIds: [ANA], roleIds: [] } },
    ]);
  });

  test("an admin on someone's computer may only narrow who can use it", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`);
    const select = screen().getByRole("combobox", { name: "Who can use it" });
    await act(async () => {
      fireEvent.pointerDown(select, { button: 0, pointerType: "mouse" });
      fireEvent.keyDown(select, { key: "Enter" });
    });
    await settle(2);
    const options = screen().getAllByRole("option");
    const disabled = options.filter((o) => o.getAttribute("aria-disabled") === "true").map((o) => o.textContent);
    expect(disabled).toEqual(["Everyone in the workspace", "Only some people or roles"]);
  });
});

describe("In the chat and the inbox", () => {
  test("an agent waiting for a device: Try now, another device, Stop waiting; once it's back, an ended pill", async () => {
    const state = acmeState();
    state.messages.push({
      id: "m-wait",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: LIA },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "run-1",
      createdAt: new Date().toISOString(),
      meta: {
        deviceWait: {
          runId: "run-1",
          agentId: LIA,
          device: {
            kind: "phone",
            id: "p-ana-iphone",
            name: "Ana's iPhone 15",
            platform: "ios",
            hostId: "m-imac",
            hostName: "Ana's iMac",
            ownerUserId: "u-ana",
          },
          deviceName: "Ana's iPhone 15",
          hostName: "Ana's iMac",
          reason: "offline",
          detail: null,
          lastSeenAt: new Date(Date.now() - 18 * 60_000).toISOString(),
          state: "waiting",
        },
      },
    } as never);
    const { sockets } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, undefined, state);
    await act(async () => sockets.last().open());
    const card = document.querySelector(".rq-open") as HTMLElement;
    expect(card.textContent).toContain("Waiting for Ana's iPhone 15");
    expect(card.textContent).toContain("Ana's iMac is offline");
    await click(within(card).getByRole("button", { name: "Try now" }));
    expect(calls(state, "devices.deviceWait")[0]?.args).toEqual([ORG_ID, "run-1", "retry"]);
    await click(within(card).getByRole("button", { name: "Stop waiting" }));
    expect(calls(state, "devices.deviceWait")[1]?.args).toEqual([ORG_ID, "run-1", "stop"]);
    // The server ends the wait and says so on the channel: the card flips without a reload.
    await act(async () =>
      sockets.last().push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "device_wait.updated",
          channelId: ENG_ID,
          threadId: null,
          messageId: "m-wait",
          deviceWait: { deviceName: "Ana's iPhone 15", reason: "offline", state: "back" },
        },
      }),
    );
    await settle(4);
    expect(document.querySelector(".rq-done")?.textContent).toContain("Ana's iPhone 15 is back");
  });

  test("someone's agent asks for my phone: Allow once, Always or No, in the inbox", async () => {
    const state = acmeState();
    state.notifications = [
      notification({
        id: "n-dev",
        kind: "device.access_request" as never,
        waiting: true,
        actors: [{ type: "agent", id: LIA }],
        source: { requestId: "ar-1", phoneId: IPHONE, label: "Sam's iPhone 16", userId: RUI, runId: "run-2" } as never,
        latest: { title: "Rui", text: "Record the checkout" },
      }),
    ];
    await open(`/org/${ORG_ID}/notifications`, undefined, state);
    const row = document.querySelector('[data-n="n-dev"]') as HTMLElement;
    expect(row.textContent).toContain("Lia (for Rui) asks to use Sam's iPhone 16");
    expect(row.textContent).toContain("Devices");
    // The answer is in the open item, beside the list (ADR 0218).
    await click(row);
    const read = document.querySelector(".ib-read") as HTMLElement;
    await click(within(read).getByRole("button", { name: "Allow once" }));
    expect(calls(state, "devices.decideAccess")[0]?.args).toEqual([ORG_ID, "ar-1", "once"]);
  });

  test("an agent waits for a folder on my computer: No from the inbox, never a yes", async () => {
    const state = acmeState();
    state.notifications = [
      notification({
        id: "n-folder",
        kind: "device.folder_request" as never,
        waiting: true,
        actors: [{ type: "agent", id: LIA }],
        source: { machineId: MAC, label: "Sam's MacBook Pro", agentId: LIA, requestId: "fr-1" } as never,
        latest: { title: "/Users/sam/Contracts", text: "read the contracts" },
      }),
    ];
    await open(`/org/${ORG_ID}/notifications`, undefined, state);
    await click(document.querySelector('[data-n="n-folder"]') as HTMLElement);
    const read = document.querySelector(".ib-read") as HTMLElement;
    expect(within(read).queryByRole("button", { name: /allow/i })).toBeNull();
    await click(within(read).getByRole("button", { name: "No" }));
    await settle(4);
    expect(calls(state, "machines.refuseFolder").map((c) => c.args)).toEqual([[ORG_ID, MAC, "fr-1"]]);
  });

  test("an agent waits for a folder on my computer with the app: Allow on the computer opens the request there", async () => {
    const state = acmeState();
    state.notifications = [
      notification({
        id: "n-folder",
        kind: "device.folder_request" as never,
        waiting: true,
        actors: [{ type: "agent", id: LIA }],
        source: { machineId: MAC, label: "Sam's MacBook Pro", agentId: LIA, requestId: "fr-1" } as never,
        latest: { title: "/Users/sam/Contracts", text: "read the contracts" },
      }),
    ];
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({ id: MAC, name: "Sam's MacBook Pro", os: "darwin", folderPick: true });
    const app = await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(6);
    await showIn(app.services, "en");
    await click(document.querySelector('[data-n="n-folder"]') as HTMLElement);
    const read = document.querySelector(".ib-read") as HTMLElement;
    await click(within(read).getByRole("button", { name: "Allow on the computer" }));
    await settle(4);
    expect(calls(state, "machines.askFolder").map((c) => c.args)).toEqual([[ORG_ID, MAC, { requestId: "fr-1" }]]);
    expect(document.body.textContent).toContain("Opened on Sam's MacBook Pro. Allow it there.");
  });

  test("my computer paired before lends its internet now: the inbox says so plainly, with Turn off", async () => {
    const state = acmeState();
    state.notifications = [
      notification({
        id: "n-lent",
        kind: "device.internet_shared" as never,
        source: { machineId: MAC, label: "Sam's MacBook Pro" } as never,
        latest: { title: "Sam's MacBook Pro" },
      }),
    ];
    await open(`/org/${ORG_ID}/notifications`, undefined, state);
    const row = document.querySelector('[data-n="n-lent"]') as HTMLElement;
    expect(row.textContent).toContain("Agents now open websites through the internet of Sam's MacBook Pro");
    await click(row);
    const read = document.querySelector(".ib-read") as HTMLElement;
    expect(read.textContent).toContain("never anything on its own network, never email on port 25");
    expect(read.textContent).not.toContain("GB");
    await click(within(read).getByRole("button", { name: "Turn off" }));
    await settle(4);
    expect(calls(state, "devices.updateComputer").map((c) => c.args)).toEqual([
      [ORG_ID, MAC, { shareInternet: false }],
    ]);
  });
});
