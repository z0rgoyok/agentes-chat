import { describe, expect, test } from "bun:test";
import { fromBase64, toBase64 } from "../src/base64";
import { contrastRatio, fnv1a, hexRgb, PEER_COLORS, peerColor, readableOn, relativeLuminance } from "../src/colors";
import { compareStack, isOrderKey, keyBetween, keysBetween, renumber, restack } from "../src/fractional";
import { isNewId, newId } from "../src/ids";
import { isLiveKind, LIVE_KINDS, LIVE_LIMITS } from "../src/limits";
import { agentOrigin, isLiveOrigin, LOCAL, REMOTE, SYSTEM } from "../src/origins";

describe("ids", () => {
  test("ten base-36 characters, never repeated", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9a-z]{10}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(20_000);
    expect(isNewId(newId())).toBe(true);
    expect(isNewId("ABC")).toBe(false);
    expect(isNewId(42)).toBe(false);
  });

  test("every digit is about as likely in every position", () => {
    const counts = new Array(36).fill(0);
    for (let i = 0; i < 20_000; i++) {
      for (const ch of newId()) counts[Number.parseInt(ch, 36)]++;
    }
    const expected = (20_000 * 10) / 36;
    for (const n of counts) expect(Math.abs(n - expected) / expected).toBeLessThan(0.1);
  });
});

describe("base64", () => {
  const sizes = [0, 1, 2, 3, 4, 5, 6143, 6144, 6145, 20_000, 100_001];
  test.each(sizes)("round trips %i bytes and matches the standard encoding", (size) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7919 + (i >> 3)) & 255;
    const text = toBase64(bytes);
    expect(text).toBe(Buffer.from(bytes).toString("base64"));
    expect(fromBase64(text)).toEqual(bytes);
  });

  test("reads the URL-safe alphabet, missing padding and whitespace", () => {
    const bytes = new Uint8Array([251, 255, 191, 0, 1, 2, 62, 63]);
    const standard = toBase64(bytes);
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(fromBase64(urlSafe)).toEqual(bytes);
    expect(fromBase64(` ${standard.slice(0, 4)}\n${standard.slice(4)} \r\n`)).toEqual(bytes);
  });

  test("refuses what isn't base64 instead of reading less", () => {
    expect(() => fromBase64("abc$")).toThrow();
    expect(() => fromBase64("a")).toThrow();
    expect(() => fromBase64("é")).toThrow();
  });
});

describe("stacking keys", () => {
  test("keys sort between their bounds, in either order", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    expect(keyBetween(b, a)).toBe(mid);
    const before = keyBetween(null, a);
    expect(before < a).toBe(true);
  });

  test("equal bounds (two people at once) still give a key just after them", () => {
    const a = keyBetween(null, null);
    const next = keyBetween(a, a);
    expect(next > a).toBe(true);
    const many = keysBetween(a, a, 3);
    expect(many).toHaveLength(3);
    expect([...many].sort()).toEqual(many);
    expect(many.every((key) => key > a)).toBe(true);
  });

  test("n keys in order, reversed bounds included", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    for (const keys of [keysBetween(a, b, 5), keysBetween(b, a, 5), keysBetween(null, null, 5)]) {
      expect(keys).toHaveLength(5);
      expect(new Set(keys).size).toBe(5);
      expect([...keys].sort()).toEqual(keys);
    }
    expect(keysBetween(a, b, 0)).toEqual([]);
    expect(keysBetween(a, b, 5).every((key) => key > a && key < b)).toBe(true);
  });

  test("only keys the library made are keys", () => {
    expect(isOrderKey(keyBetween(null, null))).toBe(true);
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("not a key!")).toBe(false);
    expect(isOrderKey(7)).toBe(false);
  });

  test("ties break by id, the same for everyone", () => {
    const items = [
      { id: "b", z: "a1" },
      { id: "a", z: "a1" },
      { id: "c", z: "a0" },
    ];
    expect([...items].sort(compareStack).map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  const stack = () => {
    const keys = keysBetween(null, null, 5);
    return ["a", "b", "c", "d", "e"].map((id, i) => ({ id, z: keys[i] as string }));
  };
  const order = (items: { id: string; z: string }[], keys: Map<string, string>) =>
    items
      .map((item) => ({ id: item.id, z: keys.get(item.id) ?? item.z }))
      .sort(compareStack)
      .map((item) => item.id)
      .join("");

  test("front, back, forward and backward move only what moves", () => {
    const items = stack();
    const front = restack(items, ["b", "d"], "front");
    expect(order(items, front)).toBe("acebd");
    expect([...front.keys()].sort()).toEqual(["b", "d"]);
    expect(order(items, restack(items, ["b", "d"], "back"))).toBe("bdace");
    expect(order(items, restack(items, ["b"], "forward"))).toBe("acbde");
    expect(order(items, restack(items, ["d"], "backward"))).toBe("abdce");
    expect(order(items, restack(items, ["d", "e"], "forward"))).toBe("abcde");
    expect(restack(items, ["e"], "front").size).toBe(0);
    expect(restack(items, ["zz"], "front").size).toBe(0);
  });

  test("keys someone broke are numbered again", () => {
    const items = [
      { id: "a", z: "garbage" },
      { id: "b", z: "garbage" },
      { id: "c", z: keyBetween(null, null) },
    ];
    const keys = restack(items, ["a"], "front");
    expect(keys.size).toBe(3);
    expect(order(items, keys).endsWith("a")).toBe(true);
    expect(renumber(items).size).toBe(3);
  });
});

describe("colors", () => {
  test("contrast follows WCAG", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("nope")).toBeNull();
    expect(hexRgb("#0a0b0c")).toEqual([10, 11, 12]);
    expect(hexRgb("#abc")).toEqual([170, 187, 204]);
    expect(readableOn("#0063d1", ["#0e1a2b", "#ffffff"])).toBe("#ffffff");
  });

  // The app's own surfaces (packages/tokens): light bg, raised, sunken; dark bg, raised, raised2.
  const LIGHT = ["#ffffff", "#fbfbfa", "#f3f3f0"];
  const DARK = ["#0f0f0e", "#1c1c1b", "#242423"];

  test("people's colors read at 4.5:1 on every surface, and as tags with text on them", () => {
    expect(PEER_COLORS).toHaveLength(10);
    for (const { light, dark } of PEER_COLORS) {
      for (const surface of LIGHT) expect(contrastRatio(light, surface)).toBeGreaterThanOrEqual(4.5);
      for (const surface of DARK) expect(contrastRatio(dark, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#ffffff", light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#0f0f0e", dark)).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set(PEER_COLORS.map((c) => c.light)).size).toBe(10);
  });

  test("a person's color is stable and spreads over the palette", () => {
    expect(peerColor("ada")).toBe(peerColor("ada"));
    expect(peerColor("ada", true)).toBe(PEER_COLORS[fnv1a("ada") % 10]?.dark as string);
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) used.add(peerColor(`person-${i}`));
    expect(used.size).toBe(10);
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });
});

describe("kinds, limits and origins", () => {
  test("the four kinds", () => {
    expect(LIVE_KINDS).toEqual(["spreadsheet", "slides", "canvas", "document"]);
    expect(isLiveKind("slides")).toBe(true);
    expect(isLiveKind("document")).toBe(true);
    expect(isLiveKind("deck")).toBe(false);
    expect(LIVE_LIMITS.awarenessBytes).toBe(4096);
    expect(LIVE_LIMITS.slides.elements).toBe(200);
  });

  test("origins say who changed the document", () => {
    expect(agentOrigin("ag1", "run1")).toEqual({ kind: "agent", agentId: "ag1", runId: "run1" });
    expect(agentOrigin("ag1")).toEqual({ kind: "agent", agentId: "ag1" });
    for (const origin of [LOCAL, REMOTE, SYSTEM, agentOrigin("x")]) expect(isLiveOrigin(origin)).toBe(true);
    expect(isLiveOrigin({ kind: "other" })).toBe(false);
    expect(isLiveOrigin(null)).toBe(false);
    expect(Object.isFrozen(LOCAL)).toBe(true);
  });
});
