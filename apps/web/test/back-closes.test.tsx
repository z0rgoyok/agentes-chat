import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { Dialog } from "@agenteschat/ui";
import type { RouterHistory } from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { SidePanel } from "@/components/SidePanel";
import { holdBackForOverlays } from "@/hooks/useBackCloses";
import { useEscClose } from "@/hooks/useEscClose";

afterEach(() => cleanup());

type Blocker = Parameters<RouterHistory["block"]>[0];

/** The router's history as far as the hold sees it: the blocker it adds, and the Backs it lets through. */
function fakeHistory() {
  let blocker: Blocker | null = null;
  const backs: unknown[] = [];
  const history = {
    block: (b: Blocker) => {
      blocker = b;
      return () => {
        blocker = null;
      };
    },
    back: (opts?: unknown) => backs.push(opts),
  } as unknown as RouterHistory;
  const undo = holdBackForOverlays(history);
  /** A Back as the browser makes it: the router asks the blocker; when held, it steps forward again (a popstate). */
  const press = async (action: "BACK" | "FORWARD" = "BACK") => {
    const held = Boolean(await blocker?.blockerFn({ action } as never));
    if (held) await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    return held;
  };
  return { press, backs, undo };
}

function Nested() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  return (
    <Dialog open={outer} onOpenChange={setOuter} title="Conectar uma IA" closeLabel="Fechar">
      <Dialog open={inner} onOpenChange={setInner} title="Escolher a conta" closeLabel="Fechar">
        <p>contas</p>
      </Dialog>
    </Dialog>
  );
}

const dialog = (name: string) =>
  Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes(name)) ?? null;

test("Back closes the dialog on top, one per Back, then leaves the page once nothing is open", async () => {
  render(<Nested />);
  const { press, backs } = fakeHistory();
  expect(await press()).toBe(true);
  expect(dialog("Escolher a conta")).toBeNull();
  expect(dialog("Conectar uma IA")).not.toBeNull();
  expect(await press()).toBe(true);
  expect(dialog("Conectar uma IA")).toBeNull();
  expect(await press()).toBe(false);
  expect(backs).toHaveLength(0);
});

test("Forward is never held, nor anything once the shell is gone", async () => {
  render(<Nested />);
  const { press, undo } = fakeHistory();
  expect(await press("FORWARD")).toBe(false);
  expect(dialog("Escolher a conta")).not.toBeNull();
  undo();
  expect(await press()).toBe(false);
});

function Discard() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Descartar?" closeLabel="Fechar">
      <p>edits</p>
    </Dialog>
  );
}

function Pane({ inAddress, children }: { inAddress?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  useEscClose(open ? () => setOpen(false) : undefined);
  return open ? (
    <SidePanel label="Tarefas" inAddress={inAddress} onClose={() => setOpen(false)}>
      {children}
    </SidePanel>
  ) : null;
}

test("a side pane of the page's own closes on Back; one the URL holds lets the Back through to move the URL", async () => {
  const { press } = fakeHistory();
  const own = render(<Pane />);
  expect(await press()).toBe(true);
  expect(document.querySelector(".thread-panel")).toBeNull();
  own.unmount();

  render(<Pane inAddress />);
  expect(await press()).toBe(false);
  expect(document.querySelector(".thread-panel")).not.toBeNull();
});

test("a dialog over a pane the URL holds closes first, the pane stays", async () => {
  const { press } = fakeHistory();
  render(
    <Pane inAddress>
      <Discard />
    </Pane>,
  );
  expect(await press()).toBe(true);
  expect(dialog("Descartar?")).toBeNull();
  expect(document.querySelector(".thread-panel")).not.toBeNull();
});

test("an overlay with no use for Esc doesn't trap the person: the Back goes through", async () => {
  render(
    <div role="dialog" aria-label="Aviso">
      aviso
    </div>,
  );
  const { press, backs } = fakeHistory();
  expect(await press()).toBe(true);
  expect(backs).toHaveLength(1);
  // The Back it sends again passes this hold, and only this hold: the router still asks the page's own blockers.
  expect(await press()).toBe(false);
  expect(await press()).toBe(true);
});
