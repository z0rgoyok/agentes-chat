import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { accentSky } from "@agenteschat/tokens/accent";
import { act, cleanup, render } from "@testing-library/react";
import { bodyTones, DEFAULT_SKY, drawnKey, gradientOf, setSkyColors } from "../src/agent/engine.js";
import { EffortPixels } from "../src/components/EffortPixels";
import { workspaceSky } from "../src/sky/accent";

const PURPLE = accentSky("#7c3aed");

afterEach(() => {
  setSkyColors(null);
  cleanup();
});

describe("drawings keyed by what `sky` draws as, not by its name (ADR 0193)", () => {
  test("drawnKey: `sky` and no color follow the accent; any other color is itself", () => {
    const before = drawnKey("sky");
    expect(drawnKey(undefined)).toBe(before);
    setSkyColors(PURPLE);
    expect(drawnKey("sky")).not.toBe(before);
    expect(drawnKey("sky")).toBe(PURPLE.join());
    expect(drawnKey("rose")).toBe("rose");
    expect(drawnKey("#123456")).toBe("#123456");
  });

  test("a pair is drawn as is", () => {
    expect(gradientOf(PURPLE)).toEqual(PURPLE);
    setSkyColors(PURPLE);
    expect(bodyTones(PURPLE)).toEqual(bodyTones("sky"));
  });

  test("a workspace's own sky: its accent's pair, or the default blue, whatever workspace is active", () => {
    setSkyColors(accentSky("#f97316"));
    expect(workspaceSky(null)).toEqual(DEFAULT_SKY);
    expect(workspaceSky(undefined)).toEqual(DEFAULT_SKY);
    expect(workspaceSky("not a color")).toEqual(DEFAULT_SKY);
    expect(workspaceSky("#7C3AED")).toEqual(PURPLE);
  });

  test("the effort slider in `sky` repaints in the accent once it changes", async () => {
    const fills: string[] = [];
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k in t ? t[k] : () => {}),
      set: (t, k, v) => {
        if (k === "fillStyle") fills.push(v);
        t[k] = v;
        return true;
      },
    });
    const pen = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as never);
    const was = (["clientWidth", "clientHeight"] as const).map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
    );
    for (const [name] of was) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 60 });
    try {
      const steps = [
        { value: "low", label: "Baixo" },
        { value: "high", label: "Alto" },
      ];
      const slider = () => <EffortPixels value="high" onValueChange={() => {}} steps={steps} label="Esforço" />;
      const painted = async () => {
        fills.length = 0;
        await act(() => new Promise((r) => setTimeout(r, 60)));
        return [...fills];
      };
      const r = render(slider());
      expect(await painted()).toContain(bodyTones("sky")[1] ?? "");
      setSkyColors(PURPLE);
      r.rerender(slider());
      expect(await painted()).toContain(bodyTones(PURPLE)[1] ?? "");
    } finally {
      pen.mockRestore();
      for (const [name, d] of was) if (d) Object.defineProperty(HTMLElement.prototype, name, d);
    }
  });
});
