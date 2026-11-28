import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { AppNotification, OrgSummary } from "../src/api/types";
import {
  BILLING_HOLDS,
  billingHoldOf,
  paidComputerLine,
  paidLine,
  paidReturnOf,
  paidRoom,
  paidSearch,
  planHeldNext,
  planLine,
  planMoveTargets,
  planOfferOf,
  planTurnedOn,
} from "../src/lib/billing";
import { errorText, holdText, restrictionLine } from "../src/lib/errors";
import { workspaceHeadline } from "../src/lib/notifications";
import { can } from "../src/lib/permissions";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const standingNotice = (latest: AppNotification["latest"]) => ({ kind: "org_standing" as const, latest });

describe("billing holds in words (ADR 0079)", () => {
  test("a hold whose reason is a billing code is one; nothing else is", () => {
    for (const code of BILLING_HOLDS) expect(billingHoldOf({ state: "hold", reason: code })).toBe(code);
    expect(billingHoldOf({ state: "hold", reason: "verificação de pagamento" })).toBeNull();
    expect(billingHoldOf({ state: "hold", reason: null })).toBeNull();
    expect(billingHoldOf({ state: "suspended", reason: "payment" })).toBeNull();
    expect(billingHoldOf(undefined)).toBeNull();
  });

  test("the banner, an API refusal and a refused run say the hold's own words, never its code", () => {
    for (const code of BILLING_HOLDS) {
      const words = `standing.billing.${code}`;
      expect(holdText(t, { state: "hold", reason: code })).toBe(words);
      expect(restrictionLine(t, "run.org_paused", { reason: code })).toBe(words);
      expect(
        errorText(t, new ApiError(403, "org.paused", `This workspace is on hold: ${code}`, { reason: code })),
      ).toBe(words);
    }
    // A suspension's reason is the operator's, whatever it says.
    expect(restrictionLine(t, "org.suspended", { reason: "payment" })).toBe(
      'standing.suspendedFor {"reason":"payment"}',
    );
  });

  test("creating another workspace while one waits for its plan: the facts, never the web's call to pay", () => {
    const refused = new ApiError(403, "org.create_unpaid", "You already have a workspace waiting for a plan", {
      orgId: "o1",
    });
    expect(errorText(t, refused)).toStartWith("standing.createInactive ");
  });

  test("the notification's headline is the hold's, the plain hold's for a code it doesn't know", () => {
    for (const code of BILLING_HOLDS)
      expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: code }))).toBe(
        `standing.notification.billing.${code}`,
      );
    expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: "trial" }))).toBe(
      "standing.notification.hold",
    );
    expect(workspaceHeadline(standingNotice({ statusTo: "active" }))).toBe("standing.notification.active");
  });

  test("whoever holds manage_billing manages billing (the server spreads administrator out)", () => {
    const of = (...permissions: string[]) => ({ permissions });
    expect([
      can(of("manage_billing"), "manage_billing"),
      can(of("post"), "manage_billing"),
      can(null, "manage_billing"),
    ]).toEqual([true, false, false]);
  });
});

describe("the plan the onboarding offers (the billing service's plan list)", () => {
  const list = (plans: unknown[], recommended = "team") => ({ recommended, plans });
  test("the recommended plan, with its price as the billing service writes it", () => {
    const json = list([
      { key: "personal", name: "Pessoal", price: "$29", period: "month" },
      { key: "team", name: "Equipe", price: "$49", period: "month" },
    ]);
    expect(planOfferOf(json)).toEqual({ key: "team", name: "Equipe", price: "$49" });
  });

  test("a plan with no price is named alone", () => {
    expect(planOfferOf(list([{ key: "team", name: "Equipe" }]))).toEqual({ key: "team", name: "Equipe" });
    expect(planOfferOf(list([{ key: "team", name: "Equipe", price: "" }]))).toEqual({ key: "team", name: "Equipe" });
  });

  test("anything else names no plan", () => {
    expect(planOfferOf(null)).toBeNull();
    expect(planOfferOf("plans")).toBeNull();
    expect(planOfferOf({ plans: [] })).toBeNull();
    expect(planOfferOf(list([{ key: "solo", name: "Solo" }]))).toBeNull();
    expect(planOfferOf(list([{ key: "team" }]))).toBeNull();
    expect(planOfferOf(list([{ key: "Team!", name: "Equipe" }], "Team!"))).toBeNull();
    expect(planOfferOf(list([{ key: "team", name: "x".repeat(41) }]))).toBeNull();
  });

  test("a personal workspace's: the list's plan for one person, or its recommended one where the list names none", () => {
    const plans = [
      { key: "personal", name: "Pessoal", price: "$29" },
      { key: "team", name: "Equipe", price: "$49" },
    ];
    const json = { recommended: "team", recommendedAlone: "personal", plans };
    expect(planOfferOf(json, undefined, true)).toEqual({ key: "personal", name: "Pessoal", price: "$29" });
    expect(planOfferOf(json)).toEqual({ key: "team", name: "Equipe", price: "$49" });
    expect(planOfferOf(list(plans), undefined, true)).toEqual({ key: "team", name: "Equipe", price: "$49" });
    expect(planOfferOf(json, "team", true)).toEqual({ key: "team", name: "Equipe", price: "$49" });
  });

  test("any plan of the list by its key, a paid return's", () => {
    const json = list([
      { key: "personal", name: "Pessoal", price: "$29" },
      { key: "team", name: "Equipe" },
    ]);
    expect(planOfferOf(json, "personal")).toEqual({ key: "personal", name: "Pessoal", price: "$29" });
    expect(planOfferOf(json, "solo")).toBeNull();
  });
});

describe("a paid return (the billing service's `?paid=1`)", () => {
  test("what it says was bought: a plan's key and its period, nothing else", () => {
    expect(paidReturnOf({ paid: 1 })).toEqual({});
    expect(paidReturnOf({ paid: "1", plan: "team", period: "year" })).toEqual({ plan: "team", period: "year" });
    expect(paidReturnOf({ paid: true, plan: "Team <b>", period: "week" })).toEqual({});
    expect(paidReturnOf({ plan: "team" })).toBeNull();
    expect(paidSearch({ paid: 1, plan: "team", period: "month", other: 1 })).toEqual({
      paid: true,
      plan: "team",
      period: "month",
    });
    expect(paidSearch({ plan: "team" })).toEqual({});
  });

  test("the plan in force in one line, with as much as the app knows", () => {
    const t = ((key: string, o?: { plan?: string }) => (o?.plan ? `${key}:${o.plan}` : key)) as never;
    expect(paidLine(t, null, "year")).toBe("paidMoment.on");
    expect(paidLine(t, "Equipe", undefined)).toBe("paidMoment.onPlan:Equipe");
    expect(paidLine(t, "Equipe", "month")).toBe("paidMoment.onMonth:Equipe");
    expect(paidLine(t, "Equipe", "year")).toBe("paidMoment.onYear:Equipe");
    // The same plan as the plan card's row: its name and period, or its name alone.
    expect(planLine(t, "Equipe", "year")).toBe("billing.planYear:Equipe");
    expect(planLine(t, "Equipe", "month")).toBe("billing.planMonth:Equipe");
    expect(planLine(t, "Equipe", undefined)).toBe("Equipe");
  });

  test("what the plan gives, from its limits: seats and files, a bucket of its own counting against none", () => {
    const GB = 1024 ** 3;
    const limits = (people: number | null, files: number | null, ownStorage = false) => ({
      members: { used: 1, limit: people },
      storage: { usedBytes: 0, limitBytes: files, ownStorage },
      uploads: { usedBytes24h: 0, limitBytesPerDay: null },
    });
    expect(paidRoom(t, "en", undefined)).toBeNull();
    expect(paidRoom(t, "en", limits(1284, 50 * GB))).toBe(
      'paidMoment.room.both {"count":1284,"people":"1,284","files":"50 GB"}',
    );
    expect(paidRoom(t, "de", limits(3, null))).toBe('paidMoment.room.people {"count":3,"people":"3"}');
    expect(paidRoom(t, "en", limits(3, 50 * GB, true))).toBe('paidMoment.room.people {"count":3,"people":"3"}');
    expect(paidRoom(t, "en", limits(null, 50 * GB))).toBe('paidMoment.room.files {"files":"50 GB"}');
    expect(paidRoom(t, "en", limits(null, null))).toBe("paidMoment.room.none");
  });

  test("the computer as it is now: on, or getting ready, its owners promised a word when it is on", () => {
    expect(paidComputerLine(t, true, true)).toBe("paidMoment.computer.on");
    expect(paidComputerLine(t, false, true)).toBe("paidMoment.computer.startingTold");
    expect(paidComputerLine(t, false, false)).toBe("paidMoment.computer.starting");
  });

  test("the phone's trigger: held when it last looked, in force now; never on a first look", () => {
    const hold = { state: "hold" as const };
    expect(planTurnedOn(true, { state: "active" })).toBe(true);
    expect(planTurnedOn(true, undefined)).toBe(true);
    expect(planTurnedOn(true, hold)).toBe(false);
    expect(planTurnedOn(false, { state: "active" })).toBe(false);
    expect(planTurnedOn(undefined, { state: "active" })).toBe(false);
  });

  test("what the phone keeps: held ones added, the one opened once its plan is on taken out, and only that one", () => {
    const hold = { state: "hold" as const, reason: "payment" };
    const orgs = [{ id: "a", standing: hold }, { id: "b" }, { id: "c" }];
    // A first look: nothing turned on, the held one noted.
    expect(planHeldNext([], orgs, "b")).toEqual({ held: ["a"], turnedOn: false });
    // "b" was held and is on now, on screen: the moment, once.
    expect(planHeldNext(["a", "b"], orgs, "b")).toEqual({ held: ["a"], turnedOn: true });
    // "c" turned on elsewhere: kept until it is opened.
    expect(planHeldNext(["c"], orgs, "b")).toEqual({ held: ["c", "a"], turnedOn: false });
    expect(planHeldNext(["c"], orgs, "c")).toEqual({ held: ["a"], turnedOn: true });
    // Still held on screen: nothing.
    expect(planHeldNext(["a"], orgs, "a")).toEqual({ held: ["a"], turnedOn: false });
  });
});

test("a plan moves only from what its payer pays, to their other workspaces on a billing hold where they manage billing", () => {
  const hold = (reason: string) => ({ state: "hold" as const, reason });
  const ws = (id: string, extra: Partial<OrgSummary> = {}): OrgSummary => ({
    id,
    name: id,
    role: "owner",
    permissions: ["manage_billing"],
    ...extra,
  });
  const paid = ws("paid", { paysPlan: true });
  const orgs = [
    paid,
    ws("unpaid", { standing: hold("payment") }),
    ws("ended", { standing: hold("ended") }),
    ws("active"),
    ws("review", { standing: hold("review") }),
    ws("member", { standing: hold("payment"), permissions: [] }),
    ws("deleting", { standing: hold("payment"), deletion: { dueAt: null, requestedAt: null, requestedBy: null } }),
  ];
  expect(planMoveTargets(orgs, paid).map((o) => o.id)).toEqual(["unpaid", "ended"]);
  expect(planMoveTargets(orgs, ws("paid"))).toEqual([]);
});
