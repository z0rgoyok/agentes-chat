import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AiComputer, Credential, MachineAccount, PlanUsage } from "../src/api/types";
import {
  accountAbout,
  accountChain,
  accountChoices,
  accountSub,
  accountTitle,
  againLogin,
  agentsToGive,
  chainHasRoom,
  endsOnClaude,
  existingAi,
  groupPlans,
  haveAbout,
  haveGroup,
  identityUnknown,
  labelTitle,
  lendable,
  listsExisting,
  lockedByOwner,
  lockedText,
  newestUsage,
  offersSignInAgain,
  orderAccounts,
  orderDrop,
  orderMover,
  orderPlaces,
  orderStep,
  ownSignInListed,
  ownSignInLower,
  ownSignInName,
  ownSignInReady,
  ownSignIns,
  pickable,
  planWordOf,
  removableLogins,
  reusableAccount,
  signInNote,
  signInOf,
  signInPlan,
  unnamedAccount,
  unusedCopies,
  withSub,
} from "../src/lib/ai-accounts";
import { accountName, roomWord, usageSourcePart } from "../src/lib/plan-usage";

const usage = (at: string, usedPercent: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent }],
  source: "turn",
  at,
});

/** One of Ana's GLM Coding logins on the Mac, unless said otherwise. */
const login = (
  id: string,
  over: Partial<MachineAccount & { machineId: string }> = {},
): MachineAccount & { machineId: string } => ({
  id,
  kind: "claude_code",
  label: "GLM Coding",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u_ana",
  ownerName: "Ana",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "zai",
  keyHint: "MnOp",
  machineId: "m1",
  ...over,
});

const rows = (accounts: (MachineAccount & { machineId: string })[]) =>
  groupPlans(accounts).map((g) => [g.key, g.logins.map((l) => l.id)]);

describe("groupPlans: one row per account, its logins together", () => {
  test("three logins of one key are one plan: every agent on it, the newest usage, who is signed out", () => {
    const [plan, ...rest] = groupPlans([
      login("a", { usedBy: ["Ada"], usage: usage("2026-10-27T10:00:00.000Z", 40) }),
      login("t", { usedBy: ["Theo"], usage: usage("2026-10-27T11:00:00.000Z", 62), status: "signed_out" }),
      login("l", { usedBy: ["Lia"], usage: null }),
    ]);
    expect(rest).toEqual([]);
    expect(plan?.key).toBe("a");
    expect(plan?.usedBy).toEqual(["Ada", "Theo", "Lia"]);
    expect(plan?.usage?.windows[0]?.usedPercent).toBe(62);
    expect(plan?.signedOut.map((l) => l.id)).toEqual(["t"]);
  });

  test("by the account, never by its name: two keys named alike stay two rows", () => {
    expect(rows([login("a", { label: "Equipe" }), login("b", { label: "Equipe", keyHint: "WxYz" })])).toEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
  });

  test("a sign-in by its email in any case; another computer, owner or plan is another account", () => {
    const claude = (id: string, email: string, over = {}) =>
      login(id, { provider: null, keyHint: null, email, label: "Claude Max", ...over });
    expect(
      rows([
        claude("a", "ana@example.com"),
        claude("b", "Ana@Example.com"),
        claude("c", "ana@example.com", { machineId: "m2" }),
        claude("d", "ana@example.com", { kind: "codex" }),
        login("e"),
        login("f", { provider: "kimi" }),
      ]),
    ).toEqual([
      ["a", ["a", "b"]],
      ["c", ["c"]],
      ["d", ["d"]],
      ["e", ["e"]],
      ["f", ["f"]],
    ]);
  });

  test("one email in two of Claude's organizations is two accounts", () => {
    const claude = (id: string, providerOrgId: string | null) =>
      login(id, { provider: null, keyHint: null, email: "ana@example.com", providerOrgId });
    expect(rows([claude("a", "org-personal"), claude("b", "org-team"), claude("c", "org-team")])).toEqual([
      ["a", ["a"]],
      ["b", ["b", "c"]],
    ]);
    // A login that doesn't say its organization is a login of either, as the server reads it.
    expect(rows([claude("a", null), claude("b", "org-team"), claude("c", null)])).toEqual([["a", ["a", "b", "c"]]]);
    expect(rows([claude("a", "org-personal"), claude("b", null), claude("c", "org-team")])).toEqual([
      ["a", ["a", "b"]],
      ["c", ["c"]],
    ]);
  });

  test("a login the computer couldn't check is neither signed in nor signed out", () => {
    const [plan] = groupPlans([
      login("a"),
      login("b", { status: "signed_out" }),
      login("c", { status: "signed_out", statusKnown: false }),
      login("d", { statusKnown: false }),
    ]);
    expect(plan?.signedOut.map((l) => l.id)).toEqual(["b"]);
    expect(plan?.unknown.map((l) => l.id)).toEqual(["c"]);
    expect(plan?.logins.map(signInOf)).toEqual(["active", "signed_out", "unknown", "active"]);
    // Still refused by the server, so signing in again stays offered; only the words change.
    expect(plan?.logins.map(offersSignInAgain)).toEqual([false, true, true, false]);
  });

  test("logins whose email or key the viewer can't see stay apart", () => {
    const theirs = { mine: false, ownerId: "u_bia", keyHint: null };
    expect(rows([login("a", theirs), login("b", theirs)])).toEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
  });
});

describe("accountChoices: an agent's account choice, one entry per account", () => {
  const claude = (id: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { provider: null, keyHint: null, label: "Claude Max", email: "ana@example.com", ...over });
  const choice = (accounts: (MachineAccount & { machineId: string })[], ids: (string | null)[]) =>
    accountChoices(accounts, ids).map((c) => [c.login.id, c.usedBy, c.also]);

  test("its own login, else a free one, else one more for it where the account may have a login per agent", () => {
    const theo = claude("t", { usedBy: ["Theo"] });
    // Every login another agent's: Claude signs in once more for this one, its agents named.
    expect(choice([theo, claude("l", { usedBy: ["Lia"] })], [null])).toEqual([["t", ["Theo", "Lia"], true]]);
    expect(choice([theo, claude("a", { usedBy: ["Ada"] })], ["a"])).toEqual([["a", ["Theo", "Ada"], false]]);
    // A login that thinks for nobody comes before a new one, a signed-in one before one signed out.
    expect(choice([theo, claude("f")], [null])).toEqual([["f", ["Theo"], false]]);
    expect(choice([claude("o", { status: "signed_out" }), claude("n")], [null])).toEqual([["n", [], false]]);
    // ChatGPT's like Claude's: one more login for this agent; someone else's is never one to sign in to.
    expect(choice([claude("c", { kind: "codex", usedBy: ["Theo"] })], [null])).toEqual([["c", ["Theo"], true]]);
    expect(choice([claude("x", { mine: false, ownerId: "u_bia", email: null, usedBy: ["Theo"] })], [null])).toEqual([
      ["x", ["Theo"], false],
    ]);
  });

  test("one made for all of its owner's agents there is offered as it is, other agents on it or not", () => {
    expect(choice([claude("s", { usedBy: ["Theo"], shared: true })], [null])).toEqual([["s", ["Theo"], false]]);
    // A login of the account for this agent alone still comes first.
    expect(choice([claude("s", { usedBy: ["Theo"], shared: true }), claude("a")], ["a"])).toEqual([
      ["a", ["Theo"], false],
    ]);
  });

  test("the login chosen comes before the one the agent thinks with", () => {
    const logins = [claude("a", { usedBy: ["Ada"] }), claude("b")];
    expect(choice(logins, ["b", "a"])).toEqual([["b", ["Ada"], false]]);
    expect(choice(logins, [null, "a"])).toEqual([["a", ["Ada"], false]]);
  });
});

describe("existingAi: what a person already has for an agent with no AI", () => {
  const claude = (id: string, email: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { provider: null, keyHint: null, label: id, email, ...over });
  const key = (id: string, revokedAt: string | null = null): Credential => ({
    id,
    provider: "anthropic",
    label: id,
    keyHint: "7f2a",
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt,
  });
  const acts = (
    accounts: (MachineAccount & { machineId: string })[],
    account: string | null,
    keys: Credential[] = [],
  ) =>
    existingAi({ accounts, account }, keys).map((r) =>
      r.kind === "key" ? ["key", r.key.id] : [r.act, r.choice.login.id],
    );

  test("free accounts first, then those to sign in to or move, the keys, someone else's; never its own login", () => {
    expect(
      acts(
        [
          claude("theo", "walt@acme.com", { usedBy: ["Theo"] }),
          claude("plus", "walt@gmail.com", { kind: "codex", usedBy: ["Theo"] }),
          claude("out", "it@example.org", { status: "signed_out" }),
          claude("free", "team@example.com"),
          claude("own", "ada@acme.com", { usedBy: ["Ada"], status: "signed_out" }),
          claude("bia", "bia@acme.com", { mine: false, ownerId: "u_bia", email: null }),
        ],
        "own",
        [key("k1"), key("gone", "2026-10-20T00:00:00.000Z")],
      ),
    ).toEqual([
      ["use", "free"],
      ["also", "theo"],
      ["also", "plus"],
      ["again", "out"],
      ["key", "k1"],
      ["locked", "bia"],
    ]);
  });

  test("a signed-out login another agent thinks with signs in again for this one; a free login of an account comes first", () => {
    expect(
      acts([claude("c", "walt@gmail.com", { kind: "codex", usedBy: ["Theo"], status: "signed_out" })], null),
    ).toEqual([["also", "c"]]);
    expect(acts([claude("t", "walt@acme.com", { usedBy: ["Theo"] }), claude("f", "walt@acme.com")], null)).toEqual([
      ["use", "f"],
    ]);
  });

  test("one made for all of its owner's agents is used as it is, never moved, while other agents think with it", () => {
    const forAll = (over: Partial<MachineAccount> = {}) =>
      claude("s", "walt@acme.com", { usedBy: ["Theo"], usedByIds: ["theo"], shared: true, ...over });
    expect(acts([forAll()], null)).toEqual([["use", "s"]]);
    expect(acts([forAll({ status: "signed_out" })], null)).toEqual([["again", "s"]]);
  });

  test("who may use other people's plans uses a teammate's in one click, never one another agent has (ADR 0059 §3)", () => {
    const theirs = (id: string, over: Partial<MachineAccount> = {}) =>
      claude(id, "", { mine: false, ownerId: "u_bia", email: null, ...over });
    const accounts = [
      theirs("free"),
      theirs("busy", { usedBy: ["Theo"] }),
      theirs("all", { usedBy: ["Theo"], shared: true }),
      theirs("out", { status: "signed_out" }),
    ];
    const rows = (canUseOthersPlans: boolean) =>
      existingAi({ accounts, account: null, canUseOthersPlans }, []).map((r) =>
        r.kind === "key" ? ["key", r.key.id] : [r.act, r.choice.login.id],
      );
    expect(rows(true)).toEqual([
      ["use", "free"],
      ["use", "all"],
      ["locked", "busy"],
      ["locked", "out"],
    ]);
    expect(rows(false).every(([act]) => act === "locked")).toBe(true);
    expect(lendable({ status: "active", shared: false, usedBy: ["Ada"] }, "Ada")).toBe(true);
    expect(lendable({ status: "active", shared: false, usedBy: ["Theo"] }, "Ada")).toBe(false);
  });
});

describe("one account signed in once per agent is one row, whoever looks", () => {
  /** Walter's Claude Team, signed in thirteen times on the Mac (one login per agent): ten agents on it, two signed out, one free. */
  const team = (mine: boolean) =>
    Array.from({ length: 13 }, (_, i) =>
      login(`w${i + 1}`, {
        provider: null,
        keyHint: null,
        label: "Claude",
        plan: "team",
        email: mine ? "walter@example.com" : null,
        mine,
        ownerId: "u_walter",
        ownerName: "Walter Branco",
        sameAs: "w1",
        status: i === 10 || i === 11 ? "signed_out" : "active",
        usedBy: i < 10 ? [`Agent ${i + 1}`] : [],
      }),
    );
  /** One more of Walter's, made for all of his agents there (another account), and one of Bia's own. */
  const more = (mine: boolean) => [
    login("s1", {
      provider: null,
      keyHint: null,
      label: "Claude",
      plan: "team",
      email: mine ? "walter.ops@example.com" : null,
      mine,
      ownerId: "u_walter",
      ownerName: "Walter Branco",
      sameAs: "s1",
      shared: true,
      usedBy: ["Atlas"],
    }),
    login("b1", {
      provider: null,
      keyHint: null,
      label: "Claude",
      email: mine ? null : "bia@example.com",
      mine: !mine,
      ownerId: "u_bia",
      ownerName: "Bia",
      sameAs: "b1",
    }),
  ];
  const acts = (mine: boolean, canUseOthersPlans: boolean, accounts = [...team(mine), ...more(mine)]) =>
    existingAi({ accounts, account: null, canUseOthersPlans }, []).map((r) =>
      r.kind === "key" ? ["key", r.key.id] : [r.act, r.choice.login.id],
    );

  test("its owner, an admin who may use others' plans and a member who may not each read one row per account", () => {
    expect(groupPlans(team(true)).map((g) => g.logins.length)).toEqual([13]);
    expect(groupPlans(team(false)).map((g) => g.logins.length)).toEqual([13]);
    // The owner: the free login of the thirteen, used at once.
    expect(acts(true, false, team(true))).toEqual([["use", "w13"]]);
    // An admin: the same free login, not the oldest (an agent's), so the account reads as usable, not locked.
    expect(acts(false, true)).toEqual([
      ["use", "w13"],
      ["use", "s1"],
      ["use", "b1"],
    ]);
    // A member who may not use others' plans: each of Walter's accounts once, locked.
    expect(acts(false, false)).toEqual([
      ["use", "b1"],
      ["locked", "w13"],
      ["locked", "s1"],
    ]);
  });

  test("its oldest login signed out, a newer one free: the row offers the newer one, usable", () => {
    const [old, , , , , , , , , , , , free] = team(false);
    if (!old || !free) throw new Error("logins");
    const logins = [{ ...old, status: "signed_out" as const, usedBy: [] }, free];
    expect(acts(false, true, logins)).toEqual([["use", "w13"]]);
  });

  test("an account none of whose logins is free stays locked, once, even for an admin", () => {
    const busy = team(false).map((l) => (l.usedBy.length ? l : { ...l, status: "signed_out" as const }));
    expect(acts(false, true, busy)).toEqual([["locked", "w1"]]);
  });

  test("what can't be picked leaves the list and is counted per person and per account, never per login", () => {
    const rows = existingAi({ accounts: [...team(false), ...more(false)], account: null }, []);
    expect(pickable(rows).map((r) => (r.kind === "account" ? r.choice.login.id : r.key.id))).toEqual(["b1"]);
    expect(lockedByOwner(rows)).toEqual([{ key: "owner:u_walter", name: "Walter", count: 2 }]);
    const t = ((key: string, o?: object) => `${key} ${JSON.stringify(o)}`) as unknown as TFunction;
    expect(lockedText(t, { name: "Walter", count: 2 })).toBe('connectAi.have.onlyOwner {"count":2,"name":"Walter"}');
  });

  test("a row's line tells accounts apart: one's own by what its title leaves out and how many more agents; someone else's by whose alone (its title says the plan)", () => {
    const t = ((key: string, o?: Record<string, unknown>) =>
      o ? `${key}(${Object.values(o).join(",")})` : key) as unknown as TFunction;
    const [own, ,] = existingAi({ accounts: more(true), account: null }, []);
    const theirs = existingAi({ accounts: team(false), account: null, canUseOthersPlans: true }, [])[0];
    if (own?.kind !== "account" || theirs?.kind !== "account") throw new Error("rows");
    // Made for all of Walter's agents, Atlas on it: its title is its email, so the line says the plan, then one more agent.
    expect(haveAbout(t, own, "Lia")).toBe("Team · agentPage.work.brain.accountAlso(format.list(Atlas))");
    expect(haveAbout(t, own, "Atlas")).toBe("Team");
    const named = { ...own, choice: { ...own.choice, login: { ...own.choice.login, named: true, label: "Trabalho" } } };
    expect(haveAbout(t, named, "Atlas")).toBe("walter.ops@example.com · Team");
    expect(haveAbout(t, theirs, "Lia")).toBe("agentPage.work.brain.accountOf(Walter)");
    expect(theirs.choice.login.plan).toBe("team");
    expect(JSON.stringify(haveAbout(t, theirs, "Lia"))).not.toContain("@");
    expect(haveGroup(t, own)).toEqual({ key: "mine", label: "connectAi.chat.mine" });
    expect(haveGroup(t, theirs)).toEqual({ key: "owner:u_walter", label: "agentPage.work.brain.accountOf(Walter)" });
    expect(roomWord(t, "en", { state: "ok", until: null })).toBe("connectAi.have.plenty");
    expect(roomWord(t, "en", { state: "almost", until: null })).toBe("aiAccounts.usage.almost");
    expect(roomWord(t, "en", null)).toBeNull();
  });
});

describe("the computers' own sign-ins", () => {
  const computer = (over: Partial<AiComputer>): AiComputer => ({
    machineId: "mac",
    name: "MacBook Air",
    online: true,
    mine: true,
    canAdd: true,
    keys: true,
    brains: { claude_code: true, codex: true },
    ...over,
  });

  test("each CLI's own sign-in a computer reported, Claude Code first, with its plan and usage", () => {
    const u = usage("2026-10-27T10:00:00.000Z", 40);
    const rows = ownSignIns({
      computers: [
        computer({ own: { codex: { usage: u }, claude_code: { plan: "max" } } }),
        computer({ machineId: "pc", name: "PC", own: {} }),
        // A server too old to say.
        computer({ machineId: "old", name: "Old" }),
      ],
    });
    expect(rows.map((r) => [r.key, r.computer, r.kind, r.plan, r.usage])).toEqual([
      ["mac:claude_code", "MacBook Air", "claude_code", "max", null],
      ["mac:codex", "MacBook Air", "codex", null, u],
    ]);
    expect(ownSignIns(undefined)).toEqual([]);
  });

  test("OpenCode's free tier is a choice where its CLI runs, never a sign-in anyone has", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const running = { brains: { opencode: true } as AiComputer["brains"], own: {} };
    // Nobody signed in: no row in "Seus planos", whatever an older server still sends.
    expect(ownSignIns({ computers: [computer({ ...running, own: { opencode: {} } })] })).toEqual([]);
    const agent = { ownSignIn: false, brain: "opencode", account: null, canUsePlans: true } as const;
    // On a computer nobody connected, for anyone's agent.
    expect(ownSignInReady(agent, computer({ ...running, mine: false }), "opencode")).toBe(true);
    // On someone else's computer, no.
    expect(ownSignInReady(agent, computer({ ...running, mine: false, canAdd: false }), "opencode")).toBe(false);
    // On a computer the agent's owner connected, for that owner's agents.
    expect(ownSignInReady({ ownSignIn: true }, computer(running), "opencode")).toBe(true);
    expect(ownSignInReady(agent, computer(running), "opencode")).toBe(false);
    // Not where the CLI can't run.
    expect(ownSignInReady({ ownSignIn: true }, computer({ own: {} }), "opencode")).toBe(false);
    expect(ownSignInName(t, true, "Mac", "opencode")).toBe("connectAi.own.free");
    expect(ownSignInName(t, true, "Mac", "claude_code")).toBe("connectAi.own.shared");
    expect(ownSignInLower(t, "opencode")).toBe("connectAi.own.freeLower");
  });

  test("an agent's account choice offers the computer's own sign-in only where it can think for the agent", () => {
    type View = Parameters<typeof ownSignInListed>[0];
    const theirs: View = { ownSignIn: true, brain: "model", account: null, canUsePlans: true };
    const reported = computer({ own: { claude_code: { plan: "max" }, codex: { usage: usage("2026-10-30", 5) } } });
    // On a computer the agent's owner connected, once that CLI's own sign-in is reported there.
    expect(ownSignInReady(theirs, reported, "codex")).toBe(true);
    expect(ownSignInReady(theirs, computer({ own: {} }), "codex")).toBe(false);
    expect(ownSignInReady(theirs, undefined, "claude_code")).toBe(false);
    expect(ownSignInListed(theirs, computer({ own: {} }), "codex")).toBe(false);
    // On one nobody connected (the workspace's), never, whatever it reports.
    const nobodys: View = { ...theirs, ownSignIn: false };
    expect(ownSignInReady(nobodys, reported, "codex")).toBe(false);
    expect(ownSignInListed({ ...nobodys, brain: "codex" }, reported, "codex")).toBe(false);
    // While the agent thinks with it: on its owner's computer, before the computer says; to someone who can't change
    // the account, wherever it is (what it thinks with).
    expect(ownSignInListed({ ...theirs, brain: "codex" }, undefined, "codex")).toBe(true);
    expect(ownSignInListed({ ...theirs, brain: "codex", account: "acct_1" }, undefined, "codex")).toBe(false);
    expect(ownSignInListed({ ...nobodys, brain: "codex", canUsePlans: false }, undefined, "codex")).toBe(true);
    // To an admin on the computer its owner connected, always: only that person sees what its CLIs report.
    expect(ownSignInListed({ ...theirs, canUsePlans: false }, undefined, "codex")).toBe(true);
    expect(ownSignInListed({ ...nobodys, canUsePlans: false }, undefined, "codex")).toBe(false);
    // Account-only brains (Antigravity / Gemini, Grok) never offer a computer's own sign-in (web and mobile).
    for (const kind of ["antigravity", "grok"] as const) {
      expect(ownSignInReady(theirs, computer({ own: { [kind]: { plan: "pro" } } }), kind)).toBe(false);
      expect(ownSignInListed({ ...theirs, canUsePlans: false }, undefined, kind)).toBe(false);
      expect(ownSignInListed({ ...theirs, brain: kind, account: null }, undefined, kind)).toBe(false);
    }
  });

  test("the plan's word", () => {
    expect(planWordOf("max")).toBe("Max");
    expect(planWordOf("PRO")).toBe("Pro");
    expect(planWordOf(null)).toBeNull();
  });

  test("an account read by its name says its plan once, after it", () => {
    expect(labelTitle({ label: "Claude", plan: "max" })).toBe("Claude · Max");
    expect(labelTitle({ label: "Claude 2", plan: "ultra" })).toBe("Claude 2 · Ultra");
    expect(labelTitle({ label: "GLM Coding", plan: null })).toBe("GLM Coding");
    // A server that still names accounts after their plan ("Claude Max 2"): the plan isn't said twice.
    expect(labelTitle({ label: "Claude Max 2", plan: "max" })).toBe("Claude Max 2");
    expect(labelTitle({ label: "claude team", plan: "team" })).toBe("claude team");
    expect(labelTitle({ label: "Claude Max", plan: "ultra" })).toBe("Claude Max · Ultra");
    expect(labelTitle({ label: "Maxwell", plan: "max" })).toBe("Maxwell · Max");
  });

  test("the viewer's own account reads by the name they gave it, else its email, else as unnamed", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const own = {
      label: "Claude 2",
      plan: "team",
      email: "ana@acme.com",
      mine: true,
      named: false,
      keyHint: null,
      provider: null,
    };
    // The automatic name says nothing: the email is the title, the plan goes under it.
    expect(accountTitle(t, own)).toBe("ana@acme.com");
    expect(accountSub(own)).toBe("Team");
    expect(withSub(own, "Também usada por Infra")).toBe("Team · Também usada por Infra");
    // A name its owner gave it stands above its email.
    const named = { ...own, label: "Trabalho", named: true };
    expect(accountTitle(t, named)).toBe("Trabalho");
    expect(accountSub(named)).toBe("ana@acme.com · Team");
    // A sign-in that says no email (Claude's token for all agents) and no name of theirs: unnamed.
    expect(accountTitle(t, { ...own, email: null })).toBe("aiAccounts.unnamed");
    expect(unnamedAccount({ ...own, email: null })).toBe(true);
    expect(unnamedAccount(own)).toBe(false);
    // An older server that doesn't say: the automatic name, read as such.
    expect(accountTitle(t, { ...own, named: undefined })).toBe("ana@acme.com");
    // Someone else's (no email for the viewer) and a key account keep their name with the plan.
    expect(accountTitle(t, { ...own, mine: false, email: null })).toBe("Claude 2 · Team");
    expect(accountSub({ ...own, mine: false, email: null })).toBeUndefined();
    const key = { ...own, label: "GLM Coding", plan: null, provider: "zai", keyHint: "MnOp", email: null };
    expect(accountTitle(t, key)).toBe("GLM Coding");
  });

  test("the plan an agent's sign-in is on: its account's, or with none its computer's own sign-in's", () => {
    const row = computer({ own: { claude_code: { plan: "team" } } });
    const seat = login("acct_team", { plan: "max", provider: null });
    expect(signInPlan({ account: null, accounts: [seat] }, row, "claude_code")).toBe("team");
    expect(signInPlan({ account: "acct_team", accounts: [seat] }, row, "claude_code")).toBe("max");
    // Codex's own sign-in said no plan; a computer whose row isn't there yet says none either.
    expect(signInPlan({ account: null, accounts: [] }, row, "codex")).toBeNull();
    expect(signInPlan({ account: null, accounts: [] }, undefined, "claude_code")).toBeNull();
  });
});

describe("the computer's own sign-in by name", () => {
  const WORDS: Record<string, string> = {
    "connectAi.own.shared": "The account your agents share",
    "agentPage.work.brain.thisComputer": "{{computer}}'s account",
    "usageViews.agent.sharedPart": "{{percent}} on the account your agents share",
    "usageViews.agent.computerPart": "{{percent}} on {{computer}}'s own account",
  };
  const t = ((key: string, o: Record<string, string> = {}) =>
    (WORDS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => o[k] ?? "")) as unknown as TFunction;

  test("the viewer's own computer: the account their agents share; someone else's: that computer's", () => {
    expect(ownSignInName(t, true, "MacBook")).toBe("The account your agents share");
    expect(ownSignInName(t, false, "MacBook")).toBe("MacBook's account");
    const own = {
      label: null,
      named: false,
      email: null,
      plan: null,
      provider: null,
      machineName: "MacBook",
      mine: true,
      kind: "claude_code" as const,
    };
    expect(accountName(t, own)).toBe("The account your agents share");
    expect(accountName(t, { ...own, mine: false })).toBe("MacBook's account");
    expect(accountName(t, { ...own, label: "Trabalho", named: true })).toBe("Trabalho");
    // An account with the automatic name: its email.
    expect(accountName(t, { ...own, label: "Claude 2", email: "ana@acme.com" })).toBe("ana@acme.com");
    const source = (mine: boolean) =>
      ({
        key: "m1:claude_code:computer",
        type: "plan",
        kind: "claude_code",
        account: { accountId: null, label: null, machineName: "MacBook", mine },
        removed: false,
        tokens: 1000,
        share: 97,
        lastDay: null,
        now: true,
      }) as unknown as Parameters<typeof usageSourcePart>[2];
    expect(usageSourcePart(t, "en", source(true))).toBe("97% on the account your agents share");
    expect(usageSourcePart(t, "en", source(false))).toBe("97% on MacBook's own account");
  });
});

describe("an account for all of its owner's agents", () => {
  const ana = "u_ana";
  const agents = [
    { id: "ada", ownerUserId: ana },
    { id: "theo", ownerUserId: ana },
    { id: "lia", ownerUserId: ana },
    { id: "bo", ownerUserId: "u_bia" },
    { id: "cy", ownerUserId: ana },
  ];
  const machine = { agents: ["ada", "theo", "lia", "bo"].map((id) => ({ id, name: id, handle: id })) };
  const give = (over: Partial<MachineAccount> = {}, onKey: (id: string) => boolean = (id) => id === "lia") =>
    agentsToGive({
      account: login("s", { shared: true, usedBy: ["Ada"], usedByIds: ["ada"], ...over }),
      agents,
      machine,
      viewerId: ana,
      onKey,
    }).map((a) => a.id);

  test("Use for…: the owner's agents on its computer not on it yet, never one on the API key", () => {
    // Theo; not Ada (on it), Lia (on the key), Bo (Bia's) nor Cy (another computer).
    expect(give()).toEqual(["theo"]);
    expect(give({}, () => false)).toEqual(["theo", "lia"]);
    // One made for one agent, or someone else's: nothing to give.
    expect(give({ shared: false })).toEqual([]);
    expect(give({ mine: false })).toEqual([]);
  });

  test("disconnecting ends it on Claude only through Claude's settings: a token, where each agent is its own user", () => {
    const token = login("t", { shared: true, provider: null, keyHint: null });
    expect(endsOnClaude(token, { mode: "system" })).toBe(true);
    expect(endsOnClaude(token, { mode: "single" })).toBe(false);
    expect(endsOnClaude({ ...token, provider: "zai" }, { mode: "system" })).toBe(false);
    expect(endsOnClaude({ ...token, shared: false }, { mode: "system" })).toBe(false);
    expect(endsOnClaude({ ...token, kind: "codex" }, { mode: "system" })).toBe(false);
  });

  test("such a token names no account: its owner reads that it isn't known, never where an email says it", () => {
    const token = login("t", { shared: true, provider: null, keyHint: null });
    expect(identityUnknown(token, { mode: "system" })).toBe(true);
    expect(identityUnknown({ ...token, email: "ana@example.com" }, { mode: "system" })).toBe(false);
    expect(identityUnknown({ ...token, mine: false }, { mode: "system" })).toBe(false);
    expect(identityUnknown(token, { mode: "single" })).toBe(false);
  });
});

describe("an account's line in an agent's account choice", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const about = (over: Partial<MachineAccount>) =>
    accountAbout(t, { login: login("k", over), usedBy: [], also: false }, "Ada");

  test("a coding plan's key that its endpoint refused asks for a new key; a sign-in that ended, to sign in again", () => {
    expect(about({ status: "signed_out" })).toBe("aiAccounts.page.keyRefused");
    expect(about({ status: "signed_out", provider: null, keyHint: null, email: "ana@acme.com" })).toBe(
      "agentPage.work.brain.accountSignedOut",
    );
    expect(about({})).toBe("aiAccounts.page.keyEnds");
  });

  test("one the computer couldn't check says so, never signed out", () => {
    expect(about({ status: "signed_out", statusKnown: false, provider: null, keyHint: null })).toBe(
      "agentPage.work.brain.accountUnknown",
    );
  });
});

describe("a sign-in made again reuses the account (`reusableAccount`), and the copies it left go (`unusedCopies`)", () => {
  const chatgpt = (id: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { kind: "codex", label: "ChatGPT", provider: null, keyHint: null, email: "ana@acme.com", ...over });
  const where = { machineId: "m1", kind: "codex" } as const;

  test("their account of that plan on that computer, a signed-out one first", () => {
    const active = chatgpt("on");
    const out = chatgpt("out", { status: "signed_out" });
    expect(reusableAccount([active, out], where)?.id).toBe("out");
    expect(reusableAccount([active], where)?.id).toBe("on");
    expect(reusableAccount([chatgpt("all", { usedBy: ["Ada"], shared: true })], where)?.id).toBe("all");
  });

  test("never someone else's, another computer's, another program's or another plan's", () => {
    expect(
      reusableAccount(
        [
          chatgpt("theirs", { mine: false }),
          // Another agent's own login: signing in to it again would sign that agent out.
          chatgpt("ada", { usedBy: ["Ada"], shared: false }),
          chatgpt("mac2", { machineId: "m2" }),
          login("claude", { kind: "claude_code", provider: null }),
          login("glm"),
        ],
        where,
      ),
    ).toBeUndefined();
    // A coding plan's key account is reused for that plan only.
    expect(reusableAccount([login("glm")], { machineId: "m1", kind: "claude_code", provider: "zai" })?.id).toBe("glm");
    expect(reusableAccount([login("glm")], { machineId: "m1", kind: "claude_code" })).toBeUndefined();
    expect(reusableAccount(undefined, where)).toBeUndefined();
  });

  test("an account's logins with no agent are copies, one kept when none has an agent", () => {
    const [nine] = groupPlans([
      chatgpt("a", { usedBy: ["Ada"] }),
      ...["b", "c", "d"].map((id) => chatgpt(id, { status: "signed_out" })),
      chatgpt("e"),
    ]);
    expect(nine && unusedCopies(nine).map((l) => l.id)).toEqual(["b", "c", "d", "e"]);
    const [idle] = groupPlans([chatgpt("x", { status: "signed_out" }), chatgpt("y"), chatgpt("z")]);
    // The signed-in one stays.
    expect(idle && unusedCopies(idle).map((l) => l.id)).toEqual(["x", "z"]);
    const [one] = groupPlans([chatgpt("only")]);
    expect(one && unusedCopies(one)).toEqual([]);
  });
});

test("Connect an AI starts with what the person has while the agent has no AI, and always for the right hand", () => {
  expect(listsExisting({ builtin: null }, true)).toBe(true);
  expect(listsExisting({ builtin: null }, false)).toBe(false);
  expect(listsExisting({ builtin: "right_hand" }, false)).toBe(true);
  expect(listsExisting(undefined, false)).toBe(false);
});

describe("accountChain: the accounts a run goes through at its plan's limit", () => {
  /** Claude accounts with the CLI's own sign-in on the Mac, Ana's unless said otherwise. */
  const claude = (id: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { label: id, provider: null, keyHint: null, shared: true, serves: "everyone", useOrder: null, ...over });
  const walter = { ownerId: "u_walter", ownerName: "Walter", mine: false };
  const agent = { id: "ag_ada", ownerId: "u_ana", account: "own1" as string | null };
  const chainOf = (
    accounts: MachineAccount[],
    over: Partial<typeof agent & { pinned: boolean; scope: "mine" | "workspace" }> = {},
  ) => accountChain(accounts, { ...agent, ...over }).map((a) => a.id);

  test("its own account, then its owner's others, then those that serve everyone, each by its place", () => {
    expect(
      chainOf([
        claude("w1", { ...walter, useOrder: 0 }),
        claude("own1", { useOrder: 3 }),
        claude("old"),
        claude("own2", { useOrder: 1 }),
        claude("w2", { ...walter }),
        claude("w0", { ...walter, useOrder: 2 }),
      ]),
    ).toEqual(["own1", "own2", "old", "w1", "w0", "w2"]);
  });

  test("never a key, another kind, one signed out, someone's owner-only one or a one-agent login, even an unused one", () => {
    expect(
      chainOf([
        claude("own1"),
        claude("key", { provider: "zai" }),
        claude("codex", { kind: "codex" }),
        claude("out", { status: "signed_out" }),
        claude("only", { ...walter, serves: "owner" }),
        claude("solo", { ...walter, shared: false, usedByIds: ["ag_other"] }),
        claude("mine-only", { serves: "owner" }),
        claude("free", { ...walter, shared: false, usedByIds: [] }),
      ]),
    ).toEqual(["own1", "mine-only"]);
  });

  test("the right hand: its person's own AI goes on with that person's accounts only, the workspace's never shows a chain", () => {
    const accounts = [
      claude("own1", { mine: true }),
      claude("w1", { ...walter }),
      claude("mine-only", { mine: true, ownerId: "u_viewer", serves: "owner" }),
    ];
    expect(chainOf(accounts, { scope: "mine" })).toEqual(["own1", "mine-only"]);
    expect(chainOf(accounts, { scope: "workspace" })).toEqual(["own1"]);
    // Its person's AI on a plan someone else gave them waits for that plan.
    expect(chainOf(accounts, { scope: "mine", account: "w1" })).toEqual(["w1"]);
  });

  test("pinned, a key, or a kind that never moves: its own account alone; none without one", () => {
    const accounts = [claude("own1"), claude("own2")];
    expect(chainOf(accounts, { pinned: true })).toEqual(["own1"]);
    expect(chainOf([claude("own1", { provider: "zai" }), claude("own2", { provider: "zai" })])).toEqual(["own1"]);
    expect(chainOf([claude("own1", { kind: "antigravity" }), claude("own2", { kind: "antigravity" })])).toEqual([
      "own1",
    ]);
    expect(chainOf(accounts, { account: null })).toEqual([]);
  });

  test("at its own account's limit it waits only when no other account of its chain has room", () => {
    const limited = new Set(["own1", "own2"]);
    const full = (a: { id: string }) => limited.has(a.id);
    expect(chainHasRoom([claude("own1"), claude("own2"), claude("w1", walter)], full)).toBe(true);
    expect(chainHasRoom([claude("own1"), claude("own2")], full)).toBe(false);
    expect(chainHasRoom([claude("own1")], full)).toBe(false);
    expect(chainHasRoom([], full)).toBe(false);
  });

  test("Subir and Descer: the next place, none at either end", () => {
    const order = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderStep(order, "b", -1)).toBe(0);
    expect(orderStep(order, "b", 1)).toBe(2);
    expect(orderStep(order, "a", -1)).toBeNull();
    expect(orderStep(order, "c", 1)).toBeNull();
    expect(orderStep(order, "x", 1)).toBeNull();
  });

  test("an account signed in once per agent is one place: its logins move together, a step passes a whole account", () => {
    // Walter's Team signed in three times (t1-t3, one apart), then Ada's, then Bia's.
    const order = [
      { id: "t1", sameAs: "t1" },
      { id: "t2", sameAs: "t1" },
      { id: "ada", sameAs: "ada" },
      { id: "t3", sameAs: "t1" },
      { id: "bia", sameAs: "bia" },
    ];
    expect(orderAccounts(order).map((b) => b.map((a) => a.id))).toEqual([["t1", "t2", "t3"], ["ada"], ["bia"]]);
    // A place is an account's: Ada's up is first, Team's down is past Ada, Bia's up passes all of Team's logins at once.
    expect(orderStep(order, "ada", -1)).toBe(0);
    expect(orderStep(order, "t2", 1)).toBe(1);
    expect(orderStep(order, "t3", -1)).toBeNull();
    expect(orderStep(order, "bia", -1)).toBe(1);
    expect(orderStep(order, "bia", 1)).toBeNull();
    expect(orderDrop(order, "bia", "t2", "before")).toBe(0);
    expect(orderDrop(order, "t1", "bia", "after")).toBe(2);
    expect(orderDrop(order, "t1", "t3", "after")).toBeNull();
  });

  test("an account has a place when one of its logins does, and one number for all of them", () => {
    // Walter's Team: t2 is signed out (no place of its own), still one account with t1. Bia's only login has no place.
    const order = [
      { id: "t1", sameAs: "t1" },
      { id: "ada", sameAs: "ada" },
      { id: "t2", sameAs: "t1", movable: false },
      { id: "bia", sameAs: "bia", movable: false },
    ];
    expect(orderPlaces(order)).toEqual([1, 2, null]);
    expect(orderStep(order, "t2", 1)).toBe(1);
    expect(orderStep(order, "ada", 1)).toBeNull();
    expect(orderStep(order, "bia", -1)).toBeNull();
    expect(orderDrop(order, "ada", "bia", "before")).toBeNull();
    // The server moves an account by a login with a place: t2's row moves by t1.
    expect(orderMover(order, "t2")).toBe("t1");
    expect(orderMover(order, "ada")).toBe("ada");
  });

  test("a CLI login by API key is never a next account: the server says so with `movable`", () => {
    expect(chainOf([claude("own1"), claude("cli-key", { movable: false }), claude("own2")])).toEqual(["own1", "own2"]);
  });

  test("only accounts a run may move to have a place: the others keep their row with no number, and no Subir or Descer", () => {
    const order = [{ id: "a" }, { id: "solo", movable: false }, { id: "b" }, { id: "out", movable: false }];
    expect(orderPlaces(order)).toEqual([1, null, 2, null]);
    expect(orderStep(order, "a", 1)).toBe(1);
    expect(orderStep(order, "b", -1)).toBe(0);
    expect(orderStep(order, "b", 1)).toBeNull();
    expect(orderStep(order, "solo", -1)).toBeNull();
  });
});

describe("a batch removal takes only what the viewer may remove (`removableLogins`)", () => {
  const grok = (id: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { kind: "grok", label: "Grok", provider: null, keyHint: null, email: "ana@acme.com", ...over });

  test("every login of that kind the viewer owns, on every computer", () => {
    const accounts = [grok("g1"), grok("g2", { machineId: "m2" }), grok("g3", { usedBy: ["Ada"] })];
    expect(removableLogins(accounts, "grok").map((a) => a.id)).toEqual(["g1", "g2", "g3"]);
  });

  test("never another person's, never another program's, and nothing of another kind", () => {
    const accounts = [
      grok("mine"),
      grok("adas", { ownerId: "u_ada", ownerName: "Ada", mine: false }),
      login("chatgpt", { kind: "codex", label: "ChatGPT", provider: null, keyHint: null }),
      login("glm"),
    ];
    expect(removableLogins(accounts, "grok").map((a) => a.id)).toEqual(["mine"]);
    expect(removableLogins(accounts, "codex").map((a) => a.id)).toEqual(["chatgpt"]);
    expect(removableLogins([], "grok")).toEqual([]);
  });
});

describe("an account's sign-ins, read from every login of it", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    o ? `${key}(${Object.values(o).join(",")})` : key) as unknown as TFunction;
  const team = (id: string, over: Partial<MachineAccount> = {}) =>
    login(id, { provider: null, keyHint: null, email: "ana@example.com", ...over });

  test("one login of several signed out says whose sign-in ended and is the one signed in again", () => {
    const [g] = groupPlans([
      team("a1", { usedBy: ["Theo"], shared: true }),
      team("a2", { usedBy: ["Ada"], status: "signed_out" }),
    ]);
    if (!g) throw new Error("group");
    expect(signInNote(t, g, false)).toEqual({ state: "out", text: "aiAccounts.page.signedOutFor(1,format.list(Ada))" });
    expect(againLogin(g)?.id).toBe("a2");
  });

  test("every login out says the account is signed out (a key: refused); one unknown says so while none is out", () => {
    const [out] = groupPlans([team("b1", { usedBy: ["Ada"], status: "signed_out" })]);
    const [key] = groupPlans([login("k1", { status: "signed_out", keyHint: "AbCd" })]);
    const [unknown] = groupPlans([
      team("c1", { usedBy: ["Theo"] }),
      team("c2", { usedBy: ["Ada"], status: "signed_out", statusKnown: false }),
    ]);
    const [fine] = groupPlans([team("d1")]);
    if (!out || !key || !unknown || !fine) throw new Error("groups");
    expect(signInNote(t, out, false)).toEqual({ state: "out", text: "aiAccounts.page.signedOut" });
    expect(signInNote(t, key, true)).toEqual({ state: "out", text: "aiAccounts.page.keyRefused" });
    expect(signInNote(t, unknown, false)).toEqual({ state: "unknown", text: "aiAccounts.page.statusUnknown" });
    expect(againLogin(unknown)?.id).toBe("c2");
    expect(signInNote(t, fine, false)).toBeNull();
    expect(againLogin(fine)?.id).toBe("d1");
  });
});

test("an order row of an account signed in once per agent shows its newest reading, not its first login's", () => {
  const old = usage("2026-11-01T10:00:00Z", 90);
  const fresh = usage("2026-11-02T10:00:00Z", 20);
  expect(newestUsage([{ usage: old }, { usage: null }, { usage: fresh }])).toBe(fresh);
  expect(newestUsage([{ usage: null }])).toBeNull();
});
