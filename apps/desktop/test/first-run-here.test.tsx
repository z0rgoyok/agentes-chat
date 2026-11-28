import { describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import type { Tailnet } from "../src/control/local-server";
import { DesktopStore } from "../src/control/store";
import { createFakeHost, type FakeHost, type HereOptions, type Scenario } from "../src/host/fake";
import { type AppLocale, createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { FirstRun } from "../src/windows/FirstRun";
import { until } from "./until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACH_TEXT =
  "With Tailscale, a private network for your devices: your phone and the people you invite join it, and nobody else can reach agentes.chat.";
const USAGE_TEXT =
  "Counts such as people, agents, machine sizes, AI tokens used, how much data the agents' browsers send and receive, and how fast the apps open and run. Never messages, files, names or sites.";

/** The first run on a fake host, with what it opened in the browser and in Tailscale; `host` changes the host first. */
async function firstRun(
  scenario: Scenario,
  check: (screen: ReturnType<typeof screenOf>) => Promise<void>,
  options: { here?: HereOptions; lang?: AppLocale; host?: (host: FakeHost) => void } = {},
) {
  const host = createFakeHost("welcome", scenario, { here: options.here });
  options.host?.(host);
  const opened: string[] = [];
  host.openExternal = async (url) => {
    opened.push(url);
  };
  const tailscale: string[] = [];
  host.openTailscale = async (page) => {
    tailscale.push(page);
  };
  // Nothing else answers on this computer, and at once (the fake host waits like a network would).
  host.checkServer = async (server) => ({ ok: false, server, problem: "unreachable" });
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n(options.lang ?? "en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <FirstRun />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    // Whether this build runs agentes.chat here arrives from the host first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await check(screenOf(el, opened, tailscale, host));
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

function screenOf(el: HTMLElement, opened: string[], tailscale: string[], host: FakeHost) {
  const button = (name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
  return {
    el,
    opened,
    tailscale,
    host,
    button,
    press: async (name: string) => {
      const target = button(name);
      expect({ name, found: !!target }).toEqual({ name, found: true });
      await act(async () => target?.click());
    },
    until,
  };
}

/** Each switch row of the card: its label, its ⓘ, the hint that describes the switch, and the line under it. */
function switchRows(el: HTMLElement) {
  return [...el.querySelectorAll(".dk-card > .dk-crow")].map((row) => {
    const control = row.querySelector(':scope > .dk-crow__end > [role="switch"]');
    const info = row.querySelector("button.ac-hint");
    return {
      label: row.querySelector("label.dk-crow__title")?.textContent,
      about: info?.getAttribute("aria-label"),
      // The switch and its ⓘ read the same hint, while the bubble is closed too.
      hint: document.getElementById(control?.getAttribute("aria-describedby") ?? "")?.textContent,
      same: !!info && info.getAttribute("aria-describedby") === control?.getAttribute("aria-describedby"),
      line: row.querySelector(".dk-crow__text > small")?.textContent ?? null,
    };
  });
}

describe("Run agentes.chat on this Mac", () => {
  test("the title, one sentence, the two fields alone, two one-line switches with their ⓘ, and Start", () =>
    firstRun("first", async ({ el, press, until, button }) => {
      await press("On this Mac");
      // Tailscale connected: the reach row has nothing under its label.
      await until(() => el.querySelector("form.dk-fr__here") && switchRows(el)[0]?.line === null);
      const form = el.querySelector("form.dk-fr__here") as HTMLElement;
      expect(el.querySelector("h1")?.textContent).toBe("Let's get this Mac ready");
      const lead = el.querySelector(".dk-lead")?.textContent ?? "";
      expect(lead).toBe("It takes a minute. Everything stays here, with you alone.");
      expect(lead).not.toContain("Docker");
      // The two fields, the card of switches, the sleeping agent's line and Start.
      expect([...form.children].map((c) => c.className)).toEqual([
        "dk-fr__who",
        "dk-card",
        "dk-fr__rest",
        "dk-fr__end",
      ]);
      expect(form.querySelector(".dk-fr__rest")?.textContent).toBe(
        "When you close the app, your agents rest. They're back as soon as you open it again.",
      );
      expect(form.querySelector(".dk-fr__rest .ac-avatar")).not.toBeNull();
      expect([...form.querySelectorAll(".ac-field label")].map((l) => l.textContent)).toEqual([
        "Your name",
        "Your email",
      ]);
      expect(form.querySelector(".ac-field__label-row")).toBeNull();
      expect(el.textContent).not.toContain("Your team sees it");
      expect(switchRows(el)).toEqual([
        {
          label: "Reach it from your phone and teammates",
          about: "About Reach it from your phone and teammates",
          hint: REACH_TEXT,
          same: true,
          line: null,
        },
        {
          label: "Send anonymous usage statistics to agentes.chat",
          about: "About Send anonymous usage statistics to agentes.chat",
          hint: USAGE_TEXT,
          same: true,
          line: null,
        },
      ]);
      expect(el.textContent).not.toContain("Your agents work here too");
      expect(el.textContent).not.toContain("Made for you or a small team");
      expect(button("Start")?.getAttribute("type")).toBe("submit");
    }));

  test("having run here before: where its data is, as the one sentence, and no fields", () =>
    firstRun(
      "here",
      async ({ el, press, until }) => {
        await press("On this Mac");
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(el.querySelector(".dk-lead")?.textContent).toBe(
          "It ran here before, and its data is still in ~/.agentes.",
        );
        expect(el.querySelector(".dk-fr__who")).toBeNull();
      },
      { here: { run: false } },
    ));

  test("running with no account left: the window opens on the form, says so, and Start makes the new owner", () => {
    const sent: unknown[] = [];
    return firstRun(
      "here",
      async ({ el, press, until }) => {
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(el.querySelector(".dk-lead")?.textContent).toBe(
          "No account is left on it. Your name and email make you its new owner.",
        );
        const [name, email] = [...el.querySelectorAll(".dk-fr__who input")];
        await act(async () => typeInto(name ?? null, "Carla Dias"));
        await act(async () => typeInto(email ?? null, "carla@example.com"));
        await press("Start");
        await until(() => sent.length > 0);
        expect(sent[0]).toMatchObject({ name: "Carla Dias", email: "carla@example.com" });
      },
      {
        here: { owner: false, pace: 10 },
        host: (host) => {
          const install = host.installLocalServer;
          host.installLocalServer = async (choice) => {
            sent.push(choice);
            return install(choice);
          };
        },
      },
    );
  });

  test("open already when the app finds no account left: shown again, it goes to the form", () => {
    let gone = false;
    let mode: "owner" | null = null;
    return firstRun(
      "here",
      async ({ el, host, until }) => {
        await until(() => el.querySelector(".dk-fr")?.getAttribute("data-screen") === "choose");
        gone = true;
        mode = "owner";
        await act(async () => host.showWindow("welcome"));
        await until(() => el.querySelector("form.dk-fr__here .dk-fr__who"));
        expect(el.querySelector(".dk-lead")?.textContent).toStartWith("No account is left on it.");
      },
      {
        host: (host) => {
          const read = host.localServer;
          host.localServer = async () => ({ ...(await read()), ...(gone ? { owner: false } : {}) });
          host.welcomeMode = async () => {
            const taken = mode;
            mode = null;
            return taken;
          };
        },
      },
    );
  });

  test("erased from Preferences: it opens on Run here's form, its first line saying where the old data went", () =>
    firstRun("here", async ({ el, host, until }) => {
      await until(() => el.querySelector(".dk-fr")?.getAttribute("data-screen") === "choose");
      await act(async () => {
        await host.eraseLocalServer();
      });
      await until(() => el.querySelector("form.dk-fr__here .dk-fr__who"));
      expect(el.querySelector(".dk-lead")?.textContent).toBe(
        "Erased. Its old data is in ~/agentes.chat erased 2026-11-14.",
      );
    }));

  test("no account left, but opened for something else: the window starts where it always does", () =>
    firstRun(
      "here",
      async ({ el, host, until }) => {
        await until(() => el.querySelector(".dk-fr")?.getAttribute("data-screen") === "choose");
        await act(async () => host.addWorkspace());
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(el.querySelector(".dk-fr")?.getAttribute("data-screen")).toBe("choose");
      },
      {
        host: (host) => {
          const read = host.localServer;
          host.localServer = async () => ({ ...(await read()), owner: false });
        },
      },
    ));

  test("running here already: one sentence, never its address", () =>
    firstRun("here", async ({ el, press, until }) => {
      await press("On this Mac");
      await until(() => el.querySelector("h1")?.textContent === "agentes.chat already runs on this Mac");
      expect(el.querySelector(".dk-lead")?.textContent).toBe("This app runs it. Open it to sign in.");
    }));

  test("without Tailscale the switch can't be used, and one line says why, with what fixes it", async () => {
    await firstRun(
      "first",
      async ({ el, press, until, tailscale }) => {
        await press("On this Mac");
        await until(() => switchRows(el)[0]?.line?.startsWith("Needs"));
        const [reach] = switchRows(el);
        expect(reach?.line).toBe("Needs Tailscale, which is free. Get Tailscale");
        expect(reach?.hint).toBe(REACH_TEXT);
        expect(el.querySelector("#here-reach")?.hasAttribute("disabled")).toBe(true);
        await press("Get Tailscale");
        expect(tailscale).toEqual(["download"]);
      },
      { here: { tailscale: "missing" } },
    );
    await firstRun(
      "first",
      async ({ el, press, until, tailscale }) => {
        await press("On this Mac");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        expect(switchRows(el)[0]?.line).toBe("Tailscale isn't connected. Open Tailscale");
        await press("Open Tailscale");
        expect(tailscale).toEqual(["app"]);
      },
      { here: { tailscale: "off" } },
    );
    await firstRun(
      "linux",
      async ({ el, press, until }) => {
        await press("On this computer");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        const row = el.querySelector(".dk-card > .dk-crow");
        expect(row?.querySelector("small")?.textContent?.trim()).toBe(
          "Tailscale isn't connected. Connect it in the terminal: sudo tailscale up",
        );
        expect(row?.querySelector("small code")?.textContent).toBe("sudo tailscale up");
        expect(row?.querySelector("small button[aria-label='Copy']")).toBeTruthy();
      },
      { here: { tailscale: "off" } },
    );
    // A Mac with only Tailscale's command-line tool (Homebrew's): no app to open, the terminal connects it.
    await firstRun(
      "first",
      async ({ el, press, until }) => {
        await press("On this Mac");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        const row = el.querySelector(".dk-card > .dk-crow");
        expect(row?.querySelector("small")?.textContent?.trim()).toBe(
          "Tailscale isn't connected. Connect it in the terminal: sudo tailscale up",
        );
        expect(row?.querySelector("small code")?.textContent).toBe("sudo tailscale up");
        expect(el.textContent).not.toContain("Open Tailscale");
      },
      {
        host: (host) => {
          host.tailscale = async () => ({ state: "off", app: false });
        },
      },
    );
    // Windows: no sudo and no app for this one to open, Tailscale's icon by the clock connects it (signed out or not).
    await firstRun(
      "windows",
      async ({ el, press, until }) => {
        await press("On this PC");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        const line = el.querySelector(".dk-card > .dk-crow small");
        expect(line?.textContent).toBe("Tailscale isn't connected. Connect it from its icon by the clock.");
        expect(line?.querySelector("code, button")).toBeNull();
      },
      { here: { tailscale: "off" } },
    );
  });
});

describe("Run here, while Tailscale is read", () => {
  test("the line under reach says it is checking and its switch waits, so no wrong line flashes", async () => {
    // Tailscale is connected, but its read takes a moment (up to 2 s on a Mac).
    const answers: ((tailnet: Tailnet) => void)[] = [];
    await firstRun(
      "first",
      async ({ el, press, until }) => {
        await press("On this Mac");
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(switchRows(el)[0]?.line).toBe("Checking whether Tailscale is connected…");
        expect(el.textContent).not.toContain("Needs Tailscale");
        expect(el.querySelector("#here-reach")?.hasAttribute("disabled")).toBe(true);
        await act(async () => {
          for (const answer of answers) answer({ state: "on", device: "macbook" });
        });
        await until(() => !el.querySelector("#here-reach")?.hasAttribute("disabled"));
        expect(switchRows(el)[0]?.line).toBeNull();
      },
      {
        host: (host) => {
          host.tailscale = () => new Promise((resolve) => answers.push(resolve));
        },
      },
    );
  });
});

describe("Where will your workspace live?", () => {
  test("the cloud recommended, this Mac and a server or VPS beside it, each a row that goes on by itself; the drawing follows the row pointed at or focused", () => {
    const chosen: (string | undefined)[] = [];
    return firstRun(
      "first",
      async ({ el, press }) => {
        expect(el.querySelector("h1")?.textContent).toBe("Where will your workspace live?");
        // No pick, then a button: each place is the way on, a chevron at its end.
        expect(el.querySelector('[role="radio"]')).toBeNull();
        expect(el.querySelector(".dk-choose__list ~ button.dk-btn-lg")).toBeNull();
        const rows = [...el.querySelectorAll<HTMLElement>(".dk-choose__list .ac-optrow")];
        expect(rows.map((r) => r.querySelector(".ac-optrow__title")?.textContent)).toEqual([
          "In the agentes.chat cloudRecommended",
          "On this Mac",
          "On a server or VPS",
        ]);
        expect(rows.every((r) => r.querySelector(".ac-optrow__go"))).toBe(true);
        // Recommended on the cloud's row in the kit's tag, as on the web; nothing says "free".
        expect(
          [...el.querySelectorAll(".ac-chip")].map((c) => c.closest(".ac-optrow") === rows[0] && c.textContent),
        ).toEqual(["Recommended"]);
        expect(el.textContent).not.toContain("Free");
        const buttons = rows.map((r) => r.querySelector<HTMLButtonElement>(".ac-optrow__hit"));
        const place = () => el.querySelector(".ac-place")?.getAttribute("data-place");
        expect(place()).toBe("cloud");
        await act(async () => buttons[1]?.focus());
        expect(place()).toBe("here");
        expect(el.querySelector(".ac-place canvas.ac-computer")?.getAttribute("data-kind")).toBe("mac");
        await act(async () => buttons[2]?.focus());
        expect(place()).toBe("box");
        expect(el.querySelector(".ac-place canvas.ac-computer")?.getAttribute("data-kind")).toBe("linux");
        await press("In the agentes.chat cloud");
        expect(chosen).toEqual(["/login"]);
      },
      {
        host: (host) => {
          host.chooseServer = async (_server, page) => {
            chosen.push(page);
          };
          host.hideWindow = async () => {};
        },
      },
    );
  });

  test("on Windows, this PC by its own words and drawing, and its row goes to getting it ready", () =>
    firstRun("windows", async ({ el, press }) => {
      const pc = [...el.querySelectorAll<HTMLButtonElement>(".dk-choose__list .ac-optrow__hit")].find((r) =>
        r.textContent?.includes("On this PC"),
      );
      await act(async () => pc?.focus());
      expect(el.querySelector(".ac-place canvas.ac-computer")?.getAttribute("data-kind")).toBe("windows");
      await press("On this PC");
      expect(el.querySelector("h1")?.textContent).toBe("Let's get this PC ready");
    }));

  test("Have one already? signs in by its address, and back comes to the choice", () =>
    firstRun("first", async ({ el, press }) => {
      await press("Sign in by its address");
      expect(el.querySelector("h1")?.textContent).toBe("Sign in to a workspace that already exists");
      await press("Where will your workspace live?");
      expect(el.querySelector("h1")?.textContent).toBe("Where will your workspace live?");
    }));
});

describe("Install on a server or VPS", () => {
  test("two steps with the command, and the words to send to whoever installs it", async () => {
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    try {
      await firstRun("first", async ({ el, press, until, button }) => {
        await press("On a server or VPS");
        expect(el.querySelector("h1")?.textContent).toBe("Install on a server or VPS");
        expect([...el.querySelectorAll(".dk-fr__ways > li b")].map((b) => b.textContent)).toEqual([
          "On the server, open the Terminal (or connect over SSH) and paste this",
          "At the end a link shows up. Open it here and that's it.",
        ]);
        expect(el.querySelector(".dk-fr__ways code")?.textContent).toBe("curl -fsSL https://agentes.chat/install | sh");
        await press("Copy the instructions");
        await until(() => button("Instructions copied"));
        expect(copied).toHaveLength(1);
        expect(copied[0]).toContain("curl -fsSL https://agentes.chat/install | sh");
        expect(copied[0]).toContain("At the end a link shows up.");
        await press("Sign in by its address");
        expect(el.querySelector("h1")?.textContent).toBe("Sign in to a workspace that already exists");
      });
    } finally {
      if (clipboard) Object.defineProperty(window.navigator, "clipboard", clipboard);
      else delete (window.navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("Connect sends one who has none yet to the install", () =>
    firstRun("first", async ({ el, press }) => {
      await press("Sign in by its address");
      await press("See how to install");
      expect(el.querySelector("h1")?.textContent).toBe("Install on a server or VPS");
    }));
});

/** Types into a React field: the value through the field's own setter, then the event React listens to. */
function typeInto(field: Element | null, value: string) {
  const input = field as HTMLInputElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const pressEscape = () =>
  act(async () => void window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));

/** Run here's form with an email typed in, then Start (in the window's language). */
async function startSetup(
  { el, press, until }: ReturnType<typeof screenOf>,
  words = { place: "On this Mac", start: "Start" },
) {
  await press(words.place);
  await until(() => el.querySelector("form.dk-fr__here"));
  await act(async () => typeInto(el.querySelector('input[type="email"]'), "ana@example.com"));
  await press(words.start);
  await until(() => el.querySelector(".dk-fr__setup"));
}

const stepOf = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>(".dk-fr__steps > li")].find((li) => li.querySelector("b")?.textContent === name);
const runButtons = (el: HTMLElement) => [...el.querySelectorAll(".dk-fr__runacts button")].map((b) => b.textContent);

describe("Setting it up here", () => {
  test("in the window's middle: the computer, the title, the steps, the bar, and Cancel", () =>
    firstRun(
      "first",
      async (screen) => {
        const { el, until } = screen;
        await startSetup(screen);
        await until(() => stepOf(el, "Creating your account")?.dataset.state === "active");
        const setup = el.querySelector(".dk-fr__setup") as HTMLElement;
        expect([...setup.children].map((c) => `${c.tagName.toLowerCase()}.${c.className}`)).toEqual([
          "div.dk-fr__setupart",
          "h1.dk-fr__h1sm",
          "div.dk-fr__run",
        ]);
        // This computer on the sky, the team beside it.
        expect(setup.querySelector(".ac-place")?.getAttribute("data-place")).toBe("here");
        expect(setup.querySelector<HTMLCanvasElement>("canvas.ac-computer")?.dataset).toMatchObject({
          kind: "mac",
          state: "online",
        });
        expect([...(setup.querySelector(".dk-fr__run") as HTMLElement).children].map((c) => c.className)).toEqual([
          "dk-fr__steps",
          "dk-bar",
          "dk-fr__runacts",
        ]);
        expect(setup.querySelector("h1")?.textContent).toBe("Getting everything ready");
        // Screen readers start where they are.
        expect(document.activeElement).toBe(setup.querySelector("h1"));
        expect(runButtons(el)).toEqual(["Cancel"]);
        expect(el.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
        // Before 10 s, no time.
        expect(el.querySelector(".dk-fr__steptime")).toBeNull();
        expect(el.querySelector(".dk-fr__stepline")).toBeNull();
      },
      { here: { hold: "account", pace: 10 } },
    ));

  test("past 30 s: its time, and the slow line with Copy details", () =>
    firstRun(
      "first",
      async (screen) => {
        const { el, until } = screen;
        await startSetup(screen);
        await until(() => stepOf(el, "Turning agentes.chat on")?.dataset.state === "active");
        setSystemTime(new Date(Date.now() + 31_000));
        try {
          await until(() => stepOf(el, "Turning agentes.chat on")?.querySelector(".dk-fr__steptime"));
          const step = stepOf(el, "Turning agentes.chat on") as HTMLElement;
          expect(step.querySelector(".dk-fr__steptime")?.textContent).toBe("0:31");
          expect(step.querySelector(".dk-fr__steptime")?.getAttribute("aria-hidden")).toBe("true");
          expect(step.querySelector(".dk-fr__stepline")?.textContent).toBe(
            "Taking a little longer than expected · Copy details",
          );
          expect(runButtons(el)).toEqual(["Cancel"]);
        } finally {
          setSystemTime();
        }
      },
      { here: { hold: "start", pace: 10 } },
    ));

  test("it stays where it opened: the room above is pinned as it starts, so the slow line grows it downward", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    expect(css.split("\n.dk-fr__setup > :first-child {")[1]?.split("}")[0]).toContain(
      "margin-top: var(--dk-setup-lead, auto);",
    );
    // The room above the drawing as the browser lays it out: the auto margin while the block is centred, or the
    // room pinned on the block.
    let room = 94;
    const g = globalThis as { getComputedStyle: typeof getComputedStyle };
    const real = g.getComputedStyle;
    g.getComputedStyle = (el: Element, pseudo?: string | null) =>
      el instanceof HTMLElement && el.classList.contains("dk-fr__setupart")
        ? ({
            marginTop: el.parentElement?.style.getPropertyValue("--dk-setup-lead") || `${room}px`,
          } as CSSStyleDeclaration)
        : real(el, pseudo);
    try {
      await firstRun(
        "first",
        async (screen) => {
          const { el, until } = screen;
          await startSetup(screen);
          await until(() => stepOf(el, "Turning agentes.chat on")?.dataset.state === "active");
          const lead = () =>
            (el.querySelector(".dk-fr__setup") as HTMLElement).style.getPropertyValue("--dk-setup-lead");
          expect(lead()).toBe("94px");
          // Taller with the slow line: left to the browser, the room above would shrink and the block move up.
          room = 82.6;
          setSystemTime(new Date(Date.now() + 31_000));
          try {
            await until(() => stepOf(el, "Turning agentes.chat on")?.querySelector(".dk-fr__stepline"));
            expect(lead()).toBe("94px");
          } finally {
            setSystemTime();
          }
        },
        { here: { hold: "start", pace: 10 } },
      );
    } finally {
      g.getComputedStyle = real;
    }
  });

  test("words that would run past the window take the room above, no more: Continue stays in view", async () => {
    const g = globalThis as { getComputedStyle: typeof getComputedStyle; ResizeObserver: unknown };
    const real = { style: g.getComputedStyle, observer: g.ResizeObserver };
    g.getComputedStyle = (el: Element, pseudo?: string | null) =>
      el instanceof HTMLElement && el.classList.contains("dk-fr__setupart")
        ? ({ marginTop: "94px" } as CSSStyleDeclaration)
        : real.style(el, pseudo);
    // What the browser reports as the steps, the bar and the buttons grow or shrink.
    let resized = () => {};
    g.ResizeObserver = class {
      report: () => void;
      constructor(report: () => void) {
        this.report = report;
      }
      observe(target: Element) {
        if (target.classList.contains("dk-fr__run")) resized = this.report;
      }
      unobserve() {}
      disconnect() {}
    };
    try {
      await firstRun(
        "first",
        async (screen) => {
          const { el, until, button, press } = screen;
          await press("On this Mac");
          await until(() => el.querySelector("#here-reach:not([disabled])"));
          await act(async () => typeInto(el.querySelector('input[type="email"]'), "ana@example.com"));
          await act(async () => (el.querySelector("#here-reach") as HTMLElement).click());
          await press("Start");
          await until(() => el.querySelector(".dk-fr__setup"));
          const setup = el.querySelector(".dk-fr__setup") as HTMLElement;
          const lead = () => Number.parseFloat(setup.style.getPropertyValue("--dk-setup-lead"));
          // The window shows 546 px of the column: the room above, then the rest.
          let rest = 360;
          const scroller = setup.parentElement as HTMLElement;
          Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 546 });
          Object.defineProperty(scroller, "scrollHeight", {
            configurable: true,
            get: () => Math.max(546, lead() + rest),
          });
          await act(async () => resized());
          expect(lead()).toBe(94);
          await until(() => button("Continue"));
          const words = setup.querySelector(".dk-fr__problem")?.textContent ?? "";
          expect(words).toContain("Give that permission once, in the terminal:");
          // The step first, then where to try again: under the command, last.
          expect(words.indexOf("sudo tailscale set --operator=$USER")).toBeGreaterThan(words.indexOf("terminal:"));
          expect(words.endsWith("Copy Try again in Preferences")).toBe(true);
          expect(setup.querySelector(".dk-fr__cmd + .dk-fr__retry")).not.toBeNull();
          // Tailscale's words and their command, 60 px more than the window shows: the room above gives those 60.
          rest = 512;
          await act(async () => resized());
          expect(lead()).toBe(34);
          expect(scroller.scrollHeight).toBe(scroller.clientHeight);
          // Shorter again (as after Try again), it goes back to where it opened.
          rest = 360;
          await act(async () => resized());
          expect(lead()).toBe(94);
        },
        { here: { fail: "reach", reason: "operator", pace: 10 } },
      );
    } finally {
      g.getComputedStyle = real.style;
      g.ResizeObserver = real.observer;
    }
  });

  test("every reason's end gives its fix first, then where to try again on a line of its own", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    // Under a link or words as under a command: never run on after "Turn it on".
    expect(css.split("\n.dk-fr__problem .dk-fr__retry {")[1]?.split("}")[0]).toContain("display: block;");
    for (const [reason, fix] of [
      ["https", "HTTPS is off on your Tailscale network. Turn it on"],
      ["serve", "Install Tailscale from tailscale.com."],
    ] as const)
      await firstRun(
        "first",
        async ({ el, until, button, press }) => {
          await press("On this Mac");
          await until(() => el.querySelector("#here-reach:not([disabled])"));
          await act(async () => typeInto(el.querySelector('input[type="email"]'), "ana@example.com"));
          await act(async () => (el.querySelector("#here-reach") as HTMLElement).click());
          await press("Start");
          await until(() => button("Continue"));
          const problem = el.querySelector(".dk-fr__problem") as HTMLElement;
          expect({ reason, words: problem.textContent }).toEqual({
            reason,
            words: expect.stringContaining(`${fix} Try again in Preferences`),
          });
          // Last: nothing follows it in the problem's words.
          const retry = problem.querySelector(".dk-fr__retry") as HTMLButtonElement;
          expect(retry.nextSibling).toBeNull();
          // It opens Preferences on Servers, where reach is turned on again.
          await act(async () => retry.click());
          expect(localStorage.getItem("agentes.desktop.prefsTab")).toBe('"servers"');
        },
        { here: { fail: "reach", reason, pace: 10 } },
      );
  });

  test("Cancel stops it, and the form comes back as it was", async () => {
    let cancels = 0;
    let cancelNow: (() => Promise<void>) | null = null;
    await firstRun(
      "first",
      async (screen) => {
        const { el, until, button, press } = screen;
        const switchOn = (id: string) => el.querySelector(`#${id}`)?.getAttribute("aria-checked");
        await press("On this Mac");
        await until(() => el.querySelector("#here-reach:not([disabled])"));
        await act(async () => typeInto(el.querySelector('input[type="email"]'), "ana@example.com"));
        await act(async () => (el.querySelector("#here-reach") as HTMLElement).click());
        await act(async () => (el.querySelector("#here-usage") as HTMLElement).click());
        await press("Start");
        await until(() => stepOf(el, "Creating your account")?.dataset.state === "active");
        await press("Cancel");
        expect(cancels).toBe(1);
        // Busy while what it started stops, the same width.
        expect(button("Cancel")?.getAttribute("aria-busy")).toBe("true");
        await act(async () => cancelNow?.());
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(el.querySelector(".dk-fr__setup")).toBeNull();
        expect((el.querySelector('input[autocomplete="name"]') as HTMLInputElement).value).toBe("Ana Souza");
        expect((el.querySelector('input[type="email"]') as HTMLInputElement).value).toBe("ana@example.com");
        // The switches as they were set, though the undone setup reads as reach off and usage on.
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect([switchOn("here-reach"), switchOn("here-usage")]).toEqual(["true", "false"]);
      },
      {
        here: { hold: "account", pace: 10 },
        host: (host) => {
          const cancel = host.cancelLocalSetup;
          host.cancelLocalSetup = async () => {
            cancels++;
            cancelNow = cancel;
          };
        },
      },
    );
  });

  test("Esc is Cancel while it runs, and after a failure", async () => {
    await firstRun(
      "first",
      async (screen) => {
        await startSetup(screen);
        await screen.until(() => stepOf(screen.el, "Creating your account")?.dataset.state === "active");
        await pressEscape();
        await screen.until(() => screen.el.querySelector("form.dk-fr__here"));
      },
      { here: { hold: "account", pace: 10 } },
    );
    await firstRun(
      "first",
      async (screen) => {
        await startSetup(screen);
        await screen.until(() => screen.button("Try again"));
        await pressEscape();
        await screen.until(() => screen.el.querySelector("form.dk-fr__here"));
      },
      { here: { fail: "start", pace: 10 } },
    );
  });

  test("a failed step: what happened, with Copy details, then Cancel and Try again", async () => {
    let runs = 0;
    await firstRun(
      "first",
      async (screen) => {
        const { el, until, button, press } = screen;
        await startSetup(screen);
        await until(() => button("Try again"));
        const step = stepOf(el, "Turning agentes.chat on") as HTMLElement;
        expect(step.dataset.state).toBe("failed");
        expect(step.querySelector(".dk-honest")?.textContent).toBe(
          "agentes.chat didn't start on this Mac. Copy details",
        );
        expect(runButtons(el)).toEqual(["Cancel", "Try again"]);
        expect(document.activeElement).toBe(button("Try again") ?? null);
        // The computer dims.
        expect(el.querySelector(".dk-fr__setup canvas")?.getAttribute("data-state")).toBe("paused");
        // Try again runs it again (it fails the same way here).
        await press("Try again");
        expect(runs).toBe(2);
        await until(() => button("Try again"));
        await press("Cancel");
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(runs).toBe(2);
      },
      {
        here: { fail: "start", pace: 10 },
        host: (host) => {
          const install = host.installLocalServer;
          host.installLocalServer = (choice) => {
            runs++;
            return install(choice);
          };
        },
      },
    );
  });

  test("an error with no failed step still ends on a step, with its buttons", () =>
    firstRun(
      "first",
      async (screen) => {
        const { el, until, button } = screen;
        await startSetup(screen);
        await until(() => button("Try again"));
        const step = stepOf(el, "Creating your account") as HTMLElement;
        expect(step.dataset.state).toBe("failed");
        expect(step.querySelector(".dk-honest")?.textContent).toBe("Your account wasn't created. Copy details");
        expect(runButtons(el)).toEqual(["Cancel", "Try again"]);
      },
      {
        here: { hold: "account", pace: 10 },
        host: (host) => {
          const install = host.installLocalServer;
          // The steps arrive up to the account, then the app answers with an error and no failed step.
          host.installLocalServer = async (choice) => {
            void install(choice).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 150));
            throw "account";
          };
        },
      },
    ));

  test("shown again mid-setup, the window keeps the setup", () =>
    firstRun(
      "first",
      async (screen) => {
        const { el, until, host } = screen;
        await startSetup(screen);
        await until(() => stepOf(el, "Creating your account")?.dataset.state === "active");
        await act(async () => host.showWindow("welcome"));
        expect(el.querySelector(".dk-fr__setup")).toBeTruthy();
        expect(stepOf(el, "Creating your account")?.dataset.state).toBe("active");
      },
      { here: { hold: "account", pace: 10 } },
    ));

  test("on this PC: the monitor and the PC's words, and in Portuguese", async () => {
    await firstRun(
      "windows",
      async (screen) => {
        const { el, until } = screen;
        await startSetup(screen, { place: "On this PC", start: "Start" });
        await until(() => stepOf(el, "Creating your account")?.dataset.state === "active");
        expect(el.querySelector(".dk-fr__setup canvas.ac-computer")?.getAttribute("data-kind")).toBe("windows");
        expect(el.querySelector(".dk-fr__setup h1")?.textContent).toBe("Getting everything ready");
        expect(stepOf(el, "Calling your agents")?.dataset.state).toBe("todo");
      },
      { here: { hold: "account", pace: 10 } },
    );
    await firstRun(
      "first",
      async (screen) => {
        const { el, until } = screen;
        await startSetup(screen, { place: "Neste Mac", start: "Começar" });
        await until(() => stepOf(el, "Criando a sua conta")?.dataset.state === "active");
        expect(el.querySelector(".dk-fr__setup h1")?.textContent).toBe("Preparando tudo");
        expect(runButtons(el)).toEqual(["Cancelar"]);
      },
      { here: { hold: "account", pace: 10 }, lang: "pt-BR" },
    );
  });
});

describe("Add a workspace", () => {
  /** The welcome window opened by the site's "Add workspace", with agentes.chat signed in here or not. */
  const adding = (cloud: boolean, chosen: (string | undefined)[]) => (host: FakeHost) => {
    host.welcomeMode = async () => "add";
    host.workspaces = async () => [{ server: "https://app.agentes.chat", signedIn: cloud, orgs: [] }];
    host.chooseServer = async (_server, page) => {
      chosen.push(page);
    };
    host.hideWindow = async () => {};
  };

  test("not signed in to agentes.chat: the cloud's row signs in (the workspaces you have), a new one is the line", () => {
    const chosen: (string | undefined)[] = [];
    return firstRun(
      "first",
      async ({ press, until, button }) => {
        await until(() => button("Want a new workspace?") || button("Create one"));
        await press("In the agentes.chat cloud");
        await press("Create one");
        expect(chosen).toEqual(["/login", "/onboarding"]);
        expect(button("Create an account")).toBeUndefined();
      },
      { host: adding(false, chosen) },
    );
  });

  test("signed in to agentes.chat here already: the cloud's row makes a new workspace", () => {
    const chosen: (string | undefined)[] = [];
    return firstRun(
      "first",
      async ({ press, until, button }) => {
        await until(() => button("Create a workspace on agentes.chat"));
        expect(button("Create one")).toBeUndefined();
        await press("Create a workspace on agentes.chat");
        expect(chosen).toEqual(["/onboarding"]);
      },
      { host: adding(true, chosen) },
    );
  });
});
