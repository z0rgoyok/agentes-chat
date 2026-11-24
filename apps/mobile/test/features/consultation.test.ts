import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composerRequestFor,
  currentComposerRequest,
  requestComposerText,
  takeComposerRequest,
} from "../../src/features/chat/composer-request";
import { consultationHref } from "../../src/features/links/logic";
import { chatScreenSource } from "./chat-screen-source";

test("two agents' conversation opens on its screen, with the conversation that asked", () => {
  expect(consultationHref("q1", "c1")).toBe("/consultation/q1?channel=c1");
  // A row of one opens as it always did; a row of several carries every question, so each agent is reachable.
  expect(consultationHref("q1", "c1", ["q1"])).toBe("/consultation/q1?channel=c1");
  expect(consultationHref("q2", "c1", ["q1", "q2"])).toBe("/consultation/q2?channel=c1&group=q1,q2");
  const group = readFileSync(join(import.meta.dir, "../../src/features/chat/ConsultGroup.tsx"), "utf8");
  expect(group).toContain("const ids = items.map((x) => x.id);");
  expect(group).toContain("consultationHref(opens, channelId, ids)");
  const route = readFileSync(join(import.meta.dir, "../../app/(app)/consultation/[id].tsx"), "utf8");
  expect(route).toContain('group.split(",").filter(isSafeId)');
});

test("'Falar com o Theo' hands '@theo ' to that conversation's composer, once", () => {
  requestComposerText("c1", "@theo ");
  const asked = currentComposerRequest();
  expect(asked).toMatchObject({ channelId: "c1", text: "@theo " });
  // Only that conversation's screen takes it.
  expect(composerRequestFor(asked, "c1")).toBe(asked);
  expect(composerRequestFor(asked, "c2")).toBeNull();
  // A request that isn't the one waiting leaves it; the one waiting, taken, is gone.
  takeComposerRequest((asked?.at ?? 0) - 1);
  expect(currentComposerRequest()).toBe(asked);
  takeComposerRequest(asked?.at ?? 0);
  expect(currentComposerRequest()).toBeNull();
});

test("the agents' talk quoted in a reply: its head on one line, the subject in up to two, the time never cut", () => {
  const group = readFileSync(join(import.meta.dir, "../../src/features/chat/ConsultGroup.tsx"), "utf8");
  const quoted = group.slice(group.indexOf("export function ConsultQuote("));
  // The head: the agent asked and how it went, on one line; the name gives way, the time never.
  expect(quoted).toContain('name: { fontWeight: "600", flexShrink: 1 },');
  expect(quoted).toContain("how: { flexShrink: 0 },");
  expect(quoted).toContain("{`· $" + "{how}`}");
  // The question's subject in up to two lines under it: what supports a card's title (13 under the names' 15).
  expect(quoted).toContain('<Text variant="footnote" tone="muted" numberOfLines={2}>');
});

test("two agents' conversation is a sheet over the one that asked, as the web's dialog", () => {
  const layout = readFileSync(join(import.meta.dir, "../../app/(app)/_layout.tsx"), "utf8");
  expect(layout).toContain('<Sheet.Screen name="consultation/[id]" options={full} />');
  const screen = readFileSync(join(import.meta.dir, "../../src/features/chat/ConsultationScreen.tsx"), "utf8");
  expect(screen).toContain("<SheetSurface>");
  expect(screen).not.toContain("PushedHeader");
  // A row of several: the sheet is named as the row is and offers each asked agent, saying where it stands.
  expect(screen).toContain("consultChoices(items");
  expect(screen).toContain("t(consultChoiceKey(ch.state, ch.item))");
  expect(screen).toContain("<Segmented");
});

test("the composer names whom it writes to in its placeholder only: no face in an agent's field", () => {
  const composer = readFileSync(join(import.meta.dir, "../../src/ui/Composer.tsx"), "utf8");
  expect(composer).not.toMatch(/\bface\?:/);
  const agentScreen = readFileSync(join(import.meta.dir, "../../src/features/computer/AgentScreen.tsx"), "utf8");
  for (const screen of [chatScreenSource(), agentScreen]) expect(screen).not.toMatch(/\bface[=:]\s*[{<]<?AgentFace/);
});
