import { describe, expect, test } from "bun:test";
import { en, ptBR } from "@agenteschat/i18n";
import { nextOccurrences } from "@agenteschat/ui/recurrence";
import type { TFunction } from "i18next";
import type { Agent } from "../src/api/types";
import {
  CONNECT_ROUTINES,
  connectRoutineAgents,
  connectRoutineInput,
  connectRoutineMade,
  connectRoutineOf,
  connectRoutineRules,
  connectRule,
  suggestedAgent,
  todayYmd,
} from "../src/lib/connect-routines";
import { ROUTINE_TEMPLATES } from "../src/lib/routine-templates";

const t = ((key: string, values?: Record<string, string>) =>
  values ? `${key} ${Object.values(values).join(" ")}` : key) as unknown as TFunction;

/** The routine an app brings: the test fails here when it brings none. */
const of = (app: string) => {
  const r = connectRoutineOf(app);
  if (!r) throw new Error(`no routine for ${app}`);
  return r;
};
/** Its `n`-th rule in When. */
const ruleOf = (app: string, n: number) => {
  const rule = connectRoutineRules(of(app))[n];
  if (!rule) throw new Error(`no rule ${n} for ${app}`);
  return rule;
};

const agent = (id: string, role: string, extra: Partial<Agent> = {}) =>
  ({ id, name: id, role, canManageRoutines: true, canTalk: true, ...extra }) as Agent;

describe("the routine each app brings", () => {
  test("one per app: a mailbox, a catalog app, none for an app without one", () => {
    expect(connectRoutineOf("mailbox")?.template).toBe("inbox");
    expect(connectRoutineOf("stripe")?.template).toBe("failed");
    expect(connectRoutineOf("abacatepay")?.template).toBe("failed");
    expect(connectRoutineOf("hubspot")?.template).toBe("leads");
    expect(connectRoutineOf("intercom-eu")?.template).toBe("tickets");
    expect(connectRoutineOf("linear")?.template).toBe("late");
    expect(connectRoutineOf("google-calendar")?.template).toBe("dayPlan");
    expect(connectRoutineOf("himetrica")?.template).toBe("traffic");
    expect(connectRoutineOf("posthog")?.template).toBe("traffic");
    expect(connectRoutineOf("notion")).toBeNull();
    expect(connectRoutineOf(null)).toBeNull();
  });

  test("GitHub and Sentry check on a schedule: their events need a webhook connecting doesn't set up", () => {
    expect(connectRoutineOf("github")?.template).toBe("openPrs");
    expect(ruleOf("sentry", 0)).toEqual({
      freq: "daily",
      interval: 1,
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      times: ["09:00", "14:00"],
    });
  });

  test("each is a schedule template with its words and its line, in the source and in pt-BR", () => {
    for (const r of CONNECT_ROUTINES) {
      const template = ROUTINE_TEMPLATES.find((x) => x.key === r.template);
      expect(template?.kind).toBe("schedule");
      for (const strings of [en, ptBR]) {
        expect(strings.connectFlow.routine[r.template]).toContain("{{name}}");
        expect(Object.keys(strings.routines.presets[r.template]).sort()).toEqual(["name", "prompt", "text"]);
      }
    }
  });

  test("an app is in one routine at most", () => {
    const apps = CONNECT_ROUTINES.flatMap((r) => (r.apps === "mailbox" ? ["mailbox"] : [...r.apps]));
    expect(new Set(apps).size).toBe(apps.length);
  });
});

describe("when it runs", () => {
  test("its own rule first, then the others, none twice; each runs", () => {
    const failed = connectRoutineOf("stripe");
    if (!failed) throw new Error("a routine");
    const rules = connectRoutineRules(failed);
    expect(rules[0]).toEqual({
      freq: "daily",
      interval: 1,
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      times: ["10:00"],
    });
    expect(new Set(rules.map((r) => JSON.stringify(r))).size).toBe(rules.length);
    expect(rules).toHaveLength(5);
    for (const r of rules)
      expect(
        nextOccurrences(connectRule(r, "America/Sao_Paulo", "2026-11-25"), new Date("2026-11-25T12:00:00Z"), 1),
      ).toHaveLength(1);
  });

  test("today is the device's calendar day", () => {
    expect(todayYmd(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("who does it", () => {
  test("the first that may run it, whatever its role; nobody: none", () => {
    const agents = connectRoutineAgents([
      agent("lodi", "", { builtin: "right_hand" }),
      agent("a", "Dev"),
      agent("b", "Financeiro"),
    ]);
    expect(suggestedAgent(agents)?.id).toBe("a");
    expect(suggestedAgent([])).toBeNull();
  });

  test("only agents I make routines for and that answer me, still in the team; the right hand last", () => {
    const list = connectRoutineAgents([
      agent("lodi", "Braço direito", { builtin: "right_hand" }),
      agent("mine", "Dev"),
      agent("notMine", "Dev", { canManageRoutines: false }),
      agent("silent", "Dev", { canTalk: false }),
      agent("gone", "Dev", { former: "archived" }),
    ]);
    expect(list.map((a) => a.id)).toEqual(["mine", "lodi"]);
  });
});

describe("what it makes", () => {
  test("its template's name and instructions, in my DM with the agent, on the rule picked", () => {
    const failed = connectRoutineOf("stripe");
    if (!failed) throw new Error("a routine");
    const input = connectRoutineInput(t, failed, {
      agentId: "agent-1",
      rule: ruleOf("stripe", 1),
      timezone: "America/Sao_Paulo",
      today: "2026-11-25",
    });
    expect(input).toEqual({
      name: "routines.presets.failed.name",
      agentId: "agent-1",
      prompt: "routines.presets.failed.prompt",
      target: { type: "dm" },
      trigger: {
        type: "schedule",
        rule: {
          freq: "daily",
          interval: 1,
          byWeekday: ["MO", "TU", "WE", "TH", "FR"],
          times: ["09:00", "14:00"],
          timezone: "America/Sao_Paulo",
          start: "2026-11-25",
          until: null,
          count: null,
        },
      },
      report: "when_new",
    });
  });

  test("a mailbox's names the mailbox it was made for", () => {
    const inbox = connectRoutineOf("mailbox");
    if (!inbox) throw new Error("a routine");
    const input = connectRoutineInput(t, inbox, {
      agentId: "agent-1",
      rule: ruleOf("mailbox", 0),
      timezone: "UTC",
      today: "2026-11-25",
      mailbox: "vendas@acme.example",
    });
    expect(input.prompt).toBe("routines.presets.inbox.prompt connectFlow.routine.mailboxOnly vendas@acme.example");
  });

  test("made already when one of my routines has its name, whatever the case", () => {
    const failed = connectRoutineOf("stripe");
    if (!failed) throw new Error("a routine");
    expect(connectRoutineMade(t, failed, [{ name: "ROUTINES.PRESETS.FAILED.NAME" }])).toBe(true);
    expect(connectRoutineMade(t, failed, [{ name: "Something else" }])).toBe(false);
  });
});
