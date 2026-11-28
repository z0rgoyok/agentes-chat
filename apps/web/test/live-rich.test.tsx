import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { LOCAL, REMOTE } from "@agenteschat/live";
import { type RichDoc, readRich, writeRich } from "@agenteschat/live/rich";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { createRef } from "react";
import { absolutePositionToRelativePosition, ySyncPluginKey } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  capsWholeText,
  colorWholeText,
  listNumbers,
  markWholeText,
  normalizeHref,
  RichText,
  type RichTextHandle,
  RichView,
  richSchema,
  setRichCaps,
  setRichColor,
  setRichLineHeight,
  setRichLink,
  setRichType,
  setWholeParagraphs,
  shiftRichLevel,
  shiftWholeLevels,
  toggleRichList,
  toggleRichMark,
  typeWholeText,
  wholeFormat,
} from "@/components/live/rich";
import { liftParagraph, splitParagraph } from "@/components/live/rich/commands";

/**
 * Rich text in live files (ADR 0196 §2, §5): the ProseMirror editor bound to a box's `Y.XmlFragment` (what is typed
 * lands in the document as the person's own change, others' changes come in, the toolbar's commands, the keys and
 * typed shortcuts, other people's carets), the drawn text, and formatting a whole box at once.
 */

afterEach(() => cleanup());

function boxWith(rich: RichDoc) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("text");
  writeRich(fragment, rich);
  return { doc, fragment };
}

function mount(fragment: Y.XmlFragment, props: Partial<Parameters<typeof RichText>[0]> = {}) {
  const ref = createRef<RichTextHandle>();
  const result = render(<RichText ref={ref} fragment={fragment} label="Texto" {...props} />);
  const view = (): EditorView => {
    const v = ref.current?.view();
    if (!v) throw new Error("no editor");
    return v;
  };
  return { ...result, ref, view };
}

/** Selects from `from` to `to` (ProseMirror positions). */
function select(view: EditorView, from: number, to = from) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Types as the keyboard does, so the typed shortcuts run ("- " starts a list). */
function typeText(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

describe("the schema and numbering", () => {
  test("the schema has the stored nodes and marks", () => {
    expect(Object.keys(richSchema.nodes).sort()).toEqual(["doc", "hard_break", "paragraph", "text"]);
    expect(Object.keys(richSchema.marks).sort()).toEqual([
      "bold",
      "caps",
      "color",
      "font",
      "highlight",
      "italic",
      "link",
      "size",
      "strike",
      "tracking",
      "underline",
      "weight",
    ]);
  });

  test("numbered items count per list and level; anything else at that level starts again", () => {
    expect(
      listNumbers([
        { list: "ordered" },
        { list: "ordered" },
        { list: "ordered", level: 1 },
        { list: "ordered", level: 1 },
        { list: "ordered" },
        {},
        { list: "ordered" },
        { list: "bullet" },
      ]),
    ).toEqual([1, 2, 1, 2, 3, null, 1, null]);
  });

  test("an address typed plainly becomes a link we keep", () => {
    expect(normalizeHref("acme.com")).toBe("https://acme.com");
    expect(normalizeHref("ada@acme.com")).toBe("mailto:ada@acme.com");
    expect(normalizeHref("https://acme.com/x")).toBe("https://acme.com/x");
    expect(normalizeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeHref("")).toBeNull();
  });
});

describe("RichView", () => {
  test("draws the type marks (ADR 0220): font, size, weight, highlight, letter spacing, capitals; never a bad value", () => {
    const { container } = render(
      <RichView
        doc={[
          {
            lineHeight: 1.6,
            spaceAfter: 12,
            runs: [
              { text: "Brand", font: "inter", size: 30, weight: 600, highlight: "#ffff00", tracking: 80, caps: true },
              { text: " bad", font: "not-a-font", size: 9999 },
            ],
          },
        ]}
      />,
    );
    const spans = [...container.querySelectorAll("span[style]")] as HTMLElement[];
    const css = spans.map((s) => s.getAttribute("style") ?? "").join(";");
    expect(css).toContain("Inter");
    expect(css).toContain("font-size: 30px");
    expect(css).toContain("font-weight: 600");
    expect(css).toContain("letter-spacing: 0.08em");
    expect(css).toContain("text-transform: uppercase");
    expect(css).toContain("background-color");
    expect(css).not.toContain("not-a-font");
    expect(css).not.toContain("9999");
    const p = container.querySelector("p") as HTMLElement;
    expect(p.style.lineHeight).toBe("1.6");
    expect(p.style.marginBottom).toBe("12px");
  });

  test("draws marks, lists, safe links and colors; never an unsafe one", () => {
    const { container } = render(
      <RichView
        doc={[
          { runs: [{ text: "Bold", bold: true }, { text: " and " }, { text: "red", color: "#c00000" }] },
          { list: "ordered", runs: [{ text: "First" }] },
          { list: "ordered", runs: [{ text: "Second" }] },
          {
            runs: [
              { text: "site", link: "https://acme.com" },
              { text: " bad", link: "javascript:alert(1)" },
            ],
          },
          { runs: [{ text: "x", color: "url(evil)" }] },
        ]}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect((container.querySelector("span[style]") as HTMLElement | null)?.style.color).toBeTruthy();
    const items = [...container.querySelectorAll("p[data-list='ordered']")].map((p) => p.getAttribute("data-n"));
    expect(items).toEqual(["1", "2"]);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://acme.com"]);
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain(" bad");
    expect(container.innerHTML).not.toContain("url(evil)");
  });

  test("an empty text shows its hint only when given one", () => {
    const { container, rerender } = render(<RichView doc={[]} placeholder="Clique para adicionar um título" />);
    expect(container.querySelector(".rt-empty")?.getAttribute("data-placeholder")).toBe(
      "Clique para adicionar um título",
    );
    rerender(<RichView doc={[]} />);
    expect(container.querySelector(".rt-empty")).toBeNull();
  });
});

describe("RichText", () => {
  test("shows the box's text and writes what is typed into it, undone by the file's undo", () => {
    const { doc, fragment } = boxWith([{ runs: [{ text: "Olá" }] }]);
    const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([LOCAL]) });
    const { container, view } = mount(fragment, { undoManager: undo });
    expect(container.querySelector(".rt-editor")?.textContent).toBe("Olá");
    act(() => {
      select(view(), 4);
      view().dispatch(view().state.tr.insertText(", Ada"));
    });
    expect(readRich(fragment)).toEqual([{ runs: [{ text: "Olá, Ada" }] }]);
    // Typing is the person's own: the file's undo takes it back.
    act(() => {
      undo.undo();
    });
    expect(readRich(fragment)).toEqual([{ runs: [{ text: "Olá" }] }]);
    expect(container.querySelector(".rt-editor")?.textContent).toBe("Olá");
    // Someone else's change comes in, and undo never takes it back.
    act(() => {
      doc.transact(() => writeRich(fragment, [{ runs: [{ text: "Olá, Atlas" }] }]), REMOTE);
    });
    expect(container.querySelector(".rt-editor")?.textContent).toBe("Olá, Atlas");
    expect(undo.canUndo()).toBe(false);
  });

  test("the toolbar's commands: marks, color, link, list and level", () => {
    const { fragment } = boxWith([{ runs: [{ text: "acme site" }] }]);
    const { ref, view } = mount(fragment);
    act(() => {
      select(view(), 1, 5);
      ref.current?.run(toggleRichMark("bold"));
      ref.current?.run(setRichColor("#0b7a6c"));
      ref.current?.run(setRichColor("not a color"));
    });
    expect(readRich(fragment)[0]?.runs[0]).toEqual({ text: "acme", bold: true, color: "#0b7a6c" });
    expect(ref.current?.format()).toMatchObject({ bold: true, color: "#0b7a6c" });
    act(() => {
      select(view(), 6, 10);
      ref.current?.run(setRichLink("acme.com"));
    });
    expect(readRich(fragment)[0]?.runs.at(-1)).toEqual({ text: "site", link: "https://acme.com" });
    act(() => {
      ref.current?.run(toggleRichList("ordered"));
      ref.current?.run(shiftRichLevel(1));
    });
    expect(readRich(fragment)[0]).toMatchObject({ list: "ordered", level: 1 });
    act(() => {
      ref.current?.run(toggleRichList("ordered"));
      ref.current?.run(shiftRichLevel(-1));
    });
    expect(readRich(fragment)[0]?.list).toBeUndefined();
    expect(readRich(fragment)[0]?.level).toBeUndefined();
  });

  test("the type commands on words (ADR 0220 §8): font, weight, spacing, highlight, capitals, line height", () => {
    const { fragment } = boxWith([{ runs: [{ text: "Meta do ano" }] }]);
    const { ref, view } = mount(fragment);
    act(() => {
      select(view(), 1, 5);
      ref.current?.run(setRichType("font", "inter"));
      ref.current?.run(setRichType("weight", 600));
      ref.current?.run(setRichType("tracking", 60));
      ref.current?.run(setRichType("highlight", "#fff176"));
      ref.current?.run(setRichCaps(true));
      ref.current?.run(setRichLineHeight(1.4));
    });
    expect(readRich(fragment)[0]).toEqual({
      lineHeight: 1.4,
      runs: [
        { text: "Meta", font: "inter", weight: 600, tracking: 60, highlight: "#fff176", caps: true },
        { text: " do ano" },
      ],
    });
    expect(ref.current?.format()).toMatchObject({
      font: "inter",
      weight: 600,
      tracking: 60,
      highlight: "#fff176",
      caps: true,
      lineHeight: 1.4,
    });
    // No spacing, no font, no capitals: the box's own look again.
    act(() => {
      ref.current?.run(setRichType("tracking", 0));
      ref.current?.run(setRichType("font", null));
      ref.current?.run(setRichCaps(false));
      ref.current?.run(setRichLineHeight(null));
    });
    expect(readRich(fragment)[0]).toEqual({
      runs: [{ text: "Meta", weight: 600, highlight: "#fff176" }, { text: " do ano" }],
    });
    expect(ref.current?.format()).toMatchObject({ font: null, tracking: null, caps: false, lineHeight: null });
  });

  test("typed shortcuts start lists; Enter keeps the list, Enter on an empty item and Backspace leave it", () => {
    const { fragment } = boxWith([{ runs: [] }]);
    const { view } = mount(fragment);
    act(() => {
      select(view(), 1);
      typeText(view(), "- Leite");
    });
    expect(readRich(fragment)).toEqual([{ list: "bullet", runs: [{ text: "Leite" }] }]);
    act(() => {
      splitParagraph(view().state, view().dispatch);
      typeText(view(), "Pão");
    });
    expect(readRich(fragment).map((p) => p.list)).toEqual(["bullet", "bullet"]);
    act(() => {
      splitParagraph(view().state, view().dispatch);
      // An empty item: Enter leaves the list.
      splitParagraph(view().state, view().dispatch);
    });
    expect(readRich(fragment).map((p) => p.list ?? null)).toEqual(["bullet", "bullet", null]);
    act(() => {
      // Backspace at the start of an item leaves the list too.
      select(view(), 8);
      liftParagraph(view().state, view().dispatch);
    });
    expect(readRich(fragment)[1]?.list).toBeUndefined();
  });

  test("a read-only box can't be typed in", () => {
    const { fragment } = boxWith([{ runs: [{ text: "Fixo" }] }]);
    const { container } = mount(fragment, { readOnly: true });
    const editor = container.querySelector(".rt-editor");
    expect(editor?.getAttribute("contenteditable")).toBe("false");
    expect(editor?.getAttribute("aria-readonly")).toBe("true");
  });

  test("an empty box shows its hint; numbered items show their numbers", () => {
    const { fragment } = boxWith([]);
    const { container } = mount(fragment, { placeholder: "Clique para adicionar um texto" });
    expect(container.querySelector(".rt-empty")?.getAttribute("data-placeholder")).toBe(
      "Clique para adicionar um texto",
    );
    const numbered = boxWith([
      { list: "ordered", runs: [{ text: "Um" }] },
      { list: "ordered", runs: [{ text: "Dois" }] },
    ]);
    cleanup();
    const second = mount(numbered.fragment);
    expect([...second.container.querySelectorAll("p[data-n]")].map((p) => p.getAttribute("data-n"))).toEqual([
      "1",
      "2",
    ]);
  });

  test("another person's caret shows in their color with their name; this person's goes out as cursorPm", async () => {
    const { doc, fragment } = boxWith([{ runs: [{ text: "Plano de vendas" }] }]);
    const awareness = new Awareness(doc);
    const { container, view } = mount(fragment, {
      awareness,
      look: (_id, user) => (user.id === "bea" ? { name: "Bea", color: "#b5179e" } : null),
    });
    // Bea's caret after "Plano", as her editor would send it.
    const ystate = ySyncPluginKey.getState(view().state) as { binding: { mapping: Map<unknown, unknown> } };
    const at = absolutePositionToRelativePosition(6, fragment, ystate.binding.mapping as never);
    // Another app's client (a second awareness on this same document would share this one's id).
    const bea = awareness.clientID + 1;
    act(() => {
      awareness.states.set(bea, {
        user: { kind: "person", id: "bea" },
        mode: "editing",
        cursorPm: { anchor: Y.relativePositionToJSON(at), head: Y.relativePositionToJSON(at) },
      });
      awareness.emit("change", [{ added: [bea], updated: [], removed: [] }, "remote"]);
    });
    await waitFor(() => expect(container.querySelector(".rt-caret .rt-caret__name")?.textContent).toBe("Bea"));
    expect((container.querySelector(".rt-caret") as HTMLElement).style.getPropertyValue("--peer")).toBe("#b5179e");
    // This person's own caret, while focused, goes to the others.
    act(() => {
      view().focus();
      select(view(), 3);
    });
    const mine = (awareness.getLocalState() as { cursorPm?: { anchor?: unknown } } | null)?.cursorPm;
    expect(mine?.anchor).toBeTruthy();
  });
});

describe("formatting a whole box", () => {
  test("marks, color, paragraphs and levels on every character, in one change of the given origin", () => {
    const { doc, fragment } = boxWith([
      { runs: [{ text: "Meta" }, { text: " 2026", italic: true }] },
      { list: "bullet", runs: [{ text: "Vendas" }] },
    ]);
    const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([LOCAL]) });
    doc.transact(() => {
      markWholeText(fragment, "bold", true, LOCAL);
      colorWholeText(fragment, "#123456", LOCAL);
      setWholeParagraphs(fragment, { align: "center", list: null }, LOCAL);
      shiftWholeLevels(fragment, 1, LOCAL);
    }, LOCAL);
    const rich = readRich(fragment);
    expect(rich.every((p) => p.align === "center" && p.level === 1 && !p.list)).toBe(true);
    expect(rich.flatMap((p) => p.runs).every((r) => r.bold && r.color === "#123456")).toBe(true);
    expect(wholeFormat(rich)).toMatchObject({ bold: true, color: "#123456", align: "center", level: 1, list: null });
    // An invalid color changes nothing.
    colorWholeText(fragment, "red; background: url(x)", LOCAL);
    expect(readRich(fragment)[0]?.runs[0]?.color).toBe("#123456");
    // One step of undo.
    undo.undo();
    expect(readRich(fragment)[1]).toMatchObject({ list: "bullet" });
    expect(wholeFormat(readRich(fragment)).bold).toBe(false);
  });

  test("type marks on every character, and taken away so the box's own style shows (ADR 0220 §8)", () => {
    const { doc, fragment } = boxWith([
      {
        lineHeight: 2,
        runs: [
          { text: "Meta", font: "inter", weight: 700 },
          { text: " do ano", tracking: 60 },
        ],
      },
    ]);
    // Mixed: the toolbar shows the box's own.
    expect(wholeFormat(readRich(fragment))).toMatchObject({ font: null, weight: null, tracking: null, caps: false });
    doc.transact(() => {
      typeWholeText(fragment, "font", null, LOCAL);
      typeWholeText(fragment, "weight", null, LOCAL);
      typeWholeText(fragment, "tracking", null, LOCAL);
      typeWholeText(fragment, "highlight", "#bbdefb", LOCAL);
      capsWholeText(fragment, true, LOCAL);
      setWholeParagraphs(fragment, { lineHeight: null }, LOCAL);
    }, LOCAL);
    expect(readRich(fragment)).toEqual([{ runs: [{ text: "Meta do ano", highlight: "#bbdefb", caps: true }] }]);
    expect(wholeFormat(readRich(fragment))).toMatchObject({ highlight: "#bbdefb", caps: true, lineHeight: null });
    typeWholeText(fragment, "font", "fraunces", LOCAL);
    expect(wholeFormat(readRich(fragment)).font).toBe("fraunces");
  });
});
