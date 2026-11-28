/**
 * Opens the app's conversations in headless Chromium, against a local server (PGlite, the fakes, the built web app),
 * and fails when what is on screen moves by itself: a placeholder that isn't its card's size, a card growing when its
 * data comes, a thread opening at one place and jumping to another. No dev server, no network.
 *
 *   bun run --filter @agenteschat/web build
 *   bun run check:shifts [--web <dist>] [--report <file>] [--shots <dir> [--frames <screen>]]
 *   bun run check:shifts --self-test   (the fixture's twins alone: no build, no server)
 *
 * Each screen opens at a desktop and a phone size, every request answered `LATENCY_MS` late (data arrives in steps, as
 * on a real network). Two measures, summed per screen:
 * - Chromium's layout shifts (the Layout Instability API), input excluded.
 * - Jumps: rows of a conversation moving under the reader's eyes with no input. A scroller pinned to its end follows
 *   what changes size at its foot by scrolling, and the API counts no scroll at all (measured: a card shrinking at the
 *   end of a pinned list scores 0 there while everything above it drops 180 px).
 * The API also errs the other way in a conversation's list: one that only starts to overflow in a frame, scrolled to
 * its end in that same frame, has its rows reported moved by the whole scroll, though they never left their place on
 * screen (measured, frame by frame: a DM whose intro is drawn at content-visibility's 56 px placeholder, then at its
 * 523 px, scores 0.107 with every row still). A shift whose sources all sit in a list, where the shift says they were
 * (within 3 px: the API rounds its boxes, and a line of text is measured by its line), is that one; the jumps watch
 * those rows as painted. So is a row first painted in the frame of the shift: Chromium laid it out twice in that frame
 * (placeholders, then real sizes, measured on a phone-size DM: rows reported 24 px off, no frame showing them there) and
 * reports the unpainted first place.
 * A screen over `LIMIT` fails. Before the screens, the fixture's twins prove both measures (`shifts-fixture.html`).
 *
 * Then a long channel is scrolled through, a wheel's worth a frame (`SCROLL`), up to its first message and back down:
 * what is on screen must move by the scroll alone, and never wait at the top for older messages. Once more as a browser
 * with no scroll anchoring (Safari, the desktop app on macOS): no row may change height as it comes into view.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { seed } from "../../apps/server/test/shifts-seed";
import { findChrome, launch } from "./check";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
/** Every request this late: what is loaded in steps shows each step, as on a phone's network. */
const LATENCY_MS = 150;
/** A screen's total (both measures, CLS's units) above this fails: a few pixels of one row, never a card's jump. */
export const LIMIT = 0.002;
/** How long nothing may change (DOM, requests) before a screen counts as settled, and the most a screen gets. */
const QUIET_MS = 800;
const SETTLE_MAX_MS = 15_000;

export const SIZES = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
] as const;

/**
 * Installed before the page's own scripts. `__shift.take()` hands over what moved since the last take:
 * - `entries`: layout shifts Chromium reports (sources named by tag, classes and words).
 * - `jumps`: painted frames in which rows of a `.channel__messages` list on screen before or after moved with no input
 *   in the last 500 ms, scored as CLS scores a shift (moved area over the window's, times the distance over its longest
 *   side).
 *   Rows gliding (an entrance that moves them) are motion on purpose and skipped; a row only fading in still counts.
 *   Positions are relative to the list, so a panel sliding in moves nothing.
 */
export const MEASURE = String.raw`(() => {
  if (window.__shift) return;
  const s = { entries: [], jumps: [], lastInput: -1e9, lastChange: performance.now() };
  window.__shift = s;
  const input = () => { s.lastInput = performance.now(); };
  for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(t, input, { capture: true, passive: true });
  const label = (n) => {
    const el = n && n.nodeType === 3 ? n.parentElement : n;
    if (!el || el.nodeType !== 1) return '?';
    const cls = [...el.classList].slice(0, 3).join('.');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36);
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const stayed = (x) => {
        const el = x.node && x.node.nodeType === 3 ? x.node.parentElement : x.node;
        return Boolean(el && el.isConnected && el.closest('.channel__messages') && Math.abs(el.getBoundingClientRect().top - x.previousRect.top) <= 3);
      };
      // A row first painted in this very frame: Chromium can lay a frame out twice (content-visibility's placeholders,
      // then real sizes) and reports where the unpainted first pass put it, a place nobody saw it leave.
      const fresh = (x) => {
        const el = x.node && x.node.nodeType === 3 ? x.node.parentElement : x.node;
        const row = el && el.closest('.channel__messages > *');
        const at = row && firstPainted.get(row);
        return at !== undefined && at !== null && at >= e.startTime - 1;
      };
      if (e.sources && e.sources.length > 0 && e.sources.every((x) => stayed(x) || fresh(x))) continue;
      const box = (r) => [r.x, r.y, r.width, r.height].map(Math.round).join(',');
      // Where the conversation's list stood then (scrolled to, how tall, what it holds first): what moved it.
      const list = document.querySelector('.channel__messages');
      const where = list
        ? 'list ' + Math.round(list.scrollTop) + '/' + list.scrollHeight + ' of ' + list.clientHeight + ', ' + list.children.length + ' rows, first ' + label(list.firstElementChild)
        : 'no list';
      s.entries.push({ at: Math.round(e.startTime), value: e.value, where, sources: (e.sources || []).map((x) => label(x.node) + ' [' + box(x.previousRect) + ']→[' + box(x.currentRect) + ']') });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  const watch = () => new MutationObserver(() => { s.lastChange = performance.now(); })
    .observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-busy', 'data-loading', 'src'] });
  if (document.documentElement) watch(); else addEventListener('DOMContentLoaded', watch);
  const gliding = (row) => row.getAnimations().some((a) => a.effect && a.effect.getKeyframes().some((k) => 'transform' in k || 'translate' in k || 'top' in k));
  let before = new Map();
  const firstPainted = new WeakMap();
  const sample = () => {
    const now = performance.now();
    const seen = new Map();
    let area = 0;
    let far = 0;
    const moved = [];
    for (const list of document.querySelectorAll('.channel__messages')) {
      const box = list.getBoundingClientRect();
      if (box.height < 1) continue;
      for (const row of list.children) {
        const r = row.getBoundingClientRect();
        if (r.height <= 0) continue;
        const top = r.top - box.top;
        seen.set(row, top);
        if (!firstPainted.has(row)) firstPainted.set(row, now);
        const was = before.get(row);
        // A day's divider goes to the top of its day when an older page of that day lands above: the rows it leaves
        // stay where they are (the list keeps its place), so its move is no jump.
        if (was === undefined || Math.abs(was - top) <= 1 || gliding(row)) continue;
        if (row.classList.contains('ac-divider')) continue;
        // On screen before or after: a row the app scrolls out of view moved under the reader's eyes too.
        const shown = (at) => Math.max(0, Math.min(box.height, at + r.height) - Math.max(0, at));
        if (!shown(was) && !shown(top)) continue;
        area += Math.min(r.width, box.width) * Math.min(box.height, shown(was) + shown(top));
        far = Math.max(far, Math.min(box.height, Math.abs(was - top)));
        moved.push(label(row) + ' ' + Math.round(top - was) + 'px');
      }
    }
    before = seen;
    if (moved.length && now - s.lastInput > 500) {
      const value = Math.min(1, area / (innerWidth * innerHeight)) * Math.min(1, far / Math.max(innerWidth, innerHeight));
      s.jumps.push({ at: Math.round(now), value, sources: moved.slice(0, 4) });
    }
  };
  // Each frame as it is about to paint: a ResizeObserver made during the frame runs after the app's (the pin of a list
  // to its end) and before the paint. A task's change after a paint (rows a response just added, laid out before
  // content-visibility draws them) is only read once a frame has drawn it.
  const frame = () => requestAnimationFrame(() => {
    if (!document.documentElement) return frame();
    const ro = new ResizeObserver(() => {
      ro.disconnect();
      sample();
      frame();
    });
    ro.observe(document.documentElement);
  });
  frame();
  s.take = () => {
    const out = { entries: s.entries, jumps: s.jumps };
    s.entries = [];
    s.jumps = [];
    return out;
  };
  s.quietFor = () => performance.now() - s.lastChange;
  s.click = (selector, text) => {
    const all = [...document.querySelectorAll(selector)].filter((e) => !text || (e.textContent || '').includes(text));
    const el = all.find((e) => e.getBoundingClientRect().height > 0);
    if (!el) return false;
    el.click();
    return true;
  };
})();`;

/**
 * Installed before the page's own scripts. `__scroll(step, frames, total)` scrolls the conversation's list `step` px a
 * frame (up when positive; a wheel event first, as the person's), stopping at its top once it holds `total` messages,
 * and reports, each frame read after layout and before paint:
 * - `off`: how far rows on screen moved beyond what the scroll moved them, summed over the frames off by over 1 px.
 * - `wall`: frames spent at the top with older messages still to come (the list stopped there, waiting).
 * - `resized`: rows whose height changed in a frame where none came or went: drawn late, at another height.
 */
export const SCROLL = `(() => {
  const frame = () => new Promise((ok) => requestAnimationFrame(() => {
    const ro = new ResizeObserver(() => { ro.disconnect(); ok(); });
    ro.observe(document.documentElement);
  }));
  window.__scroll = async (step, frames, total) => {
    const list = document.querySelector('.channel__messages');
    const out = { off: 0, worst: 0, wall: 0, resized: 0, frames: 0 };
    if (!list) return out;
    let changed = false;
    const mo = new MutationObserver(() => { changed = true; });
    mo.observe(list, { childList: true });
    const count = () => list.querySelectorAll('.ac-msg').length;
    for (let f = 0; f < frames; f++) {
      const at = list.scrollTop;
      if (step > 0 && at === 0 && count() >= total) break;
      if (step > 0 && at === 0) out.wall += 1;
      const box = list.getBoundingClientRect();
      // A day's divider goes to the top of its day when older messages of it land above, as the jumps above say: no row moved.
      const before = new Map([...list.children].filter((r) => !r.classList.contains('ac-divider')).map((r) => [r, r.getBoundingClientRect()]).filter(([, r]) => r.height > 0));
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -step, bubbles: true }));
      list.scrollTop = at - step;
      const asked = at - list.scrollTop;
      changed = false;
      await frame();
      out.frames += 1;
      let off = 0;
      for (const [row, was] of before) {
        if (!row.isConnected) continue;
        const now = row.getBoundingClientRect();
        if (!changed && Math.abs(now.height - was.height) > 1) out.resized += 1;
        if (was.bottom > box.top && was.top < box.bottom) off = Math.max(off, Math.abs(now.top - was.top - asked));
      }
      if (off > 1) { out.off += Math.round(off); out.worst = Math.max(out.worst, Math.round(off)); }
    }
    mo.disconnect();
    return out;
  };
})();`;

/** A browser with no scroll anchoring, in Chromium: the app holds the list's place itself, as in Safari. */
const NO_ANCHORING = `(() => {
  const supports = CSS.supports.bind(CSS);
  CSS.supports = (...args) => (String(args[0]).includes('overflow-anchor') ? false : supports(...args));
  const style = () => {
    const s = document.createElement('style');
    s.textContent = '.channel__messages { overflow-anchor: none !important; }';
    document.head.append(s);
  };
  if (document.head) style(); else addEventListener('DOMContentLoaded', style);
})();`;

export interface ScrollScore {
  /** With no anchoring, rows never skipped again after they were laid out (`scrolling`). */
  whole?: number;
  off: number;
  worst: number;
  wall: number;
  resized: number;
  frames: number;
}

/** What a scroll through got wrong: rows moving by themselves, a wait at the top, and (no anchoring) rows drawn late. */
export function scrollFaults(score: ScrollScore, manualAnchor: boolean) {
  return [
    score.off > 0 && `rows on screen moved ${score.off} px by themselves (at most ${score.worst} px in a frame)`,
    score.wall > 0 && `waited ${score.wall} frames at the top for older messages`,
    manualAnchor && score.resized > 0 && `${score.resized} times a row changed height as it came into view`,
    manualAnchor && (score.whole ?? 0) > 0 && `${score.whole} rows laid out once and never skipped again`,
  ].filter((x): x is string => Boolean(x));
}

/** `shifts-fixture.html`'s scrolling cases, read by `SCROLL`: rows drawn late at the top edge, and a wait at the top. */
export const SCROLL_TWINS = ["bad-scroll--edge", "good-scroll--edge", "bad-scroll--wall", "good-scroll--wall"];

interface Moved {
  at: number;
  value: number;
  sources: string[];
  /** A layout shift's list, as it stood when the shift was reported. */
  where?: string;
}
export interface Taken {
  entries: Moved[];
  jumps: Moved[];
}

/** One screen's score: Chromium's shifts plus the jumps, and what moved most. */
export function scoreOf(taken: Taken) {
  const all = [
    ...taken.entries.map((m) => ({ ...m, kind: "shift" })),
    ...taken.jumps.map((m) => ({ ...m, kind: "jump" })),
  ];
  const total = all.reduce((sum, m) => sum + m.value, 0);
  const worst = all.sort((a, b) => b.value - a.value).slice(0, 5);
  return { total, shifts: taken.entries.length, jumps: taken.jumps.length, worst };
}

type Browser = Awaited<ReturnType<typeof launch>>;

/** A tab with the measure installed, a slow network, and the size given. */
async function openTab(
  browser: Browser,
  size: (typeof SIZES)[number],
  options: { cookies?: string; origin?: string; manualAnchor?: boolean },
) {
  const { send } = browser;
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const s = <T = Record<string, never>>(method: string, params: object = {}) => send<T>(method, params, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Network.enable");
  await s("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.mobile,
  });
  await s("Emulation.setTouchEmulationEnabled", { enabled: size.mobile, maxTouchPoints: 1 });
  await s("Emulation.setLocaleOverride", { locale: "pt-BR" });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await s("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY_MS,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: MEASURE });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: SCROLL });
  if (options.manualAnchor) await s("Page.addScriptToEvaluateOnNewDocument", { source: NO_ANCHORING });
  // The app in Portuguese, as its people mostly read it, and notifications already answered (no ask over the chat).
  await s("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { localStorage.setItem('agentes.locale', 'pt-BR') } catch {}",
  });
  if (options.origin)
    await send("Browser.grantPermissions", { origin: options.origin, permissions: ["notifications"] });
  for (const pair of options.cookies?.split("; ").filter(Boolean) ?? []) {
    const at = pair.indexOf("=");
    await s("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: options.origin });
  }
  let inFlight = 0;
  let lastNetwork = Date.now();
  // One tab at a time: every request is this tab's.
  browser.on("Network.requestWillBeSent", (p) => {
    if (p.type === "WebSocket") return;
    inFlight += 1;
    lastNetwork = Date.now();
  });
  for (const done of ["Network.loadingFinished", "Network.loadingFailed"])
    browser.on(done, () => {
      inFlight = Math.max(0, inFlight - 1);
      lastNetwork = Date.now();
    });
  const run = async <T>(expression: string): Promise<T> => {
    const r = await s<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.value;
  };
  /** Until nothing changed and nothing loaded for `QUIET_MS` (at most `SETTLE_MAX_MS`). */
  const settle = async () => {
    const end = Date.now() + SETTLE_MAX_MS;
    await Bun.sleep(QUIET_MS);
    while (Date.now() < end) {
      const quiet = await run<number>("window.__shift ? window.__shift.quietFor() : 0").catch(() => 0);
      if (inFlight === 0 && Date.now() - lastNetwork > QUIET_MS && quiet > QUIET_MS) return;
      await Bun.sleep(100);
    }
  };
  const shot = async (file: string) => {
    const { data } = await s<{ data: string }>("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  const wheel = (x: number, y: number, deltaY: number) =>
    s("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  const latency = (ms: number) =>
    s("Network.emulateNetworkConditions", {
      offline: false,
      latency: ms,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  // Every painted frame into `dir` while filming (`--frames <screen>`): what moved, frame by frame.
  let film: string | null = null;
  let frame = 0;
  // One tab at a time: its frames are this tab's (`sessionId` here is the frame's, for the ack).
  browser.on("Page.screencastFrame", (p) => {
    if (!film) return;
    void s("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    frame += 1;
    writeFileSync(join(film, `${String(frame).padStart(4, "0")}.jpg`), Buffer.from(String(p.data), "base64"));
  });
  const filming = async (dir: string | null) => {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      film = dir;
      frame = 0;
      await s("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    } else {
      film = null;
      await s("Page.stopScreencast");
    }
  };
  return {
    navigate: (url: string) => s("Page.navigate", { url }),
    run,
    settle,
    shot,
    wheel,
    latency,
    filming,
    take: () => run<Taken>("window.__shift.take()"),
    close: () => send("Target.closeTarget", { targetId }),
  };
}

type Tab = Awaited<ReturnType<typeof openTab>>;

/**
 * `shifts-fixture.html`'s cases: a shift Chromium counts, a jump in a list pinned to its end that it doesn't, and a list
 * that starts to overflow, which it reports moved when only its scroll followed (and that does jump when it follows late).
 */
export const TWINS = [
  "bad-shift--grow",
  "good-shift--grow",
  "bad-shift--pinned",
  "good-shift--pinned",
  "bad-shift--overflow",
  "good-shift--overflow",
  "bad-shift--fresh",
  "good-shift--fresh",
];

/** The fixture's twins: each `bad-` case must score over the limit, each `good-` one stay under it. */
async function selfTest(browser: Browser) {
  const tab = await openTab(browser, SIZES[0], {});
  const wrong: string[] = [];
  try {
    for (const twin of TWINS) {
      await tab.navigate(`file://${join(HERE, "shifts-fixture.html")}?case=${twin}`);
      await tab.run("new Promise((ok) => setTimeout(ok, 900))");
      const { total } = scoreOf(await tab.take());
      if (twin.startsWith("bad-") && total <= LIMIT) wrong.push(`missed ${twin} (${total.toFixed(4)})`);
      if (twin.startsWith("good-") && total > LIMIT) wrong.push(`flagged ${twin} (${total.toFixed(4)})`);
    }
    for (const twin of SCROLL_TWINS) {
      await tab.navigate(`file://${join(HERE, "shifts-fixture.html")}?case=${twin}`);
      await tab.run("new Promise((ok) => setTimeout(ok, 300))");
      const total = twin.endsWith("--wall") ? 60 : 40;
      const faults = scrollFaults(await tab.run<ScrollScore>(`window.__scroll(40, 240, ${total})`), true);
      if (twin.startsWith("bad-") && !faults.length) wrong.push(`missed ${twin}`);
      if (twin.startsWith("good-") && faults.length) wrong.push(`flagged ${twin} (${faults.join(", ")})`);
    }
  } finally {
    await tab.close();
  }
  if (wrong.length) throw new Error(`Self-test: ${wrong.join(", ")}`);
}

interface Result {
  size: string;
  screen: string;
  score: ReturnType<typeof scoreOf>;
}

/** The screens, at one size: a channel opened cold, its thread, a DM, and older messages loading. */
async function screens(tab: Tab, size: (typeof SIZES)[number], app: string, ids: Awaited<ReturnType<typeof seed>>) {
  const out: Result[] = [];
  const shots = flagValue("--shots");
  const filmed = flagValue("--frames");
  const measure = async (screen: string, act: () => Promise<unknown>, shot?: string) => {
    await tab.take().catch(() => null);
    // With `--shots`, every screen is filmed and a failing one's frames are kept (`--frames <screen>`: kept anyway).
    const film = shots ? join(shots, `${size.name}-${screen}-frames`) : null;
    if (film) await tab.filming(film);
    await act();
    await tab.settle();
    if (film) await tab.filming(null);
    const score = scoreOf(await tab.take());
    if (film && score.total <= LIMIT && filmed !== screen) rmSync(film, { recursive: true, force: true });
    out.push({ size: size.name, screen, score });
    if (shot) await tab.shot(join(shot, `${size.name}-${screen}.png`));
  };
  const channel = `${app}/org/${ids.orgId}/c/${ids.channelId}`;
  await measure("channel", () => tab.navigate(channel), shots);
  await measure(
    "thread",
    async () => {
      if (!(await tab.run<boolean>("window.__shift.click('.thread-line')"))) throw new Error("no thread line to click");
    },
    shots,
  );
  await measure("dm", () => tab.navigate(`${app}/org/${ids.orgId}/dm/agent/${ids.ninaId}`), shots);
  // Older pages: back in the channel, a person wheels up to its top; the page comes later than the input's window.
  await tab.navigate(channel);
  await tab.settle();
  const rows = () => tab.run<number>("document.querySelectorAll('.channel__messages .ac-msg').length");
  const before = await rows();
  const list = "document.querySelector('.channel__messages')";
  const box = await tab.run<{ x: number; y: number }>(
    `(() => { const r = ${list}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await tab.latency(700);
  await measure("older", async () => {
    for (let i = 0; i < 80; i++) {
      const top = await tab.run<number>(`${list}.scrollTop`);
      if (top < 200) return;
      await tab.wheel(box.x, box.y, -Math.min(900, top));
      await Bun.sleep(60);
    }
  });
  await tab.latency(LATENCY_MS);
  // The screen is about the older page landing: one that never came measured nothing.
  if ((await rows()) <= before) throw new Error(`older: no older page loaded (${before} rows)`);
  return out;
}

/** Messages in the seed's long channel (`shifts-seed.ts`). */
const LONG_CHANNEL = 260;

/**
 * The long channel opened at its end, scrolled up a wheel's worth a frame (60 px: a quick trackpad) through every older
 * page to its first message, then back down a while.
 */
async function scrolling(tab: Tab, app: string, ids: Awaited<ReturnType<typeof seed>>) {
  await tab.navigate(`${app}/org/${ids.orgId}/c/${ids.longChannelId}`);
  await tab.settle();
  const up = await tab.run<ScrollScore>(`window.__scroll(60, 2000, ${LONG_CHANNEL})`);
  const down = await tab.run<ScrollScore>(`window.__scroll(-60, 300, ${LONG_CHANNEL})`);
  // What the scroll moved is no jump: the measure of the screens above starts over.
  await tab.take();
  const rows = await tab.run<number>("document.querySelectorAll('.channel__messages .ac-msg').length");
  if (rows < LONG_CHANNEL) throw new Error(`scroll: only ${rows} of ${LONG_CHANNEL} messages loaded`);
  // Laid out once, a row may be skipped again off screen (layout.css): one never marked is drawn on every change.
  const whole = await tab.run<number>(
    "document.querySelectorAll('.channel__messages[data-manual-anchor] .ac-msg:not([data-sized])').length",
  );
  return {
    whole,
    off: up.off + down.off,
    worst: Math.max(up.worst, down.worst),
    wall: up.wall,
    resized: up.resized + down.resized,
    frames: up.frames + down.frames,
  };
}

function flagValue(name: string) {
  const args = process.argv.slice(2);
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

function report(results: Result[]) {
  const lines = [
    "| Size | Screen | Score | Shifts | Jumps | What moved most |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...results.map(
      (r) =>
        `| ${r.size} | ${r.screen} | ${r.score.total.toFixed(4)} | ${r.score.shifts} | ${r.score.jumps} | ${r.score.worst
          .slice(0, 3)
          .map(
            (w) =>
              `${w.kind} ${w.value.toFixed(4)} at ${w.at} ms: ${w.sources.slice(0, 3).join(", ")}${w.where ? ` (${w.where})` : ""}`,
          )
          .join("<br>")
          .replaceAll("|", "\\|")} |`,
    ),
  ];
  return lines.join("\n");
}

async function main() {
  const out = mkdtempSync(join(tmpdir(), "shifts-"));
  const browser = await launch(findChrome(), join(out, "profile"));
  try {
    await selfTest(browser);
    if (process.argv.includes("--self-test")) {
      console.log("Self-test passed");
      return;
    }
    const web = flagValue("--web") ?? join(ROOT, "apps/web/dist");
    if (!(await Bun.file(join(web, "index.html")).exists()))
      throw new Error(`No built web app in ${web}: build it first`);
    // The server and its seed only now: the self-test and the check's own test need neither.
    const { createTestServer } = await import("../../apps/server/test/harness");
    const { seed } = await import("../../apps/server/test/shifts-seed");
    const t = await createTestServer({ webDir: web, signedBlobs: false, env: { PUBLIC_URL: "http://localhost:3999" } });
    const server = Bun.serve({
      port: 3999,
      hostname: "127.0.0.1",
      fetch: (req, srv) => t.realtime.fetch(req, srv, (r) => t.app.fetch(r)),
      websocket: t.realtime.websocket,
    });
    try {
      const ids = await seed(t, "http://localhost:3999");
      const results: Result[] = [];
      const scrolls: { size: string; manualAnchor: boolean; score: ScrollScore }[] = [];
      const runs = [...SIZES.map((size) => ({ size, manualAnchor: false })), { size: SIZES[0], manualAnchor: true }];
      for (const { size, manualAnchor } of runs) {
        const tab = await openTab(browser, size, {
          cookies: ids.cookie,
          origin: "http://localhost:3999",
          manualAnchor,
        });
        try {
          if (!manualAnchor) results.push(...(await screens(tab, size, "http://localhost:3999", ids)));
          scrolls.push({ size: size.name, manualAnchor, score: await scrolling(tab, "http://localhost:3999", ids) });
        } finally {
          await tab.close();
        }
      }
      const scrollTable = [
        "| Size | Scroll anchoring | Frames | Moved by itself (px) | Waits at the top (frames) | Rows drawn late | Never skipped |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ...scrolls.map(
          (r) =>
            `| ${r.size} | ${r.manualAnchor ? "none (as Safari)" : "Chromium's"} | ${r.score.frames} | ${r.score.off} | ${r.score.wall} | ${r.score.resized} | ${r.manualAnchor ? r.score.whole : "-"} |`,
        ),
      ].join("\n");
      const table = `${report(results)}\n\n## Scrolling a long channel\n\n${scrollTable}`;
      console.log(table);
      const file = flagValue("--report");
      if (file) writeFileSync(file, `# Layout shifts\n\n${table}\n`);
      const over = results.filter((r) => r.score.total > LIMIT);
      for (const r of over) console.error(`OVER ${r.size} ${r.screen}: ${r.score.total.toFixed(4)} > ${LIMIT}`);
      const faulty = scrolls.flatMap((r) =>
        scrollFaults(r.score, r.manualAnchor).map(
          (f) => `SCROLL ${r.size}${r.manualAnchor ? " (no anchoring)" : ""}: ${f}`,
        ),
      );
      for (const f of faulty) console.error(f);
      process.exitCode = over.length || faulty.length ? 1 : 0;
    } finally {
      server.stop(true);
      await t.close();
    }
  } finally {
    browser.close();
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
