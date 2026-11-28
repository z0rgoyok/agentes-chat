import "@fontsource-variable/jetbrains-mono/index.css";
import "@xterm/xterm/css/xterm.css";
import { type TerminalEvent, TerminalSession, type TerminalSocket } from "./session";

declare global {
  interface Window {
    /** What the phone app calls with `injectJavaScript`. */
    agentTerminal?: TerminalSession;
  }
}

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;
const SCROLLBACK = 5000;
/** The web terminal's face (`--font-mono`), loaded with the page. */
const FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';
/** How long the terminal waits for its face before it measures its cells with whatever face there is. */
const FONT_WAIT_MS = 1500;
/** The session's ids and the terminal's name, as the server checks them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const post = (event: TerminalEvent) => window.ReactNativeWebView?.postMessage(JSON.stringify(event));
const host = document.getElementById("term");
const query = new URLSearchParams(window.location.search);
const pick = (key: string) => {
  const value = query.get(key);
  return value && ID.test(value) ? value : null;
};
const orgId = pick("o");
const agentId = pick("a");
const sessionId = pick("s");
const keep = pick("k");

// xterm loads apart, as on the web. The app waits for `ready` before it asks for anything.
if (host && orgId && agentId && sessionId) {
  void (async () => {
    const [xterm, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    // Cells measured in a face that isn't loaded yet would all be off once it is.
    await Promise.race([
      document.fonts?.load(`${FONT_SIZE}px ${FONT}`),
      new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
    ]).catch(() => {});
    const shell = new xterm.Terminal({
      fontFamily: FONT,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      scrollback: SCROLLBACK,
    });
    const fit = new FitAddon();
    shell.loadAddon(fit);
    shell.open(host);
    const session = new TerminalSession(
      shell,
      { orgId, agentId, sessionId, ...(keep ? { keep } : {}), base: window.location },
      {
        // The browser's socket: its handlers get the events whose fields the session reads (`data`, `code`, `reason`).
        createSocket: (url) => new WebSocket(url) as unknown as TerminalSocket,
        post,
        room: () => fit.proposeDimensions() ?? null,
      },
    );
    window.agentTerminal = session;
    // The keyboard came or went, or the phone turned: the shell takes the page's new room.
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => session.fit());
    }).observe(host);
    // A page kept for later would keep its socket open: it ends with the page.
    window.addEventListener("pagehide", () => session.end());
    post({ type: "ready" });
  })();
}
