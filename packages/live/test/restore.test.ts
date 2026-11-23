import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  cloneValue,
  dumpValue,
  overwriteArray,
  overwriteMap,
  overwriteText,
  overwriteXml,
  sameJson,
  sameValue,
} from "../src/restore";
import { readRich, writeRich } from "../src/rich/yjs";

/** Two copies of one document, as two people (or a person and a version) hold it. */
function pair(build: (doc: Y.Doc) => void): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  build(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return [a, b];
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe("equality", () => {
  test("plain values, by structure", () => {
    expect(sameJson({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson(Number.NaN, Number.NaN)).toBe(true);
    expect(sameJson(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameJson(new Uint8Array([1, 2]), [1, 2])).toBe(false);
  });

  test("nested types from different documents, formatting included", () => {
    const [a, b] = pair((doc) => {
      writeRich(doc.getXmlFragment("f"), [{ runs: [{ text: "hi", bold: true }] }]);
      doc.getMap("m").set("n", 1);
    });
    expect(sameValue(a.getXmlFragment("f"), b.getXmlFragment("f"))).toBe(true);
    writeRich(b.getXmlFragment("f"), [{ runs: [{ text: "hi" }] }]);
    expect(sameValue(a.getXmlFragment("f"), b.getXmlFragment("f"))).toBe(false);
    expect(dumpValue(a.getMap("m"))).toEqual({ $map: { n: 1 } });
    expect(sameValue(a.getMap("m"), 1)).toBe(false);
  });
});

describe("overwriting", () => {
  test("a map: equal entries untouched, nested maps updated in place, gone keys removed", () => {
    const [doc, old] = pair((d) => {
      const root = d.getMap<unknown>("root");
      const child = new Y.Map<unknown>();
      child.set("x", 1);
      root.set("child", child);
      root.set("same", { deep: [1, 2] });
      root.set("drop", true);
    });
    const root = doc.getMap<unknown>("root");
    const child = root.get("child");
    (old.getMap<unknown>("root").get("child") as Y.Map<unknown>).set("x", 2);
    old.getMap<unknown>("root").delete("drop");
    old.getMap<unknown>("root").set("added", "yes");
    let changedKeys: string[] = [];
    root.observe((event) => {
      changedKeys = [...event.keysChanged];
    });
    doc.transact(() => overwriteMap(root, old.getMap<unknown>("root")));
    expect(root.toJSON()).toEqual(old.getMap("root").toJSON());
    expect(root.get("child")).toBe(child);
    expect(changedKeys.sort()).toEqual(["added", "drop"]);
  });

  test("a list: only the span between the common head and tail changes", () => {
    const [doc, old] = pair((d) => d.getArray<string>("ids").push(["a", "b", "c", "d"]));
    const ids = doc.getArray<string>("ids");
    ids.delete(1, 2);
    ids.insert(1, ["x"]);
    const deltas: unknown[] = [];
    ids.observe((event) => deltas.push(event.changes.delta));
    doc.transact(() => overwriteArray(ids, old.getArray<string>("ids")));
    expect(ids.toArray()).toEqual(["a", "b", "c", "d"]);
    expect(deltas).toHaveLength(1);
    const [head, ...rest] = deltas[0] as unknown[];
    expect(head).toEqual({ retain: 1 });
    expect(rest).toHaveLength(2);
    expect(rest).toContainEqual({ delete: 1 });
    expect(rest).toContainEqual({ insert: ["b", "c"] });
  });

  test("a list of maps updates each in place when they pair up", () => {
    const [doc, old] = pair((d) => {
      const list = d.getArray<Y.Map<number>>("list");
      for (let i = 0; i < 3; i++) {
        const item = new Y.Map<number>();
        item.set("n", i);
        list.push([item]);
      }
    });
    const list = doc.getArray<Y.Map<number>>("list");
    const first = list.get(0);
    list.get(1).set("n", 99);
    doc.transact(() => overwriteArray(list, old.getArray<Y.Map<number>>("list")));
    expect(list.toJSON()).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    expect(list.get(0)).toBe(first);
  });

  test("plain text: only the characters that differ, so a concurrent edit elsewhere survives", () => {
    const [a, b] = pair((d) => d.getText("t").insert(0, "The quick brown fox"));
    a.transact(() => overwriteText(a.getText("t"), "The slow brown fox"));
    b.getText("t").insert(19, " jumps");
    sync(a, b);
    expect(a.getText("t").toString()).toBe("The slow brown fox jumps");
    const text = new Y.Doc().getText("t");
    text.insert(0, "a😀b");
    overwriteText(text, "a😁b");
    expect(text.toString()).toBe("a😁b");
  });

  test("rich text: paragraphs that didn't change stay, changed ones are updated in place", () => {
    const [doc, old] = pair((d) =>
      writeRich(d.getXmlFragment("f"), [
        { list: "bullet", runs: [{ text: "one" }] },
        { runs: [{ text: "two", italic: true }] },
        { runs: [{ text: "three" }] },
      ]),
    );
    const fragment = doc.getXmlFragment("f");
    const [first, second, third] = fragment.toArray() as Y.XmlElement[];
    ((second as Y.XmlElement).get(0) as Y.XmlText).insert(0, "changed ");
    (second as Y.XmlElement).setAttribute("align", "center");
    writeRich(old.getXmlFragment("other"), [{ runs: [{ text: "unrelated" }] }]);
    doc.transact(() => overwriteXml(fragment, old.getXmlFragment("f")));
    expect(readRich(fragment)).toEqual(readRich(old.getXmlFragment("f")));
    const now = fragment.toArray();
    expect(now).toHaveLength(3);
    expect(now[0]).toBe(first as Y.XmlElement);
    expect(now[1]).toBe(second as Y.XmlElement);
    expect(now[2]).toBe(third as Y.XmlElement);
    // Fewer paragraphs: the extra one goes, the rest stay.
    writeRich(old.getXmlFragment("f"), [{ list: "bullet", runs: [{ text: "one" }] }]);
    doc.transact(() => overwriteXml(fragment, old.getXmlFragment("f")));
    expect(readRich(fragment)).toEqual([{ list: "bullet", runs: [{ text: "one" }] }]);
  });

  test("copies can join another document", () => {
    const [source] = pair((d) => {
      const m = d.getMap<unknown>("m");
      const inner = new Y.Map<unknown>();
      inner.set("k", "v");
      m.set("inner", inner);
      const text = new Y.Text();
      m.set("text", text);
      text.insert(0, "hello", { bold: true });
    });
    const target = new Y.Doc();
    const m = source.getMap<unknown>("m");
    target.getMap<unknown>("copy").set("inner", cloneValue(m.get("inner")));
    target.getMap<unknown>("copy").set("text", cloneValue(m.get("text")));
    expect(target.getMap("copy").toJSON()).toEqual({ inner: { k: "v" }, text: "hello" });
    expect((target.getMap("copy").get("text") as Y.Text).toDelta()).toEqual([
      { insert: "hello", attributes: { bold: true } },
    ]);
    expect(cloneValue(5)).toBe(5);
  });
});
