import { markTerms } from "@agenteschat/client/lib/search-filters";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, EmptyState, GROUPED_ROW, GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace, Face } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useDirectory, useMeId } from "../shared/hooks";
import { chatMatches, mayCreate } from "./logic";

/**
 * Who a conversation can start with, for the words typed: "Agents" and "People", each a grouped list under its
 * header in New's own rows (the face in the rows' 36 column, the name with the words found in it, the role, a
 * chevron), or a line when nobody matches with the way to clear the words. Used by "Chat with…"; the parent lays it
 * out in a column with a gap.
 */
export function ChatTargets({
  q,
  onAgent,
  onPerson,
  onClear,
}: {
  q: string;
  onAgent: (agentId: string) => void;
  onPerson: (userId: string) => void;
  /** Empties the search (a search that found nobody offers it). */
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const typed = q.trim();
  const found = useMemo(
    () => chatMatches(q, dir.agents, dir.memberById.values(), meId),
    [q, dir.agents, dir.memberById, meId],
  );
  return (
    <>
      {/* Each header with its list in one block: the sheet's gap goes between groups, not under a header. */}
      {found.agents.length > 0 ? (
        <View>
          <GroupedHeader>{t("mobile.find.agents")}</GroupedHeader>
          <GroupedList>
            {found.agents.map((a) => (
              <GroupedRow
                key={a.id}
                leading={<AgentFace agentId={a.id} size={GROUPED_ROW.lead} live={false} />}
                label={a.name}
                {...(typed ? { labelParts: markTerms(a.name, [typed]) } : {})}
                {...(a.role?.trim() ? { sub: a.role.trim() } : {})}
                chevron
                onPress={() => onAgent(a.id)}
              />
            ))}
          </GroupedList>
        </View>
      ) : null}
      {found.people.length > 0 ? (
        <View>
          <GroupedHeader>{t("mobile.new.people")}</GroupedHeader>
          <GroupedList>
            {found.people.map((p) => (
              <GroupedRow
                key={p.userId}
                leading={<Face who={{ type: "person", id: p.userId }} size={GROUPED_ROW.lead} />}
                label={p.name}
                {...(typed ? { labelParts: markTerms(p.name, [typed]) } : {})}
                chevron
                onPress={() => onPerson(p.userId)}
              />
            ))}
          </GroupedList>
        </View>
      ) : null}
      {found.agents.length + found.people.length === 0 && !dir.loading ? (
        typed ? (
          <EmptyState
            size="inline"
            title={t("mobile.find.nothing", { q: typed })}
            action={<Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={onClear} />}
          />
        ) : (
          <FirstUse
            place="people"
            size="panel"
            acts={mayCreate(org, "invite")}
            label={t("members.inviteTitle")}
            onPress={() => router.push("/invite-people")}
          />
        )
      ) : null}
    </>
  );
}
