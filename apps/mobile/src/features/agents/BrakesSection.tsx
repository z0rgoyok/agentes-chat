import { type Agent, type AgentBrakes, BRAKES_DEFAULTS, useUpdateAgent } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { fieldText, GROUPED_ROW, GroupedFooter, GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { confirmAction } from "../settings/parts";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { closeAgentChoose, openAgentChoose } from "./agent-choose";

const AT_ONCE = [1, 2, 3, 5, 10];
const PRS = [0, 1, 2, 3, 5, 10];

/**
 * The web's Autonomia sem pedido (ADR 0131) on the phone: costly work nobody asked for asks first, how many such jobs
 * at once, PRs an hour, which agents it may call and its project. Saved at once by who manages it; a number is
 * picked from its list in the app's picker (one save), the agents it may call on a screen of their own (each tap
 * saved), and forgetting the remembered answers asks first. Settings' own groups: each header over its group, each
 * note under it.
 */
export function BrakesSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const failed = useFailed();
  const update = useUpdateAgent(useOrgId(), agent.id);
  // Its brakes are for who manages it (the server's `canManage`), as its apps and budget.
  const editable = managesAgent(agent);
  const saved: AgentBrakes = agent.brakes ?? BRAKES_DEFAULTS;
  const b = { ...saved, ...(update.isPending ? (update.variables?.brakes ?? {}) : {}) };
  const [project, setProject] = useState(b.project);
  useEffect(() => setProject(saved.project), [saved.project]);
  const save = (patch: Partial<AgentBrakes>) => {
    if (editable) update.mutate({ brakes: patch }, { onError: failed });
  };
  // A number from its row's list, the one in use checked: saved once, when picked.
  const pickNumber = (title: string, list: readonly number[], now: number, set: (n: number) => Partial<AgentBrakes>) =>
    void pickOne({
      title,
      value: String(now),
      options: list.map((n) => ({ key: String(n), label: String(n) })),
    }).then((key) => {
      if (key !== null && Number(key) !== now) save(set(Number(key)));
    });
  // The remembered answers go for good: asked first, in the system's confirmation.
  const forget = () =>
    confirmAction({
      title: t("mobile.agent.brakes.forgetTitle"),
      text: t("mobile.agent.brakes.forgetText", agentGrammar(agent.name)),
      action: t("mobile.intentAgents.knows.forget"),
      cancel: t("common.cancel"),
      onConfirm: () => save({ go: [], never: [] }),
    });
  const others = dir.agents.filter((a) => !a.former && a.id !== agent.id);
  // The picker's taps reach the latest `save` (the brakes as they are then).
  const latest = useRef(save);
  useLayoutEffect(() => {
    latest.current = save;
  });
  useEffect(() => () => closeAgentChoose(), []);
  // "Só estes": the agents on a screen of their own, never a list unfolding in this card.
  const chooseCallees = () => {
    openAgentChoose({
      title: t("brakes.call"),
      ids: others.map((a) => a.id),
      picked: b.callAgentIds,
      multi: true,
      note: t("brakes.callHelp"),
      apply: (ids) => latest.current({ callAgents: "some", callAgentIds: ids }),
    });
    router.push("/agent-choose");
  };
  const callees = b.callAgentIds.flatMap((id) => dir.agentById.get(id)?.name ?? []);
  return (
    <>
      <GroupedHeader>{t("brakes.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="shield"
          label={t("brakes.costly")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.costly") }), text: t("brakes.costlyHelp") }}
          toggle={b.costly === "ask"}
          disabled={!editable}
          onPress={() => save({ costly: b.costly === "ask" ? "go" : "ask" })}
        />
        <GroupedRow
          label={t("brakes.atOnce")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.atOnce") }), text: t("brakes.atOnceHelp") }}
          value={String(b.maxUnrequested)}
          menu={editable}
          disabled={!editable}
          onPress={() => pickNumber(t("brakes.atOnce"), AT_ONCE, b.maxUnrequested, (n) => ({ maxUnrequested: n }))}
        />
        <GroupedRow
          label={t("brakes.prs")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.prs") }), text: t("brakes.prsHelp") }}
          value={String(b.maxPrsPerHour)}
          menu={editable}
          disabled={!editable}
          onPress={() => pickNumber(t("brakes.prs"), PRS, b.maxPrsPerHour, (n) => ({ maxPrsPerHour: n }))}
        />
        {b.go.length + b.never.length > 0 ? (
          <GroupedRow
            label={t("brakes.forget")}
            sub={[
              ...b.go.map((k) => t("brakes.rememberedGo", { what: t(`brakes.cost.${k}`) })),
              ...b.never.map((k) => t("brakes.rememberedNever", { what: t(`brakes.cost.${k}`) })),
            ].join(" · ")}
            subLines={3}
            disabled={!editable}
            onPress={forget}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t("brakes.subtitle")}</GroupedFooter>
      <GroupedHeader>{t("brakes.call")}</GroupedHeader>
      <GroupedList>
        {(["all", "some", "none"] as const).map((v) => (
          <GroupedRow
            key={v}
            label={t(`brakes.call${v === "all" ? "All" : v === "some" ? "Some" : "None"}`)}
            checked={b.callAgents === v}
            disabled={!editable}
            onPress={() => (v === "some" ? chooseCallees() : save({ callAgents: v }))}
          />
        ))}
        {b.callAgents === "some" ? (
          <GroupedRow
            key="callees"
            icon="agent"
            label={callees.length > 0 ? joinNames(callees, t) : t("repos.choose")}
            labelLines={2}
            {...(editable ? { chevron: true, onPress: chooseCallees } : {})}
          />
        ) : null}
      </GroupedList>
      <GroupedHeader hint={{ name: t("common.about", { label: t("brakes.project") }), text: t("brakes.projectHelp") }}>
        {t("brakes.project")}
      </GroupedHeader>
      <GroupedList>
        <TextInput
          value={project}
          onChangeText={setProject}
          onEndEditing={() => project.trim() !== saved.project && save({ project: project.trim() })}
          editable={editable}
          maxLength={80}
          placeholder={t("brakes.projectPlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("brakes.project")}
          style={[styles.field, fieldText("body"), { color: c.ink }]}
        />
        {/* With a project, in the project's group: its ⓘ speaks of both. */}
        {b.project ? (
          <GroupedRow
            label={t("brakes.otherProjects")}
            toggle={b.otherProjects}
            disabled={!editable}
            onPress={() => save({ otherProjects: !b.otherProjects })}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t("brakes.peopleNote")}</GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  // A field row of a group, as "Create agent"'s.
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
});
