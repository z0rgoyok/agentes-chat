import { describe, expect, test } from "bun:test";
import { brandLook, brandRandom } from "../src/lib/brand-look";

describe("a service's look in the connectors store", () => {
  test("a known brand: its own colors, the leading one first; a mark in its maker's colors is never tinted", () => {
    expect(brandLook("/connectors/figma.svg", null)).toEqual({
      mark: "/connectors/figma.svg",
      own: false,
      colors: ["#A259FF", "#F24E1E", "#1ABCFE", "#0ACF83", "#FF7262"],
    });
    expect(brandLook("/brands/canva.svg", null)).toMatchObject({ mark: "/brands/canva.svg", own: true });
  });

  test("any other brand: its brand color, a lighter and a deeper one; none, our sky's blues", () => {
    expect(brandLook("/connectors/zapier.svg", "#FF4F00").colors).toEqual(["#FF4F00", "#ff9566", "#a93705"]);
    expect(brandLook("/connectors/zapier.svg", null).colors).toEqual(["#2B74E6", "#78B4FF", "#0F56C4"]);
  });

  test("only our own files are marks; a color that isn't #rrggbb is no brand color", () => {
    expect(brandLook("https://example.com/x.svg", "#FF4F00").mark).toBeNull();
    expect(brandLook("/api/app/connector-icons/a.png", null).mark).toBeNull();
    expect(brandLook(null, "red").colors).toEqual(["#2B74E6", "#78B4FF", "#0F56C4"]);
  });

  test("the same numbers for the same brand, on every visit and device", () => {
    const a = brandRandom("/connectors/figma.svg");
    const b = brandRandom("/connectors/figma.svg");
    const seq = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seq);
    expect(seq.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});
