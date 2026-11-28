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

test("the agents' row before a reply: the names give way to nothing but the subject, how it went never cut", () => {
  const group = readFileSync(join(import.meta.dir, "../../src/features/chat/ConsultGroup.tsx"), "utf8");
  const row = group.slice(group.indexOf("export function ConsultPairRow("));
  expect(row).toContain('name: { fontWeight: "600", flexShrink: 1 },');
  expect(row).toContain("whole: { flexShrink: 0 },");
  expect(row).toContain('<Text variant="footnote" tone="faint" numberOfLines={1} style={row.whole}>');
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

test("an agent's reply that passes on another agent's words quotes them, and their bubble folds away", () => {
  const relay = readFileSync(join(import.meta.dir, "../../src/features/chat/RelayQuote.tsx"), "utf8");
  // The same plate as the pair's quote, opening the two agents' conversation.
  expect(relay).toContain("style={({ pressed }) => [quote.box,");
  expect(relay).toContain("router.push(consultationHref(consultation.id, channelId))");
  const rows = readFileSync(join(import.meta.dir, "../../src/features/chat/screen/useChatRows.ts"), "utf8");
  expect(rows).toContain("relayedAnswers(");
  expect(rows).toContain("relays.relayed.has(m.id)");
  const row = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");
  expect(row).toContain("<RelayQuote relay={relay} channelId={m.channelId} />");
  expect(row).toContain("c.id !== relay?.consultation.id");
});
