import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { caches, invalidateOrg } from "../cache";
import { enqueueIndex } from "../search";
import { type Evidence, insertContextItem, itemWords, looksLikeSecret } from "./items";

const { agents, contextItems, contextProposals, organizationMembers, users } = schema;

/**
 * Queued once per workspace by migration 0310: its agents' "## Learned" sections become memory. An agent created,
 * copied, imported or saved with one later moves it then (`createAgent`, `updateAgent`).
 */
export const MOVE_LEARNED_JOB = "memory.move_learned";

const HEADING = /^##\s+Learned\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
/** "Ada: always do X", the way a lesson named who taught it. */
const TAUGHT_BY = /^([^:\n]{1,80}):\s(.+)$/s;

export const hasLearnedSection = (text: string) => text.split("\n").some((l) => HEADING.test(l.trim()));

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * An agent's instructions without their "## Learned" sections (the heading and the bullets right under it), and the
 * lessons those held. A line that isn't a bullet after a blank line, or another heading, ends a section: what a person
 * wrote there stays.
 */
export function splitLearned(text: string): { instructions: string; lessons: string[] } {
  const kept: string[] = [];
  const lessons: string[] = [];
  let inside = false;
  let afterBullet = false;
  for (const line of text.split("\n")) {
    if (HEADING.test(line.trim())) {
      while (kept.length && !kept[kept.length - 1]?.trim()) kept.pop();
      inside = true;
      afterBullet = false;
      continue;
    }
    if (inside) {
      const start = line.trimStart();
      const bullet = /^[-*]\s/.test(start) ? start.slice(2).trim() : "";
      if (bullet) {
        lessons.push(bullet);
        afterBullet = true;
        continue;
      }
      if (!line.trim()) {
        afterBullet = false;
        continue;
      }
      if (afterBullet && !ANY_HEADING.test(line)) {
        lessons[lessons.length - 1] += ` ${line.trim()}`;
        continue;
      }
      inside = false;
      if (kept.length) kept.push("");
    }
    kept.push(line);
  }
  const seen = new Set<string>();
  return {
    instructions: kept.join("\n").trimEnd(),
    lessons: lessons.filter((l) => !seen.has(norm(l)) && seen.add(norm(l))),
  };
}

/**
 * Moves each agent's "## Learned" sections into its memory, once (ADR 0017 §6, amended): a lesson a person accepted
 * from a memory item brings that item back (who taught it and when, as it was); any other becomes the agent's own
 * lesson, from the person who asked for it or accepted it (or the "Name:" it starts with, a member's), dated when it
 * was accepted. The section leaves the instructions, so the prompt carries each lesson once. Idempotent: a workspace
 * with no section left changes nothing. Returns the lessons moved. `only`: just that agent, as the person who saved it
 * wrote the section (they taught a lesson nobody else is on record for).
 */
export async function moveLearnedSections(
  db: Database,
  orgId: string,
  only?: { agentId: string; actorId: string },
): Promise<number> {
  const rows = await db
    .select({ id: agents.id, instructions: agents.instructions })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.deletedAt), only ? eq(agents.id, only.agentId) : undefined));
  const withSection = rows.filter((a) => hasLearnedSection(a.instructions));
  if (withSection.length === 0) return 0;
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));
  const byName = new Map(people.filter((p) => p.name.trim()).map((p) => [norm(p.name), p.id]));
  let moved = 0;
  for (const { id } of withSection) {
    moved += await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ instructions: agents.instructions })
        .from(agents)
        .where(eq(agents.id, id))
        .for("update");
      if (!agent) return 0;
      const { instructions, lessons } = splitLearned(agent.instructions);
      if (instructions === agent.instructions.trimEnd() && lessons.length === 0) return 0;
      const accepted = await tx
        .select()
        .from(contextProposals)
        .where(
          and(
            eq(contextProposals.orgId, orgId),
            eq(contextProposals.agentId, id),
            eq(contextProposals.target, "agent_instructions"),
            eq(contextProposals.status, "accepted"),
          ),
        );
      const itemIds = [...new Set(accepted.flatMap((p) => p.itemIds))];
      const items = itemIds.length
        ? await tx
            .select()
            .from(contextItems)
            .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, itemIds)))
        : [];
      const own = await tx
        .select({ content: contextItems.content })
        .from(contextItems)
        .where(and(eq(contextItems.agentId, id), eq(contextItems.status, "active")));
      const known = new Set(own.map((i) => norm(itemWords(i).text)));
      const stay: string[] = [];
      let n = 0;
      for (const lesson of lessons) {
        if (known.has(norm(lesson))) {
          n++;
          continue;
        }
        const origin = accepted
          .filter((p) => p.diff.split("\n").some((l) => l.startsWith("+") && norm(l.slice(1)) === norm(`- ${lesson}`)))
          .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))[0];
        const item = items.find(
          (i) => origin?.itemIds.includes(i.id) && !i.supersededBy && norm(itemWords(i).text) === norm(lesson),
        );
        if (item) {
          if (item.status !== "active") {
            await tx
              .update(contextItems)
              .set({ status: "active", updatedAt: new Date() })
              .where(eq(contextItems.id, item.id));
            await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: item.id });
          }
        } else {
          const named = TAUGHT_BY.exec(lesson);
          const namedId = named?.[1] ? byName.get(norm(named[1])) : undefined;
          const content = namedId && named?.[2] ? named[2].trim() : lesson;
          // A credential never becomes memory: it stays where a person put it.
          if (looksLikeSecret(content)) {
            stay.push(lesson);
            continue;
          }
          const person = namedId ?? origin?.requestedByUserId ?? origin?.decidedByUserId ?? only?.actorId ?? null;
          const at = origin?.decidedAt ?? null;
          const evidence: Evidence[] = person
            ? [{ type: "human", ref: person, at: (at ?? new Date()).toISOString() }]
            : [];
          const row = await insertContextItem(tx, {
            orgId,
            kind: "lesson",
            scopeType: "agent",
            scopeId: id,
            agentId: id,
            content,
            trust: "high",
            evidence,
            confidence: 0.9,
            createdByKind: person ? "person" : "job",
            createdById: person,
          });
          // It was in the instructions already: it is never proposed for them again.
          await tx
            .update(contextItems)
            .set({ proposedAt: new Date(), ...(at ? { createdAt: at, updatedAt: at } : {}) })
            .where(eq(contextItems.id, row.id));
        }
        known.add(norm(lesson));
        n++;
      }
      const next = stay.length
        ? `${instructions}\n\n## Learned\n${stay.map((l) => `- ${l}`).join("\n")}`
        : instructions;
      if (next !== agent.instructions)
        await tx.update(agents).set({ instructions: next, updatedAt: new Date() }).where(eq(agents.id, id));
      return n;
    });
  }
  caches.contextPresence.delete(`${orgId}:`);
  invalidateOrg(orgId);
  return moved;
}
