import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvitationPreview } from "@agenteschat/client";
import {
  endInviteFlow,
  type InviteFlow,
  inviteFlowNow,
  setInviteFlow,
  updateEmailInvite,
  updateLinkInvite,
} from "../../src/features/auth/invite-flow";
import {
  endSignInFlow,
  newSignInFlowId,
  SIGN_IN_STEP_PATH,
  setSignInFlow,
  signInFlowNow,
  signInStepHref,
  stepDepth,
} from "../../src/features/auth/sign-in-flow";

/*
 * The screens before the app (signing in, an invitation's link, a new password's, a connect link, the server and the
 * QR scanner) on real navigation: each step a screen pushed on the native stack, the system's back (the bar's button,
 * the edge swipe) going to the one before, never steps swapped in one screen behind a back drawn on the sky. The
 * screens are components the tests can't render: what they wire in, as text, and the shared drafts themselves.
 */

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const flat = (path: string) => read(path).replace(/\s+/g, " ");
const AUTH = "src/features/auth";
const PAGES = "app/(auth)/(pages)";

describe("signing in: the e-mail, then each step the server asks for, on a screen of its own", () => {
  test("every step has its route, pushed with what the e-mail found out under the flow's id", () => {
    expect(existsSync(join(ROOT, PAGES, "sign-in.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, PAGES, "sign-in/index.tsx"))).toBe(true);
    for (const path of Object.values(SIGN_IN_STEP_PATH)) {
      const file = join(ROOT, PAGES, `${path.slice(1)}.tsx`);
      expect({ path, exists: existsSync(file) }).toEqual({ path, exists: true });
    }
    expect(signInStepHref("password", "f1", 1)).toEqual({
      pathname: "/sign-in/password",
      params: { flow: "f1", depth: "1" },
    });
    expect(signInStepHref("forgot", "f1", 2, "password")).toEqual({
      pathname: "/sign-in/forgot",
      params: { flow: "f1", depth: "2", from: "password" },
    });
    expect([stepDepth("3"), stepDepth(undefined), stepDepth("x"), stepDepth(["2"]), stepDepth("0")]).toEqual([
      3, 1, 1, 2, 1,
    ]);
  });

  test("what the steps share lives while the e-mail's screen is open, and goes with it", () => {
    const id = newSignInFlowId();
    expect(newSignInFlowId()).not.toBe(id);
    expect(signInFlowNow(id)).toBeNull();
    setSignInFlow(id, { start: "in", email: "ana@example.com", options: null });
    expect(signInFlowNow(id)?.email).toBe("ana@example.com");
    endSignInFlow(id);
    expect(signInFlowNow(id)).toBeNull();
    const flow = read(`${AUTH}/AuthFlow.tsx`);
    expect(flow).toContain("useEffect(() => () => endSignInFlow(flow), [flow]);");
    expect(flow).toContain("router.push(signInStepHref(step, flow, 1) as never);");
  });

  test("no step is swapped in place, nor a back drawn on the sky: the stack's clear bar has the system's", () => {
    for (const file of ["AuthFlow.tsx", "SignInSteps.tsx", "EmailSteps.tsx", "LinkSteps.tsx", "InviteSteps.tsx"]) {
      const text = read(`${AUTH}/${file}`);
      expect({ file, swaps: /setStep\(|stepKey=\{step\}|onBack=/.test(text) }).toEqual({ file, swaps: false });
    }
    for (const file of readdirSync(join(ROOT, AUTH))) {
      const text = read(`${AUTH}/${file}`);
      expect({ file, prevents: text.includes("usePreventRemove") }).toEqual({ file, prevents: false });
    }
    const scaffold = read("src/ui/auth/AuthScaffold.tsx");
    expect(scaffold).not.toContain("onBack");
    expect(scaffold).not.toContain('icon="back"');
    const layout = flat(`${PAGES}/_layout.tsx`);
    expect(layout).toContain("...pushed, ...coverBarOptions,");
    expect(layout).not.toContain("headerShown: false");
  });

  test("Use another email goes straight down to the e-mail; sign-up closed takes the name's place", () => {
    const steps = flat(`${AUTH}/SignInSteps.tsx`);
    expect(steps).toContain("toEmail: () => router.dismiss(depth),");
    expect(steps).toContain('if (signUpClosed(refused)) step.replace("closed");');
    expect(steps).toContain('onPress={() => step.push("forgot", "password")}');
    // The link went: the screen says so in its place, and back to signing in is the password's screen or the e-mail.
    expect(steps).toContain('onPress={() => (step.from === "password" ? router.back() : step.toEmail())}');
    // Its pass from the e-mail's lookup still stands for the next request (ADR 0075).
    expect(steps.match(/flow\?\.options\?\.pass,/g)?.length).toBe(3);
  });
});

describe("an invitation's link: its first screen, and each step pushed over it", () => {
  test("every step has its route, beside the link's own", () => {
    expect(existsSync(join(ROOT, "app/invite/[token].tsx"))).toBe(false);
    for (const step of ["index", "new-password", "forgot", "code", "you"]) {
      expect({ step, exists: existsSync(join(ROOT, `app/invite/[token]/${step}.tsx`)) }).toEqual({
        step,
        exists: true,
      });
      // With the clear bar over their sky and the system's back, as the root lists them.
      expect(read("app/_layout.tsx")).toContain(`<Stack.Screen name="invite/[token]/${step}" options={linkOptions} />`);
    }
  });

  test("what the steps share is kept under the token while the first screen is open, each kind its own", () => {
    const preview = { email: "ana@example.com", orgName: "Acme" } as InvitationPreview;
    const email: InviteFlow = {
      kind: "email",
      preview,
      name: "",
      nameError: null,
      joinOnSession: false,
      onSigningIn: () => {},
    };
    setInviteFlow("t1", email);
    updateEmailInvite("t1", { name: "Ana" });
    // A link's patch never lands on an email invitation's flow.
    updateLinkInvite("t1", { email: "other@example.com" });
    expect(inviteFlowNow("t1")).toMatchObject({ kind: "email", name: "Ana" });
    expect(inviteFlowNow("t1")).not.toHaveProperty("email");
    endInviteFlow("t1");
    expect(inviteFlowNow("t1")).toBeNull();
    for (const file of ["EmailSteps.tsx", "LinkSteps.tsx"])
      expect({ file, ends: read(`${AUTH}/${file}`).includes("return () => endInviteFlow(token);") }).toEqual({
        file,
        ends: true,
      });
  });

  test("joining and the wait stay the first screen's: a step signs in or asks, then goes back to it", () => {
    const steps = flat(`${AUTH}/InviteSteps.tsx`);
    expect(steps).toContain("updateEmailInvite(token, { joinOnSession: true }); router.back();");
    expect(steps).toContain("router.back(); flow.onAsked({");
    // Proven, the person's screen takes the code's place: back from it is the e-mail, never a code already typed.
    expect(steps).toContain('router.replace(inviteStepHref(token, "you"));');
    const first = flat(`${AUTH}/EmailSteps.tsx`);
    expect(first).toContain("if (!viaProvider.current && !shared?.joinOnSession) return;");
    expect(first).toContain("if (!session.signedIn || !focused) return;");
  });

  test("a link's screens opened with nothing under them close in words, never a back that isn't one", () => {
    const parts = flat(`${AUTH}/invite-parts.tsx`);
    expect(parts).toContain("if (navigation.canGoBack()) return null;");
    for (const file of ["EmailSteps.tsx", "LinkSteps.tsx", "InviteScreen.tsx", "AskWaiting.tsx"])
      expect({ file, close: read(`${AUTH}/${file}`).includes("<CloseIfFirst />") }).toEqual({ file, close: true });
    for (const route of ["reset-password", "connect"])
      expect(read("app/_layout.tsx")).toContain(`<Stack.Screen name="${route}" options={linkOptions} />`);
    expect(read("app/connect.tsx")).not.toContain("onBack=");
    expect(read("app/connect.tsx")).not.toContain('t("mobile.common.back")');
  });
});

describe("the server's address and the QR scanner", () => {
  test("pushed with the system's back over their sky or the camera, signed out and from Workspaces", () => {
    const scan = read(`${PAGES}/scan.tsx`);
    expect(scan).not.toContain("IconButton");
    expect(scan).not.toContain("onBack=");
    expect(scan).toContain("<Stack.Screen options={OVER_CAMERA} />");
    // Type the address: the address's screen is the one under the scanner.
    expect(scan).not.toContain('router.replace("/server")');
    const main = read("app/(app)/(main)/_layout.tsx");
    expect(main).toContain('"me/team-server": cover,');
    expect(main).toContain('"me/scan": cover,');
    expect(read("src/features/me/WorkspacesPages.tsx")).not.toContain("onBack=");
  });

  test("over the waiting splash, where nothing can be pushed, its window closes with Cancel", () => {
    const address = read("src/features/server/ServerAddress.tsx");
    expect(address).not.toContain("onBack=");
    expect(address).toContain(
      '{onCancel && !busy ? <Quiet label={t("mobile.common.cancel")} onPress={onCancel} /> : null}',
    );
    expect(read("src/features/server/ServerDown.tsx")).toContain("onCancel={() => setSwitching(false)}");
  });
});
