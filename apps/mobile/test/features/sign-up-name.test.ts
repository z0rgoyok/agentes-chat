import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikePassword, nameIsPassword } from "@agenteschat/client/lib/text";

/* Every phone flow that makes an account (or a request that becomes one) refuses a password equal to the name. */

const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/features/auth", file), "utf8");
/** The name and the password on one screen: the password is cleared there, with the name in view. */
const SAME_SCREEN = (onward: string) =>
  new RegExp(
    `if \\(nameIsPassword\\(name, password\\)\\) \\{\\s*(?:\\/\\/[^\\n]*\\n\\s*)*setPassword\\(""\\);\\s*setError\\(t\\("auth\\.flow\\.nameIsPassword"\\)\\);\\s*\\} else void ${onward}\\(\\);`,
  );
/** An email invitation's password, on a screen over its name's: back on the name, which says so. */
const BACK_ON_NAME =
  /if \(nameIsPassword\(name, password\)\) \{\s*(?:\/\/[^\n]*\n\s*)*setPassword\(""\);\s*updateEmailInvite\(token, \{ nameError: t\("auth\.flow\.nameIsPassword"\) \}\);\s*router\.back\(\);\s*\} else void signUp\(\);/;

describe("a password typed as the name, on the phone", () => {
  test("signing up: the name and the password on one screen, cleared there before the account", () => {
    const steps = source("SignInSteps.tsx");
    const name = steps.slice(steps.indexOf("export function NameStep("), steps.indexOf("export function ClosedStep("));
    expect(name).toMatch(SAME_SCREEN("signUp"));
    expect(name).toContain("<NameHint name={name} />");
  });

  test("an email invitation: the password's screen sends the person back to the name, which shows why", () => {
    const steps = source("InviteSteps.tsx");
    const password = steps.slice(
      steps.indexOf("export function InviteNewPassword("),
      steps.indexOf("export function InviteForgot("),
    );
    expect(password).toMatch(BACK_ON_NAME);
    const first = source("EmailSteps.tsx");
    expect(first).toContain("const nameError = shared?.nameError ?? null;");
    expect(first).toContain("{shownError ? <ErrorLine error={shownError} /> : <NameHint name={name} />}");
  });

  test("asking through a link: the name and the password on one screen, cleared there before the ask", () => {
    const steps = source("InviteSteps.tsx");
    const you = steps.slice(steps.indexOf("export function InviteYou("), steps.indexOf("function ResendLine("));
    expect(you).toMatch(SAME_SCREEN("ask"));
    expect(you).toContain("<NameHint name={name} />");
  });

  test("what the guard and the hint go by", () => {
    expect(nameIsPassword("Fake#Pass1", "Fake#Pass1")).toBe(true);
    expect(nameIsPassword("Ana Souza", "Fake#Pass1")).toBe(false);
    expect(looksLikePassword("Fake#Pass1")).toBe(true);
    expect(looksLikePassword("Ana 2")).toBe(false);
  });
});
