import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { fireEvent } from "@testing-library/react";
import { EDGE_ROOM, TIP_GAP } from "../src/floating";
import { installTitleTips, TITLE_TIP_GRACE_MS, TITLE_TIP_ID, TITLE_TIP_OPEN_MS } from "../src/title-tips";
import { box, place, step, tick } from "../testing";

/** The tip's box in these tests: happy-dom lays nothing out. */
const TIP = { width: 200, height: 24 };
const sizes = ["offsetWidth", "offsetHeight"] as const;
let off: () => void;
/** What the tests replace on the window every DOM file shares, to put back. */
const real = new Map<string, PropertyDescriptor | undefined>();
const restore = (on: object, key: string) => {
  const was = real.get(key);
  if (was) Object.defineProperty(on, key, was);
  else delete (on as Record<string, unknown>)[key];
};

beforeEach(async () => {
  jest.useFakeTimers();
  // The pointer leads, whatever an earlier file's keys did.
  await step(() => fireEvent.pointerDown(document.body));
  for (const key of sizes) {
    real.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.id === TITLE_TIP_ID ? TIP[key === "offsetWidth" ? "width" : "height"] : 0;
      },
    });
  }
  real.set("innerWidth", Object.getOwnPropertyDescriptor(window, "innerWidth"));
  off = installTitleTips();
});
afterEach(async () => {
  off();
  document.body.innerHTML = "";
  // The pointer leads again, whatever the test's keys did.
  await step(() => {
    fireEvent.keyUp(document.body, { key: "Tab" });
    fireEvent.pointerDown(document.body);
  });
  for (const key of sizes) restore(HTMLElement.prototype, key);
  restore(window, "innerWidth");
  // As hover-card.test.tsx: happy-dom's own 0 ms batch must not be dropped while timers are fake.
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const page = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
};
const wide = (px: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: px });
const tip = () => document.getElementById(TITLE_TIP_ID);
const over = (el: Element, init: object = {}) =>
  step(() => fireEvent.pointerOver(el, { pointerType: "mouse", ...init }));
const out = (el: Element, to: Element | null = null) =>
  step(() => fireEvent.pointerOut(el, { pointerType: "mouse", relatedTarget: to }));
const tabTo = (el: HTMLElement) =>
  step(() => {
    fireEvent.keyDown(document.body, { key: "Tab" });
    el.focus();
    fireEvent.keyUp(document.body, { key: "Tab" });
  });
// The icon's stand-in: an unsized <svg> in a bare button is a 300px box the layout check would measure.
const ICON = '<span aria-hidden="true"></span>';

describe("a `title` opens the product's tip, never the browser's", () => {
  test("after the delay under a mouse; the title is held meanwhile and given back on leave", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    await over(pin);
    // Emptied at first contact: the browser has nothing to show. Named only by its title, it keeps the name.
    expect(pin.getAttribute("title")).toBe("");
    expect(pin.getAttribute("aria-label")).toBe("Fixar");
    await tick(TITLE_TIP_OPEN_MS - 1);
    expect(tip()).toBeNull();
    await tick(1);
    expect(tip()?.textContent).toBe("Fixar");
    expect(tip()?.getAttribute("role")).toBe("tooltip");
    expect(tip()?.className).toBe("ac-tip ac-tip--title");
    // The last thing in <body>: over whatever dialog or popover opened before it.
    expect(document.body.lastElementChild).toBe(tip());
    await out(pin);
    expect(tip()).toBeNull();
    expect(pin.getAttribute("title")).toBe("Fixar");
    expect(pin.hasAttribute("aria-label")).toBe(false);
  });

  test("an element with a name of its own is described by the shown tip, unless they say the same", async () => {
    const members = page(`<button title="Esconder membros" aria-label="Membros do canal (4)">${ICON}</button>`);
    await over(members);
    expect(members.hasAttribute("aria-describedby")).toBe(false);
    await tick(TITLE_TIP_OPEN_MS);
    expect(members.getAttribute("aria-label")).toBe("Membros do canal (4)");
    expect(members.getAttribute("aria-describedby")).toBe(TITLE_TIP_ID);
    expect(tip()?.hasAttribute("aria-hidden")).toBe(false);
    await out(members);
    expect(members.hasAttribute("aria-describedby")).toBe(false);

    const chip = page('<button title="Ana reagiu com 🎉" aria-label="Ana reagiu com 🎉">🎉 1</button>');
    await over(chip);
    await tick(TITLE_TIP_OPEN_MS);
    expect(tip()?.textContent).toBe("Ana reagiu com 🎉");
    expect(chip.hasAttribute("aria-describedby")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Ana reagiu com 🎉");

    // Cut words with their whole text as the title: shown, never read twice.
    const name = page('<span title="Ana Beatriz Lima">Ana Beatriz Lima</span>');
    await over(name);
    await tick(TITLE_TIP_OPEN_MS);
    expect(name.hasAttribute("aria-describedby")).toBe(false);
    expect(tip()?.getAttribute("aria-hidden")).toBe("true");

    // Named by the face inside: the title describes it, the name stays the face's.
    const face = page('<button title="Abrir perfil"><img alt="Ana"></button>');
    await over(face);
    await tick(TITLE_TIP_OPEN_MS);
    expect(face.hasAttribute("aria-label")).toBe(false);
    expect(face.getAttribute("aria-describedby")).toBe(TITLE_TIP_ID);
  });

  test("at once on the keys' focus, not on a pointer's; Escape closes it where the focus is", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    await step(() => pin.focus());
    expect(tip()).toBeNull();
    expect(pin.getAttribute("title")).toBe("Fixar");
    await step(() => pin.blur());
    await tabTo(pin);
    expect(tip()?.textContent).toBe("Fixar");
    await step(() => fireEvent.keyDown(pin, { key: "Escape" }));
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(pin);
    await step(() => pin.blur());
    expect(pin.getAttribute("title")).toBe("Fixar");
  });

  test("a scroll or a press closes it, and it stays closed until the pointer leaves", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    for (const close of [() => fireEvent.scroll(document), () => fireEvent.pointerDown(pin)]) {
      await over(pin);
      await tick(TITLE_TIP_OPEN_MS);
      expect(tip()).not.toBeNull();
      await step(close);
      expect(tip()).toBeNull();
      // Still held: neither tooltip opens under a pointer that stays.
      expect(pin.getAttribute("title")).toBe("");
      await over(pin);
      await tick(TITLE_TIP_OPEN_MS * 2);
      expect(tip()).toBeNull();
      await out(pin);
      expect(pin.getAttribute("title")).toBe("Fixar");
    }
    // A scroll that does not move it (another column) leaves it open.
    const log = document.body.appendChild(document.createElement("div"));
    await out(pin);
    await over(pin);
    await tick(TITLE_TIP_OPEN_MS);
    await step(() => fireEvent.scroll(log));
    expect(tip()).not.toBeNull();
    await out(pin);
    await tick(TITLE_TIP_GRACE_MS);
    // Under the keys it stays through the scroll that brings its element into view.
    await tabTo(pin);
    await step(() => fireEvent.scroll(document));
    expect(tip()).not.toBeNull();
    await step(() => pin.blur());
    await step(() => fireEvent.pointerDown(document.body));
    // A drag let go over it rests there: the title is held and the tip opens, as after a move onto it.
    await over(pin, { buttons: 1 });
    expect(pin.getAttribute("title")).toBe("Fixar");
    await step(() => fireEvent.pointerUp(pin, { pointerType: "mouse" }));
    expect(pin.getAttribute("title")).toBe("");
    await tick(TITLE_TIP_OPEN_MS);
    expect(tip()?.textContent).toBe("Fixar");
    await out(pin);
    await tick(TITLE_TIP_GRACE_MS);
    // A press before it opened: it never opens.
    await over(pin);
    await step(() => fireEvent.pointerDown(pin));
    await tick(TITLE_TIP_OPEN_MS * 2);
    expect(tip()).toBeNull();
  });

  test("moving from one tip to the next: no wait within the grace, the full wait after it", async () => {
    page(`<button id="a" title="Fixar">${ICON}</button><button id="b" title="Buscar">${ICON}</button>`);
    const a = document.getElementById("a") as HTMLElement;
    const b = document.getElementById("b") as HTMLElement;
    await over(a);
    await tick(TITLE_TIP_OPEN_MS);
    await out(a, b);
    await tick(TITLE_TIP_GRACE_MS - 1);
    await over(b);
    expect(tip()?.textContent).toBe("Buscar");
    expect(tip()?.classList.contains("ac-tip--now")).toBe(true);
    expect(document.querySelectorAll(`#${TITLE_TIP_ID}`).length).toBe(1);
    await out(b, a);
    await tick(TITLE_TIP_GRACE_MS);
    await over(a);
    expect(tip()).toBeNull();
    await tick(TITLE_TIP_OPEN_MS);
    expect(tip()?.textContent).toBe("Fixar");
    expect(tip()?.classList.contains("ac-tip--now")).toBe(false);
  });

  test("never under a finger: the title stays the browser's", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    await over(pin, { pointerType: "touch" });
    await tick(TITLE_TIP_OPEN_MS * 2);
    expect(tip()).toBeNull();
    expect(pin.getAttribute("title")).toBe("Fixar");
  });

  test("a title that changes while shown changes the tip; one that is dropped closes it and is not given back", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    await over(pin);
    await tick(TITLE_TIP_OPEN_MS);
    await step(() => pin.setAttribute("title", "Desafixar"));
    await tick(0);
    expect(tip()?.textContent).toBe("Desafixar");
    expect(pin.getAttribute("title")).toBe("");
    expect(pin.getAttribute("aria-label")).toBe("Desafixar");
    await step(() => pin.removeAttribute("title"));
    await tick(0);
    expect(tip()).toBeNull();
    await out(pin);
    expect(pin.hasAttribute("title")).toBe(false);
    expect(pin.hasAttribute("aria-label")).toBe(false);

    // Emptied by the page while held: the old words never come back.
    pin.setAttribute("title", "Fixar");
    await over(pin);
    await tick(TITLE_TIP_OPEN_MS);
    await step(() => pin.setAttribute("title", "Desafixar"));
    await tick(0);
    await step(() => pin.setAttribute("title", ""));
    await tick(0);
    expect(tip()).toBeNull();
    await out(pin);
    expect(pin.getAttribute("title")).toBe("");
  });

  test("it goes with an element the page removes", async () => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    await over(pin);
    await tick(TITLE_TIP_OPEN_MS);
    await step(() => pin.remove());
    await tick(0);
    expect(tip()).toBeNull();
  });
});

describe("what carries a tip", () => {
  const shows = async (el: Element) => {
    await over(el);
    await tick(TITLE_TIP_OPEN_MS);
    const text = tip()?.textContent ?? null;
    await out(el);
    return text;
  };

  test("an icon-only control says its label; one with words, a hover card or an open menu does not", async () => {
    expect(await shows(page(`<button aria-label="Reagir">${ICON}</button>`))).toBe("Reagir");
    expect(await shows(page(`<a href="/x" aria-label="Abrir">${ICON}</a>`))).toBe("Abrir");
    expect(await shows(page('<button aria-label="Enviar agora">Enviar</button>'))).toBeNull();
    expect(await shows(page(`<button aria-label="Perfil de Ana" data-no-tip="">${ICON}</button>`))).toBeNull();
    expect(await shows(page(`<button aria-label="O que é" aria-describedby="hint">${ICON}</button>`))).toBeNull();
    expect(await shows(page(`<button aria-label="Mais" aria-expanded="true">${ICON}</button>`))).toBeNull();
    expect(await shows(page(`<button role="switch" aria-label="Sons">${ICON}</button>`))).toBeNull();
  });

  test("a button's words cut short by its place are said whole; whole ones say nothing", async () => {
    const cut = (scroll: number) => {
      const button = page('<button><span class="ac-btn__label">Usar Conta compartilhada do time · Max</span></button>');
      const label = button.firstElementChild as HTMLElement;
      Object.defineProperty(label, "scrollWidth", { configurable: true, value: scroll });
      Object.defineProperty(label, "clientWidth", { configurable: true, value: 120 });
      return button;
    };
    expect(await shows(cut(240))).toBe("Usar Conta compartilhada do time · Max");
    expect(await shows(cut(120))).toBeNull();
  });

  test("a label's tip inside a titled row: the row's title stays closed in the browser meanwhile", async () => {
    const row = page(`<div title="Linha"><button aria-label="Fechar">${ICON}</button></div>`);
    const close = row.querySelector("button") as HTMLElement;
    await over(close);
    expect(close.getAttribute("title")).toBe("");
    await tick(TITLE_TIP_OPEN_MS);
    expect(tip()?.textContent).toBe("Fechar");
    // It repeats the button's name: hidden from a screen reader, which already said it.
    expect(tip()?.getAttribute("aria-hidden")).toBe("true");
    await out(close, row);
    expect(close.hasAttribute("title")).toBe(false);
    expect(row.getAttribute("title")).toBe("Linha");
  });

  test("the nearest title, as the browser picks it; an empty one says nothing", async () => {
    const row = page('<div title="Linha"><button>Abrir</button><span title="">calado</span></div>');
    expect(await shows(row.querySelector("button") as Element)).toBe("Linha");
    expect(await shows(row.querySelector("span") as Element)).toBeNull();
    expect(row.getAttribute("title")).toBe("Linha");
  });

  test("line breaks are kept", async () => {
    const day = page("<span>seg</span>");
    day.setAttribute("title", "segunda\n1.200 tokens");
    expect(await shows(day)).toBe("segunda\n1.200 tokens");
  });

  test("an SVG's <title>, a frame's name and a field's validation hint stay the browser's", async () => {
    const svg = page("<svg><title>Gráfico</title><rect></rect></svg>");
    expect(await shows(svg.querySelector("rect") as Element)).toBeNull();
    const frame = page('<iframe title="Prévia"></iframe>');
    await over(frame);
    expect(frame.getAttribute("title")).toBe("Prévia");
    const field = page('<input pattern="[0-9]+" title="Só números">');
    await over(field);
    await tabTo(field);
    expect(field.getAttribute("title")).toBe("Só números");
    expect(tip()).toBeNull();
  });
});

describe("where it goes", () => {
  const open = async (at: DOMRect, init: object = {}) => {
    const pin = page(`<button title="Fixar">${ICON}</button>`);
    place(pin, at);
    await over(pin, init);
    await tick(TITLE_TIP_OPEN_MS);
    return tip() as HTMLElement;
  };

  test("centred over its element, under it at the window's top", async () => {
    wide(1280);
    const over600 = await open(box(600, 100, 32, 32));
    expect(over600.style.left).toBe(`${600 + 16 - TIP.width / 2}px`);
    expect(over600.style.top).toBe(`${100 - TIP_GAP - TIP.height}px`);
    const top = await open(box(600, 8, 32, 32));
    expect(top.style.top).toBe(`${8 + 32 + TIP_GAP}px`);
  });

  test("in a column of tiles that asks for it, beside its element on the right, centred on it", async () => {
    wide(1280);
    const column = page(`<div data-tip-side="right"><button title="Drive">${ICON}</button></div>`);
    const tile = column.firstElementChild as HTMLElement;
    place(tile, box(12, 200, 40, 40));
    await over(tile);
    await tick(TITLE_TIP_OPEN_MS);
    const shown = tip() as HTMLElement;
    expect(shown.style.left).toBe(`${52 + TIP_GAP}px`);
    expect(shown.style.top).toBe(`${200 + 20 - TIP.height / 2}px`);
    expect(shown.dataset.side).toBe("right");
  });

  test("inside a 320px window, the edges' room kept", async () => {
    wide(320);
    const right = await open(box(280, 100, 32, 32));
    expect(right.style.left).toBe(`${320 - EDGE_ROOM - TIP.width}px`);
    const left = await open(box(4, 100, 32, 32));
    expect(left.style.left).toBe(`${EDGE_ROOM}px`);
  });

  test("a long one with no room over or under its element stays whole in the window", async () => {
    wide(1280);
    TIP.height = 700;
    const tall = await open(box(600, 400, 32, 32));
    TIP.height = 24;
    expect(tall.style.top).toBe(`${window.innerHeight - EDGE_ROOM - 700}px`);
  });

  test("by the pointer on a whole row", async () => {
    wide(1280);
    const row = await open(box(0, 100, 800, 40), { clientX: 700, clientY: 120 });
    expect(row.style.left).toBe(`${700 - TIP.width / 2}px`);
    expect(row.style.top).toBe(`${100 - TIP_GAP - TIP.height}px`);
  });

  test("long words wrap at a label's width and are never cut", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = css.split(".ac-tip--title {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain(`max-width: min(280px, calc(100vw - ${2 * EDGE_ROOM}px))`);
    expect(rule).toContain("white-space: pre-line");
    expect(rule).not.toContain("overflow");
    expect(css.split(".ac-tip {")[1]?.split("}")[0]).toContain("overflow-wrap: anywhere");
    // Over a toast: its buttons carry tips too.
    expect(rule).toContain("z-index: var(--z-toast)");
    expect(css).toMatch(/\.ac-tip--now \{\s*animation: none;/);
  });

  test("every window installs it: the web app and the desktop windows", async () => {
    for (const main of ["../../../apps/web/src/main.tsx", "../../../apps/desktop/src/main.tsx"]) {
      const source = await Bun.file(new URL(main, import.meta.url).pathname).text();
      expect(source).toMatch(/^installTitleTips\(\);$/m);
    }
  });
});
