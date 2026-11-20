import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { railSteps } from "@agenteschat/client/lib/onboarding";
import {
  endOnboarding,
  isPushedStep,
  isRootPage,
  nextStep,
  ONBOARDING_ROUTE,
  onboardingNow,
  openOnboarding,
  stepHref,
  stepsBetween,
  updateOnboarding,
} from "../../src/features/onboarding/draft";

/*
 * The first run is real navigation (ADR 0162): each step a screen of its own pushed on the native stack, the system's
 * back (its button and the edge swipe) going to the step before, the answers the steps share in a small store. The
 * screens are components the tests can't render: what they wire in, as text.
 */
const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the first run's steps are screens on the stack", () => {
  test("each step has its own address, and only the phone's steps are pushed", () => {
    expect(stepHref("business")).toBe(`${ONBOARDING_ROUTE}/business`);
    expect(["name", "business", "team", "plan"].every(isPushedStep)).toBe(true);
    for (const other of ["purpose", "you", "ai", "people", "", undefined, ["team"]])
      expect({ other, pushed: isPushedStep(other) }).toEqual({ other, pushed: false });
    // The app's start has nothing under it to go back to: only its own param says so.
    expect(isRootPage({ root: "1" })).toBe(true);
    expect(isRootPage({})).toBe(false);
    expect(isRootPage(undefined)).toBe(false);
  });

  test("a visit picked up again has the steps before it under it; Continue pushes the next one", () => {
    const team = railSteps({ plan: true, ai: false, personal: false });
    expect(team).toEqual(["name", "business", "team", "plan"]);
    // Left at the team's step: what it does and the team go over its name, so back walks them.
    expect(stepsBetween(team, "name", "team")).toEqual(["business", "team"]);
    expect(stepsBetween(team, "name", "plan")).toEqual(["business", "team", "plan"]);
    // Nothing to push when it is at its name, or opens now.
    expect(stepsBetween(team, "name", "name")).toEqual([]);
    expect(stepsBetween(team, "name", "open")).toEqual([]);
    expect(nextStep(team, "name")).toBe("business");
    expect(nextStep(team, "team")).toBe("plan");
    // No plan to wait for: after the team, the workspace opens instead of another step.
    expect(nextStep(railSteps({ plan: false, ai: false, personal: false }), "team")).toBeNull();
  });

  test("the answers live while the flow does: a page ends only its own, and says how it ended", () => {
    const leave = () => {};
    const first = openOnboarding({ another: null, leave });
    updateOnboarding({ name: "Acme", purpose: "team" });
    expect(onboardingNow()).toMatchObject({ id: first.id, name: "Acme", purpose: "team", finishing: false });
    // A flow opened meanwhile (back from one and in again before its page slid away) isn't ended by the old page.
    const second = openOnboarding({ another: "Old", leave: null });
    expect(endOnboarding(first.id)).toBeNull();
    expect(onboardingNow()?.id).toBe(second.id);
    updateOnboarding({ finishing: true });
    expect(endOnboarding(second.id)).toMatchObject({ id: second.id, finishing: true });
    expect(onboardingNow()).toBeNull();
    // Nothing changes once it has ended.
    updateOnboarding({ name: "Late" });
    expect(onboardingNow()).toBeNull();
  });

  test("the flow pushes its steps and never swaps them in place or draws a back of its own", () => {
    const flow = read("src/features/onboarding/OnboardingFlow.tsx");
    for (const fake of ["setPicked", "onBack", "usePreventRemove", "forTeam", 'icon="back"'])
      expect({ fake, found: flow.includes(fake) }).toEqual({ fake, found: false });
    // Continue on each step pushes the next one; a company or team's first question pushes its name.
    expect(flow).toContain("if (next) router.push(stepHref(next));");
    expect(flow).toContain('if (purpose === "team" || answered) router.push(stepHref("name"));');
    expect(flow).toContain("if (orgName && !pending) void save(advance);");
    expect(flow).toContain("onCreated={advance}");
    expect(read("src/features/onboarding/steps.tsx")).toMatch(/setFailed\(null\);\s+onCreated\(\);/);
    // A visit picked up again: its earlier steps pushed in place, each sliding back once it is on screen.
    expect(flow).toContain(
      'for (const later of stepsBetween(steps, "name", at)) router.push(stillHref(stepHref(later)));',
    );
    expect(flow).toContain("router.setParams({ [STILL_PARAM]: undefined })");
    // The shared answers are the store's, so a step pushed again finds them.
    expect(flow).not.toMatch(/useState<WorkspaceMode|useState<BusinessType|const \[name, setName\] = useState/);
  });

  test("finishing leaves the whole flow; back from the first page goes where it was opened from", () => {
    const flow = read("src/features/onboarding/OnboardingFlow.tsx");
    // Opening the workspace takes every step down at once, then opens it over where the app starts.
    const open = flow.slice(flow.indexOf("const open = ("), flow.indexOf("const advance = ("));
    expect(open).toContain("updateOnboarding({ finishing: true });");
    expect(open.indexOf('router.dismissTo("/");')).toBeLessThan(open.indexOf("router.push(chatHref("));
    expect(open).toContain("updateOnboarding({ finishing: false });");
    // The first page ends the answers as it leaves; leaving by back (not by opening) tells where it came from.
    expect(flow).toContain("const ended = endOnboarding(flow.current);");
    expect(flow).toContain("if (ended && !ended.finishing) ended.leave?.();");
    // The app's start: Android's back leaves the app, as on any first screen.
    expect(flow).toContain("BackHandler.exitApp();");
    // A step's address with no first run under way goes back.
    expect(flow).toContain("if (orphan) goBack();");
  });

  test("the root layout pushes the first run over the app, with the system's bar, and takes it down", () => {
    const layout = read("app/_layout.tsx");
    expect(layout).not.toContain("<OnboardingFlow");
    expect(layout).not.toContain("StyleSheet.absoluteFill");
    // Inside the signed-in group: signing out takes the steps down with the app.
    const signedIn = layout.slice(
      layout.indexOf("<Stack.Protected guard={inApp}"),
      layout.indexOf("<Stack.Protected guard={!inApp}"),
    );
    expect(signedIn).toContain('<Stack.Screen name="onboarding/index" options={firstRunOptions} />');
    expect(signedIn).toContain('<Stack.Screen name="onboarding/[step]" options={firstRunOptions} />');
    // The system's back over the sky, none on the app's start.
    expect(layout).toContain("...coverBarOptions,");
    expect(layout).toContain("...(isRootPage(route.params) ? { gestureEnabled: false, headerBackVisible: false");
    expect(layout).toContain("openOnboarding({ another: anotherName, leave: fresh ? newWorkspaceDone : null });");
    expect(layout).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the layout's source
      "router.push(fresh ? ONBOARDING_ROUTE : stillHref(`${ONBOARDING_ROUTE}?${ROOT_PARAM}=1`));",
    );
    // A workspace that opened some other way takes the steps down; the flow's own opening does it itself.
    expect(layout).toMatch(
      /!firstRun && flowId !== null && !finishing && signedIn\) \{\s+endOnboarding\(flowId\);\s+router\.dismissTo\("\/"\);/,
    );
    // The steps are screens under the same accessibility as the app: nothing hides them.
    expect(layout).toContain("const covered = suspendedShown || down !== null || !!accountDeletion;");
    expect(read("app/onboarding/index.tsx")).toContain("<OnboardingPage />");
    expect(read("app/onboarding/[step].tsx")).toContain("<OnboardingPage step={isPushedStep(step) ? step : null} />");
  });
});
