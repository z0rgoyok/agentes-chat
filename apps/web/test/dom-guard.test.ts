import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { dropKeylessKeyEvents, tolerateForeignDomEdits } from "../src/lib/dom-guard";

describe("a page edited behind React's back", () => {
  let original: Pick<Node, "removeChild" | "insertBefore">;
  beforeAll(() => {
    original = { removeChild: Node.prototype.removeChild, insertBefore: Node.prototype.insertBefore };
    tolerateForeignDomEdits();
  });
  afterAll(() => {
    Object.assign(Node.prototype, original);
  });

  test("removing a node something else moved away does nothing", () => {
    const parent = document.createElement("div");
    const text = document.createTextNode("Olá");
    parent.append(text);
    document.createElement("font").append(text);
    expect(parent.removeChild(text)).toBe(text);
    expect(text.parentNode?.nodeName).toBe("FONT");
  });

  test("inserting before a neighbour that left goes last, and a real neighbour still counts", () => {
    const parent = document.createElement("div");
    const first = parent.appendChild(document.createElement("i"));
    const gone = document.createElement("b");
    const added = parent.insertBefore(document.createElement("u"), gone);
    expect(parent.lastChild).toBe(added);
    const put = parent.insertBefore(document.createElement("s"), first);
    expect(parent.firstChild).toBe(put);
  });
});

describe("a key event with no key (autofill, a password manager)", () => {
  test("never reaches a shortcut listener; a real key press does", () => {
    const target = new EventTarget() as Window;
    dropKeylessKeyEvents(target);
    const keys: string[] = [];
    target.addEventListener("keydown", (e) => keys.push(String((e as KeyboardEvent).key)));
    target.dispatchEvent(new Event("keydown"));
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "N" }));
    expect(keys).toEqual(["N"]);
  });
});
