import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("Nova tarefa half written: a back swipe asks first, and a task just made leaves without asking", () => {
  // The settings' forms' one guard (below), not one of its own.
  const form = src("features/issues/NewIssueForm.tsx");
  expect(form).toContain('const leave = useUnsavedGuard(title.trim() !== "" || text.trim() !== "");');
  expect(form).not.toContain("usePreventRemove");
  expect(form.indexOf("leave();")).toBeLessThan(form.lastIndexOf("close();"));
});

test("the settings' forms ask before a back swipe drops what was typed, and a finished save leaves without asking", () => {
  // One guard for them all, with an agent's edit's words: "Discard your changes?", Keep editing, Discard.
  const parts = src("features/settings/parts.tsx");
  expect(parts).toContain("usePreventRemove(dirty, ({ repeat }) => {");
  expect(parts).toContain("if (leaving.current) return repeat();");
  expect(parts).toContain('{ text: t("mobile.agentEdit.discard"), style: "destructive", onPress: repeat }');
  // Account: a changed name, @ or zone (Fuso and E-mail open over it and keep the form).
  const account = src("features/me/AccountPage.tsx");
  expect(account).toContain("const leave = useUnsavedGuard(changed);");
  expect(account.indexOf("leave();")).toBeLessThan(account.indexOf("goBack();", account.indexOf("leave();")));
  // A new Vault item, with anything typed in it; saved, it opens its own page without asking.
  const vault = src("features/vault/VaultNewScreen.tsx");
  expect(vault).toContain("const leave = useUnsavedGuard(typed);");
  expect(vault).toContain("leave(); router.replace(vaultHref.item(item.id) as never);");
  // A computer's new name.
  const rename = src("features/settings/MachineScreen.tsx");
  expect(rename).toContain("const leave = useUnsavedGuard(Boolean(m) && name !== null && clean !== m?.name);");
  expect(rename).toContain("leave(); goBack();");
  // Storage's bucket, until it is turned on: then what the form holds is where it starts.
  const storage = src("features/settings/StorageScreen.tsx");
  expect(storage).toContain("useUnsavedGuard(JSON.stringify(form) !== JSON.stringify(base));");
  expect(storage).toContain("setForm(kept); setBase(kept);");
});
