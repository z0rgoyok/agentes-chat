import { describe, expect, test } from "bun:test";
import {
  AGENT_ARROW,
  type BrowserPointer,
  CURSOR_FLIP_AT,
  CURSOR_IDLE_MS,
  CURSOR_REST_OPACITY,
  CURSOR_TAG_BELOW,
  cursorTagLifts,
  desktopPointerOf,
  frameView,
  glideMs,
  glidePoint,
  nextPointer,
  parseBrowserPointer,
  pointerAtRest,
  pointerInView,
  pointerShare,
} from "../src/browser";

describe("the agent's cursor on its way to a point", () => {
  test("it leaves from where it was and lands exactly on the point, on any shape of picture", () => {
    const from = { x: 0.2, y: 0.8 };
    const to = { x: 0.7, y: 0.3 };
    for (const ratio of [0.625, 1, 1.6]) {
      expect(glidePoint(from, to, 0, ratio)).toEqual(from);
      const end = glidePoint(from, to, 1, ratio);
      expect(end.x).toBeCloseTo(to.x, 9);
      expect(end.y).toBeCloseTo(to.y, 9);
    }
  });

  test("the way there bends off the straight line, and a gesture on the point it is on stays put", () => {
    const half = glidePoint({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 0.5, 1);
    expect(half.x).toBeCloseTo(0.5, 9);
    expect(half.y).not.toBeCloseTo(0.5, 3);
    const same = { x: 0.4, y: 0.4 };
    expect(glidePoint(same, same, 0.5, 0.625)).toEqual(same);
  });

  test("a short hop takes about 0.3 s, the whole picture no more than 0.64 s", () => {
    expect(glideMs(0)).toBe(280);
    expect(glideMs(0.1)).toBeCloseTo(342, 0);
    expect(glideMs(2)).toBe(640);
  });

  test("after 4 s with no gesture it rests where it was, dimmed but still seen", () => {
    expect(CURSOR_REST_OPACITY).toBeGreaterThan(0.3);
    expect(CURSOR_REST_OPACITY).toBeLessThan(0.6);
  });

  test("its name opens above the arrow where the box's bottom would cut it below, never in a box not laid out", () => {
    expect(cursorTagLifts(400 - CURSOR_TAG_BELOW, 400)).toBe(false);
    expect(cursorTagLifts(401 - CURSOR_TAG_BELOW, 400)).toBe(true);
    expect(cursorTagLifts(10, 0)).toBe(false);
  });

  test("its look: rests after 4 s, the name opens to the left past 0.74 of the width, an 8×12 pixel arrow", () => {
    expect(CURSOR_IDLE_MS).toBe(4000);
    expect(CURSOR_FLIP_AT).toBe(0.74);
    expect(AGENT_ARROW).toHaveLength(12);
    for (const row of AGENT_ARROW) expect(row).toMatch(/^[Xo.]{8}$/);
    // The tip, where the gesture lands, is the top left pixel.
    expect(AGENT_ARROW[0]?.[0]).toBe("X");
  });
});

const point = (x: number, y: number, act: BrowserPointer["act"] = "click"): BrowserPointer => ({
  x,
  y,
  width: 1280,
  height: 800,
  act,
});

describe("each gesture of the agent's pointer", () => {
  test("counts up, also for two clicks on the same point", () => {
    const one = nextPointer(null, point(10, 20), 1000);
    const two = nextPointer(one, point(10, 20), 1200);
    expect(one).toEqual({ ...point(10, 20), n: 1, at: 1000 });
    expect(two).toMatchObject({ n: 2, at: 1200 });
    // When it came, stamped as it comes.
    const before = Date.now();
    expect(nextPointer(two, point(1, 2)).at).toBeGreaterThanOrEqual(before);
  });

  test("a gesture under way glides; one over by now, or said before the view opened, is placed at rest", () => {
    const fresh = nextPointer(null, point(10, 20), 1000);
    expect(pointerAtRest(fresh, 1000)).toBe(false);
    expect(pointerAtRest(fresh, 1000 + CURSOR_IDLE_MS)).toBe(false);
    expect(pointerAtRest(fresh, 1001 + CURSOR_IDLE_MS)).toBe(true);
    // The server's copy of the last one, sent as a view opens: long over, whatever the clock says.
    const replayed = nextPointer(null, { ...point(10, 20), replay: true }, 5000);
    expect(replayed).toEqual({ ...point(10, 20), n: 1, at: 0 });
    expect(pointerAtRest(replayed, 5000)).toBe(true);
  });

  test("the last one sent again to a view that already shows it changes nothing; a newer one is placed", () => {
    const shown = nextPointer(null, point(10, 20), 1000);
    expect(nextPointer(shown, { ...point(10, 20), replay: true }, 1100)).toBe(shown);
    const missed = nextPointer(shown, { ...point(30, 40), replay: true }, 1100);
    expect(missed).toEqual({ ...point(30, 40), n: 2, at: 0 });
  });

  test("a replay is said with `replay: true` only", () => {
    expect(parseBrowserPointer({ ...point(1, 2), replay: true })).toEqual({ ...point(1, 2), replay: true });
    expect(parseBrowserPointer({ ...point(1, 2), replay: "yes" })).toEqual(point(1, 2));
  });

  test("the desktop's pointer event is read for that agent only", () => {
    const event = { type: "agent.desktop.pointer", agentId: "a1", pointer: point(5, 6, "double") };
    expect(desktopPointerOf(event, "a1")).toEqual(point(5, 6, "double"));
    expect(desktopPointerOf(event, "a2")).toBeNull();
    expect(desktopPointerOf({ ...event, type: "agent.desktop.status" }, "a1")).toBeNull();
    expect(
      desktopPointerOf({ ...event, pointer: { x: 1, y: 2, width: 0, height: 800, act: "move" } }, "a1"),
    ).toBeNull();
    expect(desktopPointerOf({ ...event, pointer: { ...point(1, 2), act: "drag" } }, "a1")).toBeNull();
    expect(desktopPointerOf({ type: "agent.desktop.pointer" }, "a1")).toBeNull();
  });

  test("the right hand's shared seat and a person's own are told apart: each view draws its own seat's only", () => {
    const own = { type: "agent.desktop.pointer", agentId: "a1", pointer: point(5, 6) };
    const shared = { ...own, shared: true };
    expect(desktopPointerOf(own, "a1")).toEqual(point(5, 6));
    expect(desktopPointerOf(shared, "a1")).toBeNull();
    expect(desktopPointerOf(shared, "a1", true)).toEqual(point(5, 6));
    expect(desktopPointerOf(own, "a1", true)).toBeNull();
  });
});

describe("where the arrow's tip lands on the view", () => {
  test("on a letterboxed page picture: inside the drawn page, never on the bands", () => {
    const view = frameView({ width: 360, height: 300 }, { deviceWidth: 1272, deviceHeight: 653 });
    const at = pointerInView(pointerShare({ x: 630, y: 608, width: 1272, height: 653, act: "click" }), view);
    const scale = 360 / 1272;
    const top = (300 - 653 * scale) / 2;
    expect(at.x).toBeCloseTo(630 * scale, 6);
    expect(at.y).toBeCloseTo(top + 608 * scale, 6);
    expect(at.y).toBeGreaterThan(top);
    expect(at.y).toBeLessThan(300 - top);
  });

  test("each edge of the page is the drawn picture's edge, upright and sideways", () => {
    const page = { deviceWidth: 1280, deviceHeight: 800 };
    for (const box of [
      { width: 390, height: 600 },
      { width: 844, height: 390 },
    ]) {
      const view = frameView(box, page);
      const scale = Math.min(box.width / 1280, box.height / 800);
      const left = (box.width - 1280 * scale) / 2;
      const top = (box.height - 800 * scale) / 2;
      const corner = (x: number, y: number) => pointerInView(pointerShare(point(x, y)), view);
      expect(corner(0, 0).x).toBeCloseTo(left, 6);
      expect(corner(0, 0).y).toBeCloseTo(top, 6);
      expect(corner(1280, 800).x).toBeCloseTo(box.width - left, 6);
      expect(corner(1280, 800).y).toBeCloseTo(box.height - top, 6);
      expect(corner(1280, 0).x).toBeCloseTo(box.width - left, 6);
      expect(corner(0, 800).y).toBeCloseTo(box.height - top, 6);
    }
  });

  test("through a camera on the desktop: the same place the picture shows that pixel, zoomed and panned", () => {
    const desk = { width: 1280, height: 900 };
    const share = pointerShare({ x: 640, y: 450, width: 2560, height: 1800, act: "move" });
    // The whole desktop at a quarter scale.
    expect(pointerInView(share, { s: 0.25, x: 0, y: 0, ...desk })).toEqual({ x: 80, y: 56.25 });
    // Pinched to 2× and panned to the desktop's (500, 300): the picture puts pixel p at (p - camera) × s.
    expect(pointerInView(share, { s: 2, x: 500, y: 300, ...desk })).toEqual({ x: (320 - 500) * 2, y: (225 - 300) * 2 });
    // The desktop's far corner, with the camera at its far end.
    expect(pointerInView({ x: 1, y: 1 }, { s: 2, x: 1280 - 195, y: 900 - 300, ...desk })).toEqual({ x: 390, y: 600 });
  });

  test("no size yet places nothing off in the distance", () => {
    const view = frameView({ width: 0, height: 0 }, { deviceWidth: 1280, deviceHeight: 800 });
    expect(pointerInView({ x: 0.5, y: 0.5 }, view)).toEqual({ x: 0, y: 0 });
  });
});
