import { expect, test } from "bun:test";
import { BoundedMap } from "../src/bounded-map";

test("a bounded map forgets its oldest entries past its limit, counted per entry or by weight", () => {
  const counted = new BoundedMap<string, number>(2);
  counted.set("a", 1).set("b", 2).set("c", 3);
  expect([...counted.keys()]).toEqual(["b", "c"]);

  const weighed = new BoundedMap<string, string>(10, (_, v) => v.length);
  weighed.set("a", "1234").set("b", "1234");
  weighed.set("a", "12");
  expect([...weighed.keys()]).toEqual(["b", "a"]);
  weighed.set("c", "1234");
  expect([...weighed.keys()]).toEqual(["b", "a", "c"]);
  weighed.set("d", "12345");
  expect([...weighed.keys()]).toEqual(["c", "d"]);
  // One entry heavier than the whole limit stays, alone.
  weighed.set("e", "x".repeat(50));
  expect([...weighed.keys()]).toEqual(["e"]);
  weighed.delete("e");
  weighed.set("f", "1234567890");
  expect([...weighed.keys()]).toEqual(["f"]);
});
