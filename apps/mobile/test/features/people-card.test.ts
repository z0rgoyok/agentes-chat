import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src/features", file), "utf8");

test("the people card applies each row as the web does: the shared words and keys, the members' own calls", () => {
  const card = src("ai/OfferPeople.tsx");
  // What a row says, who may apply it and whether it is done come from the helpers the web's card uses.
  for (const helper of ["memberRowText(", "memberRowNeeds(", "memberRowsBlocked(", "memberRowDone(", "rolesAfter("])
    expect(card).toContain(helper);
  expect(card).toContain("change.mutate({ userId: r.userId, role: r.role }, { onError: failed })");
  expect(card).toContain("setRoles.mutate({ userId: r.userId, roleIds: rolesAfter(r, now) }, { onError: failed })");
  // Removal goes through the members screen's confirmation, never straight to the call.
  expect(card).toContain('if ("remove" in r) return void remove({ userId: r.userId, name: r.name });');
  expect(card).not.toContain("useRemoveMember");
  expect(src("members/MembersPage.tsx")).toContain("export function useRemoveFlow()");
  // With its message, each change is audited as made from the card.
  expect(card).toContain("<CardVia messageId={message.id}>");
  // Without it, the card's id is still its own: two cards about one person never share one.
  expect(card).toContain("const own = useId();");
  expect(card).not.toContain("card.rows[0]?.userId");
  // Nothing takes a second press while a change is on its way, and nothing shows before the members list.
  expect(card).toContain("disabled={busy}");
  // A row never offers Aplicar before it can name the roles it gives or takes.
  expect(card).toContain("if (!people || !known.isSuccess) return null;");
});

test("a workspace change's card says who asked, and its tap says which action this app showed", () => {
  const card = src("right-hand/SettingsCard.tsx");
  expect(card).toContain("useDecideActionCard(orgId, { ...where, action: card.params.action })");
  expect(card).toContain('kindNote={asker ? t("audit.behind.person", { name: asker }) : undefined}');
  expect(card).toContain("const asker = mine ? undefined : dir.memberById.get(card.forUserId)?.name;");
  // What only whoever applied it reads (an address that already held an invitation) comes from their tap's answer.
  expect(card).toContain('actionCardDetail(own?.state === "applied" ? own : card, t, i18n.language)');
  // As on the web: a card that deletes says so on its button, and one whose sentence says what happened has no kind
  // line over it.
  expect(card).toContain("label={t(actionCardApplyKey(card))}");
  expect(card).toContain("headless={actionCardSaysDone(card)}");
  expect(src("chat/asks.tsx")).toContain("{headless ? null : (");
});
