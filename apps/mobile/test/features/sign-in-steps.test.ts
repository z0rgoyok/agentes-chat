import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (file: string) => src(file).replace(/\s+/g, " ");

describe("the screens before the app never leave anyone without a way on", () => {
  test("the e-mail step: Continue is on screen with the keyboard up or down, gray until the address is whole", () => {
    const flow = flat("features/auth/AuthFlow.tsx");
    // Never hidden behind whether the keyboard is up: spinning while the lookup runs, off until the address is whole.
    expect(flow).not.toContain("useKeyboardState");
    expect(flow).toContain(
      '<LastUsed on={lastWay === "email"}> <Button variant="primary" wide label={t("auth.flow.continue")} loading={pending} disabled={!ready} onPress={submit} /> </LastUsed>',
    );
  });

  test("asking to join by a link, typed: name, then e-mail, then the note, with the bar over the keyboard", () => {
    const screen = flat("features/auth/InviteScreen.tsx");
    expect(screen).toContain(
      'returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => emailField.current?.focus()}',
    );
    expect(screen).toContain(
      'returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => noteField.current?.focus()}',
    );
    expect(screen).toContain('toolbar={view.state === "form"}');
    // Joining by an e-mail's invitation spins in its button.
    expect(screen).toContain(
      'label={personal ? t("invite.enterPersonal") : t("mobile.invite.accept", { org })} loading={joining}',
    );
  });

  test("a new password's link: only the link itself expired says so, anything else keeps the form", () => {
    const reset = flat("features/auth/ResetPasswordScreen.tsx");
    expect(reset).toContain('const LINK_GONE = new Set(["INVALID_TOKEN", "USER_NOT_FOUND"]);');
    expect(reset).toContain('if (refused.code && LINK_GONE.has(refused.code)) setState("expired");');
    expect(reset).toContain(
      'else setError(refused.status ? refusalText(t, refused) : t("mobile.auth.errors.network"));',
    );
    expect(reset).toContain('setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));');
    // The thrown case never says the link expired.
    const thrown = reset.slice(reset.indexOf("} catch (e) {"), reset.indexOf("} finally {"));
    expect(thrown).not.toContain('setState("expired")');
    // A way out on every state, as a connect link has: no back drawn on the sky (the system's is there when a screen
    // is under it), and "Not now" on the form, the sign-in on the others.
    expect(reset).toContain('const leave = () => landOn(session.signedIn ? "/" : "/sign-in");');
    expect(reset).not.toContain("onBack=");
    expect(reset).toContain('{pending ? null : <Quiet label={t("mobile.auth.connect.notNow")} onPress={leave} />}');
    expect(reset.match(/label=\{t\("mobile\.reset\.toSignIn"\)\} onPress=\{toSignIn\}/g)?.length).toBe(2);
  });

  test("the link's three steps keep one sky, each on its own screen", () => {
    const first = flat("features/auth/LinkSteps.tsx");
    expect(first).toContain('sky="low"');
    // The code and the person, pushed over the e-mail: the same low sky, so nothing jumps from one to the next.
    const steps = src("features/auth/InviteSteps.tsx");
    const code = steps.slice(
      steps.indexOf("export function InviteCode("),
      steps.indexOf("export async function sendJoinCode("),
    );
    const you = steps.slice(steps.indexOf("export function InviteYou("), steps.indexOf("function ResendLine("));
    expect(code).toContain('sky="low"');
    expect(you.match(/sky="low"/g)?.length).toBe(2);
  });

  test("busy buttons keep their words and spin", () => {
    const down = flat("features/server/ServerDown.tsx");
    expect(down).toContain('label={t("mobile.auth.server.down.tryNow")} loading={down.checking}');
    expect(down).not.toContain('down.checking ? t("mobile.auth.server.checking")');
  });
});

describe("signing in with Apple, Google or GitHub", () => {
  const social = flat("ui/auth/SocialButtons.tsx");

  test("one sign-in at a time, the system's Apple button included, and the one on its way spins", () => {
    expect(social).toContain("const [pending, setPending] = useState<SignInProvider | null>(null);");
    // Apple's own button can't be turned off: its press is dropped while another is out, and it is dimmed meanwhile.
    expect(social).toContain(
      "const appleNative = async () => { // The system's button can't be turned off: a second press while a sign-in is out is dropped here. if (busy) return;",
    );
    expect(social).toContain('pointerEvents={busy ? "none" : "auto"}');
    expect(social).toContain('{pending === "apple" ? ( <View style={styles.appleSpinner}');
    expect(social).toContain("loading={pending === p}");
    expect(social).toContain('loading={pending === "apple"}');
  });

  test('"Last used" is written only once a sign-in worked', () => {
    for (const [way, success] of [
      [
        "browser",
        'else { // "Last used" names a way that worked, never one that was only tried. rememberSignIn(provider);',
      ],
      ["apple", 'else { rememberSignIn("apple"); onSignedIn?.(); }'],
    ] as const)
      expect({ way, after: social.includes(success) }).toEqual({ way, after: true });
    // Never before the answer.
    const browser = social.slice(social.indexOf("const browser = async"), social.indexOf("const appleNative"));
    expect(browser.indexOf("rememberSignIn(provider)")).toBeGreaterThan(browser.indexOf("socialReturnText("));
  });
});

describe("the first run", () => {
  test("picking up where it was left: the steps' sky with the right hand at work, never a bare screen", () => {
    const flow = flat("features/onboarding/OnboardingFlow.tsx");
    const resume = flow.slice(flow.indexOf("if (!me.data || !known ||"), flow.indexOf("const submit = () =>"));
    expect(resume).toContain('<AuthScaffold sky="low" {...(failed ? { title: failed } : {})} agent={lodiLook}');
    expect(resume).toContain('agentMode={failed ? "idle" : "run"}');
    expect(resume).not.toContain("<View");
    // With no question yet, the scaffold draws its bones in the title's place.
    const scaffold = src("ui/auth/AuthScaffold.tsx");
    expect(scaffold).toContain("{title === undefined ? (");
    expect(scaffold).toContain("<QuestionBones />");
  });

  test("the time zone comes in the app's sheet, its list drawn only while the sheet is up", () => {
    const flow = src("features/onboarding/OnboardingFlow.tsx");
    expect(flow).not.toContain("<Modal");
    expect(flow).toContain("<ZoneSheet");
    const account = src("features/me/AccountPage.tsx");
    const sheet = account.slice(account.indexOf("export function ZoneSheet("), account.indexOf("function ZonePicker("));
    expect(sheet).toContain("<Sheet");
    expect(sheet).toContain("{shown ? <ZoneSheetRows value={value} query={query} onPick={onPick} /> : null}");
    expect(sheet).toContain("<SearchField");
  });
});
