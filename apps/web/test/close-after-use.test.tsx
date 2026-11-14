import { afterEach, expect, jest, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { useCloseAfterUse } from "@/hooks/useCloseAfterUse";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

/** The channel's greeting in miniature: a band with its ×, and the page around it. */
function Band({ closes = [] }: { closes?: string[] }) {
  const box = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  useCloseAfterUse(
    box,
    () => {
      closes.push("closed");
      setOpen(false);
    },
    open,
  );
  return (
    <div>
      <button type="button">Enviar</button>
      {open && (
        <section ref={box} aria-label="Resumo">
          <button type="button">Fechar</button>
        </section>
      )}
    </div>
  );
}

const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

test("it closes 8 s after the first press elsewhere: never before the person does anything, never under the pointer", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  await wait(60_000);
  expect(band()).not.toBeNull();
  // Pressing on it is reading it, not moving on.
  fireEvent.pointerDown(view.getByRole("button", { name: "Fechar" }));
  await wait(8_000);
  expect(band()).not.toBeNull();
  fireEvent.keyDown(view.getByRole("button", { name: "Enviar" }), { key: "Enter" });
  await wait(7_900);
  expect(band()).not.toBeNull();
  // The pointer resting on it when the time comes: it stays while the pointer does.
  fireEvent.pointerEnter(band() as HTMLElement);
  await wait(5_000);
  expect(band()).not.toBeNull();
  // It leaves 2 s after the pointer does; the pointer back within them holds it again.
  fireEvent.pointerLeave(band() as HTMLElement);
  await wait(1_900);
  expect(band()).not.toBeNull();
  fireEvent.pointerEnter(band() as HTMLElement);
  await wait(5_000);
  expect(band()).not.toBeNull();
  fireEvent.pointerLeave(band() as HTMLElement);
  await wait(1_900);
  expect(band()).not.toBeNull();
  await wait(100);
  expect(band()).toBeNull();
});

test("a pointer that left just before the 8 s still gets its 2 s", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  fireEvent.wheel(view.getByRole("button", { name: "Enviar" }));
  await wait(7_000);
  fireEvent.pointerEnter(band() as HTMLElement);
  fireEvent.pointerLeave(band() as HTMLElement);
  await wait(1_900);
  expect(band()).not.toBeNull();
  await wait(100);
  expect(band()).toBeNull();
});

test("the focus inside it when the time comes keeps it until 2 s after the focus goes elsewhere", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  const shut = view.getByRole("button", { name: "Fechar" });
  const send = view.getByRole("button", { name: "Enviar" });
  fireEvent.wheel(send);
  shut.focus();
  await wait(8_000);
  expect(band()).not.toBeNull();
  await act(async () => {
    send.focus();
    fireEvent.focusOut(shut, { relatedTarget: send });
  });
  await wait(1_900);
  expect(band()).not.toBeNull();
  await wait(100);
  expect(band()).toBeNull();
});

test("a modifier key or a shortcut that leaves the page (Cmd+Tab, Alt+Tab, Ctrl+L) starts no clock", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  const send = view.getByRole("button", { name: "Enviar" });
  for (const key of ["Meta", "Control", "Alt", "Shift", "CapsLock"]) fireEvent.keyDown(send, { key });
  fireEvent.keyDown(send, { key: "Tab", metaKey: true });
  fireEvent.keyDown(send, { key: "Tab", altKey: true });
  fireEvent.keyDown(send, { key: "l", ctrlKey: true });
  await wait(60_000);
  expect(band()).not.toBeNull();
  // A capital typed in the box is using the page.
  fireEvent.keyDown(send, { key: "B", shiftKey: true });
  await wait(8_000);
  expect(band()).toBeNull();
});

test("leaving once the clock runs counts as closed; leaving before anything was done doesn't", async () => {
  jest.useFakeTimers();
  const untouched: string[] = [];
  render(<Band closes={untouched} />).unmount();
  expect(untouched).toEqual([]);
  const used: string[] = [];
  const view = render(<Band closes={used} />);
  fireEvent.pointerDown(view.getByRole("button", { name: "Enviar" }));
  await wait(3_000);
  view.unmount();
  expect(used).toEqual(["closed"]);
  // Nothing more once it is gone.
  await wait(60_000);
  expect(used).toEqual(["closed"]);
});
