import {
  type Actor,
  type Issue,
  type IssuePriority,
  useAiStatus,
  useIssueAction,
  useIssueColumns,
  useIssueProjects,
} from "@agenteschat/client";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { pickableProjects } from "@agenteschat/client/lib/issue-projects";
import { assigneeNames, PRIORITIES } from "@agenteschat/client/lib/issues";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { type AudienceChoice, EVERYONE } from "@agenteschat/client/lib/who-sees";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, OPTION_ROW, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chooseAction, NEXT_FIELD, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { Face } from "../shared/Face";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { overLimit, TextArea } from "../shared/TextArea";
import { useWhoSeesLabel } from "../shared/WhoSees";
import { columnOfIssue, DUE_CHOICES, type DueChoice, dueDateOf } from "./logic";
import { ProjectDot, useColumnLabel } from "./parts";
import { audienceReady, openTaskPick, type TaskPick } from "./pick";
import { useStartAgent } from "./useStartAgent";

const DESCRIPTION_LIMIT = { max: FIELD_LIMITS.issueDescription };
const close = () => goBack("/issues");

/**
 * "Nova tarefa", a screen pushed over Tarefas (the native bar: back, the title, "Criar"), on the settings' form page
 * (`SettingsPage`: a focused field scrolls clear of the keyboard on both systems, the bar over the keyboard walks
 * the fields): the title (the person taps it: the keyboard never comes up on its own), a description, who does it
 * (several at once, ADR 0188; the first agent picked is asked right away, as on the web: it starts and the status moves
 * on its own), its project, the priority, the due date and who sees it. Who does it, the project and who sees it are
 * picked on their own pushed screen (`TaskPickScreen`), the priority and the due date in the app's menu of choices:
 * nothing opens inside the form. From a board column's "+" (`column`), it goes in that column; from a
 * project's tasks (`project`), it starts in that project.
 */
export function NewIssueForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const start = useStartAgent();
  const ai = useAiStatus(orgId);
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const { column: columnId, project: fromProject } = useLocalSearchParams<{ column?: string; project?: string }>();
  const projects = pickableProjects(useIssueProjects(orgId).data?.projects ?? []);
  const [projectId, setProjectId] = useState<string | null>(fromProject ?? null);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const column = columnId ? columns.data?.find((c) => c.id === columnId) : undefined;
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [who, setWho] = useState<Actor[]>([]);
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [due, setDue] = useState<DueChoice>("none");
  const [audience, setAudience] = useState<AudienceChoice>(EVERYONE);
  const seesLabel = useWhoSeesLabel();
  const ready =
    title.trim().length > 0 && !overLimit(text, DESCRIPTION_LIMIT) && !action.isPending && audienceReady(audience);
  // A back swipe with a task half written asks first, as the web's dialog keeps it from a stray click.
  const leave = useUnsavedGuard(title.trim() !== "" || text.trim() !== "");
  const whoName = (a: Actor | null) =>
    !a ? t("mobile.issues.nobody") : a.type === "person" && a.id === meId ? t("mobile.issues.you") : dir.nameOf(a);
  const [only] = who;
  const whoRole = who.length === 1 && only?.type === "agent" ? (dir.agentById.get(only.id)?.role ?? "") : "";
  // The first agent picked starts on the task once it exists; the others it is given to only have it.
  const starter = who.find((a) => a.type === "agent");

  const submit = () => {
    if (!ready) return;
    action.mutate(
      {
        type: "create",
        input: {
          title: title.trim(),
          description: text.trim(),
          assignees: who.filter((a) => a !== starter),
          priority,
          dueDate: dueDateOf(due),
          ...(project ? { projectId: project.id } : {}),
          audience,
        },
      },
      {
        onSuccess: (created) => {
          const issue = created as Issue;
          // New tasks land in A fazer's first column; another one was picked by its "+" (an agent's moves on).
          if (column && !starter && columnOfIssue(issue, columns.data ?? [])?.id !== column.id)
            action.mutate({ type: "update", id: issue.id, patch: { columnId: column.id } });
          // An agent picked here starts right away: assigned, its run linked, in progress (as on the web).
          if (starter) start.run(issue, starter.id, { created: true });
          successHaptic();
          toast({
            title: t("mobile.issues.form.created", { number: issue.number }),
            ...(starter ? { agentId: starter.id } : {}),
          });
          leave();
          close();
        },
        onError: () => toast({ title: t("mobile.issues.form.createFailed"), icon: "x" }),
      },
    );
  };

  // A field with many choices is picked on its own pushed screen; a short fixed list (priority, due date) in the
  // app's menu of choices, its row marked as one.
  const pickOn = (pick: TaskPick) => {
    openTaskPick(pick);
    router.push("/issues/pick");
  };
  const pickPriority = () =>
    chooseAction(
      t("issues.form.priority"),
      PRIORITIES.map((p) => ({
        label: t(`issues.priority.${p}`),
        checked: p === priority,
        onPress: () => setPriority(p),
      })),
      t("common.cancel"),
    );
  const pickDue = () =>
    chooseAction(
      t("mobile.issues.form.due"),
      DUE_CHOICES.map((d) => ({
        label: t(`mobile.issues.form.dueChoice.${d}`),
        checked: d === due,
        onPress: () => setDue(d),
      })),
      t("common.cancel"),
    );
  return (
    <SettingsPage
      title={t("mobile.issues.form.title")}
      action={{ label: t("mobile.issues.form.create"), disabled: !ready, onPress: submit }}
      locked={action.isPending}
      toolbar
    >
      <View style={styles.fields}>
        <TextArea
          value={title}
          onChangeText={setTitle}
          placeholder={t("mobile.issues.form.titlePlaceholder")}
          accessibilityLabel={t("issues.form.title")}
          multiline={false}
          minHeight={50}
          maxLength={300}
          {...NEXT_FIELD}
        />
        <TextArea
          value={text}
          onChangeText={setText}
          placeholder={t("mobile.issues.form.description")}
          accessibilityLabel={t("mobile.issues.form.description")}
          minHeight={96}
          limit={DESCRIPTION_LIMIT}
        />
        <View>
          <GroupedHeader>{t("mobile.issues.form.who")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={
                only
                  ? assigneeNames(
                      t,
                      who.map((a) => whoName(a)),
                    )
                  : whoName(null)
              }
              leading={only ? <Face who={only} size={OPTION_ROW.face} live={false} /> : undefined}
              icon={only ? undefined : "agent"}
              value={whoRole || undefined}
              chevron
              onPress={() => pickOn({ what: "who", value: who, apply: setWho })}
            />
          </GroupedList>
          {starter ? (
            <GroupedFooter>
              {/* "Starts as soon as it's created" isn't true for an agent with no AI: it waits for one. */}
              {aiStateOf(ai.data, starter.id) === "no_ai"
                ? t("mobile.ai.taskNoAi", { name: dir.agentById.get(starter.id)?.name ?? "" })
                : t("mobile.issues.form.agentStarts")}
            </GroupedFooter>
          ) : null}
        </View>
        <View>
          <GroupedHeader>{t("mobile.issues.form.details")}</GroupedHeader>
          <GroupedList>
            {column ? (
              <GroupedRow icon="circle" label={t("issues.column")} sub={columnLabel(column)} subLines={0} />
            ) : null}
            {projects.length > 0 ? (
              <GroupedRow
                leading={<ProjectDot color={project?.color} />}
                label={t("issues.projects.label")}
                value={project?.name ?? t("issues.projects.none")}
                chevron
                onPress={() => pickOn({ what: "project", value: project, apply: setProjectId })}
              />
            ) : null}
            <GroupedRow
              icon="flag"
              label={t("issues.form.priority")}
              value={t(`issues.priority.${priority}`)}
              menu
              onPress={pickPriority}
            />
            <GroupedRow
              icon="clock"
              label={t("mobile.issues.form.due")}
              value={t(`mobile.issues.form.dueChoice.${due}`)}
              menu
              onPress={pickDue}
            />
            <GroupedRow
              icon={audience.mode === "everyone" ? "globe" : "lock"}
              label={t("whoSees.label")}
              value={seesLabel(audience)}
              chevron
              onPress={() => pickOn({ what: "sees", value: audience, apply: setAudience })}
            />
          </GroupedList>
        </View>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // Under the page's own 4 pt top: the fields 8 under the bar, 12 apart.
  fields: { paddingTop: 4, gap: 12 },
});
