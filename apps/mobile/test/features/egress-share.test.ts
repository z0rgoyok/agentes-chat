import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("a computer's page on the phone: its internet for the agents, as the web's (ADR 0237)", () => {
  const computer = flat("features/devices/ComputerSection.tsx");
  // Shown where there is something to lend to, and to whoever may change it or while it is on.
  expect(computer).toContain("d.shareInternet && (d.mayManage || sharing)");
  expect(computer).toContain('label={t("devices.shareInternet")}');
  expect(computer).toContain("sub={shareInternetText(t, d, lending) ?? undefined}");
  // What goes through it depends on the server: all TCP on the Cloud, what follows proxy settings on one's own.
  expect(computer).toContain("text: shareInternetHint(t, auth.data),");
  // Its owner turns it on; an admin may only turn it off.
  expect(computer).toContain("disabled={!d.mayManage || (!mine && !sharing)}");
  // The pending value shows at once; on again picks it first, its owner's alone.
  expect(computer).toContain("(share.isPending ? share.variables : undefined) ?? d.shareInternet?.on ?? false");
  expect(computer).toContain('label={t("devices.shareInternetPick")}');
  expect(computer).toContain("lending !== null && mine");
});

test("use only this computer's internet on the phone: one step in under the switch while it lends, as the web's", () => {
  const computer = flat("features/devices/ComputerSection.tsx");
  expect(computer).toContain(
    "{sharing && d.shareInternet?.only !== undefined && (d.mayManage || onlyLent) ? ( <GroupedRow depth={1}",
  );
  expect(computer).toContain('label={t("devices.shareInternetOnly")}');
  expect(computer).toContain('text: t("devices.shareInternetOnlyHint"),');
  // Its owner turns it on; an admin may only turn it off.
  expect(computer).toContain("disabled={!d.mayManage || (!mine && !onlyLent)}");
  expect(computer).toContain("api.devices.updateComputer(orgId, d.id, { internetOnly: on })");
  // The workspace's computer says when its agents have no internet, and whose computer is offline.
  expect(flat("features/settings/MachineScreen.tsx")).toContain("egressOfflineText(t, m),");
});

test("a borrowing computer on the phone says whose internet its agents use", () => {
  expect(flat("features/settings/MachineScreen.tsx")).toContain("egressViaText(t, m),");
});

test("an offline computer on the phone: plain words, the command that tells why folded under Technical details", () => {
  const screen = flat("features/settings/MachineScreen.tsx");
  expect(screen).toContain(
    'offlineCauseText(t, s.cause, clockAt(i18n.language, s.lastSeenAt), "line", terminalInstall(m))',
  );
  expect(screen).toContain("{m.canManage && doctorShown(s, m) ? (");
  expect(screen).toContain('label={t("devices.technical.title")}');
  expect(screen).toContain("{techOpen ? (");
  expect(screen).toContain("<CommandBlock command={RUNNER_DOCTOR_COMMAND} />");
});

test("the agent's screen on the phone says nothing about what programs there see, with no ⓘ for it", () => {
  const screen = flat("features/computer/AgentScreen.tsx");
  for (const gone of ["desktop.control.notice", "desktop.session.", "useInfoHint", "notice.button"])
    expect(screen).not.toContain(gone);
});

test("letting a computer join on the phone says it will lend its internet, as the web's Let it join does", () => {
  const parts = flat("features/devices/parts.tsx");
  // Where the server says computers lend (a self-hosted server too), not only beside the workspace's own computer,
  // and not for a server box, which borrows (ADR 0237).
  expect(parts).toContain("const lends = joinLends(useDevices().data, os);");
  expect(parts).toContain('t("devices.shareInternetJoin")');
  // The devices list's card and the notice's card both show it.
  expect(parts).toContain("{joinFacts(t, r)} </Text> <JoinInternetLine os={r.os} />");
  expect(flat("features/devices/notices.tsx")).toContain(
    "{joinFacts(t, request)} </Text> <JoinInternetLine os={request.os} />",
  );
});

test("a computer whose runner is behind this server, on the phone: its owner sees why and how to update it, as the web's", () => {
  const screen = flat("features/settings/MachineScreen.tsx");
  expect(screen).toContain("{m.canManage && m.update ? (");
  expect(screen).toContain("machines.runnerBehind.");
  expect(screen).toContain("{ computer: title })");
  expect(screen).toContain('m.update === "command" ? ( <> <Gap /> <CommandBlock command={RUNNER_UPDATE_COMMAND} />');
});

test("a computer waiting on an OS permission, on the phone: the same lines as the web's, under its state", () => {
  const parts = flat("features/devices/parts.tsx");
  expect(parts).toContain("permissionWaitLines(t, need, device.name, agent || undefined)");
  expect(parts).toContain("sub={words.asked ? `$" + "{words.next} $" + "{words.asked}` : words.next}");
  const screen = flat("features/settings/MachineScreen.tsx");
  expect(screen).toContain("{device?.permissions?.length ? ( <> <Gap /> <PermissionWaits device={device} />");
});
