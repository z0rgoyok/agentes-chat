import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { claimPlayback, releasePlayback, stopPlayback } from "../src/components/media-playback";
import { VideoPlayer, type VideoPlayerProps } from "../src/components/VideoPlayer";

afterEach(() => cleanup());

const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
/** The declarations of the first rule written exactly as `selector {`. */
const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";

const labels: VideoPlayerProps["labels"] = {
  play: "Tocar",
  pause: "Pausar",
  replay: "Ver de novo",
  seek: "Posição no vídeo",
  volume: "Volume",
  mute: "Tirar o som",
  unmute: "Ligar o som",
  speed: (s) => `Velocidade ${s}×`,
  fullscreen: "Tela cheia",
  exitFullscreen: "Sair da tela cheia",
  open: "Abrir",
};
const player = (props: Partial<VideoPlayerProps> = {}) =>
  render(<VideoPlayer src="/f?version=2" name="abertura.mp4" labels={labels} {...props} />);

describe("VideoPlayer", () => {
  test("stopped: the first frame, a play key named after the file, its length, and the corner group", () => {
    let opened = 0;
    let saved = 0;
    player({
      onOpen: () => opened++,
      actions: (
        <button type="button" onClick={() => saved++}>
          Baixar
        </button>
      ),
    });
    const video = document.querySelector("video");
    // `#t`: the first frame shows before it plays; only its details load until then.
    expect(video?.getAttribute("src")).toBe("/f?version=2#t=0.001");
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(screen.getByRole("button", { name: "Tocar: abertura.mp4" })).toBeTruthy();
    // No name over the picture (a picture's tile has none): only its length, once it is known.
    expect(document.querySelector(".ac-video__caption")).toBeNull();
    expect(document.querySelector(".ac-video__length")).toBeNull();
    Object.defineProperty(video, "duration", { configurable: true, value: 161 });
    fireEvent.loadedMetadata(video as HTMLVideoElement);
    expect(document.querySelector(".ac-video__length")?.textContent).toBe("2:41");
    // The bar waits, out of the tab order, until it plays.
    expect(document.querySelector(".ac-video__bar")?.hasAttribute("inert")).toBe(true);
    // The corner group: open in the viewer, then the caller's actions; a click there never plays the video.
    const group = document.querySelector(".ac-video__acts") as HTMLElement;
    expect(
      Array.from(group.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Abrir", "Baixar"]);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    fireEvent.click(screen.getByRole("button", { name: "Baixar" }));
    expect([opened, saved]).toEqual([1, 1]);
  });

  test("the viewer has no length badge and no corner button", () => {
    player({ variant: "viewer", onOpen: () => undefined });
    expect(document.querySelector(".ac-video__acts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir" })).toBeNull();
  });

  test("a video that can't play here says so to the caller", () => {
    let failed = 0;
    player({ onFailed: () => failed++ });
    const video = document.querySelector("video");
    if (!video) throw new Error("no video");
    fireEvent.error(video);
    expect(failed).toBe(1);
  });

  test("its link went stale while the page stayed open: it loads once more and goes on from there", async () => {
    let failed = 0;
    player({ onFailed: () => failed++ });
    const [v] = videos() as [HTMLVideoElement];
    const video = fake(v, { ready: true, time: 42, playing: true });
    let ready = 1;
    let loads = 0;
    Object.defineProperties(v, {
      error: { configurable: true, get: () => ({ code: 2 }) },
      readyState: { configurable: true, get: () => ready },
      load: {
        configurable: true,
        value: () => {
          loads++;
          ready = 0;
          v.currentTime = 0;
        },
      },
    });
    fireEvent.error(v);
    expect([loads, failed]).toEqual([1, 0]);
    await act(async () => {
      ready = 1;
      fireEvent.loadedMetadata(v);
    });
    expect(v.currentTime).toBe(42);
    expect(video.plays.count).toBe(1);
    // A second failure right after is the caller's, who shows the file instead.
    fireEvent.error(v);
    expect([loads, failed]).toEqual([1, 1]);
  });

  test("a page left open for hours: each fresh link that expires in turn is asked for again", () => {
    let failed = 0;
    player({ onFailed: () => failed++ });
    const [v] = videos() as [HTMLVideoElement];
    fake(v, { ready: true, time: 42, playing: true });
    let loads = 0;
    Object.defineProperties(v, {
      error: { configurable: true, get: () => ({ code: 2 }) },
      load: { configurable: true, value: () => loads++ },
    });
    try {
      for (const at of ["09:00", "10:10", "11:20"]) {
        setSystemTime(new Date(`2026-01-05T${at}:00Z`));
        fireEvent.error(v);
      }
      expect([loads, failed]).toEqual([3, 0]);
      setSystemTime(new Date("2026-01-05T11:20:30Z"));
      fireEvent.error(v);
      expect([loads, failed]).toEqual([3, 1]);
    } finally {
      setSystemTime();
    }
  });

  test("crossOrigin reaches the element, so its frames can be read back from a canvas", () => {
    player({ crossOrigin: "anonymous" });
    expect(document.querySelector("video")?.getAttribute("crossorigin")).toBe("anonymous");
  });

  test("speed goes 1×, 1.5×, 2× and back", () => {
    player();
    const speed = () => screen.getByRole("button", { name: /^Velocidade/, hidden: true });
    expect(speed().textContent).toBe("1×");
    fireEvent.click(speed());
    expect(speed().textContent).toBe("1.5×");
    fireEvent.click(speed());
    fireEvent.click(speed());
    expect(speed().textContent).toBe("1×");
  });
});

describe("a file's comments on the player (ADR 0208)", () => {
  test("onVideo hands over the element; onTime hears where it is and how long it is", () => {
    const heard: [number, number][] = [];
    let element: HTMLVideoElement | null = null;
    player({ variant: "viewer", onTime: (at, length) => heard.push([at, length]), onVideo: (v) => (element = v) });
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(element === video).toBe(true);
    expect(heard.at(-1)).toEqual([0, 0]);
    Object.defineProperty(video, "duration", { configurable: true, value: 161 });
    fireEvent.loadedMetadata(video);
    expect(heard.at(-1)).toEqual([0, 161]);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 42 });
    fireEvent.seeked(video);
    expect(heard.at(-1)).toEqual([42, 161]);
    // Only when something changed.
    const before = heard.length;
    fireEvent.seeked(video);
    expect(heard.length).toBe(before);
  });

  test("marks sit beside the timeline, never inside its slider", () => {
    player({
      variant: "viewer",
      marks: (
        <button type="button" className="mark" style={{ left: "25%" }}>
          1
        </button>
      ),
    });
    const box = document.querySelector(".ac-video__seekbox") as HTMLElement;
    const slider = screen.getByRole("slider", { name: "Posição no vídeo", hidden: true });
    expect(box.contains(slider)).toBe(true);
    const marks = box.querySelector(".ac-video__marks") as HTMLElement;
    expect(marks.querySelector("button.mark")?.textContent).toBe("1");
    expect(slider.contains(marks)).toBe(false);
    expect(marks.contains(slider)).toBe(false);
  });

  test("with no marks, the timeline is as it was", () => {
    player({ variant: "viewer" });
    expect(document.querySelector(".ac-video__seekbox")).toBeNull();
    expect(document.querySelector(".ac-video__marks")).toBeNull();
    expect(screen.getByRole("slider", { name: "Posição no vídeo", hidden: true })).toBeTruthy();
  });
});

describe("a slider's knob", () => {
  test("travels inside its track, and the volume's box that slides open has room for it at both ends", () => {
    player();
    const knobs = Array.from(document.querySelectorAll<HTMLElement>(".ac-video__knob"));
    expect(knobs.length).toBe(2);
    // The volume starts full: at its end, never `left: 100%`, which put half the knob past the track.
    for (const k of knobs) expect(k.style.left).toBe("");
    expect(knobs[1]?.style.getPropertyValue("--at")).toBe("1");
    expect(rule(".ac-video__knob")).toContain("left: calc(var(--knob) / 2 + var(--at, 0) * (100% - var(--knob)));");
    // On hover the knob grows by a quarter and keeps a 2px ring: 9.5px from its centre, which sits 6px inside the
    // track's end, so the rail keeps at least 3.5px of the clipping box on each side.
    const side = Number(/margin: 0 (\d+)px;/.exec(rule(".ac-video__volume .ac-video__rail"))?.[1] ?? 0);
    expect(side).toBeGreaterThanOrEqual(4);
    const open = Number(/width: (\d+)px;/.exec(rule(".ac-video__sound:focus-within .ac-video__volume"))?.[1]);
    expect(open).toBe(56 + 2 * side);
  });
});

describe("full screen", () => {
  const setFull = (el: Element | null) => {
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: el });
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  };

  test("the player marks itself while it is the full screen element", () => {
    player({ onOpen: () => undefined });
    const root = document.querySelector(".ac-video") as HTMLElement;
    try {
      setFull(root);
      expect(root.hasAttribute("data-full")).toBe(true);
      setFull(null);
      expect(root.hasAttribute("data-full")).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  test("a chat tile keeps its fixed box only outside full screen, where the video then fills the screen whole", () => {
    expect(rule(".ac-video--tile .ac-video__media")).toBe("");
    const box = rule(".ac-video--tile:not([data-full]) .ac-video__media");
    expect(box).toContain("width: 320px");
    expect(box).toContain("height: 180px");
    const media = rule(".ac-video__media");
    expect(media).toContain("width: 100%");
    expect(media).toContain("height: 100%");
    expect(media).toContain("object-fit: contain");
    // The tile's compact bar and its missing total time stay in the chat too.
    expect(rule(".ac-video--tile .ac-video__bar")).toBe("");
    expect(rule(".ac-video--tile .ac-video__total")).toBe("");
    expect(rule(".ac-video--tile:not([data-full]) .ac-video__total")).toContain("display: none");
    // The viewer and menus the corner opens would land behind the full screen.
    expect(rule(".ac-video[data-full] .ac-video__acts")).toContain("display: none");
    expect(rule(".ac-video[data-full]")).toContain("box-shadow: none");
  });

  test("a tile whose size the server read has the video's shape from the first paint, an upright one upright", () => {
    player({ ratio: 9 / 16 });
    const root = document.querySelector(".ac-video") as HTMLElement;
    expect(root.hasAttribute("data-ratio")).toBe(true);
    expect(root.style.getPropertyValue("--ratio")).toBe(String(9 / 16));
    const shaped = rule(".ac-video--tile[data-ratio]:not([data-full]) .ac-video__media");
    expect(shaped).toContain("width: min(320px, calc(360px * var(--ratio)))");
    expect(shaped).toContain("aspect-ratio: var(--ratio)");
    expect(shaped).toContain("height: auto");
    cleanup();
    // The viewer fills its box whatever the video's shape; a tile with no size read keeps the 16:9 box.
    player({ variant: "viewer", ratio: 9 / 16 });
    expect(document.querySelector(".ac-video")?.hasAttribute("data-ratio")).toBe(false);
    cleanup();
    player();
    expect(document.querySelector(".ac-video")?.hasAttribute("data-ratio")).toBe(false);
  });
});

describe("one thing plays at a time", () => {
  test("claiming stops the one before; releasing forgets it", () => {
    const stopped: string[] = [];
    const a = () => stopped.push("a");
    const b = () => stopped.push("b");
    claimPlayback(a);
    claimPlayback(b);
    expect(stopped).toEqual(["a"]);
    releasePlayback(b);
    stopPlayback();
    expect(stopped).toEqual(["a"]);
    claimPlayback(a);
    stopPlayback();
    expect(stopped).toEqual(["a", "a"]);
  });
});

/** A video element the test drives: where it is, whether it plays, and what `play()` answers. */
function fake(v: HTMLVideoElement, at: { time?: number; playing?: boolean; ready?: boolean; refuse?: number } = {}) {
  let time = at.time ?? 0;
  let paused = !at.playing;
  let ready = at.ready ? 1 : 0;
  let refuse = at.refuse ?? 0;
  const plays = { count: 0 };
  Object.defineProperties(v, {
    currentTime: { configurable: true, get: () => time, set: (t: number) => (time = t) },
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => false },
    duration: { configurable: true, get: () => 161 },
    readyState: { configurable: true, get: () => ready },
    play: {
      configurable: true,
      value: () => {
        plays.count++;
        if (refuse > 0) {
          refuse--;
          return Promise.reject(Object.assign(new Error("refused"), { name: "NotAllowedError" }));
        }
        paused = false;
        v.dispatchEvent(new Event("play"));
        return Promise.resolve();
      },
    },
    pause: {
      configurable: true,
      value: () => {
        if (paused) return;
        paused = true;
        v.dispatchEvent(new Event("pause"));
      },
    },
  });
  return {
    plays,
    load() {
      ready = 1;
      fireEvent.loadedMetadata(v);
    },
  };
}
const videos = () => Array.from(document.querySelectorAll("video"));
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

describe("a viewer opened over a chat tile takes its playback over", () => {
  /** The tile on screen as the test says, then the viewer of the same file opening over it. */
  type At = NonNullable<Parameters<typeof fake>[1]>;
  function openOver(tile: At, viewer: At = {}) {
    player({ handoff: "file-1", onOpen: () => undefined });
    const [t] = videos() as [HTMLVideoElement];
    const tileVideo = fake(t, { ready: true, ...tile });
    t.playbackRate = 1.5;
    t.volume = 0.6;
    if (tile.playing) fireEvent.play(t);
    // The viewer's element is faked as soon as React makes it, before its handoff runs.
    const made = document.createElement.bind(document);
    let viewerVideo: ReturnType<typeof fake> | undefined;
    const spy = (name: string, options?: ElementCreationOptions) => {
      const el = made(name, options);
      if (name === "video") viewerVideo = fake(el as HTMLVideoElement, viewer);
      return el;
    };
    document.createElement = spy as typeof document.createElement;
    let closed: (() => void) | undefined;
    try {
      closed = player({ handoff: "file-1", variant: "viewer" }).unmount;
    } finally {
      document.createElement = made;
    }
    const v = videos()[1] as HTMLVideoElement;
    if (!viewerVideo) throw new Error("no viewer video");
    return { t, tileVideo, v, viewerVideo, close: closed };
  }

  test("playing: the tile stops, the viewer plays on from its moment at its speed and sound", async () => {
    const { t, v, viewerVideo } = openOver({ time: 42, playing: true });
    expect(t.paused).toBe(true);
    // It goes on once it knows its length.
    expect(viewerVideo.plays.count).toBe(0);
    await act(async () => viewerVideo.load());
    expect(v.currentTime).toBe(42);
    expect(v.playbackRate).toBe(1.5);
    expect(v.volume).toBe(0.6);
    expect(v.muted).toBe(false);
    expect(viewerVideo.plays.count).toBe(1);
    expect(v.paused).toBe(false);
    const viewer = document.querySelectorAll(".ac-video")[1] as HTMLElement;
    expect(viewer.dataset.phase).toBe("playing");
    expect(viewer.querySelector(".ac-video__speed")?.textContent).toBe("1.5×");
  });

  test("paused: the viewer waits at the same moment, its bar showing, nothing plays", async () => {
    const { v, viewerVideo } = openOver({ time: 30 });
    await act(async () => viewerVideo.load());
    expect(v.currentTime).toBe(30);
    expect(viewerVideo.plays.count).toBe(0);
    const viewer = document.querySelectorAll(".ac-video")[1] as HTMLElement;
    expect(viewer.dataset.phase).toBe("paused");
    expect(viewer.querySelector(".ac-video__bar")?.hasAttribute("inert")).toBe(false);
  });

  test("closing gives the tile the viewer's moment, paused", async () => {
    const { t, tileVideo, v, viewerVideo, close } = openOver({ time: 42, playing: true });
    await act(async () => viewerVideo.load());
    v.currentTime = 75;
    act(() => close?.());
    expect(t.currentTime).toBe(75);
    expect(t.paused).toBe(true);
    expect(tileVideo.plays.count).toBe(0);
    expect(document.querySelector(".ac-video__speed")?.textContent).toBe("1.5×");
  });

  test("closed before it loaded: the tile goes on as it was", () => {
    const { t, tileVideo, close } = openOver({ time: 42, playing: true });
    act(() => close?.());
    expect(t.currentTime).toBe(42);
    expect(tileVideo.plays.count).toBe(1);
    expect(t.paused).toBe(false);
  });

  test("sound refused by the browser: it plays muted", async () => {
    const { v, viewerVideo } = openOver({ time: 42, playing: true }, { refuse: 1 });
    await act(async () => viewerVideo.load());
    await flush();
    expect(viewerVideo.plays.count).toBe(2);
    expect(v.muted).toBe(true);
    expect(v.paused).toBe(false);
  });

  test("refused even muted: it waits at the moment with its sound as it was and its play button focused", async () => {
    const { v, viewerVideo } = openOver({ time: 42, playing: true }, { refuse: 2 });
    await act(async () => viewerVideo.load());
    await flush();
    expect(viewerVideo.plays.count).toBe(2);
    expect(v.muted).toBe(false);
    expect(v.currentTime).toBe(42);
    const viewer = document.querySelectorAll(".ac-video")[1] as HTMLElement;
    expect(viewer.dataset.phase).toBe("paused");
    expect(document.activeElement).toBe(viewer.querySelector(".ac-video__play"));
  });

  test("a tile never started hands nothing over", async () => {
    const { v, viewerVideo } = openOver({});
    await act(async () => viewerVideo.load());
    expect(v.currentTime).toBe(0);
    expect(viewerVideo.plays.count).toBe(0);
    expect((document.querySelectorAll(".ac-video")[1] as HTMLElement).dataset.phase).toBe("idle");
  });

  test("another file's tile keeps playing", () => {
    player({ handoff: "file-2" });
    const [t] = videos() as [HTMLVideoElement];
    fake(t, { ready: true, time: 10, playing: true });
    player({ handoff: "file-1", variant: "viewer" });
    expect(t.paused).toBe(false);
  });
});

describe("one video plays at a time, on screen", () => {
  test("starting one pauses the one playing", async () => {
    player();
    player();
    const [a, b] = videos() as [HTMLVideoElement, HTMLVideoElement];
    const fa = fake(a, { ready: true });
    fake(b, { ready: true });
    await act(async () => {
      await a.play();
    });
    expect(a.paused).toBe(false);
    await act(async () => {
      await b.play();
    });
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    expect(fa.plays.count).toBe(1);
  });
});
