import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  phoneTerminalKeep,
  terminalCall,
  terminalEvent,
  terminalOpensAgain,
  terminalPageStays,
  terminalPageUrl,
} from "../../src/features/coding/terminal-page";
import { mainLayout } from "../main-stack";

const SERVER = "https://app.example.test";
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a code session's terminal on the phone (ADR 0215)", () => {
  test("the page's address names the session and a terminal of the phone's own", () => {
    const url = new URL(terminalPageUrl(SERVER, { orgId: "org_1", agentId: "ag_1", sessionId: "cs_1" }));
    expect(url.origin + url.pathname).toBe(`${SERVER}/terminal.html`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ o: "org_1", a: "ag_1", s: "cs_1", k: "phone-cs_1" });
    // Within what the server takes for a name, and never the web drawer's.
    expect(phoneTerminalKeep("cs_1")).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(phoneTerminalKeep("cs_1")).not.toBe("drawer-cs_1");
  });

  test("only the server's own page loads in the WebView", () => {
    expect(terminalPageStays(SERVER, `${SERVER}/terminal.html?o=1`)).toBe(true);
    expect(terminalPageStays(SERVER, `${SERVER}/screen.html`)).toBe(false);
    expect(terminalPageStays(SERVER, "https://elsewhere.test/terminal.html")).toBe(false);
    expect(terminalPageStays(SERVER, "not a url")).toBe(false);
  });

  test("it hears only the page's own messages, of the kinds it says", () => {
    const from = (data: string, url = `${SERVER}/terminal.html`) => terminalEvent(SERVER, { url, data });
    expect(from('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(from('{"type":"folder"}')).toEqual({ type: "folder" });
    expect(from('{"type":"state","state":"live"}')).toEqual({ type: "state", state: "live" });
    expect(from('{"type":"state","state":"whatever"}')).toBeNull();
    expect(from('{"type":"ready"}', "https://elsewhere.test/terminal.html")).toBeNull();
    expect(from("not json")).toBeNull();
    expect(from("null")).toBeNull();
  });

  test("opening again is offered only where it can change something", () => {
    for (const s of ["screening", "forbidden", "outdated"] as const) expect(terminalOpensAgain(s)).toBe(false);
    for (const s of ["ended", "dropped", "moved", "offline", "busy", "failed"] as const)
      expect(terminalOpensAgain(s)).toBe(true);
  });

  test("a call carries its values as JSON, and opening sets the session's cookie first", () => {
    const session = { cookie: "a=b", server: SERVER };
    const typed = terminalCall(session, "type", '"); alert(1); ("');
    expect(typed).toBe(`window.agentTerminal?.type(${JSON.stringify('"); alert(1); ("')});true;`);
    expect(terminalCall(session, "key", "CtrlC")).toBe('window.agentTerminal?.key("CtrlC");true;');
    const open = terminalCall(session, "open");
    expect(open.endsWith("window.agentTerminal?.open();true;")).toBe(true);
    expect(open.length).toBeGreaterThan("window.agentTerminal?.open();true;".length);
  });

  test("it opens from the session's code screen and its menu, pushed with an opaque bar", () => {
    expect(src("features/coding/SessionCodeScreen.tsx")).toContain("router.push(sessionTerminalHref(s.id) as never)");
    expect(src("features/coding/menu.tsx")).toContain("router.push(sessionTerminalHref(session.id) as never)");
    expect(mainLayout()).toContain('"coding/[sessionId]/terminal": solid,');
  });

  test("Code's list keeps the screen's side margin", () => {
    expect(src("features/coding/CodingScreen.tsx")).toContain("paddingHorizontal: SCREEN_X");
  });
});
