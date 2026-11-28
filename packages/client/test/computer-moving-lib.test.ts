import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { ComputerMaintenance, ComputerQueue, ManagedTask, TaskWait } from "../src/api/types";
import { type AgentComputerFacts, entryLine, entryPortrait, entryState } from "../src/lib/agent-computer";
import {
  maintenanceDetails,
  maintenanceLine,
  maintenanceNamed,
  maintenanceShort,
} from "../src/lib/computer-maintenance";
import { queueStatusText, queueView } from "../src/lib/computer-queue";
import { statusDetail, statusLook, statusPill, statusSentence } from "../src/lib/devices";
import { waitCardState } from "../src/lib/machine-outages";
import { taskWaitWords } from "../src/lib/task-manager";

/** The workspace's own computer away while it moves to another server: every place says so, never "offline". */

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
const t = i18n.t as TFunction;
const MOVING = "Moving to a new server… back in a few minutes";

const away = { name: "Acme's computer", online: false, lastSeenAt: "2026-11-24T06:28:00.000Z", paused: null };
const facts = (moving: boolean): AgentComputerFacts => ({
  edition: "cloud",
  held: false,
  setup: null,
  machine: { ...away, moving },
  desktop: null,
  browser: false,
  browserGranted: true,
  handoff: null,
  userId: "me",
  working: false,
});
const words = { edition: "cloud", locale: "en", computer: away.name, lastSeenAt: away.lastSeenAt } as const;
const line = (moving: boolean) =>
  entryLine(t, entryState(facts(moving)), { ...words, person: () => "", step: null, emailPromised: false });

test("the agent's computer entry: moving, dimmed, where it would say it isn't answering", () => {
  expect(entryState(facts(true))).toMatchObject({ kind: "moving", maintenance: { kind: "moving", away: true } });
  expect(line(true)).toBe(MOVING);
  expect(entryPortrait(entryState(facts(true)), null)).toBe("paused");
  expect(entryState(facts(false))).toEqual({ kind: "offline" });
  expect(line(false)).not.toBe(MOVING);
});

test("the device's pill and line", () => {
  const s = { kind: "moving", since: "2026-11-24T06:28:00.000Z" } as const;
  expect(statusPill(t, s)).toBe("Moving servers");
  expect(statusSentence(t, "en", s)).toBe(MOVING);
  expect(statusLook(s)).toBe("preparing");
});

test("a task waiting for it says it moves, back by itself", () => {
  const wait: TaskWait = {
    code: "machine_offline",
    key: null,
    plan: null,
    model: null,
    scope: null,
    percent: null,
    window: null,
    resetsAt: null,
    canContinue: false,
  };
  const task = (w: TaskWait) =>
    ({ runId: "r1", status: "waiting_input", held: "computer_offline", line: null, wait: w }) as ManagedTask;
  expect(taskWaitWords(t, "en", task({ ...wait, moving: true }))?.next).toBe(MOVING);
  expect(taskWaitWords(t, "en", task(wait))?.next).not.toBe(MOVING);
});

test("the chat's waiting card and the computer's line know it moves", () => {
  const outage = {
    machineId: "m1",
    name: away.name,
    platform: "other",
    offlineSince: away.lastSeenAt,
    moving: true,
    agents: [{ agentId: "a1", name: "Ada", brain: "claude_code" as const, waiting: { routines: 0, conversations: 1 } }],
    waitingRuns: 1,
  };
  expect(waitCardState({ machineId: "m1", agentId: "a1" }, [outage], "a1")).toMatchObject({
    kind: "waiting",
    maintenance: { kind: "moving", away: true },
  });
  const queue: ComputerQueue = { machineId: "m1", name: away.name, moving: true, working: [], waiting: [] };
  expect(queueStatusText(t, queueView(queue, "me"), queue)).toBe(MOVING);
  expect(queueStatusText(t, queueView({ ...queue, moving: false }, "me"), { moving: false })).not.toBe(MOVING);
});

/** What we do to it (ADR 0257): each kind in its own words, about when it is back, and the tip's details. */
const NOW = new Date("2026-11-20T14:10:00.000Z");
const restart: ComputerMaintenance = {
  kind: "restarting",
  since: "2026-11-20T14:06:00.000Z",
  eta: "2026-11-20T14:12:00.000Z",
  detail: "unresponsive",
  away: true,
};

test("a restart says so with about when it is back, everywhere it would say offline", () => {
  expect(maintenanceShort(t, restart)).toBe("Restarting");
  expect(maintenanceLine(t, restart, NOW)).toBe("Restarting… back in about 2 min");
  expect(maintenanceNamed(t, restart, "Acme's computer", NOW)).toBe("Acme's computer: Restarting… back in about 2 min");
  expect(maintenanceDetails(t, "en", restart, NOW)).toEqual([
    "It stopped answering, so we restarted it automatically.",
    "Since 2:06 PM",
    "Expected back around 2:12 PM",
    "Messages to its agents wait and go on by themselves when it's back.",
  ]);
  // Past its time: never a time already gone.
  const late = new Date("2026-11-20T14:15:00.000Z");
  expect(maintenanceLine(t, restart, late)).toBe("Restarting… taking a little longer than expected");
  expect(maintenanceDetails(t, "en", restart, late)).not.toContain("Expected back around 2:12 PM");

  const s = { kind: "moving", since: restart.since, maintenance: restart } as const;
  expect(statusPill(t, s)).toBe("Restarting");
  expect(statusDetail(t, "en", s, { now: NOW })).toBe("back in about 2 min");
  expect(statusSentence(t, "en", s, { now: NOW })).toBe("Restarting… back in about 2 min");
  const f = { ...facts(false), machine: { ...away, moving: true, maintenance: restart } };
  expect(entryLine(t, entryState(f), { ...words, person: () => "", step: null, emailPromised: false, now: NOW })).toBe(
    "Restarting… back in about 2 min",
  );
});

test("a move's copy while it works: it may be slower, never away; other kinds and unknown ones have words", () => {
  const copying: ComputerMaintenance = {
    kind: "moving",
    since: restart.since,
    eta: "2026-11-20T14:50:00.000Z",
    detail: "copying",
    away: false,
  };
  expect(maintenanceLine(t, copying, NOW)).toBe("Copying to a new server… it may be slower for about 40 min");
  expect(statusDetail(t, "en", { kind: "ready" }, { now: NOW, maintenance: copying })).toBe("Moving servers");
  expect(statusSentence(t, "en", { kind: "ready" }, { now: NOW, maintenance: copying })).toBe(
    "Copying to a new server… it may be slower for about 40 min",
  );
  expect(maintenanceDetails(t, "en", copying, NOW).at(-1)).toBe("Its agents keep working meanwhile.");
  // Gone mid-copy: its tip says a move, never "while it works".
  expect(maintenanceDetails(t, "en", { ...copying, away: true }, NOW)[0]).toBe("We're moving it to a new server.");
  for (const [kind, short] of [
    ["updating", "Updating"],
    ["converting", "Upgrading disk"],
    ["host_maintenance", "Maintenance"],
    ["a_kind_from_later", "Maintenance"],
  ] as const) {
    expect(maintenanceShort(t, { ...restart, kind, detail: null })).toBe(short);
  }
  expect(maintenanceLine(t, { ...restart, kind: "updating", eta: null, detail: null }, NOW)).toBe(
    "Updating its software… back in a few minutes",
  );
});
