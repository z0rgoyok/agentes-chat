import { useApplyTeamTemplate, useTeamTemplates } from "@agenteschat/client";
import { isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { teamFailureText } from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  Button,
  CARD_PAD,
  EmptyState,
  GroupedFooter,
  GroupedList,
  GroupedRow,
  SkeletonList,
  Text,
} from "@/ui";
import { router } from "@/ui/navigation";
import { fullLook } from "../agents/edit";
import { usePlanHold } from "../ai/parts";
import { useFailed } from "../routines/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { countsText, TeamRows } from "./TeamCard";

/*
 * "Team templates" (ADR 0137 §10) as two pushed screens, each with the system's back: the templates, each with its
 * team's faces, "None of these" and the other ways to start; then one template's team on a screen of its own, where
 * "Create the team" makes it and leaves both. In a personal workspace (ADR 0159) the server lists them by area of life,
 * and the words are about the person's agents.
 */

/**
 * Opens the templates from the right hand's first run or its held card. `template`: the one the first run's areas
 * point to (ADR 0155 §6), opened over the list, so the system's back goes to the others.
 */
export function openTeamTemplates(template?: string) {
  router.push("/team-templates");
  if (template) router.push({ pathname: "/team-template", params: { id: template } });
}

/** A template's team, its faces side by side under its name. */
const TEMPLATE_FACE = 22;

/** The right hand's name, which keeps the weekly check every template's team gets. */
function useReviewer() {
  return useDirectory().agents.find(isRightHand)?.name ?? RIGHT_HAND_DEFAULT.name;
}

export function TeamTemplatesScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const held = usePlanHold(orgId, org) !== null;
  const name = useReviewer();
  const list = useTeamTemplates(orgId, i18n.language);
  return (
    <SettingsPage title={t(modeKey(org, "teamPlan.templates.title"))}>
      {/* What the list is for, said once over it. */}
      <GroupedFooter>
        {held ? t(modeKey(org, "teamPlan.templates.heldLead")) : t(modeKey(org, "teamPlan.templates.lead"), { name })}
      </GroupedFooter>
      {list.isPending ? <SkeletonList rows={3} /> : null}
      {list.isError && !list.data ? <LoadFailed onRetry={() => void list.refetch()} /> : null}
      <GroupedList>
        {(list.data ?? []).map((x) => (
          <GroupedRow
            key={x.id}
            label={x.name}
            sub={x.sub}
            subLines={2}
            below={
              <View style={styles.faces}>
                {x.team.agents.map((a) => (
                  <AgentAvatar
                    key={a.handle}
                    agent={fullLook(a.appearance)}
                    size={TEMPLATE_FACE}
                    name={a.name}
                    live={false}
                  />
                ))}
              </View>
            }
            chevron
            onPress={() => router.push({ pathname: "/team-template", params: { id: x.id } })}
          />
        ))}
        {/* "None of these": back to writing what they do, where the list was opened. */}
        {held || !list.data ? null : (
          <GroupedRow
            icon="pen"
            label={t("teamPlan.templates.none")}
            sub={t(modeKey(org, "teamPlan.templates.noneSub"), { name })}
            subLines={2}
            onPress={() => goBack()}
          />
        )}
      </GroupedList>
      <Gap />
      {/* The other ways to start take this list's place: back from them is where it was opened. */}
      <GroupedList>
        <GroupedRow
          icon="out"
          label={t("teamPlan.templates.import")}
          chevron
          onPress={() => router.replace("/settings/import")}
        />
        <GroupedRow
          icon="plus"
          label={t("teamPlan.templates.scratch")}
          chevron
          onPress={() => router.replace("/new-agent")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * One template's team (`?id=`), pushed from its row: what it is for, its agents with their routines and skills, how many
 * of each, and "Create the team" pinned under it. Made, the template's screens go and the person is back where the
 * list was opened (the right hand's DM, where its card lands); a step that failed says why and stays.
 */
export function TeamTemplateScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const failed = useFailed();
  const held = usePlanHold(orgId, org) !== null;
  const personal = isPersonal(org);
  const name = useReviewer();
  const list = useTeamTemplates(orgId, i18n.language);
  const use = useApplyTeamTemplate(orgId);
  const [refused, setRefused] = useState<string | null>(null);
  const chosen = list.data?.find((x) => x.id === id) ?? null;
  const create = () =>
    chosen &&
    use.mutate(
      { templateId: chosen.id, locale: i18n.language },
      {
        onSuccess: (out) => {
          if (out.state === "created") {
            // The template's team and the list under it: both go, back to where the list was opened.
            router.dismiss(2);
            return;
          }
          setRefused(
            out.error ? teamFailureText(t, out.error, i18n.language) : t(modeKey(org, "teamPlan.templates.failed")),
          );
        },
        onError: failed,
      },
    );
  return (
    <SettingsPage
      title={chosen?.name ?? t(modeKey(org, "teamPlan.templates.title"))}
      locked={use.isPending}
      {...(chosen
        ? {
            bottom: (
              <Button
                variant="primary"
                wide
                label={t(modeKey(org, "teamPlan.templates.create"))}
                loading={use.isPending}
                onPress={create}
              />
            ),
          }
        : {})}
    >
      {list.isPending ? (
        <SkeletonList rows={3} />
      ) : list.isError && !list.data ? (
        <LoadFailed onRetry={() => void list.refetch()} />
      ) : !chosen ? (
        // A template this server no longer offers (an old link): said, never an empty page.
        <EmptyState icon="agent" title={t("common.loadFailed")} />
      ) : (
        <>
          <GroupedFooter>{chosen.description}</GroupedFooter>
          {/* The team on the list's own surface, as its card draws it in the conversation. */}
          <GroupedList>
            <View style={styles.team}>
              <TeamRows plan={chosen.team} reviewer={name} personal={personal} />
            </View>
          </GroupedList>
          <GroupedFooter>
            {held
              ? countsText(t, chosen.team, personal)
              : `${countsText(t, chosen.team, personal)} · ${t(modeKey(org, "teamPlan.templates.tailor"))}`}
          </GroupedFooter>
          {refused ? (
            <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite" style={styles.refused}>
              {refused}
            </Text>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // A template's team under its name and line.
  faces: { flexDirection: "row", flexWrap: "wrap", gap: 2, paddingTop: 6 },
  // The team inside the list's surface, at a card's padding.
  team: { padding: CARD_PAD },
  // Under the footer's words, as far in.
  refused: { paddingHorizontal: 16, paddingTop: 8 },
});
