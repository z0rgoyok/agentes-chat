import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

/**
 * happy-dom lays nothing out. Here the card's row is 600px wide, its two tool groups 64px each (the text beside them
 * 472px), the box 8px of padding a side, 20px a line under 8px of padding (one line: 28px, its min-height), and its
 * words 8px a character. A canvas measures them 7.5px a character: it knows nothing of the app's font-size-adjust,
 * which draws them bigger than their font size.
 */
const ROW = 600;
const TOOLS = 64;
const CHAR = 8;

function laidOut() {
  const width = (el: HTMLTextAreaElement) => {
    if (el.style.width.endsWith("px")) return Number.parseFloat(el.style.width);
    return el.closest(".ac-composer")?.hasAttribute("data-wide") ? ROW : ROW - 2 * TOOLS;
  };
  const lines = (el: HTMLTextAreaElement) =>
    el.value
      .split("\n")
      .reduce((sum, part) => sum + Math.max(1, Math.ceil((part.length * CHAR) / (width(el) - 16))), 0);
  // Height "auto" is the box's one row.
  const height = (el: HTMLTextAreaElement) =>
    el.style.height.endsWith("px") ? Number.parseFloat(el.style.height) : 28;
  const area = HTMLTextAreaElement.prototype;
  Object.defineProperty(area, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return Math.max(8 + 20 * lines(this), height(this));
    },
  });
  Object.defineProperty(area, "clientHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return height(this);
    },
  });
  Object.defineProperty(area, "offsetHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return height(this);
    },
  });
  const proto = HTMLElement.prototype;
  const was = {
    offsetWidth: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  };
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this instanceof HTMLTextAreaElement) return width(this);
      return this.classList.contains("ac-composer__tools") ? TOOLS : 0;
    },
  });
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("ac-composer__row") ? ROW : 0;
    },
  });
  // This DOM doesn't cascade the kit's CSS: the box's own padding and one line's height.
  const computed = globalThis.getComputedStyle.bind(globalThis);
  const style = spyOn(globalThis, "getComputedStyle").mockImplementation(((el: Element) =>
    el instanceof HTMLTextAreaElement
      ? ({ minHeight: "28px", paddingLeft: "8px", paddingRight: "8px", font: "14px sans-serif" } as never)
      : computed(el)) as typeof getComputedStyle);
  const pen = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ font: "", measureText: (text: string) => ({ width: text.length * 7.5 }) }) as never,
  );
  return () => {
    pen.mockRestore();
    style.mockRestore();
    for (const key of ["scrollHeight", "clientHeight", "offsetHeight"]) Reflect.deleteProperty(area, key);
    for (const [key, descriptor] of Object.entries(was)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
}

function Chat() {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={() => setValue("")}
      label="Mensagem para #geral"
      sendLabel="Enviar"
      attachLabel="Anexar arquivo"
    />
  );
}

/** `n` characters of words. */
const words = (n: number) => "palavra ".repeat(Math.ceil(n / 8)).slice(0, n);

describe("the composer past one line", () => {
  test("goes wide when the words wrap beside the tools and back once they fit there, never flipping on its own", async () => {
    const restore = laidOut();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Chat />);
      const box = screen.getByRole("textbox") as HTMLTextAreaElement;
      const card = () => box.closest(".ac-composer") as HTMLElement;
      const type = (value: string) => act(async () => fireEvent.change(box, { target: { value } }));

      // 50 characters: 400px, one line beside the tools (456px of text).
      await type(words(50));
      expect(card().hasAttribute("data-wide")).toBe(false);
      // 58: 464px wraps beside the tools. The canvas called it 435px, room enough, and flipped the box back and forth
      // until React gave up ("Maximum update depth exceeded"), taking the conversation down with it.
      await type(words(58));
      expect(box.isConnected).toBe(true);
      expect(card().hasAttribute("data-wide")).toBe(true);
      await type(words(60));
      expect(card().hasAttribute("data-wide")).toBe(true);
      // Changed in the middle, still too long for the row beside the tools: it stays wide, the box measured and put back.
      await type(`X${words(60).slice(1)}`);
      expect(card().hasAttribute("data-wide")).toBe(true);
      expect(box.style.width).toBe("");
      // Back to 52 characters (416px): they fit beside the tools again.
      await type(words(52));
      expect(card().hasAttribute("data-wide")).toBe(false);
      // A long text pasted in one go.
      await type(words(5000));
      expect(box.isConnected).toBe(true);
      expect(card().hasAttribute("data-wide")).toBe(true);
      await type("");
      expect(card().hasAttribute("data-wide")).toBe(false);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("Maximum update depth");
    } finally {
      errors.mockRestore();
      restore();
    }
  });
});
