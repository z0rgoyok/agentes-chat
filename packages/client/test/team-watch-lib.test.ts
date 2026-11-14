import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import type { AppNotification } from "../src/api/types";
import { openTarget, sortWaiting, TEAM_WATCH_CAUSES, teamWatchOf, waitingCardOf } from "../src/lib/notifications";
import { soundForNotification } from "../src/lib/sounds";
import { teamWatchLine } from "../src/lib/team-watch";

const notice = (latest: AppNotification["latest"], extra: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1",
  kind: "team_watch",
  waiting: true,
  actors: [{ type: "agent", id: "lodi" }],
  count: 1,
  source: {},
  latest,
  readAt: null,
  doneAt: null,
  snoozedUntil: null,
  createdAt: "2026-11-11T15:00:00.000Z",
  updatedAt: "2026-11-11T15:00:00.000Z",
  ...extra,
});

test("the right hand's notice is worded by its cause, with the first names, how many more and how many in all", () => {
  const n = notice({ reason: "connector", names: ["Slack", "Notion", "Linear"], text: "stored" }, { count: 5 });
  expect(teamWatchOf(n)).toEqual({
    cause: "connector",
    key: "notifications.teamWatch.connector",
    names: ["Slack", "Notion", "Linear"],
    count: 5,
    text: "stored",
    act: "notifications.teamWatch.act.reconnect",
  });
  expect(teamWatchOf(notice({ reason: "sign_in", names: ["Work"] }))).toMatchObject({ names: ["Work"], count: 1 });
  expect(teamWatchOf({ ...n, kind: "approval" })).toBeNull();
});

test("its one button names the way out of its cause, and every cause's sentence and button have words", () => {
  const act = (reason: string) => teamWatchOf(notice({ reason, names: ["X"] }))?.act;
  expect(act("sign_in")).toBe("notifications.teamWatch.act.sign_in");
  for (const reason of ["connector", "mailbox", "database"])
    expect(act(reason)).toBe("notifications.teamWatch.act.reconnect");
  for (const reason of ["budget_out", "budget_low"]) expect(act(reason)).toBe("notifications.teamWatch.act.budget");
  expect(act("computer")).toBe("notifications.teamWatch.act.computer");

  const t = i18next.createInstance();
  void t.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const say = (reason: string, names: string[], count = names.length) =>
    teamWatchLine(t.t, notice({ reason, names }, { count }));
  expect(say("sign_in", ["Claude da Ana"])).toBe("O login de Claude da Ana acabou.");
  expect(say("connector", ["Notion"])).toBe("Notion precisa ser reconectado.");
  // Its names are a list in words, and the ones it does not name are counted in words too.
  expect(say("connector", ["Slack", "Notion"])).toBe("Slack e Notion precisam ser reconectados.");
  expect(say("connector", ["Slack", "Notion"], 3)).toBe("Slack, Notion e mais 1 precisam ser reconectados.");
  // A computer's name often holds the word: the sentence does not say it again.
  expect(say("computer", ["Computador da Ana"])).toBe("Computador da Ana está offline com agentes esperando.");
  expect(say("budget_out", ["Ada"])).toBe("O orçamento de Ada acabou.");
  expect(t.t(act("sign_in") ?? "")).toBe("Entrar de novo");
  expect(t.t(act("connector") ?? "")).toBe("Reconectar");
  expect(t.t(act("budget_out") ?? "")).toBe("Aumentar orçamento");
  expect(t.t(act("computer") ?? "")).toBe("Trocar computador");
  // A sentence, never a label with a colon: a full stop ends it, in every language.
  for (const lng of Object.keys(resources)) {
    const tl = i18next.createInstance();
    void tl.init({ lng, fallbackLng: "en", resources, initAsync: false });
    for (const cause of TEAM_WATCH_CAUSES)
      for (const count of [1, 3]) {
        const said = tl.t(`notifications.teamWatch.${cause}`, { names: "X", count });
        expect([lng, cause, said, /[:;—]/.test(said), /[.。]$/.test(said)]).toEqual([lng, cause, said, false, true]);
      }
  }
});

test("a cause this build does not know keeps the server's own sentence", () => {
  const n = notice({ reason: "something_new", names: ["X"], text: "Something new is wrong. Fix it in Settings" });
  expect(teamWatchOf(n)).toMatchObject({
    cause: null,
    key: null,
    text: "Something new is wrong. Fix it in Settings",
    // Its button only opens.
    act: null,
  });
  expect(openTarget(n)).toBeNull();
  expect(waitingCardOf(n)).toMatchObject({ title: "Something new is wrong. Fix it in Settings", action: "open" });
});

test("it opens where it is fixed", () => {
  const section = (name: string): unknown => ({ to: "/org/$orgId/settings/$section", params: { section: name } });
  const open = (n: AppNotification): unknown => openTarget(n);
  expect(open(notice({ reason: "sign_in", names: ["Work"] }))).toEqual(section("usage"));
  for (const reason of ["connector", "mailbox", "database"])
    expect(open(notice({ reason, names: ["X"] }))).toEqual(section("connectors"));
  expect(open(notice({ reason: "budget_out", names: ["Dev"] }, { source: { agentId: "a1" } }))).toEqual({
    to: "/org/$orgId/agents/$agentId",
    params: { agentId: "a1" },
  });
  expect(open(notice({ reason: "budget_low", names: ["Dev", "Ada"] }, { count: 2 }))).toEqual(section("usage"));
  expect(open(notice({ reason: "computer", names: ["Mac"] }, { source: { machineId: "m1" } }))).toEqual({
    to: "/org/$orgId/settings/computers/$machineId",
    params: { machineId: "m1" },
  });
  expect(open(notice({ reason: "computer", names: ["Mac", "PC"] }, { count: 2 }))).toEqual(section("computers"));
});

test("it waits after what an agent asks, sounds once when it waits, and a budget about to end is quiet", () => {
  const found = notice({ reason: "sign_in", names: ["Work"] });
  const question = { ...found, id: "n2", kind: "agent_question" as const, updatedAt: "2026-11-11T10:00:00.000Z" };
  expect(sortWaiting([found, question]).map((n) => n.id)).toEqual(["n2", "n1"]);
  expect(soundForNotification(found, false)).toBe("attention");
  expect(soundForNotification({ ...found, waiting: false }, false)).toBeNull();
});

test("a build from before the kind shows the stored sentence and opens nothing", () => {
  // What `waitingCardOf` and `openTarget` do for any kind they have no case for, as installed builds run them.
  const unknown = {
    ...notice({ reason: "sign_in", names: ["Work"], text: "The sign-in for Work ended." }),
    kind: "kind_of_a_newer_server",
  } as unknown as AppNotification;
  expect(waitingCardOf(unknown).title).toBe("The sign-in for Work ended.");
  expect(openTarget(unknown)).toBeNull();
});
