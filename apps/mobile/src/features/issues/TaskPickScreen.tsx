import { type Actor, type IssueColumn, useIssueColumns, useIssueProjects } from "@agenteschat/client";
import { NO_PROJECT, pickableProjects, projectFilterRows } from "@agenteschat/client/lib/issue-projects";
import { audienceOfKind } from "@agenteschat/client/lib/who-sees";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Icon, SearchField } from "@/ui";
import { AGENT_SEARCH_FROM, agentsMatching } from "../dashboards/logic";
import { Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { useWhoSeesDraft, WhoSeesRows } from "../shared/WhoSees";
import { columnChoices, stageCustomized } from "./logic";
import { ProjectDot, useColumnLabel } from "./parts";
import { closeTaskPick, sameActor, type TaskPick, taskPickNow, toggleActor } from "./pick";

/** A face in the rows' 36 pt leading column, as the agent picker's. */
const FACE = 36;

/**
 * A task's field, pushed from where it is set (ADR 0135: screens, never a list opened in place): who does it, its
 * project, its column, who sees it, or Tarefas' project filter. A single choice goes back on its tap with the check on
 * the one in use; who does it and who sees it write back as each option is tapped and go back with the bar's back.
 */
export function TaskPickScreen() {
  // The pick this screen was pushed for, taken as it opens: one started for the next screen while this one slides away
  // isn't its own.
  const [pick] = useState(taskPickNow);
  useEffect(() => {
    // Opened with nothing to pick for (its address on its own): back.
    if (!pick) goBack("/issues");
    // The pick ends with its screen, however it closes.
    return () => closeTaskPick(pick);
  }, [pick]);
  if (!pick) return null;
  if (pick.what === "who") return <WhoPick pick={pick} />;
  if (pick.what === "project" || pick.what === "projectFilter") return <ProjectPick pick={pick} />;
  if (pick.what === "column") return <ColumnPick pick={pick} />;
  return <SeesPick pick={pick} />;
}

/** One choice made: back to where it was asked. */
function chose(apply: () => void) {
  apply();
  goBack("/issues");
}

/**
 * Who does it, several at once (ADR 0188): the agents the person can talk to (a search past a handful), then me and
 * whoever had the task already, then nobody, with a check on each one that has it. A tap adds one or takes one off and
 * is written back at once; the screen stays open for the next, and the bar's back (or "Pronto") goes back with it.
 */
function WhoPick({ pick }: { pick: Extract<TaskPick, { what: "who" }> }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const [query, setQuery] = useState("");
  // What the rows show is what was tapped: a task itself comes back with it a moment later.
  const [list, setList] = useState<Actor[]>(() => [...pick.value]);
  const agents = useMemo(() => dir.agents.filter((a) => a.canTalk !== false), [dir.agents]);
  const shown = useMemo(() => agentsMatching(agents, query), [agents, query]);
  // Whoever had it and isn't offered above (someone else, an agent I can't talk to) stays listed, to take off or back.
  const others = useMemo(
    () => pick.value.filter((a) => (a.type === "agent" ? !agents.some((g) => g.id === a.id) : a.id !== meId)),
    [pick.value, agents, meId],
  );
  const set = (next: Actor[]) => {
    const was = list;
    setList(next);
    // A save that failed takes its tap back, unless another one came since.
    Promise.resolve(pick.apply(next, was)).catch(() => setList((now) => (now === next ? was : now)));
  };
  const row = (who: Actor | null, label: string, sub?: string | null) => (
    <GroupedRow
      key={who ? `${who.type}:${who.id}` : "nobody"}
      {...(who ? { leading: <Face who={who} size={FACE} live={false} /> } : { icon: "circle" as const })}
      label={label}
      {...(sub ? { sub } : {})}
      checked={who ? list.some((a) => sameActor(a, who)) : list.length === 0}
      onPress={() => {
        if (who) set(toggleActor(list, who));
        else if (list.length > 0) set([]);
      }}
    />
  );
  return (
    <SettingsPage
      title={t("mobile.issues.form.who")}
      action={{ label: t("mobile.common.done"), onPress: () => goBack() }}
    >
      {agents.length >= AGENT_SEARCH_FROM ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.dashboards.agentPick.search")}
            accessibilityLabel={t("mobile.dashboards.agentPick.search")}
          />
        </View>
      ) : (
        <Gap />
      )}
      {shown.length > 0 ? (
        <GroupedList>{shown.map((a) => row({ type: "agent", id: a.id }, a.name, a.role))}</GroupedList>
      ) : query ? (
        <GroupedFooter>{t("mobile.dashboards.agentPick.noMatch")}</GroupedFooter>
      ) : null}
      {query ? null : (
        <>
          <Gap />
          <GroupedList>
            {meId ? row({ type: "person", id: meId }, t("mobile.issues.you")) : null}
            {others.map((who) =>
              row(who, dir.nameOf(who), who.type === "agent" ? dir.agentById.get(who.id)?.role : null),
            )}
            {row(null, t("mobile.issues.nobody"))}
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

/**
 * A project: a task's (the ones in use, its own even archived, then "Sem projeto"), or Tarefas' filter ("Todos os
 * projetos", the ones in use, "Sem projeto", the archived ones marked).
 */
function ProjectPick({ pick }: { pick: Extract<TaskPick, { what: "project" | "projectFilter" }> }) {
  const { t } = useTranslation();
  const c = useColors();
  const projects = useIssueProjects(useOrgId()).data?.projects ?? [];
  const rows: ProjectRow[] =
    pick.what === "project"
      ? [
          ...pickableProjects(projects, pick.value).map((p) => ({
            key: p.id,
            label: p.name,
            leading: <ProjectDot color={p.color} />,
            on: p.id === pick.value?.id,
            choose: () => pick.apply(p.id),
          })),
          {
            key: NO_PROJECT,
            label: t("issues.projects.none"),
            leading: <ProjectDot />,
            on: pick.value === null,
            choose: () => pick.apply(null),
          },
        ]
      : [
          { key: "", label: t("issues.projects.all"), leading: <Icon name="issue" size={20} color={c.muted} /> },
          ...projectFilterRows(projects).map((p) =>
            p
              ? {
                  key: p.id,
                  label: p.name,
                  leading: <ProjectDot color={p.color} />,
                  ...(p.archived ? { sub: t("issues.projects.archivedMark") } : {}),
                }
              : { key: NO_PROJECT, label: t("issues.projects.none"), leading: <ProjectDot /> },
          ),
        ].map((r) => ({ ...r, on: r.key === pick.value, choose: () => pick.apply(r.key) }));
  return (
    <SettingsPage title={t("issues.projects.label")}>
      <Gap />
      <GroupedList>
        {rows.map((r) => (
          <GroupedRow
            key={r.key || "all"}
            leading={r.leading}
            label={r.label}
            {...(r.sub ? { sub: r.sub } : {})}
            checked={r.on}
            onPress={() => chose(r.choose)}
          />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

interface ProjectRow {
  key: string;
  label: string;
  /** Its color's dot ("Sem projeto": the hollow ring); every task: the list's mark. */
  leading: ReactNode;
  sub?: string;
  on: boolean;
  choose: () => void;
}

/** A column: the board's columns under their stage; a board that isn't customized shows just the stages. */
function ColumnPick({ pick }: { pick: Extract<TaskPick, { what: "column" }> }) {
  const { t } = useTranslation();
  const columns = useIssueColumns(useOrgId()).data ?? [];
  const columnLabel = useColumnLabel();
  const stages = columnChoices(columns);
  const row = (c: IssueColumn) => (
    <GroupedRow
      key={c.id}
      label={columnLabel(c)}
      labelLines={0}
      checked={c.id === pick.value}
      onPress={() => chose(() => pick.apply(c))}
    />
  );
  return (
    <SettingsPage title={t("issues.column")}>
      {stages.some((s) => stageCustomized(s.columns)) ? (
        stages.map((s) => (
          <View key={s.stage}>
            <GroupedHeader>{t(`mobile.issues.section.${s.stage}`)}</GroupedHeader>
            <GroupedList>{s.columns.map(row)}</GroupedList>
          </View>
        ))
      ) : (
        <>
          <Gap />
          <GroupedList>{stages.flatMap((s) => s.columns.map(row))}</GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

/** Who sees the task being written: the three options, the people under them; each tap is written back. */
function SeesPick({ pick }: { pick: Extract<TaskPick, { what: "sees" }> }) {
  const { t } = useTranslation();
  const meId = useMeId() ?? "";
  const draft = useWhoSeesDraft(pick.value);
  const { apply } = pick;
  const { kind, picked } = draft;
  useEffect(() => {
    apply(audienceOfKind(kind, [...picked], meId));
  }, [apply, kind, picked, meId]);
  return (
    <SettingsPage title={t("whoSees.label")} action={{ label: t("mobile.common.done"), onPress: () => goBack() }}>
      <Gap />
      <View style={styles.sees}>
        <WhoSeesRows draft={draft} />
      </View>
      <GroupedFooter>{t("whoSees.admins")}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 8, paddingBottom: 12 },
  sees: { gap: 12 },
});
