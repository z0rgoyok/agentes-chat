import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("Liberar uma pasta on the phone, as the web's: the app on the computer picks it, the command only folded without the app", () => {
  const screen = flat("features/settings/MachineScreen.tsx");
  expect(screen).toContain("{m.canManage && m.folderPick ? (");
  expect(screen).toContain('label={t("machines.access.pick")}');
  expect(screen).toContain("{ machineId: m.id },");
  // Until a folder comes back from the computer, the line says it waits for the person there.
  expect(screen).toContain('t("machines.access.pickWaiting", { machine: m.name })');
  expect(screen).toContain('label={t("machines.access.grantTerminalMore")}');
});

test("an agent's folder request on the phone opens on the computer where its app runs, as the web's", () => {
  const notices = flat("features/devices/notices.tsx");
  expect(notices).toContain("{computer?.folderPick ? (");
  expect(notices).toContain('label={t("devices.notice.folderOnComputer")}');
  expect(notices).toContain("{ machineId: d.machineId, requestId: d.requestId },");
});

test("each agent's own screen on the phone: only on a Linux computer, never Indisponível on a Mac", () => {
  const screen = flat("features/settings/MachineScreen.tsx");
  expect(screen).toContain('if (!use || m.os !== "linux") return null;');
  expect(screen).not.toContain("desktop.use.linuxOnly");
});
