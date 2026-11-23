import { describe, expect, test } from "bun:test";
import { accentPalette, contrastRatio, DEFAULT_ACCENT } from "../src/accent";
import { dark, light } from "../src/index";

const HEX = /^#[0-9a-f]{6}$/;

describe("accentPalette", () => {
  test("the design system's blue gives back the default tokens exactly", () => {
    const p = accentPalette(DEFAULT_ACCENT);
    for (const [palette, theme] of [
      [p.light, light],
      [p.dark, dark],
    ] as const) {
      expect(palette).toEqual({
        agent: theme.agent,
        agent2: theme.agent2,
        agentSoft: theme.agentSoft,
        onAgent: theme.onAgent,
      });
    }
    expect(accentPalette("#0063D1")).toEqual(p);
  });

  const picks = {
    gray: "#808080",
    "light gray": "#c8c8c8",
    "near white": "#fdfdfd",
    white: "#ffffff",
    "near black": "#050505",
    black: "#000000",
    "pure yellow": "#ffff00",
    "pure red": "#ff0000",
    "pure green": "#00ff00",
    cyan: "#00ffff",
    purple: "#7c3aed",
    orange: "#f97316",
    navy: "#001a33",
  };

  for (const [name, hex] of Object.entries(picks)) {
    test(`${name} comes out readable in both themes`, () => {
      const p = accentPalette(hex);
      for (const [tokens, theme] of [
        [p.light, light],
        [p.dark, dark],
      ] as const) {
        for (const v of Object.values(tokens)) expect(v).toMatch(HEX);
        expect(contrastRatio(tokens.agent, theme.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens.agent, tokens.agentSoft)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens.agent, tokens.onAgent)).toBeGreaterThanOrEqual(4.5);
        expect([light.onAgent, dark.onAgent]).toContain(tokens.onAgent);
      }
    });
  }

  test("a color already readable is not moved", () => {
    expect(accentPalette("#6d28d9").light.agent).toBe("#6d28d9");
    expect(accentPalette("#ffb020").dark.agent).toBe("#ffb020");
  });

  test("the lighter step is lighter and the soft surface is quiet", () => {
    const p = accentPalette("#7c3aed");
    expect(contrastRatio(p.light.agent2, "#ffffff")).toBeLessThan(contrastRatio(p.light.agent, "#ffffff"));
    expect(contrastRatio(p.dark.agent2, "#000000")).toBeGreaterThan(contrastRatio(p.dark.agent, "#000000"));
    expect(contrastRatio(p.light.agentSoft, light.bg)).toBeLessThan(1.3);
    expect(contrastRatio(p.dark.agentSoft, dark.bg)).toBeLessThan(1.6);
  });

  test("anything not a #rrggbb is the default", () => {
    expect(accentPalette("red")).toEqual(accentPalette(DEFAULT_ACCENT));
  });
});
