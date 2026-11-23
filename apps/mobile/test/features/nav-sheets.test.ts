import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

/**
 * Real navigation inside sheets: a step of a sheet is a sheet over the one before (the screen's sheet stack, or a
 * `Sheet` presented over a route's sheet), so a flick down goes back a step; never the sheet's content swapped in
 * place with a back drawn in it. The sheets are components the tests can't render: what they wire in, as text.
 */
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("connecting a service: each step a sheet over the one before", () => {
  const sheet = src("connectors/ConnectSheet.tsx");

  test("no step is swapped in place, and no Back is drawn to step back", () => {
    expect(sheet).not.toContain("setStep(");
    expect(sheet).not.toContain("setPhase(");
    expect(sheet).not.toContain('t("common.back")');
  });

  test("Connect, Adjust and Continue push the next step; the address is a step of its own", () => {
    // What it does → connecting.
    expect(sheet).toContain("onPress={() => sheet.push(<ConnectingStep flow={flow} />)}");
    // The address → connecting to it, the address shown there (a flick down goes back to change it).
    expect(sheet).toContain("sheet.push(<ConnectingStep flow={flow} url={address} />);");
    expect(sheet).toContain('if (!item) return <AddressStep flow={flow} initialUrl={url ?? ""} />;');
    // The confirmation → its tools (a catalog service) or who uses it, and its tools → who uses it.
    expect(sheet).toContain(
      "sheet.push(<StepView flow={flow} step={nextOf(flow, from)} connectionId={connectionId} />)",
    );
    expect(sheet).toContain('step === "done" && flow.head.steps.includes("review") ? "review" : "who"');
    // Every step repeats the service's head and its place among the steps.
    expect(sheet.match(/<StepHead\b/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("the address field lives only on its step; connecting reads the address it was handed", () => {
    expect(sheet.match(/t\("mobile\.connectors\.addressLabel"\)/g)).toHaveLength(2);
    const address = sheet.slice(sheet.indexOf("function AddressStep("), sheet.indexOf("function ConnectingStep("));
    expect(address).toContain('accessibilityLabel={t("mobile.connectors.addressLabel")}');
    const connect = sheet.slice(sheet.indexOf("function ConnectStep("));
    expect(connect).not.toContain("useState(initialUrl");
    expect(connect).toContain('url = "",');
  });

  test("connecting ends on its own step's confirmation, and Done closes every step", () => {
    const connecting = sheet.slice(sheet.indexOf("function ConnectingStep("), sheet.indexOf("function DoneStep("));
    expect(connecting).toContain("onConnected={(id, name) => setConnected({ id, name })}");
    expect(connecting).toContain("onDone={sheet.close}");
    const who = sheet.slice(sheet.indexOf("function WhoStep("));
    expect(who).toContain(
      '<Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />',
    );
  });
});

// A request's Refuse, denying a join request, Remind me's time and the team templates: covered where those
// screens are (`sweep2-work`, `settings-sweep2`, `agents-checklist` tests).

describe("Remind me: the quick times' way back is gone", () => {
  test("the quick times' way back is gone from both languages", () => {
    for (const tree of [featureKeysEn, featureKeysPtBR]) expect("quick" in tree.remind).toBe(false);
  });
});

describe("no back drawn in a sheet's bar or as a row", () => {
  test("Add workspace closes with ×, over the list it came from", () => {
    expect(src("me/WorkspacesPages.tsx")).toContain('<SheetHeader title={t("mobile.me.addWorkspace")} />');
    const parts = src("new/parts.tsx");
    expect(parts).not.toContain('icon?: "x" | "back"');
    expect(parts).toContain("<SheetBar inset title={title} onClose={onPress ?? (() => goBack())} />");
  });

  test("a gone cargo says so, and the bar's back is the way out", () => {
    const gone = src("roles/parts.tsx");
    expect(gone).not.toContain("backToList");
    expect(gone).not.toContain('icon="back"');
    for (const tree of [featureKeysEn, featureKeysPtBR]) expect("backToList" in tree.roles).toBe(false);
  });
});
