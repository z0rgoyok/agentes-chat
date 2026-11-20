import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { type BrowserCardLine, browserCardLine, hostAndPath, screenT, titleKind } from "../src/lib/browser-card";
import { agentGrammar } from "../src/lib/grammar";
import { siteName } from "../src/lib/sites";

const translator = (lng: string) => {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t as TFunction;
};
const en = translator("en");
const pt = translator("pt-BR");

/** The card watching the agent at work, nothing else going on. */
const base: BrowserCardLine = {
  grammar: agentGrammar("Ada"),
  inControl: false,
  otherInControl: false,
  controllerName: "",
  hidden: false,
  closed: false,
  stuck: false,
  reconnecting: false,
  starting: false,
  ask: null,
  host: "",
  profile: null,
  now: null,
};

describe("the agent's browser card, the same on the web and the phone", () => {
  test("a page's host and path, without the query or a trailing slash", () => {
    expect(hostAndPath("https://painel.acme.example/login?x=1")).toEqual(["painel.acme.example", "/login"]);
    expect(hostAndPath("https://loja.exemplo/")).toEqual(["loja.exemplo", ""]);
    expect(hostAndPath("loja.exemplo")).toEqual(["loja.exemplo", ""]);
    expect(hostAndPath(null)).toEqual(["", ""]);
  });

  test("its title: the request in control, else the site, opening until a page, else the agent's browser", () => {
    expect(titleKind({ inControl: true, ask: "Sign in", host: "acme.example", opening: false })).toBe("ask");
    expect(titleKind({ inControl: false, ask: "Sign in", host: "acme.example", opening: false })).toBe("host");
    expect(titleKind({ inControl: false, ask: null, host: "", opening: true })).toBe("opening");
    expect(titleKind({ inControl: false, ask: null, host: "", opening: false })).toBe("agent");
  });

  test("the site as people say it", () => {
    expect(siteName("www.loja.exemplo")).toBe("loja.exemplo");
    expect(siteName("web.acme.example")).toBe("acme.example");
    expect(siteName("m.acme.example")).toBe("acme.example");
    expect(siteName("mail.acme.example")).toBe("mail.acme.example");
  });

  test("its line: what the agent does now, or why it waits", () => {
    expect(browserCardLine(en, { ...base, now: "clicked" })).toBe("Ada · clicked");
    expect(browserCardLine(en, { ...base, starting: true, now: "clicked" })).toBe("Ada is opening the browser");
    expect(browserCardLine(en, { ...base, reconnecting: true, starting: true })).toBe("Reconnecting… Ada waits 2 min");
    expect(browserCardLine(en, { ...base, stuck: true, reconnecting: true })).toBe("Didn't open · try again");
    expect(browserCardLine(en, { ...base, closed: true, stuck: true })).toBe("Closed");
    expect(browserCardLine(en, base)).toBe("Live");
  });

  test("its line while someone is in control: who, and whether the page is hidden", () => {
    const other = { ...base, otherInControl: true, controllerName: "Bia", now: "clicked" };
    expect(browserCardLine(en, other)).toBe("Bia is in control · you're watching");
    expect(browserCardLine(en, { ...other, hidden: true })).toBe("Bia is in control · screen hidden");
    const mine = { ...base, inControl: true };
    expect(browserCardLine(en, mine)).toBe("You're in control · Ada waits");
    expect(browserCardLine(en, { ...mine, ask: "Sign in" })).toBe("You're in control · Ada asked");
    expect(browserCardLine(en, { ...mine, ask: "Sign in", host: "acme.example" })).toBe(
      "You're in control · acme.example · Ada asked",
    );
    // The sentence agrees with the agent's gender where the language writes it.
    expect(browserCardLine(pt, mine)).toBe("Você no controle · a Ada espera");
    expect(browserCardLine(pt, { ...mine, grammar: agentGrammar("Theo") })).toBe("Você no controle · o Theo espera");
  });

  test("the desktop's words where it has its own, the browser's otherwise", () => {
    expect(screenT(en, "browser")("inCard.group", agentGrammar("Ada"))).toBe("Ada's browser");
    expect(screenT(en, "desktop")("inCard.group", agentGrammar("Ada"))).toBe("Ada's screen");
    expect(screenT(en, "desktop")("after.titleNoSite")).toBe("Used the screen");
    expect(screenT(en, "desktop")("after.showSteps")).toBe(en("browser.after.showSteps"));
  });
});
