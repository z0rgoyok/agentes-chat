import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const screen = readFileSync(join(import.meta.dir, "../../src/features/settings/SkillsScreen.tsx"), "utf8");
const install = screen.slice(
  screen.indexOf("function InstallSkill("),
  screen.indexOf("\nfunction ", screen.indexOf("function InstallSkill(") + 1),
);

describe("Instalar skill › Enviar .zip on the phone, as on the web", () => {
  test("a .zip past the server's limit is refused when picked, with a way to the GitHub link", () => {
    expect(install).toContain("const tooBig = (zip?.size ?? 0) > SKILL_ZIP_BYTES;");
    expect(install).toContain('t("skills.zipTooLarge"');
    expect(install).toContain('label={t("skills.zipUseLink")}');
    expect(install).toContain('onPress={() => setTab("github")}');
    expect(install).toContain('disabled: busy || (tab === "zip" && tooBig)');
  });

  test("on its way it says how much went; Cancelar in the bar and leaving the screen stop it", () => {
    expect(install).toContain("upload: { signal: stopper.signal, onProgress: setSending }");
    expect(install).toContain('t("skills.zipSending"');
    expect(install).toContain('{ label: t("common.cancel"), onPress: () => stop.current?.abort() }');
    expect(install).toContain("useEffect(() => () => stop.current?.abort(), []);");
    // Locked from the moment the file is read for sending, not only once the request is out.
    expect(install).toContain("const busy = action.isPending || sending !== null;");
  });
});
