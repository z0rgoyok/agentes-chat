import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import type { LocalServerStatus, Tailnet } from "../src/control/local-server";
import { DesktopStore } from "../src/control/store";
import type { UpdateCheck } from "../src/hooks";
import { createFakeHost, type FakeHost, type HereOptions, type Scenario } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { Prefs } from "../src/windows/Prefs";
import { Advanced } from "../src/windows/prefs/Advanced";
import { Folders } from "../src/windows/prefs/Folders";
import { General } from "../src/windows/prefs/General";
import { Servers } from "../src/windows/prefs/Servers";
import { Tools } from "../src/windows/prefs/Tools";
import { Updates } from "../src/windows/prefs/Updates";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A Preferences tab on a fake host, once `ready` says it shows what the test looks at. `options.host` changes the
 * host before the tab first reads it.
 */
async function pane(
  scenario: Scenario,
  view: ReactNode,
  ready: (el: HTMLElement) => unknown,
  check: (el: HTMLElement, host: FakeHost, opened: string[]) => Promise<void> | void,
  options: { someCommands?: boolean; here?: HereOptions; host?: (host: FakeHost) => void } = {},
) {
  const host = createFakeHost("prefs", scenario, { someCommands: options.someCommands, here: options.here });
  options.host?.(host);
  const opened: string[] = [];
  host.openExternal = async (url) => {
    opened.push(url);
  };
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>{view}</ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    await until(() => ready(el));
    await check(el, host, opened);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

/** What an element is described by, each description in order (a hint's text is in the page while it's closed). */
const describedBy = (el: Element | null | undefined) =>
  (el?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .filter(Boolean)
    .join(" ") || null;

/** Each row: its title, its ⓘ's hint, the hint its switch reads (when it has one) and the line under the title. */
const rows = (root: ParentNode) =>
  [...root.querySelectorAll(".dk-crow")].map((row) => {
    const control = row.querySelector(':scope > .dk-crow__end > [role="switch"]');
    return {
      title: row.querySelector(".dk-crow__title")?.textContent ?? null,
      hint: describedBy(row.querySelector("button.ac-hint")),
      ...(control ? { switch: describedBy(control) } : {}),
      line: row.querySelector(".dk-crow__text > small")?.textContent ?? null,
    };
  });
const row = (root: ParentNode, title: string) => rows(root).find((r) => r.title === title);
const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text);
const eraseButton = (root: ParentNode) => buttonIn(root, "Erase and start over…");
/** A failed erase: its line inside the dialog, which stays open with both buttons pressable again, and no toast. */
const expectFailureInDialog = (dialog: HTMLElement, line: string) => {
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(line);
  expect((buttonIn(dialog, "Cancel") as HTMLButtonElement).disabled).toBe(false);
  expect((buttonIn(dialog, "Erase it") as HTMLButtonElement).disabled).toBe(false);
  expect(document.querySelector(".dk-toast")?.textContent).toBe("");
};

describe("Preferences: a setting's explanation behind its ⓘ", () => {
  test("General: no lead, and each behavior on one line, its ⓘ where it has something to say", () =>
    pane(
      "selfhost",
      <General />,
      (el) => row(el, "Name") && row(el, "Open at login"),
      (el) => {
        expect(el.querySelector(".dk-phead .dk-lead")).toBeNull();
        const behavior = [...el.querySelectorAll(".dk-card")].at(-1) as HTMLElement;
        expect(rows(behavior)).toEqual([
          // The language this computer shows the app in (ADR 0122): nothing to explain.
          { title: "Language", hint: null, line: null },
          {
            title: "Let me know about messages and requests",
            hint: "Mentions, direct messages and what waits for you, while the app is in the background.",
            switch: "Mentions, direct messages and what waits for you, while the app is in the background.",
            line: null,
          },
          { title: "Let me know when an agent asks for a folder", hint: null, switch: null, line: null },
          {
            title: "Let me know when an agent needs me in its browser",
            hint: "The request already reaches your phone and the site. This tells you here too.",
            switch: "The request already reaches your phone and the site. This tells you here too.",
            line: null,
          },
          { title: "Show in the menu bar", hint: null, switch: null, line: null },
          {
            title: "Show the agents in the notch",
            hint: "On MacBooks with a notch: who is working shows around the camera.",
            switch: "On MacBooks with a notch: who is working shows around the camera.",
            line: null,
          },
        ]);
        // Open at login closes This Mac's card, where agents use this computer while the app is open.
        expect(row(el, "Open at login")).toEqual({
          title: "Open at login",
          hint: "Agents work only while the app is open.",
          switch: "Agents work only while the app is open.",
          line: null,
        });
        // The computer's name and the organizations: no lines that only describe them.
        expect(row(el, "Name")?.line).toBeNull();
        expect(el.textContent).not.toContain("Each one has its own folders and tasks");
      },
    ));

  test("Servers: what the usage switch sends and that changing it restarts agentes.chat sit behind its ⓘ", () =>
    pane(
      "here",
      <Servers />,
      (el) =>
        row(el, "Send anonymous usage statistics to agentes.chat") &&
        row(el, "Reach it from your phone and teammates")?.line === null,
      (el) => {
        expect(row(el, "Send anonymous usage statistics to agentes.chat")).toEqual({
          title: "Send anonymous usage statistics to agentes.chat",
          hint: "Counts such as people, agents, machine sizes, AI tokens used and how much data the agents' browsers send and receive. Never messages, files, names or sites. Changing it restarts agentes.chat for a moment.",
          switch:
            "Counts such as people, agents, machine sizes, AI tokens used and how much data the agents' browsers send and receive. Never messages, files, names or sites. Changing it restarts agentes.chat for a moment.",
          line: null,
        });
        expect(el.textContent).not.toContain("nothing is sent");
        expect(el.querySelector(".dk-phead .dk-lead")?.textContent).toBe("Where this app opens agentes.chat.");
      },
    ));

  test("Servers: installed and internal versions stay distinct through a restart", () =>
    pane(
      "here",
      <Servers />,
      (el) => row(el, "Reach it from your phone and teammates"),
      async (el) => {
        const installed = () => row(el, "Installed package version")?.line;
        const internal = () => row(el, "Internal server version")?.line;
        const phase = () => el.querySelector(".dk-card .dk-crow__end .ac-chip")?.textContent;
        const restart = [...el.querySelectorAll("button")].find((button) => button.textContent === "Restart");

        expect(installed()).toBe("0.8.5");
        expect(internal()).toBe("0.1.1");
        expect(restart?.disabled).toBe(false);
        await act(async () => restart?.click());
        await until(() => phase() === "Starting");
        expect(installed()).toBe("0.8.5");
        expect(internal()).toBeUndefined();

        await until(() => phase() === "Running");
        expect(installed()).toBe("0.8.5");
        expect(internal()).toBe("0.1.1");
      },
    ));

  test("Servers: until Tailscale answers, reach says it is checking and its switch waits", async () => {
    // Tailscale is connected, but its read takes a moment: the line says so, never "Needs Tailscale" meanwhile.
    const answers: ((tailnet: Tailnet) => void)[] = [];
    await pane(
      "here",
      <Servers />,
      (el) => row(el, "Reach it from your phone and teammates"),
      async (el) => {
        const reach = () => row(el, "Reach it from your phone and teammates");
        expect(reach()?.line).toBe("Checking whether Tailscale is connected…");
        expect(el.querySelector("#here-reach")?.hasAttribute("disabled")).toBe(true);
        await act(async () => {
          for (const answer of answers) answer({ state: "on", device: "macbook" });
        });
        await until(() => !el.querySelector("#here-reach")?.hasAttribute("disabled"));
        expect(reach()?.line).toBeNull();
      },
      {
        host: (host) => {
          host.tailscale = () => new Promise((resolve) => answers.push(resolve));
        },
      },
    );
  });

  test("Preferences: once the server here is erased, the window's header no longer names its address", () =>
    pane(
      "here",
      <Prefs />,
      (el) => buttonIn(el, "Servers"),
      async (el, host) => {
        const header = () => el.querySelector(".dk-pnav__whotext")?.textContent ?? "";
        const address = new URL((await host.servers()).current ?? "").host;
        await act(async () => buttonIn(el, "Servers")?.click());
        await until(() => eraseButton(el));
        await act(async () => eraseButton(el)?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        await act(async () => buttonIn(document.querySelector('[role="dialog"]') as HTMLElement, "Erase it")?.click());
        await until(() => !eraseButton(el) && !document.querySelector('[role="dialog"]'));
        // Its agents' homes went with it, so the header is the app's own again: its name, and no server under it.
        await until(() => host.runners.size === 0);
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(header()).not.toContain(address);
        expect(header()).toBe("agentes.chat");
      },
    ));

  test("Servers: Erase and start over… asks once, then the server here's card goes and a line says where its data went", () =>
    pane(
      "here",
      <Servers />,
      (el) => eraseButton(el),
      async (el, host) => {
        expect(eraseButton(el)?.closest(".dk-here__end")?.textContent).toContain("Stop running it here…");
        await act(async () => eraseButton(el)?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.textContent).toContain("Erase agentes.chat on this Mac?");
        // Its date never breaks at a hyphen (U+2011).
        expect(dialog.textContent).toContain("~/agentes.chat erased 2026\u201111\u201114");
        expect([...dialog.querySelectorAll("button")].map((b) => b.textContent).filter(Boolean)).toEqual([
          "Cancel",
          "Erase it",
        ]);
        await act(async () => buttonIn(dialog, "Erase it")?.click());
        // While it erases, nothing else can be pressed in its dialog, and it stays up once the server stopped.
        expect((buttonIn(dialog, "Cancel") as HTMLButtonElement).disabled).toBe(true);
        expect((await host.localServer()).phase).toBe("stopped");
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(document.querySelector('[role="dialog"]')).toBe(dialog);
        await until(() => !eraseButton(el) && !document.querySelector('[role="dialog"]'));
        expect(el.textContent).not.toContain("agentes.chat on this Mac");
        expect(document.querySelector(".dk-toast")?.textContent).toContain(
          "Erased. Its old data is in ~/agentes.chat erased 2026-11-14.",
        );
        expect(host.window).toBe("welcome");
        expect(await host.localServer()).toMatchObject({ installed: "none", run: false });
      },
    ));

  test("Servers: on the stopped card too; a folder that couldn't move says so in its dialog, which stays open", () =>
    pane(
      "here",
      <Servers />,
      (el) => eraseButton(el),
      async (el) => {
        // Under the card, as on the running one: the line about its data keeps its width.
        expect(eraseButton(el)?.closest(".dk-crow")).toBeNull();
        expect(eraseButton(el)?.closest(".dk-here__end")).toBeTruthy();
        expect(el.textContent).toContain("Start it here");
        await act(async () => eraseButton(el)?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        await act(async () => buttonIn(dialog, "Erase it")?.click());
        await until(() => dialog.querySelector('[role="alert"]'));
        expectFailureInDialog(
          dialog,
          "Its data couldn't be moved, so nothing was erased and it stays in ~/.agentes. It's stopped until you start it again.",
        );
        // Opened again later, it starts clean.
        await act(async () => buttonIn(dialog, "Cancel")?.click());
        await until(() => !document.querySelector('[role="dialog"]'));
        await act(async () => eraseButton(el)?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
      },
      {
        here: { run: false },
        host: (host) => {
          host.eraseLocalServer = () => Promise.reject("move");
        },
      },
    ));

  test("Servers: another server holding its folder: its dialog says to stop it first, and a second try erases", () =>
    pane(
      "here",
      <Servers />,
      (el) => eraseButton(el),
      async (el) => {
        await act(async () => eraseButton(el)?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        // Everything that goes and everything that stays, in that order.
        expect(dialog.textContent).toContain(
          "Its workspaces go for everyone who uses them, on every device. Its data moves to ~/agentes.chat erased 2026\u201111\u201114 and stays there. What its agents kept on this Mac, such as their browsers and sign-ins, is deleted. The agents' files in ~/agentes are yours and stay where they are. Then you set it up again with a new owner.",
        );
        await act(async () => buttonIn(dialog, "Erase it")?.click());
        await until(() => dialog.querySelector('[role="alert"]'));
        expectFailureInDialog(
          dialog,
          "Another agentes.chat server is using its folder, so nothing was erased. Stop that server, then try again.",
        );
        await act(async () => buttonIn(dialog, "Erase it")?.click());
        await until(() => !document.querySelector('[role="dialog"]'));
        expect(document.querySelector(".dk-toast")?.textContent).toContain("Erased. Its old data is in");
      },
      {
        host: (host) => {
          const erase = host.eraseLocalServer;
          let tries = 0;
          host.eraseLocalServer = () => (tries++ === 0 ? Promise.reject("held") : erase());
        },
      },
    ));

  test("Servers: Erase and start over… waits while it starts, updates or restarts, since its files are being copied", () =>
    pane(
      "here",
      <Servers />,
      (el) => eraseButton(el),
      (el) => {
        expect((eraseButton(el) as HTMLButtonElement).disabled).toBe(true);
      },
      { here: { phase: "updating" } },
    ));

  test("Folders: the note under the list is a link to how folders work, opened in the browser", () =>
    pane(
      "selfhost",
      <Folders />,
      (el) => el.querySelector(".dk-card .dk-crow"),
      async (el, _host, opened) => {
        expect(el.querySelector(".dk-phead .dk-lead")?.textContent).toBe("What agents can see and change on this Mac.");
        const link = [...el.querySelectorAll("button")].find((b) => b.textContent === "How folders work");
        expect(link?.className).toBe("ac-link ac-link--muted dk-link");
        await act(async () => link?.click());
        expect(opened).toEqual(["https://agentes.chat/docs/computers#folders"]);
        expect(el.textContent).not.toContain("Removing deletes nothing");
      },
    ));

  test("Tools: each tool on one line with its ⓘ and its state; Commands one switch per workspace", () =>
    pane(
      "selfhost",
      <Tools />,
      (el) => el.querySelector(".dk-crow .ac-chip") && el.querySelectorAll(".dk-ctitle").length >= 3,
      (el) => {
        const card = el.querySelector(".dk-card") as HTMLElement;
        const tools = [...card.querySelectorAll(":scope > .dk-crow")].map((r) => ({
          title: r.querySelector(".dk-crow__title")?.textContent ?? null,
          hint: describedBy(r.querySelector("button.ac-hint")),
        }));
        expect(tools).toEqual([
          {
            title: "Claude Code",
            hint: "Writes and changes code in the allowed folders, with your Claude account. Runs its own commands in the agent's folder, even with Commands off.",
          },
          {
            title: "Codex",
            hint: "Writes and changes code in the allowed folders, with your ChatGPT account. Runs its own commands in the agent's folder, even with Commands off.",
          },
          {
            title: "Cursor",
            hint: "Writes and changes code in the allowed folders, with your Cursor account.",
          },
          {
            title: "OpenCode",
            hint: "Writes and changes code in the allowed folders, with OpenCode's free models or your key.",
          },
          {
            title: "Grok Build",
            hint: "Writes and changes code in the allowed folders, with your Grok account.",
          },
          {
            title: "Antigravity CLI",
            hint: "Writes and changes code in the allowed folders, with your Gemini account.",
          },
          {
            title: "Commands",
            hint: "Tests, builds and other Terminal commands. Each one shows in Activity. Commands run as you. They can read anything you can on this Mac, agentes.chat's database and keys included. Turn them on only for workspaces you trust with all of it.",
          },
          {
            title: "Browser",
            hint: "Opens websites for the agents in a browser of their own, without your logins. Logins an agent makes stay on this Mac, in its folder. Use only test accounts or the agent's own.",
          },
        ]);
        const [claude] = card.querySelectorAll(".dk-crow");
        expect(claude?.querySelector(".ac-hintline > .ac-chip")?.textContent).toBe("Connected");
        // One switch per workspace under Commands, named after it; no warning in sight.
        const orgs = [...card.querySelectorAll(".dk-crow__under > .dk-crow")].map((r) => [
          r.querySelector(".dk-crow__title")?.textContent,
          r.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
        ]);
        expect(orgs).toEqual([
          ["Acme", "true"],
          ["Horizonte", "true"],
        ]);
        // Every warning sits behind its ⓘ.
        expect(card.querySelectorAll(".dk-honest")).toHaveLength(0);
        expect(row(el, "Protected mode")?.hint).toBe(
          "Coming: commands that write only in allowed folders and can't read the rest of this Mac.",
        );
        expect(el.textContent).not.toContain("Soon");
        expect(el.querySelector(".dk-phead .dk-lead")?.textContent).toBe(
          "What agents of every workspace can run on this Mac.",
        );
      },
    ));

  test("Tools: the installed Codex can be checked again", () =>
    pane(
      "selfhost",
      <Tools />,
      (el) => el.querySelector('#tool-claude[aria-checked="true"]'),
      async (el, host) => {
        const codex = el.querySelector("#tool-codex")?.closest(".dk-crow");
        const button = [...(codex?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent === "Check again",
        );
        expect(button?.disabled).toBe(false);
        const checks = new Set<string>();
        for (const [id, runner] of host.runners) {
          const handle = runner.handle.bind(runner);
          runner.handle = (line) => {
            if (JSON.parse(line).type === "executors.check") checks.add(id);
            handle(line);
          };
        }
        await act(async () => button?.click());
        await until(() => checks.size === host.runners.size);
      },
    ));

  test("Tools: every coding program has a switch of its own, on or off whether or not it is installed", () =>
    pane(
      "selfhost",
      <Tools />,
      // The switches are there before the computer's access is: Claude Code's turns on once it arrives.
      (el) => el.querySelector('#tool-claude[aria-checked="true"]'),
      async (el) => {
        const state = (id: string) => el.querySelector(`#tool-${id}`)?.getAttribute("aria-checked");
        const programs = ["claude", "codex", "cursor", "opencode", "grok", "antigravity"];
        // One with no switch stored follows Codex's, off here; none of the four is found here.
        expect(programs.map(state)).toEqual(["true", "false", "false", "false", "false", "false"]);
        expect(programs.every((id) => !(el.querySelector(`#tool-${id}`) as HTMLButtonElement).disabled)).toBe(true);
        await act(async () => (el.querySelector("#tool-opencode") as HTMLElement).click());
        await until(() => state("opencode") === "true");
        expect(programs.map(state)).toEqual(["true", "false", "false", "true", "false", "false"]);
      },
    ));

  test("Tools: turning Commands on for one workspace asks first, and only that workspace changes", () =>
    pane(
      "selfhost",
      <Tools />,
      (el) =>
        [...el.querySelectorAll('.dk-crow__under [role="switch"]')].some((s) => !(s as HTMLButtonElement).disabled),
      async (el) => {
        const switchOf = (org: string) =>
          [...el.querySelectorAll(".dk-crow__under > .dk-crow")]
            .find((r) => r.querySelector(".dk-crow__title")?.textContent === org)
            ?.querySelector('[role="switch"]') as HTMLButtonElement;
        expect(switchOf("Horizonte").getAttribute("aria-checked")).toBe("false");
        await act(async () => switchOf("Horizonte").click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.textContent).toContain("Turn on Commands for Horizonte?");
        expect(dialog.textContent).toContain("agentes.chat's database and keys included");
        const turnOn = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Turn on");
        await act(async () => turnOn?.click());
        await until(() => switchOf("Horizonte").getAttribute("aria-checked") === "true");
        expect(switchOf("Acme").getAttribute("aria-checked")).toBe("true");
      },
      { someCommands: true },
    ));

  test("Tools › accounts: what the card is for behind its title's ⓘ; signing in, the wrong account behind one", () =>
    pane(
      "selfhost",
      <Tools />,
      (el) => [...el.querySelectorAll("button")].some((b) => b.textContent === "Add account" && !b.disabled),
      async (el) => {
        const title = [...el.querySelectorAll(".dk-ctitle")].find((t) => t.textContent?.includes("Claude accounts"));
        expect(title?.querySelector("h3")?.textContent).toBe("Claude accounts");
        expect(title?.querySelector("h3 .ac-hint")).toBeNull();
        expect(title?.querySelector(":scope > button.ac-hint")?.getAttribute("aria-label")).toBe(
          "About Claude accounts",
        );
        expect(describedBy(title?.querySelector(":scope > button.ac-hint"))).toBe(
          "Each Acme agent picks its account on its own page. Accounts stay on this Mac only.",
        );
        const card = title?.closest("section")?.querySelector(".dk-card");
        const last = [...(card?.querySelectorAll(".dk-crow") ?? [])].at(-1);
        expect(last?.querySelector(".dk-crow__text")?.textContent).toBe("");
        const add = last?.querySelector("button");
        expect(add?.textContent).toBe("Add account");
        await act(async () => add?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        // The dialog is described by the sentence alone; its ⓘ ends the sentence's line, outside the description.
        expect(describedBy(dialog)).toBe("Sign in with the account you want to add, then click Authorize.");
        const info = dialog.querySelector(".ac-dialog__desc > button.ac-hint");
        expect(info).toBeTruthy();
        expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.contains(info)).toBe(false);
        expect(info?.getAttribute("aria-label")).toBe("About the wrong account");
        expect(describedBy(info)).toBe(
          "Signed in to the wrong account by itself? Sign out of Claude there and try again.",
        );
        expect(dialog.querySelector(".dk-help")?.textContent ?? "").not.toContain("wrong account");
      },
    ));

  test("Advanced on Linux: back to defaults keeps two conversations open for 20 minutes, as the runner does", () =>
    pane(
      "selfhost",
      <Advanced />,
      (el) =>
        el.querySelectorAll(".dk-card").length === 3 && !el.querySelector(".dk-phead button")?.hasAttribute("disabled"),
      async (el) => {
        const defaults = el.querySelector<HTMLButtonElement>(".dk-phead button");
        expect(defaults?.textContent).toBe("Back to defaults");
        await act(async () => defaults?.click());
        const idle = () =>
          [...el.querySelectorAll('[role="radiogroup"]')]
            .find((g) => g.textContent?.includes("min"))
            ?.querySelector('[aria-checked="true"]')?.textContent;
        await until(() => idle() === "20 min");
        expect(el.querySelector('[aria-label="Open conversations"] output')?.textContent).toBe("2");
      },
      {
        host: (h) => {
          (h as { platform: string }).platform = "linux";
        },
      },
    ));

  test("Advanced: each limit on one line with its ⓘ; the agents' folder explained once, by its title", () =>
    pane(
      "selfhost",
      <Advanced />,
      (el) => el.querySelectorAll(".dk-card").length === 3 && el.querySelector(".dk-path"),
      (el) => {
        expect(el.querySelector(".dk-phead .dk-lead")?.textContent).toBe(
          "Only change this if the Mac feels slow or busy.",
        );
        const [jobs, claude, folders] = el.querySelectorAll(".dk-card");
        expect([...rows(jobs as HTMLElement), ...rows(claude as HTMLElement)]).toEqual([
          {
            title: "At the same time",
            hint: "How many long jobs, like builds and tests, run together in each workspace.",
            line: null,
          },
          { title: "Longest each one may run", hint: "After that the job stops and the agent says so.", line: null },
          {
            title: "Open conversations",
            hint: "How many stay open in each workspace. More of them answer faster but use more memory.",
            line: null,
          },
          { title: "Close an idle conversation after", hint: null, line: null },
        ]);
        const title = [...el.querySelectorAll(".dk-ctitle")].find(
          (t) => t.querySelector("h3")?.textContent === "Agents' folder",
        );
        expect(describedBy(title?.querySelector("button.ac-hint"))).toBe(
          "One folder per workspace, with a folder for each agent.",
        );
        for (const r of rows(folders as HTMLElement)) expect(r.line).not.toContain("One folder per workspace");
      },
    ));

  test("Updates: no lead; Update and reopen alone, and the manual way keeps what stays", async () => {
    const latest = { version: "9.9.9", url: "https://app.agentes.chat/api/desktop/download/9.9.9/agentes.dmg" };
    const update: UpdateCheck = {
      state: { latest, available: true, required: false },
      checkedAt: null,
      checking: false,
      failed: false,
      check: async () => null,
      version: "0.6.0",
    };
    await pane(
      "selfhost",
      <Updates update={update} />,
      (el) => el.querySelector(".dk-ver__acts"),
      async (el, host) => {
        expect(el.querySelector(".dk-phead .dk-lead")).toBeNull();
        // The license's attribution and legal notices, always at the end.
        expect(el.textContent).toContain("Based on agentes.chat by AGENTESCHAT, LLC");
        expect(el.textContent).toContain("Copyright © 2026 AGENTESCHAT, LLC and contributors");
        const acts = el.querySelector(".dk-ver__acts") as HTMLElement;
        expect(acts.textContent).toBe("Update and reopen");
        host.installUpdate = async () => false;
        await act(async () => (acts.querySelector("button") as HTMLButtonElement).click());
        await until(() => el.textContent?.includes("Download version 9.9.9"));
        expect(el.querySelector(".dk-ver__acts .dk-help")?.textContent).toBe("Your servers and settings stay.");
      },
    );
  });

  test("Updates: the system details to copy, on every system", async () => {
    const update: UpdateCheck = {
      state: { latest: null, available: false, required: false },
      checkedAt: null,
      checking: false,
      failed: false,
      check: async () => null,
      version: "0.6.0",
    };
    const copied: string[] = [];
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    try {
      await pane(
        "linux",
        <Updates update={update} />,
        (el) => rows(el).some((r) => r.title === "System details"),
        async (el) => {
          const row = [...el.querySelectorAll(".dk-crow")].find(
            (r) => r.querySelector(".dk-crow__title")?.textContent === "System details",
          ) as HTMLElement;
          const line =
            "agentes.chat 0.6.0 · Linux · Ubuntu 26.04 LTS · wayland (GNOME) · WebKitGTK 2.50.4 · Intel (i915) · CPU (chosen) · AppImage";
          expect(row.querySelector("small")?.textContent).toBe(line);
          await act(async () => (row.querySelector("button") as HTMLButtonElement).click());
          await until(() => copied.length > 0);
          expect(copied).toEqual([line]);
        },
      );
      await pane(
        "selfhost",
        <Updates update={update} />,
        (el) => rows(el).some((r) => r.title === "System details"),
        (el) => {
          expect(row(el, "System details")?.line).toBe("agentes.chat 0.6.0 · macOS 15.5");
        },
      );
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    }
  });

  test("Updates: the download with its bar and Cancel, which drops it; once whole, Installing… with no Cancel", async () => {
    const latest = { version: "9.9.9", url: "https://app.agentes.chat/api/desktop/download/9.9.9/agentes.dmg" };
    const update: UpdateCheck = {
      state: { latest, available: true, required: false },
      checkedAt: null,
      checking: false,
      failed: false,
      check: async () => null,
      version: "0.6.0",
    };
    await pane(
      "selfhost",
      <Updates update={update} />,
      (el) => el.querySelector(".dk-ver__acts"),
      async (el) => {
        const install = () => act(async () => (el.querySelector(".dk-ver__acts button") as HTMLButtonElement).click());
        const bar = () => el.querySelector('.dk-upd [role="progressbar"]');
        await install();
        await until(() => Number(bar()?.getAttribute("aria-valuenow")) > 0);
        expect(el.querySelector(".dk-upd__label")?.textContent).toBe("Downloading…");
        expect([...el.querySelectorAll(".dk-upd button")].map((b) => b.textContent)).toEqual(["Cancel"]);
        // Cancel: nothing installed, Update and reopen again, and no manual way.
        await act(async () => (el.querySelector(".dk-upd button") as HTMLButtonElement).click());
        await until(() => el.querySelector(".dk-ver__acts")?.textContent === "Update and reopen");
        expect(el.querySelector(".dk-upd")).toBeNull();
        expect(el.textContent).not.toContain("Update by hand");
        await install();
        await until(() => el.querySelector(".dk-upd__label")?.textContent === "Installing…");
        expect(el.querySelector(".dk-upd button")).toBeNull();
        expect(bar()?.getAttribute("aria-valuenow")).toBe("100");
        // The fake ends the install a moment later (nothing installs here): wait for it, or its state lands after
        // the DOM is gone and breaks the next file.
        await until(() => el.textContent?.includes("Download version 9.9.9"));
      },
    );
  });
});

describe("Preferences › General: Compatibility mode (Linux)", () => {
  const compatRow = (el: HTMLElement) => row(el, "Compatibility mode");
  const toast = () => document.querySelector(".dk-toast");

  test("only on Linux, on by default, its explanation behind ⓘ; a change says it takes effect on reopening", () =>
    pane(
      "linux",
      <General />,
      (el) => compatRow(el) && !el.querySelector<HTMLButtonElement>("#compat")?.disabled,
      async (el, host) => {
        expect(compatRow(el)).toEqual({
          title: "Compatibility mode",
          hint: "Draws the window without the graphics card. It's slower but works on any computer. Use it if the window goes black, gets cut off or freezes.",
          switch:
            "Draws the window without the graphics card. It's slower but works on any computer. Use it if the window goes black, gets cut off or freezes.",
          line: null,
        });
        const chosen: boolean[] = [];
        let reopened = 0;
        let save = () => {};
        host.setCompatMode = (on) =>
          new Promise<void>((done) => {
            chosen.push(on);
            save = done;
          });
        host.reopen = async () => {
          reopened++;
        };
        const sw = el.querySelector<HTMLButtonElement>("#compat") as HTMLButtonElement;
        expect(sw.getAttribute("aria-checked")).toBe("true");
        await act(async () => sw.click());
        // Saving: the switch waits for it.
        expect(chosen).toEqual([false]);
        expect(sw.disabled).toBe(true);
        await act(async () => save());
        await until(() => !sw.disabled);
        expect(sw.getAttribute("aria-checked")).toBe("false");
        expect(toast()?.textContent).toBe("Takes effect when the app reopens.Reopen now");
        await act(async () => buttonIn(toast() as HTMLElement, "Reopen now")?.click());
        expect(reopened).toBe(1);
      },
    ));

  test("a switch that couldn't be saved goes back, and says so", () =>
    pane(
      "linux",
      <General />,
      (el) => compatRow(el) && !el.querySelector<HTMLButtonElement>("#compat")?.disabled,
      async (el, host) => {
        host.setCompatMode = async () => {
          throw new Error("read-only");
        };
        const sw = el.querySelector<HTMLButtonElement>("#compat") as HTMLButtonElement;
        await act(async () => sw.click());
        await until(() => !sw.disabled);
        expect(sw.getAttribute("aria-checked")).toBe("true");
        expect(toast()?.textContent).toBe("Something went wrong. Try again.");
      },
    ));

  test("after an opening with the graphics card that never painted: on again, said once, with the way back", () =>
    pane(
      "linux",
      <General />,
      () => toast()?.textContent?.includes("compatibility mode"),
      async (el, host) => {
        expect(el.querySelector("#compat")?.getAttribute("aria-checked")).toBe("true");
        expect(toast()?.textContent).toBe(
          "The window didn't open with the graphics card, so it opened in compatibility mode.Try the graphics card again",
        );
        const chosen: boolean[] = [];
        let reopened = 0;
        host.setCompatMode = async (on) => void chosen.push(on);
        host.reopen = async () => {
          reopened++;
        };
        await act(async () => buttonIn(toast() as HTMLElement, "Try the graphics card again")?.click());
        await until(() => reopened === 1);
        expect(chosen).toEqual([false]);
      },
      { host: (h) => (h.compat = { on: true, fellBack: true, own: false }) },
    ));

  test("the fallback's way back asks first when agentes.chat starts running here after the window opened", () => {
    let said: ((status: LocalServerStatus) => void) | undefined;
    return pane(
      "linux",
      <General />,
      () => toast()?.textContent?.includes("compatibility mode"),
      async (_el, host) => {
        let reopened = 0;
        host.setCompatMode = async () => {};
        host.reopen = async () => {
          reopened++;
        };
        const status = await host.localServer();
        await act(async () => said?.({ ...status, run: true }));
        await act(async () => buttonIn(toast() as HTMLElement, "Try the graphics card again")?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]')?.textContent;
        expect(dialog).toContain("Reopen agentes.chat?");
        expect(dialog).toContain("agentes.chat stops on this computer: nobody can use it");
        expect(reopened).toBe(0);
      },
      {
        host: (h) => {
          h.compat = { on: true, fellBack: true, own: false };
          h.onLocalServer = (cb) => {
            said = cb;
            return () => {};
          };
        },
      },
    );
  });

  test("Reopen now asks first while agents work here, and waits while the app reopens", () =>
    pane(
      "selfhost",
      <General />,
      // Agents work here once this computer's name shows.
      (el) => row(el, "Name") && compatRow(el) && !el.querySelector<HTMLButtonElement>("#compat")?.disabled,
      async (el, host) => {
        let reopened = 0;
        host.reopen = () => {
          reopened++;
          return new Promise<void>(() => {});
        };
        await act(async () => el.querySelector<HTMLButtonElement>("#compat")?.click());
        await until(() => buttonIn(toast() as HTMLElement, "Reopen now"));
        await act(async () => buttonIn(toast() as HTMLElement, "Reopen now")?.click());
        await until(() => document.querySelector('[role="dialog"]'));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.textContent).toContain("Reopen agentes.chat?");
        expect(dialog.textContent).toContain("Agents can't use this computer until the app opens again.");
        expect(reopened).toBe(0);
        await act(async () => buttonIn(dialog, "Reopen now")?.click());
        expect(reopened).toBe(1);
        expect((buttonIn(dialog, "Cancel") as HTMLButtonElement).disabled).toBe(true);
        expect((buttonIn(dialog, "Reopen now") as HTMLButtonElement).disabled).toBe(true);
      },
      { host: (h) => Object.assign(h, { platform: "linux" }) },
    ));

  test("the system's own WEBKIT_DISABLE_DMABUF_RENDERER decides: the switch shows it, can't change it, and its ⓘ says why", () =>
    pane(
      "linux",
      <General />,
      (el) => compatRow(el)?.hint?.includes("decides this now"),
      (el) => {
        const desc =
          "Draws the window without the graphics card. It's slower but works on any computer. Use it if the window goes black, gets cut off or freezes.";
        expect(compatRow(el)?.hint).toBe(
          `${desc} WEBKIT_DISABLE_DMABUF_RENDERER decides this now. To choose here, quit the app and open it without that variable.`,
        );
        const sw = el.querySelector<HTMLButtonElement>("#compat") as HTMLButtonElement;
        expect(sw.getAttribute("aria-checked")).toBe("false");
        expect(sw.disabled).toBe(true);
      },
      { host: (h) => (h.compat = { on: false, fellBack: false, own: true }) },
    ));

  test("not on a Mac or Windows", async () => {
    for (const scenario of ["selfhost", "windows"] as const)
      await pane(
        scenario,
        <General />,
        (el) => row(el, "Language"),
        (el) => {
          expect(compatRow(el)).toBeUndefined();
        },
      );
  });
});
