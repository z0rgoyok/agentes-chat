import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { addShape, canvasPreview, initLiveDoc, type ShapeView } from "@agenteschat/live";
import { cleanup, render } from "@testing-library/react";
import * as Y from "yjs";
import { CanvasMini } from "@/components/live/canvas";
import { isInk, strokeStyle } from "@/components/live/canvas/palette";
import { ArrowShape, ShapeBody } from "@/components/live/canvas/shapes";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage } from "./render";

/**
 * The canvas's newer shapes as the web draws them (ADR 0196 §2): pen strokes as a path (the marker see-through), hidden
 * shapes not at all, arrows along their route with their heads (a line has none) in their own color, and the small
 * map on cards drawing forms, strokes and routes.
 */

afterEach(() => cleanup());

const base = { x: 0, y: 0, w: 100, h: 50, z: "a0" };

describe("the shape layer", () => {
  test("a pen stroke is a path in its box; a hidden shape isn't drawn", () => {
    const stroke: ShapeView = {
      ...base,
      id: "s1",
      type: "draw",
      points: [0, 0, 50, 50, 100, 0],
      stroke: "#e5484d",
      strokeWidth: 6,
      tool: "marker",
    };
    const body = (shape: ShapeView) => <ShapeBody shape={shape} editing={false} interacting={false} fresh={false} />;
    const { container, rerender } = render(body(stroke));
    const svg = container.querySelector("svg.cnv-draw");
    expect(svg?.getAttribute("data-tool")).toBe("marker");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe("M0 0 Q50 50 75 25 L100 0");
    expect((svg as SVGElement | null)?.style.getPropertyValue("--stroke-light")).toBe("#e5484d");
    rerender(body({ ...stroke, hidden: true }));
    expect(container.querySelector(".cnv-shape")).toBeNull();
  });

  test("arrows: a curve with two heads in its color; a line has no head; by default one at the end", () => {
    const line = { x1: 0, y1: 0, x2: 200, y2: 0 };
    const { container } = render(
      <>
        <ArrowShape
          id="a1"
          line={line}
          dashed={false}
          label="then"
          editingLabel={false}
          look={{ route: "curve", heads: { start: "arrow", end: "arrow" }, stroke: "#151514", strokeWidth: 4 }}
        />
        <ArrowShape
          id="a2"
          line={line}
          dashed
          label={undefined}
          editingLabel={false}
          look={{ heads: { start: "none", end: "none" } }}
        />
        <ArrowShape id="a3" line={line} dashed={false} label={undefined} editingLabel={false} />
      </>,
    );
    const [curve, plain, arrow] = [...container.querySelectorAll(".cnv-arrow")] as HTMLElement[];
    expect(curve?.querySelector("path")?.getAttribute("d")).toContain("Q");
    expect(curve?.querySelectorAll(".cnv-arrow__head")).toHaveLength(2);
    expect(curve?.getAttribute("data-stroke")).toBe("custom");
    // The ink is drawn light on the dark canvas.
    expect(curve?.style.getPropertyValue("--stroke-dark")).toBe("#efefec");
    expect(plain?.querySelectorAll(".cnv-arrow__head")).toHaveLength(0);
    expect(plain?.querySelector("path")?.getAttribute("stroke-dasharray")).toBe("8 7");
    expect(arrow?.querySelectorAll(".cnv-arrow__head")).toHaveLength(1);
  });

  test("the ink and the colors as CSS variables", () => {
    expect(isInk("#151514")).toBe(true);
    expect(isInk("#000")).toBe(true);
    expect(isInk("#e5484d")).toBe(false);
    expect(strokeStyle(undefined)).toBeUndefined();
    expect(strokeStyle("#0063d1", 3)).toEqual({
      "--stroke-light": "#0063d1",
      "--stroke-dark": "#0063d1",
      "--stroke-width": "3",
    } as never);
  });
});

describe("the small map on cards", () => {
  test("forms, a pen stroke and a curved line; hidden shapes left out", async () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "canvas");
    const a = addShape(doc, { type: "shape", kind: "star", x: 0, y: 0, w: 200, h: 200 }, null);
    const b = addShape(doc, { type: "shape", kind: "triangle", x: 400, y: 0, w: 200, h: 200 }, null);
    addShape(doc, { type: "arrow", from: { shape: a }, to: { shape: b }, route: "curve" }, null);
    addShape(doc, { type: "draw", points: [0, 0, 30, 30, 60, 0], x: 0, y: 400 }, null);
    addShape(doc, { type: "note", x: 900, y: 900, hidden: true }, null);
    await renderPage(<CanvasMini preview={canvasPreview(doc)} />, { api: createFakeApi(seedState()), org: true });
    expect(document.querySelectorAll("polygon.cnv-mini__shape")).toHaveLength(2);
    expect(document.querySelector("path.cnv-mini__arrow")?.getAttribute("d")).toContain("Q");
    expect(document.querySelector("path.cnv-mini__draw")?.getAttribute("transform")).toBe("translate(0 400)");
    expect(document.querySelector('rect[fill="#fdf0b0"]')).toBeNull();
  });
});
