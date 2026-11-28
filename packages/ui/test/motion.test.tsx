import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { glideHeight, List, MorphRoom, useMorph } from "../src";

afterEach(() => cleanup());

const css = () => Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("motion", () => {
  test("enters and exits are short and live only inside a no-preference block", async () => {
    const all = await css();
    const section = all.slice(all.indexOf("Motion (2026-10)"));
    expect(section.length).toBeGreaterThan(100);
    const outside = section
      .replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "")
      .replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation(-name)?:/);
    // Under reduced motion a change is still seen: a fade in, and nothing else.
    for (const calm of section.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g))
      for (const a of (calm[1] ?? "").matchAll(/animation: ([\w-]+) (\d+)ms/g))
        expect([a[1], a[2]]).toEqual(["ac-fade-in", "120"]);
    // 120–200 ms, opacity and transform only (no layout properties in the keyframes).
    for (const ms of section.matchAll(/animation: [a-z-]+ (\d+)ms/g)) {
      expect(Number(ms[1])).toBeGreaterThanOrEqual(120);
      expect(Number(ms[1])).toBeLessThanOrEqual(200);
    }
    // Exits are faster than entrances; ⌘K, opened by keyboard many times a day, has none.
    expect(section).toContain('.ac-dialog[data-state="closed"]');
    expect(section).toContain('.ac-menu[data-state="closed"]');
    expect(section).toContain(".ac-toast[data-leaving]");
    expect(all).not.toMatch(/\.ac-palette(__scrim)?\[data-state="open"\] \{\s*animation/);
    for (const exit of section.matchAll(/\[data-state="closed"\][^{]*\{\s*animation: [\w-]+ ([^ ]+)/g))
      expect(["var(--dur-fast)", "var(--dur-base)"]).toContain(exit[1] ?? "");
    for (const block of all.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) {
      expect({ name: block[1], layout: /\b(width|height|top|left|margin|padding):/.test(block[2] ?? "") }).toEqual({
        name: block[1],
        layout: false,
      });
    }
  });

  test("a list's first rows show at once; only rows added later rise in", async () => {
    const { container } = render(
      <List>
        <div>Ada</div>
        <div>Atlas</div>
      </List>,
    );
    const list = container.querySelector(".ac-list") as HTMLElement;
    expect(list.classList.contains("ac-list--settled")).toBe(false);
    await wait(50);
    expect(list.classList.contains("ac-list--settled")).toBe(true);
    expect(await css()).not.toContain("ac-list--stagger");
  });

  test("a card changing size glides from its last height, and its old look fades out over the new", () => {
    const calls: { el: Element; frames: Keyframe[] }[] = [];
    const heights = new Map<string, number>([
      ["waiting", 200],
      ["answered", 90],
    ]);
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const { animate, getBoundingClientRect } = proto;
    const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const { getContext } = canvasProto;
    const painted: { onto: Element; from: unknown }[] = [];
    canvasProto.getContext = function (this: HTMLCanvasElement) {
      return { drawImage: (from: unknown) => painted.push({ onto: this, from }) };
    };
    proto.animate = function (this: Element, frames: Keyframe[]) {
      calls.push({ el: this, frames });
      const anim = new EventTarget() as Animation;
      Object.assign(anim, { cancel() {}, currentTime: 0 });
      return anim;
    };
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return { width: 320, height: heights.get(this.dataset.state ?? "") ?? 0 } as DOMRect;
    };
    function Card({ state }: { state: string }) {
      const ref = useRef<HTMLDivElement>(null);
      useMorph(ref, { key: "card-1", live: state === "waiting" });
      return (
        <div ref={ref} data-state={state}>
          <p>{state}</p>
          <canvas width={10} height={10} />
        </div>
      );
    }
    try {
      const view = render(<Card state="waiting" />);
      expect(calls).toHaveLength(0);
      view.rerender(<Card state="answered" />);
      const card = view.container.firstElementChild as HTMLElement;
      const glide = calls.find((c) => c.el === card);
      expect(glide?.frames.map((f) => f.height)).toEqual(["200px", "90px"]);
      const ghost = card.querySelector("[data-morph-ghost]") as HTMLElement;
      expect(ghost.inert).toBe(true);
      expect(ghost.textContent).toBe("waiting");
      expect(calls.find((c) => c.el === ghost)?.frames.at(-1)?.opacity).toBe(0);
      expect(calls.find((c) => c.el === card.firstElementChild)?.frames[0]?.opacity).toBe(0);
      // The copy's canvas shows the card's last frame (its sky), not a blank.
      expect(painted).toEqual([{ onto: ghost.querySelector("canvas") as Element, from: card.querySelector("canvas") }]);
    } finally {
      Object.assign(proto, { animate, getBoundingClientRect });
      canvasProto.getContext = getContext;
    }
  });
  /** Records `animate` calls, answers `getBoundingClientRect` from `heightOf`, and lets a test fire resize observers. */
  function fakeLayout(heightOf: (el: HTMLElement) => number) {
    const calls: { el: Element; frames: Keyframe[]; anim: Animation }[] = [];
    const observers: { fire: () => void; el: Element }[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      animate: proto.animate,
      rect: proto.getBoundingClientRect,
      anims: proto.getAnimations,
      ro: g.ResizeObserver,
    };
    let running: { transitionProperty: string }[] = [];
    proto.animate = function (this: Element, frames: Keyframe[]) {
      const anim = new EventTarget() as Animation;
      Object.assign(anim, { cancel() {}, currentTime: 0 });
      calls.push({ el: this, frames, anim });
      return anim;
    };
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return { width: 320, height: heightOf(this) } as DOMRect;
    };
    proto.getAnimations = () => running;
    g.ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(el: Element) {
        observers.push({ fire: () => this.cb(), el });
      }
      disconnect() {}
    };
    return {
      calls,
      resized: (el: Element) =>
        act(() => {
          for (const o of observers) if (o.el === el) o.fire();
        }),
      cssResizing: (on: boolean) => {
        running = on ? [{ transitionProperty: "grid-template-rows" }] : [];
      },
      restore: () => {
        Object.assign(proto, { animate: saved.animate, getBoundingClientRect: saved.rect, getAnimations: saved.anims });
        g.ResizeObserver = saved.ro;
      },
    };
  }

  test("a box resized with no draw of its own (a fold, a narrower column) glides from where it stands, not from a stale height", () => {
    let h = 40;
    const layout = fakeLayout((el) => (el.dataset.box === undefined ? 0 : h));
    function Box({ n }: { n: number }) {
      const ref = useRef<HTMLDivElement>(null);
      useMorph(ref);
      return (
        <div ref={ref} data-box="">
          {n}
        </div>
      );
    }
    try {
      const view = render(<Box n={1} />);
      const box = view.container.firstElementChild as HTMLElement;
      // Its fold opens by CSS: no draw of the box, its observer sees it.
      h = 300;
      layout.resized(box);
      // Its steps load and it draws again a little taller: it glides from 300, never back from 40.
      h = 320;
      view.rerender(<Box n={2} />);
      expect(layout.calls.filter((c) => c.el === box).map((c) => c.frames.map((f) => f.height))).toEqual([
        ["300px", "320px"],
      ]);
      // While a CSS transition still resizes what is inside, the box isn't pinned to a height.
      layout.cssResizing(true);
      h = 500;
      view.rerender(<Box n={3} />);
      expect(layout.calls.filter((c) => c.el === box)).toHaveLength(1);
    } finally {
      layout.restore();
    }
  });

  test("a room emptied stays drawn while it glides shut, then takes no room", async () => {
    const layout = fakeLayout((el) => (el.classList.contains("ac-morph__in") ? el.childElementCount * 60 : 0));
    try {
      const view = render(
        <MorphRoom>
          <p>notice</p>
        </MorphRoom>,
      );
      const room = view.container.firstElementChild as HTMLElement;
      const inner = room.firstElementChild as HTMLElement;
      view.rerender(<MorphRoom>{null}</MorphRoom>);
      layout.resized(inner);
      const glide = layout.calls.find((c) => c.el === room);
      expect(glide?.frames.map((f) => f.height)).toEqual(["60px", "0px"]);
      expect(room.hasAttribute("data-closing")).toBe(true);
      glide?.anim.dispatchEvent(new Event("finish"));
      expect(room.hasAttribute("data-closing")).toBe(false);
      expect(await css()).toContain(".ac-morph:not([data-closing]):has(> .ac-morph__in:empty)");
    } finally {
      layout.restore();
    }
  });

  test("a box drawn again mid-glide to the same height goes on from where it was, instead of throwing", () => {
    // As browsers do: a cancelled animation's time is unresolved, and setting a running one's to that throws.
    class Glide extends EventTarget {
      #time: number | null = 0;
      get currentTime() {
        return this.#time;
      }
      set currentTime(t: number | null) {
        if (t === null) throw new TypeError("currentTime may not be changed from resolved to unresolved");
        this.#time = t;
      }
      cancel() {
        this.#time = null;
      }
    }
    const made: Glide[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const { animate, getBoundingClientRect } = proto;
    proto.animate = () => {
      const glide = new Glide();
      made.push(glide);
      return glide;
    };
    // 90 at rest; mid-glide, where the running glide holds it.
    const gliding = () => made.length > 0 && made[made.length - 1]?.currentTime !== null;
    proto.getBoundingClientRect = () => ({ width: 320, height: gliding() ? 150 : 90 }) as DOMRect;
    try {
      const box = document.createElement("div");
      glideHeight(box, 200);
      (made[0] as Glide).currentTime = 120;
      expect(() => glideHeight(box, 200)).not.toThrow();
      expect(made[1]?.currentTime).toBe(120);
    } finally {
      Object.assign(proto, { animate, getBoundingClientRect });
    }
  });
});
