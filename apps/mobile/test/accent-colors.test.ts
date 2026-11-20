import { describe, expect, test } from "bun:test";
import { accentPalette, accentSky } from "@agenteschat/tokens/accent";
import { bodyTones, gradientOf } from "@agenteschat/ui/agent/engine";
import { contrastRatio } from "../src/lib/nav";
import { appColors, paintSky, sheetColors, skyAccent, withAccent } from "../src/ui/palette";
import { ditherPaths } from "../src/ui/role-mark";

describe("a workspace's accent on the phone (ADR 0193)", () => {
  test("its agent colors take the place of the theme's, in both themes, and nothing else moves", () => {
    for (const scheme of ["light", "dark"] as const) {
      const base = appColors(scheme);
      const painted = withAccent(base, scheme, "#F97316");
      const want = accentPalette("#f97316")[scheme];
      expect([painted.agent, painted.agent2, painted.agentSoft, painted.onAgent]).toEqual([
        want.agent,
        want.agent2,
        want.agentSoft,
        want.onAgent,
      ]);
      expect({ ...painted, agent: "", agent2: "", agentSoft: "", onAgent: "" }).toEqual({
        ...base,
        agent: "",
        agent2: "",
        agentSoft: "",
        onAgent: "",
      });
      // Readable on the phone's own pages and sheets, the native light white included.
      expect(contrastRatio(painted.agent, painted.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.agent, sheetColors(painted, scheme).bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.agent, painted.onAgent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("no accent, or anything not a #rrggbb: the theme's own colors", () => {
    const base = appColors("light");
    expect(withAccent(base, "light", null)).toBe(base);
    expect(withAccent(base, "light", undefined)).toBe(base);
    expect(withAccent(base, "light", "orange")).toBe(base);
  });

  test("the provider's sky: the accent's pair while one is shown, the default again once cleared", () => {
    const sky = gradientOf("sky");
    const rose = gradientOf("rose");
    paintSky("#f97316");
    try {
      expect(skyAccent()).toBe("#f97316");
      expect(gradientOf("sky")).toEqual(accentSky("#f97316"));
      expect(gradientOf("rose")).toEqual(rose);
    } finally {
      paintSky(null);
    }
    expect(skyAccent()).toBeNull();
    expect(gradientOf("sky")).toEqual(sky);
  });

  test("a role mark in `sky` is drawn in the accent once it changes, not from a cache kept by the name", () => {
    const fills = () => ditherPaths("sky", 8).map((p) => p.fill);
    for (const fill of fills()) expect(bodyTones("sky")).toContain(fill);
    paintSky("#f97316");
    try {
      const painted = fills();
      expect(painted.length).toBeGreaterThan(0);
      for (const fill of painted) expect(bodyTones(accentSky("#f97316"))).toContain(fill);
    } finally {
      paintSky(null);
    }
    for (const fill of fills()) expect(bodyTones("sky")).toContain(fill);
  });
});
