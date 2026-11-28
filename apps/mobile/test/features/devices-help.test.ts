import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const flat = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

/* Devices as extra capacity (ADR 0233) on the phone, as on the web. */
describe("computers that help when the team's is full or away", () => {
  test("someone else's computer has one switch, which an admin may only turn off and the workspace's switch overrides", () => {
    const page = flat("features/devices/ComputerSection.tsx");
    expect(page).toContain('label={t("devices.spillOwn")}');
    expect(page).not.toContain("devices.spillOthers");
    expect(page).toContain("{brought && !mine && d.mayManage && !d.systemMode ? (");
    expect(page).toContain("toggle={spillOn && !helpOff}");
    expect(page).toContain("disabled={helpOff || !spillOn}");
    expect(page).toContain('sub: t("devices.spillWorkspaceOff")');
  });

  test("its owner makes one choice of three (never, only as backup, first for their agents), as the line offers", () => {
    const page = flat("features/devices/ComputerSection.tsx");
    expect(page).toContain('label={t("devices.helpUse")}');
    expect(page).toContain("{brought && mine && !d.systemMode ? (");
    expect(page).toContain("SPILL_USES.map((next) => ({");
    expect(page).toContain("spill: spillOfUse(next)");
    expect(page).not.toContain("devices.spillFirst");
    const line = flat("features/queue/QueueSheet.tsx");
    expect(line).toContain("SPILL_USES.map((use) => ({");
    expect(line).toContain("checked: use === spillUseOf(d),");
  });

  test("the devices list gives admins the workspace's switch", () => {
    const list = flat("features/devices/DevicesScreen.tsx");
    expect(list).toContain('label={t("devices.helpWorkspace")}');
    expect(list).toContain("api.devices.setHelp(id, on)");
    expect(list).toContain("{admin && list.data ? (");
  });

  test("a reply that thought elsewhere says where and why, and the away computer says who helps meanwhile", () => {
    expect(flat("features/chat/MessageRow.tsx")).toContain("{spilled ? <SpilledLine text={spilled} /> : null}");
    const computer = flat("features/computer/ComputerScreen.tsx");
    expect(computer).toContain('help={withHelping(t, t("agentComputer.state.offlineHelpPlain", g), helping)}');
    expect(computer).toContain("help={withHelping(t, undefined, helping)}");
  });

  test("the line's own computers aren't offered while the workspace's switch is off", () => {
    expect(flat("features/queue/QueueSheet.tsx")).toContain(
      "if (mine.length === 0 || devices.data?.devicesHelp === false) return null;",
    );
  });
});
