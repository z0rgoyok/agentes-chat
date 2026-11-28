import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, "../..", file), "utf8");

/*
 * The phone's counterpart of the web's paid moment (ADR 0079): it never sees the billing service's return, so the app
 * checks each workspace it opens (`planHeldNext`, tested in packages/client) and opens a sheet once.
 */
describe("the paid moment on the phone", () => {
  test("the app's own check runs on every screen, and opens a sheet of its own", () => {
    const layout = read("app/(app)/_layout.tsx");
    expect(layout).toContain("usePlanTurnedOn();");
    expect(layout).toContain('<Sheet.Screen name="paid-moment"');
    expect(read("app/(app)/paid-moment.tsx")).toContain("PaidMomentSheet");
  });

  test("its one way on is the web's: Connect an AI while the team has none, else the right hand, known before it shows", () => {
    const sheet = read("src/features/billing/PaidMoment.tsx");
    expect(sheet).toMatch(/thinks === undefined\s*\?\s*null/);
    expect(sheet).toMatch(
      /toConnect\s*\?\s*\{ label: t\("paidMoment\.next\.ai"\), run: \(\) => openConnectAi\(\{\}\) \}/,
    );
    expect(sheet).toContain('t("paidMoment.next.talk", { name: lead.name })');
  });

  test("the web's truth: the plan on (its name never known here), the computer as it is, read before the sheet opens", () => {
    const sheet = read("src/features/billing/PaidMoment.tsx");
    expect(sheet).toContain("title={paidLine(t, null, undefined)}");
    // On, or getting ready (`workspaceComputerOn`, packages/client); none of its own: what the plan gives.
    expect(sheet).toMatch(/const on = workspaceComputerOn\(view, machines\.data\)/);
    expect(sheet).toMatch(
      /on === null\s*\?\s*\(paidRoom\(t, i18n\.language, limits\.data\) \?\? ""\)\s*:\s*paidComputerLine\(t, on, org\?\.role === "owner"\)/,
    );
    // What it says is in hand as it opens: its words never change under the person.
    expect(sheet).toMatch(
      /Promise\.all\(\[[\s\S]*keys\.limits\(orgId\)[\s\S]*keys\.computerSetup\(orgId\)[\s\S]*keys\.machines\(orgId\)[\s\S]*\]\)\.then\(\(\) => router\.push\("\/paid-moment"\)\)/,
    );
    expect(sheet).not.toMatch(/paidMoment\.title|up and running/);
  });
});
