import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { codeKeyLabel, codeKeyOf, emitCodeKey, takeCodeKey, withKey } from "../src/components/code/shortcuts";

/** A key press as the browser reports it: nothing held unless said. */
const press = (key: string, code: string, held: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {}) => ({
  key,
  code,
  metaKey: held.meta ?? false,
  ctrlKey: held.ctrl ?? false,
  altKey: held.alt ?? false,
  shiftKey: held.shift ?? false,
});

describe("the Code page's keys (ADR 0215)", () => {
  test("⌘ on Apple platforms, Ctrl elsewhere, never both", () => {
    expect(codeKeyOf(press("p", "KeyP", { meta: true }), true)).toBe("files");
    expect(codeKeyOf(press("p", "KeyP", { ctrl: true }), true)).toBeNull();
    expect(codeKeyOf(press("p", "KeyP", { ctrl: true }), false)).toBe("files");
    expect(codeKeyOf(press("p", "KeyP", { meta: true }), false)).toBeNull();
    expect(codeKeyOf(press("p", "KeyP", { meta: true, ctrl: true }), true)).toBeNull();
  });

  test("each key, and none with Shift or without the modifier", () => {
    expect(codeKeyOf(press("j", "KeyJ", { meta: true }), true)).toBe("terminal");
    expect(codeKeyOf(press("ArrowUp", "ArrowUp", { meta: true, alt: true }), true)).toBe("prevSession");
    expect(codeKeyOf(press("ArrowDown", "ArrowDown", { meta: true, alt: true }), true)).toBe("nextSession");
    expect(codeKeyOf(press("P", "KeyP", { meta: true, shift: true }), true)).toBeNull();
    expect(codeKeyOf(press("p", "KeyP"), true)).toBeNull();
    // ⌘↑ alone is the text field's own (the start of the text).
    expect(codeKeyOf(press("ArrowUp", "ArrowUp", { meta: true }), true)).toBeNull();
  });

  test("with ⌥ held a Mac types another character: the physical key says which", () => {
    expect(codeKeyOf(press("˜", "KeyN", { meta: true, alt: true }), true)).toBe("newSession");
    expect(codeKeyOf(press("n", "KeyN", { ctrl: true, alt: true }), false)).toBe("newSession");
    // ⌘P with ⌥ is not the files' key.
    expect(codeKeyOf(press("π", "KeyP", { meta: true, alt: true }), true)).toBeNull();
  });

  test("how a key reads on each platform, and in a button's tooltip", () => {
    expect(codeKeyLabel("files", true)).toBe("⌘P");
    expect(codeKeyLabel("newSession", true)).toBe("⌥⌘N");
    expect(codeKeyLabel("prevSession", true)).toBe("⌥⌘↑");
    expect(codeKeyLabel("files", false)).toBe("Ctrl+P");
    expect(codeKeyLabel("newSession", false)).toBe("Ctrl+Alt+N");
    expect(codeKeyLabel("nextSession", false)).toBe("Ctrl+Alt+Down");
    expect(withKey("Find a file", "files")).toMatch(/^Find a file \((⌘P|Ctrl\+P)\)$/);
  });

  test("a key waits a moment for the piece it opens, and is answered once", () => {
    emitCodeKey("files");
    expect(takeCodeKey("files")).toBe(true);
    expect(takeCodeKey("files")).toBe(false);
    // A key nobody asked for is never taken.
    expect(takeCodeKey("terminal")).toBe(false);
  });
});
