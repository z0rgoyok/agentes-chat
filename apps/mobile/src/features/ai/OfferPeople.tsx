import { CardVia, type Message, useChangeRole, useMembers, useRoles, useSetMemberRoles } from "@agenteschat/client";
import {
  type MemberChangeRow,
  type MemberChangesCard,
  memberRowDone,
  memberRowNeeds,
  memberRowsBlocked,
  memberRowText,
  rolesAfter,
} from "@agenteschat/client/lib/action-cards";
import { can } from "@agenteschat/client/lib/permissions";
import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, PersonAvatar, Text } from "@/ui";
import { AskCard } from "../chat/asks";
import { useRemoveFlow } from "../members/MembersPage";
import { useFailed } from "../routines/hooks";
import { OfferShell } from "./OfferShell";

/**
 * The right hand's people card (ADR 0137 §4), as on the web: a row per person and change ("Ganha Dono", "Perde
 * Vendas", "Remover do workspace"), each applied with the members screen's own call as whoever taps, removal through
 * that screen's confirmation. Who can't reads who may. `message`: the card's own, so each change is audited as made
 * from it.
 */
export function OfferPeople({ card, message }: { card: MemberChangesCard; message?: Message }) {
  // Without its message a card still gets an id of its own: two cards about one person never share one.
  const own = useId();
  const rows = <People card={card} id={message?.id ?? `people:${own}`} agentId={message?.author.id ?? ""} />;
  return message ? <CardVia messageId={message.id}>{rows}</CardVia> : rows;
}

function People({ card, id, agentId }: { card: MemberChangesCard; id: string; agentId: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const members = useMembers(orgId);
  const known = useRoles(orgId);
  const roles = known.data?.roles ?? [];
  const change = useChangeRole(orgId);
  const setRoles = useSetMemberRoles(orgId);
  const remove = useRemoveFlow();
  const failed = useFailed();
  // A card read while it had rows to apply stays that card once they are done: only one found done is the short pill.
  const shown = useRef(false);
  // What is done, and who may apply what, is read from the members list, and a row names the roles it gives or takes:
  // nothing to draw, and nothing to apply, before both are here.
  const people = members.data;
  if (!people || !known.isSuccess) return null;
  const title = t("rightHand.people.title");
  const done = (r: MemberChangeRow) => memberRowDone(r, people);
  const may = (r: MemberChangeRow) => can(org, memberRowNeeds(r, people));
  const open = card.rows.filter((r) => !done(r));
  const over = open.length === 0;
  if (!over) shown.current = true;
  if (over && !shown.current) {
    const names = [...new Set(card.rows.map((r) => r.name))].join(", ");
    return (
      <OfferShell
        icon="members"
        title={title}
        why={card.why}
        done={`${t("rightHand.people.done")}: ${names}`}
        action={null}
        onAction={() => {}}
        blocked=""
      />
    );
  }
  const busy = change.isPending || setRoles.isPending;
  const apply = (r: MemberChangeRow) => {
    if ("remove" in r) return void remove({ userId: r.userId, name: r.name });
    if ("role" in r) return change.mutate({ userId: r.userId, role: r.role }, { onError: failed });
    // Roles are set whole, from their roles as listed now.
    const now = people.find((p) => p.userId === r.userId)?.roleIds ?? [];
    setRoles.mutate({ userId: r.userId, roleIds: rolesAfter(r, now) }, { onError: failed });
  };
  const mine = open.some(may);
  return (
    <AskCard
      id={id}
      kind="proposal"
      agentId={agentId}
      waitsFor={mine ? "you" : null}
      lead={card.why || title}
      well={{ tile: <Icon name="members" size={16} />, title }}
      ended={over}
      body={
        <View style={styles.rows}>
          {card.rows.map((r) => {
            const what = memberRowText(t, r, (roleId) => roles.find((x) => x.id === roleId)?.name);
            const email = people.find((p) => p.userId === r.userId)?.email;
            const acting =
              (change.isPending && change.variables?.userId === r.userId) ||
              (setRoles.isPending && setRoles.variables?.userId === r.userId);
            return (
              <View key={`${r.userId}:${what}`} style={styles.row}>
                <View style={styles.who}>
                  <PersonAvatar name={r.name} size={20} />
                  <Text variant="subhead" tone="ink" style={styles.name}>
                    {r.name}
                  </Text>
                </View>
                {/* Their email too: a display name alone can be anyone's (the card may follow what someone else wrote). */}
                {email ? (
                  <Text variant="footnote" tone="faint">
                    {email}
                  </Text>
                ) : null}
                <View style={styles.act}>
                  <Text variant="footnote" tone="muted" style={styles.fill}>
                    {what}
                  </Text>
                  {done(r) ? (
                    <Text variant="footnote" tone="muted">
                      {t("rightHand.people.done")}
                    </Text>
                  ) : may(r) ? (
                    <Button
                      variant={"remove" in r ? "secondary" : "primary"}
                      size="card"
                      label={"remove" in r ? t("members.remove.item") : t("rightHand.card.apply")}
                      loading={acting}
                      disabled={busy}
                      onPress={() => apply(r)}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
          {/* Whole under the rows: the top line would cut it. */}
          {over || mine ? null : (
            <Text variant="footnote" tone="muted">
              {t(memberRowsBlocked(open, may))}
            </Text>
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  rows: { gap: 12 },
  row: { gap: 4 },
  // The face on the name's line, the address and the change full width under them: never a column beside the words.
  who: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, minWidth: 0, fontWeight: "600" },
  act: { flexDirection: "row", alignItems: "center", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
});
