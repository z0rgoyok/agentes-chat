import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { InlineName } from "../src";

afterEach(() => cleanup());

function field(onSave: (name: string) => unknown = () => {}) {
  const log: string[] = [];
  const { getByRole } = render(
    <InlineName
      value="Claude 2"
      aria-label="Name"
      onSave={(name) => {
        log.push(`save:${name}`);
        return onSave(name);
      }}
      onDone={() => log.push("done")}
    />,
  );
  return { input: getByRole("textbox", { name: "Name" }) as HTMLInputElement, log };
}

test("opens on the name, selected and focused; Enter saves it trimmed, once, and is done", async () => {
  const { input, log } = field();
  expect(input.value).toBe("Claude 2");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  fireEvent.change(input, { target: { value: "  Work account " } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  await act(async () => fireEvent.blur(input));
  expect(log).toEqual(["save:Work account", "done"]);
});

test("Esc goes back to the name and stops there, so a dialog around it stays open", async () => {
  const { input, log } = field();
  let reached = false;
  const outside = () => {
    reached = true;
  };
  document.addEventListener("keydown", outside, true);
  fireEvent.change(input, { target: { value: "Something else" } });
  await act(async () => fireEvent.keyDown(input, { key: "Escape" }));
  document.removeEventListener("keydown", outside, true);
  expect(reached).toBe(false);
  expect(log).toEqual(["done"]);
});

test("leaving it saves; unchanged or empty saves nothing", async () => {
  const left = field();
  fireEvent.change(left.input, { target: { value: "Home" } });
  await act(async () => fireEvent.blur(left.input));
  expect(left.log).toEqual(["save:Home", "done"]);
  cleanup();
  const same = field();
  fireEvent.change(same.input, { target: { value: " Claude 2 " } });
  await act(async () => fireEvent.keyDown(same.input, { key: "Enter" }));
  expect(same.log).toEqual(["done"]);
  cleanup();
  const empty = field();
  fireEvent.change(empty.input, { target: { value: "   " } });
  await act(async () => fireEvent.keyDown(empty.input, { key: "Enter" }));
  expect(empty.log).toEqual(["done"]);
});

test("a refused save keeps the field with what was typed, read only while it waits", async () => {
  let fail: (e: Error) => void = () => {};
  const { input, log } = field(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  fireEvent.change(input, { target: { value: "Taken" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(input.readOnly).toBe(true);
  await act(async () => fail(new Error("refused")));
  expect(input.readOnly).toBe(false);
  expect(input.value).toBe("Taken");
  expect(log).toEqual(["save:Taken"]);
});
