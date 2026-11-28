import { describe, expect, test } from "bun:test";
import { en, resources } from "@agenteschat/i18n";
import { QueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import { keys } from "../src/api/keys";
import { applyUnreadEvent } from "../src/api/queries";
import type { SurfaceLink, SurfaceLinks } from "../src/api/types";
import { ApiError } from "../src/index";
import { errorText } from "../src/lib/errors";
import { rightHandName } from "../src/lib/right-hand";
import {
  CODE_TTL_MS,
  codeDeadline,
  newlyLinked,
  PIN_SHAPE,
  pinChosen,
  pinDigits,
  pinMismatch,
  surfaceRowOf,
  surfaceViaName,
} from "../src/lib/surface-links";
import { appVia, surfaceVia } from "../src/lib/via";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const link = (extra: Partial<SurfaceLink> = {}): SurfaceLink => ({
  nudge: { on: true, afterHours: 4, quietFrom: 22, quietTo: 8 },
  id: "l1",
  status: "active",
  display: "+1 555 0100",
  profileName: "Ana",
  orgId: "o1",
  orgName: "Acme",
  createdAt: "2026-01-10T11:00:00Z",
  confirmedAt: "2026-01-10T11:01:00Z",
  expiresAt: null,
  pinSet: false,
  ...extra,
});
const pending = (expiresAt: string) => link({ id: "p1", status: "pending", confirmedAt: null, expiresAt });
const answer = (links: SurfaceLink[], extra: Partial<SurfaceLinks> = {}): SurfaceLinks => ({
  surface: { name: "Example Chat" },
  allowed: true,
  links,
  ...extra,
});

describe("a message that came through the outside chat surface", () => {
  test("reads the server's mark, forwarded or not", () => {
    expect(surfaceVia({ via: { kind: "surface", surface: "example chat", linkId: "l1" } })).toEqual({
      surface: "example chat",
      linkId: "l1",
      forwarded: false,
    });
    expect(surfaceVia({ via: { kind: "surface", surface: "example chat", linkId: "l1", forwarded: true } })).toEqual({
      surface: "example chat",
      linkId: "l1",
      forwarded: true,
    });
  });

  test("anything else is no surface mark, and the app reader ignores it", () => {
    expect(surfaceVia(null)).toBeNull();
    expect(surfaceVia({ via: { kind: "app", name: "Claude", brand: "claude" } })).toBeNull();
    expect(surfaceVia({ via: { kind: "surface", surface: " " } })).toBeNull();
    expect(surfaceVia({ via: "surface" })).toBeNull();
    expect(appVia({ via: { kind: "surface", surface: "example chat", linkId: "l1" } })).toBeNull();
  });
});

describe("what the surface row shows", () => {
  test("hidden when the server bridges none, or this account may not link", () => {
    expect(surfaceRowOf(undefined, NOW)).toEqual({ kind: "hidden" });
    expect(surfaceRowOf({ surface: null, allowed: false, links: [] }, NOW)).toEqual({ kind: "hidden" });
    expect(surfaceRowOf(answer([link()], { allowed: false }), NOW)).toEqual({ kind: "hidden" });
  });

  test("none, active, and a pending link waiting on the confirm before the active one", () => {
    expect(surfaceRowOf(answer([]), NOW)).toEqual({ kind: "none", surface: "Example Chat" });
    expect(surfaceRowOf(answer([link()]), NOW)).toMatchObject({ kind: "active", link: { id: "l1" } });
    const waiting = pending("2026-01-10T12:05:00Z");
    expect(surfaceRowOf(answer([link(), waiting]), NOW)).toMatchObject({ kind: "pending", link: { id: "p1" } });
  });

  test("a pending link past its time counts as none", () => {
    const late = pending("2026-01-10T11:59:59Z");
    expect(surfaceRowOf(answer([late]), NOW)).toEqual({ kind: "none", surface: "Example Chat" });
    expect(surfaceRowOf(answer([link(), late]), NOW)).toMatchObject({ kind: "active", link: { id: "l1" } });
  });
});

test("a change to my links, from any device, reads them again", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.surfaceLinks, answer([]));
  applyUnreadEvent(qc, "org-1", { type: "surface_link.changed", linkId: "l1", status: "active" } as never);
  expect(qc.getQueryState(keys.surfaceLinks)?.isInvalidated).toBe(true);
});

test("every refusal of linking says its cause in the person's words", () => {
  const t = i18next.createInstance();
  void t.init({ lng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  const lines = {
    "surface.off": en.errors.surface.off,
    "surface.not_allowed": en.errors.surface.notAllowed,
    "surface.no_assistant": en.errors.surface.noAssistant,
    "surface.no_workspace": en.errors.surface.noWorkspace,
    "surface.link_gone": en.errors.surface.linkGone,
    "surface.taken": en.errors.surface.taken,
    "surface.undo_gone": en.errors.surface.undoGone,
    "surface.code_gone": en.errors.surface.codeGone,
    "surface.pin_unset": en.errors.surface.pinUnset,
    "surface.email_unverified": en.errors.surface.emailUnverified,
  };
  for (const [code, line] of Object.entries(lines)) expect(errorText(t.t, new ApiError(409, code, "x"))).toBe(line);
});

describe("the code's deadline on this device's clock", () => {
  test("the server's time while the clocks agree, else 10 minutes from the answer", () => {
    expect(codeDeadline({ expiresAt: "2026-01-10T12:09:30Z" }, NOW)).toBe(Date.parse("2026-01-10T12:09:30Z"));
    expect(codeDeadline({ expiresAt: "2026-01-10T12:30:00Z" }, NOW)).toBe(NOW + CODE_TTL_MS);
    expect(codeDeadline({ expiresAt: "2026-01-10T11:50:00Z" }, NOW)).toBe(NOW + CODE_TTL_MS);
    expect(codeDeadline({ expiresAt: "not a time" }, NOW)).toBe(NOW + CODE_TTL_MS);
  });
});

test("a link confirmed on another device is one active link more than when the code showed", () => {
  expect(newlyLinked(answer([link()]), ["l1"])).toBeNull();
  expect(newlyLinked(answer([pending("2026-01-10T12:05:00Z")]), [])).toBeNull();
  expect(newlyLinked(answer([link(), link({ id: "l2" })]), ["l1"])?.id).toBe("l2");
  expect(newlyLinked(undefined, [])).toBeNull();
});

test("a via mark's surface name: the server's when it matches the id, else the id capitalized", () => {
  expect(surfaceViaName("example chat", "Example Chat")).toBe("Example Chat");
  expect(surfaceViaName("otherchat", "Example Chat")).toBe("Otherchat");
  expect(surfaceViaName("otherchat", undefined)).toBe("Otherchat");
});

test("the right hand's name, null while the agents load or when there is none", () => {
  expect(rightHandName(undefined)).toBeNull();
  expect(rightHandName([{ builtin: null, name: "Ada" }])).toBeNull();
  expect(
    rightHandName([
      { builtin: null, name: "Ada" },
      { builtin: "right_hand", name: "Iris" },
    ]),
  ).toBe("Iris");
});

test("a PIN field keeps six digits; choosing one takes the same six twice", () => {
  expect(pinDigits("48 2-9a13 77")).toBe("482913");
  expect(PIN_SHAPE.test("482913")).toBe(true);
  expect(PIN_SHAPE.test("48291")).toBe(false);
  expect(pinChosen("482913", "482913")).toBe(true);
  expect(pinChosen("482913", "482914")).toBe(false);
  expect(pinChosen("48291", "48291")).toBe(false);
  // Said only once the second is whole, never while it is still being typed.
  expect(pinMismatch("482913", "4829")).toBe(false);
  expect(pinMismatch("482913", "482914")).toBe(true);
});
