import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AuditRow } from "../src/api/types";
import {
  auditDetailEntries,
  auditHint,
  auditOutcome,
  auditQueryOf,
  auditReason,
  auditReasonLabel,
  auditSentence,
  auditSubLine,
  auditToolSaid,
} from "../src/lib/audit";

// The key and its values, so each test reads which words were picked.
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key}(${Object.values(o).join(",")})` : key) as unknown as TFunction;

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: "a1",
  at: "2026-10-28T12:00:00Z",
  actor: { type: "agent", id: "ag", name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "gmail_send" },
  details: { kind: "external", connector: "Gmail", title: "Gmail: Send", behind: "person", input: {} },
  runId: "r1",
  channelId: "c1",
  channel: { id: "c1", name: "geral", kind: "channel" },
  onBehalfOf: { id: "u1", name: "Bia" },
  outcome: "done",
  approval: null,
  secret: null,
  ...over,
});

const standing = (details: Record<string, unknown>) =>
  row({ actor: { type: "system", id: null, name: null }, action: "organization.standing_changed", details });

describe("Auditoria in words (web and phone)", () => {
  test("the shortcuts and the agent ask the server for the same thing on both", () => {
    expect(auditQueryOf("all", null)).toEqual({});
    // An agent: what it did and what people applied from its cards.
    expect(auditQueryOf("problems", "ag")).toEqual({ via: "ag", outcome: ["refused", "failed"] });
    expect(auditQueryOf("waiting", null)).toEqual({ waiting: true });
    // People's changes are people's, whichever agent was picked.
    expect(auditQueryOf("people", "ag")).toEqual({ actorType: "person", kind: "change" });
  });

  test("who may do one thing, changed for everyone and the roles at once, says which thing", () => {
    const person = { type: "person" as const, id: "u1", name: "Bia" };
    const set = (details: Record<string, unknown>) =>
      auditSentence(t, row({ actor: person, action: "role.permission_set", details }), "pt-BR").text;
    expect(set({ row: "create_channels" })).toBe("audit.change.role.permission_set(permissions.create_channels.short)");
    expect(set({ row: "computers" })).toBe("audit.change.role.permission_set_computers");
    // An older row without one reads as any change.
    expect(set({})).toBe("audit.change.pattern(audit.change.verb.other,audit.change.area.other)");
  });

  test("a Vault change to many items at once says how many; one item's says none", () => {
    const person = { type: "person" as const, id: "u1", name: "Bia" };
    const said = (action: string, details: Record<string, unknown>) =>
      auditSentence(t, row({ actor: person, action, target: { type: "vault", id: null }, details }), "en").text;
    expect(said("vault.items_changed", { fields: ["access"], count: 1200 })).toBe(
      "audit.change.vault.items_changed(1200)",
    );
    expect(said("vault.items_deleted", { count: 3 })).toBe("audit.change.vault.items_deleted(3)");
    expect(said("vault.item_deleted", { kind: "login" })).toBe("audit.change.vault.item_deleted");
  });

  test("a billing hold's reason is said in words, never as its code; any other reason as written", () => {
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "unpaid" }))).toBe(
      "standing.notification.billing.unpaid",
    );
    expect(auditReason(t, standing({ from: "hold", to: "active", reason: null }))).toBeNull();
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "Spam reports" }))).toBe("Spam reports");
    expect(auditReason(t, row({ details: { reason: "unpaid" } }))).toBe("unpaid");
  });

  test("the category an automatic review hold names is said in words; plain review and an unknown one as written", () => {
    const hold = (reason: string) => auditReason(t, standing({ from: "active", to: "hold", reason }));
    expect(hold("review.phishing_impersonation")).toBe("standing.cloud.reviewWhat.phishing_impersonation");
    expect(hold("review.fraud")).toBe("standing.cloud.reviewWhat.fraud");
    expect(hold("review")).toBe("review");
    expect(hold("review.spam")).toBe("review.spam");
  });

  test("who did what, then about what, who asked and where", () => {
    expect(auditSentence(t, row(), "en")).toEqual({ name: "Ada", text: "audit.call.used(Gmail)" });
    // About what, as the call's approval card says it, never the server's English title ("Gmail: Send").
    expect(auditSubLine(t, row())).toBe("approval.titles.action.send · audit.behind.person(Bia) · #geral");
    const expired = row({ actor: { type: "system", id: null, name: null }, action: "approval.expired", details: {} });
    expect(auditSentence(t, expired, "en")).toEqual({ name: null, text: "audit.change.approval.expired" });
    const gone = row({ actor: { type: "person", id: "u1", name: "Bia" }, action: "channel.deleted", details: {} });
    expect(auditSentence(t, gone, "en").text).toBe(
      "audit.change.pattern(audit.change.verb.deleted,audit.change.area.channel)",
    );
  });

  test("a call's title in the person's words, as its approval card says it, never the server's English", () => {
    const merge = row({
      target: { type: "tool", id: "github_merge_pull_request" },
      details: {
        kind: "external",
        connector: "GitHub",
        title: "Merge PR #12 in acme/app",
        behind: "person",
        input: { owner: "acme", repo: "app", pullNumber: 12 },
      },
    });
    const worded = "approval.titles.github.merge_pull_request(12,,acme/app,Merge PR #12 in acme/app)";
    expect(auditHint(t, merge)).toBe(worded);
    expect(auditSubLine(t, merge)).toBe(`${worded} · audit.behind.person(Bia) · #geral`);
    // A change keeps its own name.
    expect(auditHint(t, row({ action: "wiki.page_created", details: { title: "Onboarding" } }))).toBe("Onboarding");
  });

  test("a call that didn't go through says why only in words; what the tool said goes to the technical part", () => {
    const base = row().details;
    const refused = row({
      outcome: "refused",
      details: { ...base, reason: "Not allowed: this agent lacks the scope github:pr.merge", refusal: "noAccess" },
    });
    expect(auditReason(t, refused)).toBe("chat.work.refusal.noAccess()");
    expect(auditToolSaid(refused)).toBe("Not allowed: this agent lacks the scope github:pr.merge");
    const failed = row({
      outcome: "failed",
      details: { ...base, reason: "Failed: That person isn't in this conversation" },
    });
    expect(auditReason(t, failed)).toBeNull();
    expect(auditToolSaid(failed)).toBe("Failed: That person isn't in this conversation");
    // The reason an agent gave when it asked a person is its own words: it stays.
    const asked = row({ outcome: "pending", details: { ...base, reason: "To ship the fix today" } });
    expect(auditReason(t, asked)).toBe("To ship the fix today");
    expect(auditToolSaid(asked)).toBeNull();
  });

  test("a change's details never list an id, in any spelling", () => {
    const details = {
      name: "Acme",
      connectionId: "c-1",
      machineId: "m-1",
      agentIds: ["a"],
      toStorageConfigId: "s",
      delivery_id: "d",
      id: "x",
      paid: true,
      reason: "r",
    };
    expect(auditDetailEntries(details).map(([k]) => k)).toEqual(["name", "paid"]);
  });

  test("whoever runs the server read something: who and what, then at whose request or for which fault, never an id", () => {
    const read = (details: Record<string, unknown>, over: Partial<AuditRow> = {}) =>
      row({
        actor: { type: "system", id: null, name: null },
        action: "operator.content_read",
        target: { type: "message", id: "m1" },
        details: { field: "text", offset: 0, limit: 2000, ...details },
        runId: null,
        channelId: null,
        channel: null,
        onBehalfOf: null,
        outcome: null,
        ...over,
      });
    const bia = { onBehalfOf: { id: "u1", name: "Bia" } };
    const asked = read({ purpose: "member_request", requestId: "q1", source: "form", assistedByAi: true }, bia);
    expect(auditSentence(t, asked, "en")).toEqual({
      name: null,
      text: "audit.operatorRead.sentence(audit.operatorRead.who.server,audit.operatorRead.what.message)",
    });
    const why = "audit.operatorRead.request.app(Bia) · audit.operatorRead.ai";
    expect([auditSubLine(t, asked), auditReason(t, asked)]).toEqual([why, why]);
    expect(auditOutcome(t, asked)).toBeNull();

    // How the request arrived, and who recorded one that came another way.
    const how = (source: unknown, cloud?: true) =>
      auditSubLine(t, read({ purpose: "member_request", source, ...(cloud ? { cloud } : {}) }, bia));
    expect(how("offer")).toBe("audit.operatorRead.request.app(Bia)");
    expect(how("email")).toBe("audit.operatorRead.request.email(Bia)");
    expect(how("operator")).toBe("audit.operatorRead.request.operator(Bia)");
    expect(how("operator", true)).toBe("audit.operatorRead.request.support(Bia)");
    expect(how("pigeon")).toBe("audit.operatorRead.request.plain(Bia)");
    expect(how(undefined)).toBe("audit.operatorRead.request.plain(Bia)");
    // Their account is gone since.
    expect(auditSubLine(t, read({ purpose: "member_request", source: "form" }))).toBe(
      "audit.operatorRead.request.app(audit.removed)",
    );

    // A fault is nobody's request, even when a report named the run.
    const fault = read({ purpose: "fault", runId: "r1", requestId: "q1", assistedByAi: false }, bia);
    expect([auditSubLine(t, fault), auditReason(t, fault)]).toEqual([
      "audit.operatorRead.fault",
      "audit.operatorRead.fault",
    ]);
    // A purpose these apps don't know says nothing it can't.
    expect([auditSubLine(t, read({ purpose: "later" })), auditReason(t, read({ purpose: "later" }))]).toEqual([
      "",
      null,
    ]);

    // What was read, by the entry's target. On agentes.chat's own servers, its support.
    const what = (type: string, details: Record<string, unknown> = {}) =>
      auditSentence(t, read({ purpose: "fault", ...details }, { target: { type, id: null } }), "en").text;
    for (const kind of ["run_step", "agent", "routine", "task", "channel", "connection", "support_request"]) {
      expect(what(kind)).toBe(
        `audit.operatorRead.sentence(audit.operatorRead.who.server,audit.operatorRead.what.${kind})`,
      );
    }
    expect(what("message", { direct: true })).toBe(
      "audit.operatorRead.sentence(audit.operatorRead.who.server,audit.operatorRead.what.direct)",
    );
    expect(what("constructor")).toBe(
      "audit.operatorRead.sentence(audit.operatorRead.who.server,audit.operatorRead.what.other)",
    );
    expect(what("message", { cloud: true })).toBe(
      "audit.operatorRead.sentence(audit.operatorRead.who.cloud,audit.operatorRead.what.message)",
    );
    // The panel's details: what was read of it, never an id nor the server's own mark.
    expect(auditDetailEntries({ ...asked.details, seq: 3, runId: "r1", cloud: true })).toEqual([
      ["field", "text"],
      ["offset", 0],
      ["limit", 2000],
      ["purpose", "member_request"],
      ["source", "form"],
      ["assistedByAi", true],
      ["seq", 3],
    ]);
  });

  test("whoever runs the server answered a member's support request: who and how, then whose request, never an id", () => {
    const replied = (details: Record<string, unknown>, over: Partial<AuditRow> = {}) =>
      row({
        actor: { type: "system", id: null, name: null },
        action: "operator.support_replied",
        target: { type: "support_request", id: "q1" },
        details: { template: "text", chars: 412, assistedByAi: false, ...details },
        runId: null,
        channelId: null,
        channel: null,
        outcome: null,
        ...over,
      });
    const own = replied({});
    expect(auditSentence(t, own, "en")).toEqual({
      name: null,
      text: "audit.operatorReply.sentence(audit.operatorRead.who.server)",
    });
    const whose = "audit.operatorReply.request(Bia)";
    expect([auditSubLine(t, own), auditReason(t, own)]).toEqual([whose, whose]);
    expect(auditOutcome(t, own)).toBeNull();
    // The panel's title is the sentence: the entry holds nothing a hint could be.
    expect(auditHint(t, own)).toBeNull();

    // One of the server's own sentences, sent with an AI assistant. On agentes.chat's own servers, its support.
    const assisted = replied({ template: "received", chars: 0, assistedByAi: true, cloud: true });
    expect(auditSentence(t, assisted, "en").text).toBe("audit.operatorReply.sentence(audit.operatorRead.who.cloud)");
    const withAi = `${whose} · audit.operatorRead.ai`;
    expect([auditSubLine(t, assisted), auditReason(t, assisted)]).toEqual([withAi, withAi]);
    // Their account is gone since.
    expect(auditSubLine(t, replied({}, { onBehalfOf: null }))).toBe("audit.operatorReply.request(audit.removed)");
    // The panel's details: which answer and how long, never an id nor the server's own mark.
    expect(auditDetailEntries(assisted.details)).toEqual([
      ["template", "received"],
      ["chars", 0],
      ["assistedByAi", true],
    ]);
  });

  test("whoever runs the server discloses a safety review: who and what in the sentence, how many items and which days under it", () => {
    const year = new Date().getFullYear();
    const disclosed = (details: Record<string, unknown>) =>
      row({
        actor: { type: "system", id: null, name: null },
        action: "operator.content_review_disclosed",
        target: { type: "organization", id: null },
        details,
        runId: null,
        channelId: null,
        channel: null,
        onBehalfOf: null,
        outcome: null,
      });
    const week = { from: `${year}-03-03T12:00:00.000Z`, to: `${year}-03-09T12:00:00.000Z` };
    const own = disclosed({ ...week, count: 12 });
    // The sentence holds no number and no date: rows of different reviews are told apart by the line under them.
    expect(auditSentence(t, own, "en")).toEqual({
      name: null,
      text: "audit.operatorReview.sentence(audit.operatorRead.who.server)",
    });
    // Under it the count first, then the days. The count twice: once to pick the plural form, once as the language
    // writes numbers.
    const under = (details: Record<string, unknown>) => auditSubLine(t, disclosed(details), "en");
    expect(under({ ...week, count: 12 })).toBe(
      "audit.operatorReview.items(12,12) · audit.operatorReview.period(Mar 3,Mar 9)",
    );
    expect(under({ ...week, count: 10000 })).toBe(
      "audit.operatorReview.items(10000,10,000) · audit.operatorReview.period(Mar 3,Mar 9)",
    );
    // A review that began and ended on one day names that day once. On agentes.chat's own servers, its support.
    const day = disclosed({
      from: `${year}-03-09T10:00:00.000Z`,
      to: `${year}-03-09T13:00:00.000Z`,
      count: 1,
      cloud: true,
    });
    expect(auditSentence(t, day, "en").text).toBe("audit.operatorReview.sentence(audit.operatorRead.who.cloud)");
    expect(auditSubLine(t, day, "en")).toBe("audit.operatorReview.items(1,1) · Mar 9");
    // A date of another year says its year, and so does the one beside it.
    expect(under({ from: `${year - 1}-12-28T12:00:00.000Z`, to: `${year}-01-03T12:00:00.000Z`, count: 3 })).toBe(
      `audit.operatorReview.items(3,3) · audit.operatorReview.period(Dec 28, ${year - 1},Jan 3, ${year})`,
    );
    // The dates as the reader's language writes them.
    expect(auditSubLine(t, own, "pt-BR")).toBe(
      "audit.operatorReview.items(12,12) · audit.operatorReview.period(3 mar,9 mar)",
    );
    // The panel says the same line where a reason goes, under no heading: it is no reason. A read's line keeps its
    // heading.
    expect([auditReason(t, own, "en"), auditReasonLabel(t, own)]).toEqual([auditSubLine(t, own, "en"), null]);
    const read = row({ action: "operator.content_read", details: { purpose: "fault" }, outcome: null });
    expect(auditReasonLabel(t, read)).toBe("audit.panel.reason.other");
    // No outcome, the sentence is the panel's title, and the three values the line says are not listed again.
    expect([auditOutcome(t, own), auditHint(t, own)]).toEqual([null, null]);
    expect(auditDetailEntries(day.details, day.action)).toEqual([]);
    // Another action's `from`, `to` and `count` stay details.
    expect(auditDetailEntries(day.details, "member.role_changed").map(([key]) => key)).toEqual(["from", "to", "count"]);
    // An entry without its period, or with one that is no date, keeps its sentence and says nothing under it.
    for (const details of [{ count: 3 }, { from: "soon", to: week.to, count: 3 }]) {
      const broken = disclosed(details);
      expect([
        auditSentence(t, broken, "en").text,
        auditSubLine(t, broken, "en"),
        auditReason(t, broken, "en"),
      ]).toEqual(["audit.operatorReview.sentence(audit.operatorRead.who.server)", "", null]);
    }
  });

  test("a merge done without asking says where", () => {
    const merged = row({
      action: "agent.merged_without_asking",
      target: { type: "repository", id: "acme/app" },
      details: {},
    });
    expect(auditSentence(t, merged, "en").text).toBe("audit.change.mergedWithoutAsking(acme/app)");
  });

  test("a waiting call says what became of its approval or of the secret it asked for", () => {
    expect(auditOutcome(t, row())).toMatchObject({ mood: "done", text: "audit.outcome.done" });
    const waiting = row({ outcome: "pending", approval: { id: "ap", status: "pending", decidedBy: null } });
    expect(auditOutcome(t, waiting)).toMatchObject({ mood: "waiting", text: "audit.outcome.pending" });
    const refused = row({ outcome: "pending", approval: { id: "ap", status: "refused", decidedBy: null } });
    expect(auditOutcome(t, refused)).toMatchObject({ mood: "refused", text: "audit.outcome.refusedByPerson" });
    const asked = row({ outcome: "pending", secret: { id: "s", status: "pending" } });
    expect(auditOutcome(t, asked)).toMatchObject({ mood: "waiting", text: "audit.outcome.pendingSecret" });
    const delivered = row({ outcome: "pending", secret: { id: "s", status: "delivered" } });
    expect(auditOutcome(t, delivered)).toMatchObject({ mood: "neutral", text: "audit.outcome.delivered" });
    expect(auditOutcome(t, row({ action: "routine.created", outcome: null }))).toBeNull();
  });
});

test("an outside collaborator's approval, removal and leaving say who they work for (ADR 0191)", () => {
  const person = { type: "person" as const, id: "u1", name: "Bia" };
  const of = (action: string, details: Record<string, unknown>, actor: AuditRow["actor"] = person) =>
    auditSentence(t, row({ actor, action, target: { type: "person", id: "u2" }, details }), "en");
  expect(of("join_request.approved", { outsideOf: "Northwind" }).text).toBe("audit.change.outside.approved(Northwind)");
  expect(of("member.removed", { outsideOf: "Northwind" }, { type: "system", id: null, name: null })).toEqual({
    name: null,
    text: "audit.change.outside.removed(Northwind)",
  });
  expect(of("member.left", { outsideOf: "Northwind" }).text).toBe("audit.change.outside.left(Northwind)");
  // Without it, the sentences as before.
  expect(of("member.left", {}).text).toBe("audit.change.member.left");
  expect(of("join_request.approved", {}).text).not.toContain("outside");
});
