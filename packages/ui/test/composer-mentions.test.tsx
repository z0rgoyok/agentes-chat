import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer, type ComposerSuggestion } from "../src/components/Composer";

afterEach(() => cleanup());

const PEOPLE: ComposerSuggestion[] = [
  { key: "helga", insert: "helga", label: "Helga" },
  { key: "helena", insert: "helena", label: "Helena" },
];
const CHANNELS: ComposerSuggestion[] = [{ key: "eng", insert: "eng", label: "#eng" }];

function Box({ sent }: { sent: string[] }) {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={setValue}
      // As a conversation does: the message goes out and the box empties.
      onSend={(text) => {
        sent.push(text);
        setValue("");
      }}
      label="Mensagem"
      sendLabel="Enviar"
      mentions={{ search: (q) => PEOPLE.filter((p) => p.insert.startsWith(q)), listLabel: "Pessoas e agentes" }}
      channels={{ search: (q) => CHANNELS.filter((c) => c.insert.startsWith(q)), listLabel: "Canais" }}
    />
  );
}

function setup() {
  const sent: string[] = [];
  render(<Box sent={sent} />);
  const box = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    });
  const enter = () =>
    act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
  return { box, sent, type, enter };
}

test("with the @ list open, the first Enter picks the highlighted one and never sends, even typed in full", async () => {
  const { box, sent, type, enter } = setup();
  await type("oi @helga");
  expect(screen.getByRole("listbox", { name: "Pessoas e agentes" })).toBeTruthy();
  await enter();
  expect(sent).toEqual([]);
  expect(box.value).toBe("oi @helga ");
  expect(box.getAttribute("aria-expanded")).toBe("false");
  await enter();
  expect(sent).toEqual(["oi @helga"]);
});

test("sent with the list open (the send button): the box empties and the list closes with it", async () => {
  const { box, sent, type } = setup();
  await type("oi @hel");
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  });
  expect(sent).toEqual(["oi @hel"]);
  expect(box.value).toBe("");
  expect(box.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("the # list too: Enter on a name typed in full picks it first", async () => {
  const { box, sent, type, enter } = setup();
  await type("veja #eng");
  await enter();
  expect(sent).toEqual([]);
  expect(box.value).toBe("veja #eng ");
});

/** The browser's text editing as far as these tests need it: typing over the selection, its undo and redo. */
function fakeEditing() {
  const undo: [HTMLTextAreaElement, string][] = [];
  const redo: [HTMLTextAreaElement, string][] = [];
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  // Not the element's own setter: React would take the new text for its own and skip the change, as it would never
  // see a real browser's edit come through it.
  const write = (el: HTMLTextAreaElement, text: string, caret: number) => {
    setValue?.call(el, text);
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const was = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _ui: boolean, text = "") => {
      const el = document.activeElement as HTMLTextAreaElement;
      if (command === "undo" || command === "redo") {
        const [from, to] = command === "undo" ? [undo, redo] : [redo, undo];
        const step = from.pop();
        if (!step) return false;
        to.push([step[0], step[0].value]);
        write(step[0], step[1], step[1].length);
        return true;
      }
      const start = el.selectionStart ?? 0;
      undo.push([el, el.value]);
      redo.length = 0;
      write(el, el.value.slice(0, start) + text + el.value.slice(el.selectionEnd ?? start), start + text.length);
      return true;
    },
  });
  return () => {
    if (was) Object.defineProperty(document, "execCommand", was);
    else delete (document as { execCommand?: unknown }).execCommand;
  };
}

test("a pick is typed in, not set: ⌘Z takes it back to what was typed and ⇧⌘Z puts it again", async () => {
  const restore = fakeEditing();
  try {
    const { box, sent, type, enter } = setup();
    await type("oi @hel");
    await act(async () => box.focus());
    await enter();
    expect(box.value).toBe("oi @helga ");
    expect(box.selectionStart).toBe("oi @helga ".length);
    await act(async () => void document.execCommand("undo"));
    expect(box.value).toBe("oi @hel");
    await act(async () => void document.execCommand("redo"));
    expect(box.value).toBe("oi @helga ");
    expect(sent).toEqual([]);
  } finally {
    restore();
  }
});
