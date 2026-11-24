import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { createContext, memo, useContext, useState } from "react";
import { useStorePart, useValueStore, type ValueStore } from "@/lib/value-store";

afterEach(() => cleanup());

type Lines = Map<string, { count: number }>;
const Store = createContext<ValueStore<Lines>>({ get: () => new Map(), subscribe: () => () => {} });

test("a change of the value draws only the readers whose part changed", async () => {
  const draws: Record<string, number> = {};
  const Row = memo(function Row({ id }: { id: string }) {
    const line = useStorePart(useContext(Store), (lines) => lines.get(id));
    draws[id] = (draws[id] ?? 0) + 1;
    return <span>{`${id}:${line?.count ?? 0}`}</span>;
  });
  let set: (lines: Lines) => void = () => {};
  const a = { count: 1 };
  function List() {
    const [lines, setLines] = useState<Lines>(() => new Map([["a", a]]));
    set = setLines;
    const store = useValueStore(lines);
    return (
      <Store.Provider value={store}>
        <Row id="a" />
        <Row id="b" />
      </Store.Provider>
    );
  }
  const view = render(<List />);
  expect(draws).toEqual({ a: 1, b: 1 });
  // A reply in thread b: a's line is the same object, so only b draws.
  await act(async () =>
    set(
      new Map([
        ["a", a],
        ["b", { count: 3 }],
      ]),
    ),
  );
  expect(draws).toEqual({ a: 1, b: 2 });
  expect(view.container.textContent).toBe("a:1b:3");
});
