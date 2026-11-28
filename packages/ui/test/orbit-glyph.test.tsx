import { expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { OrbitGlyph } from "../src";
import { ORBIT_RINGS } from "../src/agent/orbit-rings";

test("each ring turns round the face itself, at its own pace and way, the same in front of and behind it", () => {
  const { container } = render(
    <OrbitGlyph appearance={{ color: "indigo" }}>
      <span />
    </OrbitGlyph>,
  );
  const layers = [".ac-orbit__back", ".ac-orbit__front"].map((sel) => container.querySelector(sel));
  const rolls = layers.map((layer) =>
    [...(layer?.querySelectorAll(".ac-orbit__ring > .ac-orbit__roll") ?? [])].map((g) => (g as SVGElement).style),
  );
  for (const layer of rolls) {
    expect(layer).toHaveLength(ORBIT_RINGS.length);
    // The ring's line, its light and its dot all ride the turning group.
    ORBIT_RINGS.forEach((ring, i) => {
      expect(layer[i]?.getPropertyValue("--spin")).toBe(`${Math.abs(ring.spin)}s`);
      expect(layer[i]?.animationDirection).toBe(ring.spin < 0 ? "reverse" : "");
    });
  }
  // Behind and in front of the face, one ring is one turn: the same starting point in both layers.
  expect(rolls[0]?.map((s) => s.animationDelay)).toEqual(rolls[1]?.map((s) => s.animationDelay) ?? []);
  const back = container.querySelector(".ac-orbit__back");
  expect(back?.querySelectorAll(".ac-orbit__roll .ac-orbit__path")).toHaveLength(ORBIT_RINGS.length);
  expect(back?.querySelectorAll(".ac-orbit__roll .ac-orbit__spin")).toHaveLength(ORBIT_RINGS.length);
  // Slow and calm beside the light, each ring its own pace, the two turning opposite ways so they keep crossing.
  for (const ring of ORBIT_RINGS) expect(Math.abs(ring.spin)).toBeGreaterThan(ring.turn * 4);
  expect(new Set(ORBIT_RINGS.map((r) => Math.abs(r.spin))).size).toBe(ORBIT_RINGS.length);
  expect(new Set(ORBIT_RINGS.map((r) => Math.sign(r.spin))).size).toBe(2);
});
