import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const flat = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("the right hand's memory on the phone: its learning switch, Forget all, and the web's two groups", () => {
  const screen = flat("features/memory/MemoryScreen.tsx");
  expect(screen).toContain("{lodi && agent === lodi.id ? <RightHandLearning agentId={lodi.id} /> : null}");
  expect(screen).toContain("onPress={() => setPrefs.mutate({ learnOff: !prefs?.learnOff }, { onError: failed })}");
  expect(screen).toContain('title: t("agentPage.memory.learning.forgetTitle")');
  expect(screen).toContain("forget.mutate(undefined, {");
  expect(screen).toContain("memoryAudienceGroups(justLearned(shown, shown.length))");
  expect(screen).toContain('t("agentPage.memory.learning.onlyYou")');
  expect(screen).toContain('{can(org, "configure") && settings ? (');
});
