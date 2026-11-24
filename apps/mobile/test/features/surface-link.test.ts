import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type SurfaceLink, type SurfaceLinks } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { RENEW_BEFORE_MS, surfaceRowOf } from "@agenteschat/client/lib/surface-links";
import {
  codeIsStale,
  codeLeftText,
  linkAssistant,
  linkRanOut,
  linkStep,
  surfaceRowText,
  surfaceSenderText,
  surfaceTagText,
} from "../../src/features/me/surface";
import { translator } from "./fixtures";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const SURFACE = "Example Chat";
const LONG_DISPLAY = "+1 555 0100 0101 0102 0103 0104 0105 0106 0107 0108 0109 0110 0111";
const LONG_PROFILE = "Ana 🌿 من فريق المبيعات Theo example.com 🚀 a very long profile name";
/** The longest name `SURFACE_NAME` allows (32 characters), with one long unbroken word. */
const LONG_SURFACE = "Example Chat Longunbrokenwordxyz";

const link = (over: Partial<SurfaceLink> = {}): SurfaceLink => ({
  id: "l1",
  status: "pending",
  display: "5511900000001",
  profileName: "Ana",
  orgId: "o1",
  orgName: "Acme",
  createdAt: new Date(NOW - 60_000).toISOString(),
  confirmedAt: null,
  expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
  ...over,
});
const links = (list: SurfaceLink[], over: Partial<SurfaceLinks> = {}): SurfaceLinks => ({
  surface: { name: SURFACE },
  allowed: true,
  links: list,
  ...over,
});

describe("the row in Notificações", () => {
  test("hidden unless this account may link", () => {
    expect(surfaceRowOf(links([], { allowed: false }), NOW).kind).toBe("hidden");
    expect(surfaceRowOf(links([], { surface: null, allowed: false }), NOW).kind).toBe("hidden");
    expect(surfaceRowOf(undefined, NOW).kind).toBe("hidden");
  });

  test("none offers Link with the assistant's line, pending waits, active shows the sender with On", async () => {
    const t = await translator("en");
    const none = surfaceRowOf(links([]), NOW);
    if (none.kind === "hidden") throw new Error("hidden");
    expect(surfaceRowText(t, none, "Lodi")).toEqual({ hint: "Lodi can message you there", value: "Link" });
    expect(surfaceRowText(t, none, null)).toEqual({ value: "Link" });

    const pending = surfaceRowOf(links([link()]), NOW);
    if (pending.kind === "hidden") throw new Error("hidden");
    expect(pending.kind).toBe("pending");
    expect(surfaceRowText(t, pending, "Lodi")).toEqual({ sub: "A sender is waiting for you to confirm" });

    const active = surfaceRowOf(links([link({ status: "active", expiresAt: null })]), NOW);
    if (active.kind === "hidden") throw new Error("hidden");
    expect(surfaceRowText(t, active, "Lodi")).toEqual({ sub: "+55 (11) 90000-0001", below: "Ana", value: "On" });
  });

  test("the sheet's confirm step names the sender formatted, and only through the shared helper", () => {
    expect(surfaceSenderText(link())).toEqual({ display: "+55 (11) 90000-0001", profileName: "Ana" });
    expect(surfaceSenderText(link({ display: null }))).toEqual({ display: null, profileName: "Ana" });
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("surfaceSenderText(link)");
    expect(src).not.toMatch(/\{link\.(display|profileName)\}/);
  });

  test("worst case: the whole display and profile name, never cut, and only one line when the other is missing", async () => {
    const t = await translator("en");
    const row = surfaceRowOf(
      links([link({ status: "active", display: LONG_DISPLAY, profileName: LONG_PROFILE, expiresAt: null })], {
        surface: { name: LONG_SURFACE },
      }),
      NOW,
    );
    if (row.kind !== "active") throw new Error(row.kind);
    expect(row.surface).toBe(LONG_SURFACE);
    expect(surfaceRowText(t, row, "Lodi")).toEqual({ sub: LONG_DISPLAY, below: LONG_PROFILE, value: "On" });
    expect(surfaceRowText(t, { ...row, link: { ...row.link, display: null } }, "Lodi")).toEqual({
      sub: LONG_PROFILE,
      value: "On",
    });
  });

  test("the row wraps every line and unlinks through the system's confirm", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("labelLines={0}");
    expect(src).toContain("subLines: 0");
    // What linking does is the ⓘ's beside the name, as on the phone switch's row above it.
    expect(src).toContain('hint: { name: t("common.about", { label: row.surface }), text: text.hint }');
    expect(src).toContain("confirmAction({");
    const page = readFileSync(join(import.meta.dir, "../../src/features/me/PreferencePages.tsx"), "utf8");
    expect(page).toContain("<SurfaceLinkRow />");
  });

  test("unlink says the web's words, naming the right hand", async () => {
    const t = await translator("en");
    expect(t("surface.row.unlinkTitle", { surface: SURFACE })).toBe("Unlink Example Chat?");
    expect(t("surface.row.unlinkText", { assistant: "Lodi" })).toBe(
      "Lodi stops answering you there. You can link it again any time.",
    );
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain('t("surface.row.unlinkText", { assistant: assistant ?? t("rightHand.labelCapitalized") })');
  });
});

describe("the sheet", () => {
  test("code, then confirm once a pending link arrives, then linked", () => {
    expect(linkStep(surfaceRowOf(links([]), NOW), false)).toBe("code");
    expect(linkStep(surfaceRowOf(links([link()]), NOW), false)).toBe("confirm");
    expect(linkStep(surfaceRowOf(links([link({ status: "active" })]), NOW), true)).toBe("linked");
    // A pending link past its 10 minutes goes back to a fresh code.
    const old = link({ expiresAt: new Date(NOW - 1).toISOString() });
    expect(linkStep(surfaceRowOf(links([old]), NOW), false)).toBe("code");
  });

  test("a fresh code before the shown one runs out", () => {
    expect(codeIsStale(null, NOW)).toBe(true);
    expect(codeIsStale(NOW + RENEW_BEFORE_MS + 1, NOW)).toBe(false);
    expect(codeIsStale(NOW + RENEW_BEFORE_MS, NOW)).toBe(true);
  });

  test("the countdown under the code", async () => {
    const t = await translator("en");
    expect(codeLeftText(t, NOW + 9 * 60_000 + 41_000, NOW)).toBe("Valid for 9:41");
    expect(codeLeftText(t, NOW - 5000, NOW)).toBe("Valid for 0:00");
  });

  test("the code step opens the surface, shows the code and waits: live event, every 3 seconds, back in front", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("Linking.openURL(code.made.openUrl)");
    expect(src).toContain("setInterval(() => void refetch(), LINK_POLL_MS)");
    expect(src).toContain("useAppActive()");
    expect(src).toContain("{code.made.code}");
    expect(src).toMatch(/label=\{t\("surface\.link\.open", \{ surface \}\)\}/);
    expect(src).not.toMatch(/QrCode/);
  });

  test("the consent line sits directly above Confirm, in the recorded words", async () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    const consent = src.indexOf('t("surface.link.consent"');
    const confirm = src.indexOf('label={t("surface.link.confirm")}');
    expect(consent).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(consent);
    expect(src.slice(consent, confirm)).not.toMatch(/<Text/);
    const en = await translator("en");
    expect(en("surface.link.consent", { assistant: "Lodi", surface: SURFACE })).toBe(
      "Lodi by agentes.chat may message you on Example Chat about your workspaces, and call you only when something is urgent and you allow it. Write stop to turn this off.",
    );
    const pt = await translator("pt-BR");
    expect(pt("surface.link.consent", { assistant: "Lodi", surface: SURFACE })).toContain("Escreva parar");
  });

  test("a link confirmed on another device while the sheet is open ends it as linked", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("const done = linked ?? (before && newlyLinked(data, before));");
    expect(src).toContain("<LinkSteps row={row} linked={done}");
  });

  test("Not me drops the refused sender from the cache before the fresh code, so it never flashes back", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    const notMe = src.slice(src.indexOf("const notMe = () => {"), src.indexOf("return (", src.indexOf("const notMe")));
    expect(notMe.indexOf("qc.setQueryData")).toBeGreaterThan(0);
    expect(notMe.indexOf("qc.setQueryData")).toBeLessThan(notMe.indexOf("setError(null)"));
    expect(notMe).toContain("onSuccess: fresh");
    expect(notMe).toContain('errorCode(e) === "surface.link_gone" ? fresh()');
  });

  test("the confirm step waits only while the agents load, then names the right hand or the generic label", () => {
    const lodi = [{ builtin: "right_hand" as const, name: "Lodi" }];
    expect(linkAssistant({ isPending: true, data: undefined }, "Your right hand")).toBeNull();
    expect(linkAssistant({ isPending: false, data: lodi }, "Your right hand")).toBe("Lodi");
    // No right hand in that workspace, or the agents failed: the server's confirm says why if it refuses.
    expect(linkAssistant({ isPending: false, data: [{ builtin: null, name: "Theo" }] }, "Your right hand")).toBe(
      "Your right hand",
    );
    expect(linkAssistant({ isPending: false, data: undefined }, "Your right hand")).toBe("Your right hand");
  });

  test("a pending link that runs out drops the confirm step and says why, one removed by Not me does not", async () => {
    const pending = link();
    const later = Date.parse(pending.expiresAt as string) + 1;
    expect(surfaceRowOf(links([pending]), NOW).kind).toBe("pending");
    expect(surfaceRowOf(links([pending]), later).kind).toBe("none");
    expect(linkRanOut(pending, later)).toBe(true);
    expect(linkRanOut(pending, NOW)).toBe(false);
    expect(linkRanOut(link({ expiresAt: null }), later)).toBe(false);
    const src = readFileSync(join(import.meta.dir, "../../src/features/me/SurfaceLink.tsx"), "utf8");
    expect(src).toContain("surfaceRowOf(links.data, now)");
    expect(src).toContain('setError(t("errors.surface.linkGone"))');
    const t = await translator("en");
    expect(t("errors.surface.linkGone")).toContain("Make a new code");
  });

  test("failures say the cause and a way out", async () => {
    const t = await translator("en");
    for (const code of ["surface.link_gone", "surface.taken", "surface.no_assistant", "surface.not_allowed"]) {
      const line = errorText(t, new ApiError(409, code, code));
      expect(line).not.toBe(t("mobile.app.failed"));
      expect(line.toLowerCase()).not.toContain("support");
    }
    expect(t("mobile.surface.openFailed", { surface: SURFACE })).toBe(
      "Couldn't open Example Chat on this phone. Send it the code below instead.",
    );
  });
});

describe("the mark on messages", () => {
  test("via the surface, and forwarded there, by the server's name for it", async () => {
    const t = await translator("en");
    const data = links([]);
    const via = { via: { kind: "surface", surface: "example chat", linkId: "l1" } };
    expect(surfaceTagText(t, via, "Ana", data)).toEqual({
      label: "via Example Chat",
      hint: "Sent by Ana on Example Chat",
      mark: null,
    });
    // The logo named like the surface, for one written there; a forwarded one keeps its own glyph.
    const named = { via: { kind: "surface", surface: "examplechat", linkId: "l1" } };
    expect(surfaceTagText(t, named, "Ana", data)?.mark).toBe("/connectors/examplechat.svg");
    expect(surfaceTagText(t, { via: { ...named.via, forwarded: true } }, "Ana", data)?.mark).toBeNull();
    expect(surfaceTagText(t, { via: { ...via.via, forwarded: true } }, "Ana", data)?.label).toBe(
      "forwarded via Example Chat",
    );
    // Before the links answer is read, or after the surface was renamed, the id stands in, capitalized as on the web.
    expect(surfaceTagText(t, via, "Ana", undefined)?.label).toBe("via Example chat");
    expect(surfaceTagText(t, via, "Ana", links([], { surface: { name: "Renamed" } }))?.label).toBe("via Example chat");
    const long = { via: { kind: "surface", surface: LONG_SURFACE.toLowerCase() } };
    expect(surfaceTagText(t, long, "Ana", links([], { surface: { name: LONG_SURFACE } }))?.label).toBe(
      `via ${LONG_SURFACE}`,
    );
    expect(surfaceTagText(t, { via: { kind: "app", name: "Claude" } }, "Ana", data)).toBeNull();
    expect(surfaceTagText(t, null, "Ana", data)).toBeNull();
  });

  test("only a person's message carries it: a glyph before the time on my own rows, a whole tag on others'", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");
    expect(src).toMatch(/m\.author\.type === "person"\s*\?\s*surfaceTagText/);
    // My own rows never draw the name line, so the mark rides in both of their time lines, ahead of the time.
    const own = src.slice(src.indexOf("if (onRight) {"), src.indexOf("const who = (inBubble: boolean)"));
    expect(own.match(/\{surfaceTag \? <SurfaceMark tag=\{surfaceTag\}/g)?.length).toBe(2);
    expect(own.indexOf("<SurfaceMark")).toBeLessThan(own.indexOf("when.time(m.createdAt)"));
    expect(src).toMatch(/accessibilityLabel=\{tag\.label\} accessibilityHint=\{tag\.hint\}/);
    // Others' rows: the tag counts as one, so a bubble with no names still shows its line, and wraps a long name.
    expect(src).toMatch(/<Tag\s+icon="chat"\s+lead=\{<MarkIcon uri=\{iconUri\(serverUrl\(\), surfaceTag\.mark\)\}/);
    expect(src).toMatch(/const tagged = Boolean\([^)]*surfaceTag/);
  });
});

describe("the surface's logo beside the line icons", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

  test("the row's tile draws it in the icon's box and color, the chat icon without one", () => {
    // The row hands the logo to its tile, which draws it where the symbol goes: same box, same color.
    expect(read("ui/Grouped.tsx")).toContain("<IconTile icon={icon} danger={danger} mark={mark ?? null} />");
    const tile = read("ui/IconTile.tsx");
    expect(tile).toContain(
      "<MarkIcon uri={mark} fallback={icon} size={Math.round(size * glyphShare(icon))} color={ON_TILE} />",
    );
    expect(read("features/me/SurfaceLink.tsx")).toMatch(
      /icon="chat"\s+mark=\{iconUri\(serverUrl\(\), surfaceMarkUrl\(row\.surface\)\)\}/,
    );
    const mark = read("ui/MarkIcon.tsx");
    // The box is the icon's own size; the logo sits where the icons' strokes do on their 24 grid.
    expect(mark).toContain("style={{ width: size, height: size,");
    expect(mark).toContain("Math.round((size * 16) / 24)");
    expect(mark).toContain("<Icon name={fallback} size={size}");
  });
});
