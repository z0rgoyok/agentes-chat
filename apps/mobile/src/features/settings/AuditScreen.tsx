import { type AuditRow, useAudit, useAuditRow } from "@agenteschat/client";
import { auditUnasked } from "@agenteschat/client/lib/approvals-level";
import {
  AUDIT_HIDDEN,
  AUDIT_SHOWS,
  type AuditMark,
  type AuditMood,
  type AuditShow,
  auditActorName,
  auditApprovalText,
  auditDetailEntries,
  auditHint,
  auditOutcome,
  auditPhrase,
  auditQueryOf,
  auditReason,
  auditReasonKey,
  auditReasonLabel,
  auditRoutine,
  auditSecretText,
  auditSentence,
  auditStr,
  auditSubLine,
  auditToolSaid,
  auditValueText,
  auditWhere,
  TOOL_CALL,
} from "@agenteschat/client/lib/audit";
import { humanize } from "@agenteschat/client/lib/custom-tools";
import { whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import type { TFunction } from "i18next";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  LineIcon,
  SCREEN_X,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { closeAgentPick, openAgentPick } from "../dashboards/agent-pick";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { LoadFailed, useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { copyText, Tile } from "../shared/parts";
import { Gap, SettingsPage } from "./parts";

/*
 * Configurações › Auditoria on the phone (admins), as the web's: the log by day, a sentence per row (who, what),
 * the line under it (about what, who asked, where) and how it ended; shortcuts on top and an agent to narrow it to,
 * picked on its own pushed screen (the agent picker every form shares) and taken off with the row's ×.
 * A row pushes its own screen with the reason, the approval or the secret, what was sent (secrets hidden), the
 * technical detail, and the conversation and the request to open. Words in `@agenteschat/client/lib/audit`.
 */

const FACE = 30;

/** Each mark of the shared outcome (`auditOutcome`) as this app's icon. */
const MARK_ICON: Record<AuditMark, IconName> = {
  check: "check",
  block: "x",
  clock: "clock",
  stop: "stop",
  alert: "info",
  waiting: "wait",
};

export function AuditScreen({ agentId: first = null }: { agentId?: string | null } = {}) {
  const { t } = useTranslation();
  const when = useWhen();
  const dir = useDirectory();
  const { orgId, org } = useOrg();
  const admin = can(org, "view_audit");
  const look = useEmptyLook();
  const [show, setShow] = useState<AuditShow>("all");
  const [agentId, setAgentId] = useState<string | null>(first);
  const audit = useAudit(orgId, auditQueryOf(show, agentId), admin);
  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.rows) ?? [], [audit.data]);
  const days = useMemo(() => byDay(rows, when.day), [rows, when.day]);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  // Every agent of the workspace (the log has those no one talks to), on the picker's own screen; the pick comes
  // back here at once. The pick's state goes when the log closes.
  const pickAgent = () => {
    openAgentPick({ agentId, apply: setAgentId, title: t("audit.agent"), note: "", everyone: true });
    router.push("/agent-pick");
  };
  useEffect(() => closeAgentPick, []);

  return (
    <SettingsPage
      title={t("settings.section.audit")}
      largeTitle
      {...(admin ? { onRefresh: () => audit.refetch() } : {})}
    >
      <GroupedFooter>{t("settings.sectionText.audit")}</GroupedFooter>
      {!admin ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : (
        <>
          <Gap />
          {/* The chips scroll to the screen's edges; the first one starts where the groups do. */}
          <View style={styles.bleed}>
            <Filters
              items={AUDIT_SHOWS.map((s) => ({ key: s, label: t(`audit.filter.${s}`) }))}
              value={show}
              onChange={(key) => setShow(key as AuditShow)}
            />
          </View>
          {show !== "people" ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="agent"
                  label={t("audit.agent")}
                  value={agent?.name ?? t("audit.anyAgent")}
                  {...(agent
                    ? { valueLeading: <Face who={{ type: "agent", id: agent.id }} size={22} live={false} /> }
                    : {})}
                  {...(agentId
                    ? { remove: { label: t("audit.anyAgent"), onPress: () => setAgentId(null) } }
                    : { chevron: true })}
                  onPress={pickAgent}
                />
              </GroupedList>
            </>
          ) : null}
          {audit.isPending ? <SkeletonList rows={4} /> : null}
          {audit.isError && !audit.data ? <LoadFailed onRetry={() => void audit.refetch()} /> : null}
          {audit.isSuccess && rows.length === 0 ? (
            show === "all" && !agentId ? (
              <EmptyState
                size="panel"
                agent={look}
                mood="deal"
                title={t("mobile.empty.audit.title")}
                subtitle={t("mobile.empty.audit.text")}
              />
            ) : (
              <EmptyState
                size="inline"
                title={t("audit.emptyFiltered")}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("filters.clearAll")}
                    onPress={() => {
                      setShow("all");
                      setAgentId(null);
                    }}
                  />
                }
              />
            )
          ) : null}
          {days.map(([day, list]) => (
            <Fragment key={day}>
              <GroupedHeader>{day}</GroupedHeader>
              <GroupedList>
                {list.map((row) => (
                  // The list's kept clock format (`useWhen`), not a new one per row.
                  <AuditRowView key={row.id} row={row} time={when.time(row.at)} />
                ))}
              </GroupedList>
            </Fragment>
          ))}
          {audit.hasNextPage ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="down"
                  label={t("audit.loadMore")}
                  disabled={audit.isFetchingNextPage}
                  onPress={() => void audit.fetchNextPage()}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

/** The rows under each day's heading ("Hoje", "Ontem", "terça-feira, 27 de outubro"), newest first. */
function byDay(rows: AuditRow[], day: (iso: string) => string): [string, AuditRow[]][] {
  const out: [string, AuditRow[]][] = [];
  for (const row of rows) {
    const label = day(row.at);
    const last = out.at(-1);
    if (last && last[0] === label) last[1].push(row);
    else out.push([label, [row]]);
  }
  return out;
}

/** One row: the face, "Ada criou uma tarefa", the line under it, and how it ended with the time. */
function AuditRowView({ row, time }: { row: AuditRow; time: string }) {
  const { t, i18n } = useTranslation();
  const { name, text } = auditSentence(t, row, i18n.language);
  const sub = auditSubLine(t, row, i18n.language);
  const look = auditOutcome(t, row);
  return (
    <GroupedRow
      leading={<AuditFace row={row} />}
      label={name ? `${name} ${text}` : text}
      labelLines={2}
      {...(sub ? { sub } : {})}
      below={
        <View style={styles.end}>
          {look ? <OutcomeLine mood={look.mood} mark={look.mark} text={look.text} /> : null}
          <Text variant="caption" tone="faint" style={styles.time}>
            {time}
          </Text>
        </View>
      }
      chevron
      onPress={() => router.push(`/settings/audit/${row.id}`)}
    />
  );
}

/** Who did it: the agent's or the person's face; a gear for the system. */
function AuditFace({ row }: { row: AuditRow }) {
  if (row.actor.type === "system" || !row.actor.id) return <Tile icon="server" size={FACE} />;
  return <Face who={{ type: row.actor.type, id: row.actor.id }} size={FACE} live={false} />;
}

/** How it ended in its color: green when done, amber while it waits, red when refused or failed. */
function OutcomeLine({ mood, mark, text }: { mood: AuditMood; mark: AuditMark; text: string }) {
  const c = useColors();
  const color =
    mood === "done"
      ? c.ok
      : mood === "waiting"
        ? c.amber
        : mood === "refused" || mood === "failed"
          ? c.danger
          : c.muted;
  return (
    <View style={styles.outcome}>
      <LineIcon name={MARK_ICON[mark]} size={13} color={color} variant="caption" />
      <Text variant="caption" style={[styles.semibold, { color }, styles.shrink]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A row of the log on its own screen (pushed over the list): the sentence and how it ended, the reason, the facts
 * (who asked, where, through which app, the approval or the secret, when), what was sent with secrets hidden, a
 * change's details, the technical detail, and the conversation and the waiting request to open.
 */
export function AuditRowScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const row = useAuditRow(orgId, id);
  if (!row) {
    return (
      <SettingsPage title={t("settings.section.audit")}>
        <View style={styles.note}>
          <Note icon="info">{t("audit.emptyFiltered")}</Note>
        </View>
      </SettingsPage>
    );
  }
  const name = auditActorName(t, row) ?? t("audit.system");
  const { name: who, text } = auditSentence(t, row, i18n.language);
  const look = auditOutcome(t, row);
  const reason = auditReason(t, row, i18n.language);
  const reasonKey = auditReasonKey(row);
  const reasonLabel = auditReasonLabel(t, row);
  const said = auditToolSaid(row);
  const isCall = row.action === TOOL_CALL;
  const where = auditWhere(t, row);
  const connector = auditStr(row.details.connector);
  const asked = isCall ? askedOf(t, row) : null;
  const input = isCall ? (row.details.input as Record<string, unknown> | undefined) : undefined;
  const sent = input ? Object.entries(input) : [];
  const changeDetails = isCall ? [] : auditDetailEntries(row.details, row.action);
  const copy = async () => {
    if (await copyText(row.id)) toast({ title: t("audit.panel.copied"), icon: "check" });
  };

  return (
    <SettingsPage
      title={auditHint(t, row) ?? auditPhrase(t, row, i18n.language)}
      subtitle={`${name} · ${whenAt(t, i18n.language, row.at)}`}
    >
      <View style={styles.lead}>
        <Text variant="body" tone="ink">
          {who ? (
            <Text variant="body" tone="ink" style={styles.semibold}>
              {`${who} `}
            </Text>
          ) : null}
          {text}
        </Text>
        {look ? <OutcomeLine mood={look.mood} mark={look.mark} text={look.text} /> : null}
      </View>
      {reason ? (
        <View style={styles.note}>
          <Note icon={reasonKey === "refused" ? "x" : "info"}>
            {reasonLabel ? `${reasonLabel}: ${reason}` : reason}
          </Note>
        </View>
      ) : null}

      <Gap />
      <GroupedList>
        {asked ? <GroupedRow label={t("audit.panel.asked")} value={asked} /> : null}
        {where && row.channel ? (
          <GroupedRow
            label={t("audit.panel.where")}
            value={where}
            chevron
            onPress={() => router.push(chatHref(row.channel?.id ?? ""))}
          />
        ) : null}
        {connector ? <GroupedRow label={t("audit.panel.via")} value={connector} /> : null}
        {row.approval ? (
          <GroupedRow label={t("audit.panel.approval")} value={auditApprovalText(t, row.approval)} />
        ) : auditUnasked(row) ? (
          <GroupedRow
            label={t("audit.panel.approval")}
            value={t("audit.panel.unasked", { level: t("approvalsLevel.never.title") })}
          />
        ) : null}
        {row.secret ? <GroupedRow label={t("audit.panel.secret")} value={auditSecretText(t, row.secret)} /> : null}
        <GroupedRow label={t("audit.panel.when")} value={whenAt(t, i18n.language, row.at)} />
      </GroupedList>

      {sent.length > 0 ? (
        <>
          <GroupedHeader>{t("audit.panel.sent")}</GroupedHeader>
          <KeyValues entries={sent} />
          <GroupedFooter>{t("audit.panel.sentHint")}</GroupedFooter>
        </>
      ) : null}
      {changeDetails.length > 0 ? (
        <>
          <GroupedHeader>{t("audit.panel.details")}</GroupedHeader>
          <KeyValues entries={changeDetails} />
        </>
      ) : null}

      {row.approval?.status === "pending" || row.channel ? (
        <>
          <Gap />
          <GroupedList>
            {row.approval?.status === "pending" ? (
              <GroupedRow
                icon="wait"
                label={t("audit.panel.openApproval")}
                chevron
                onPress={() => router.push(`/approval/${row.approval?.id ?? ""}`)}
              />
            ) : null}
            {row.channel ? (
              <GroupedRow
                icon="chat"
                label={t("audit.panel.openConversation")}
                chevron
                onPress={() => router.push(chatHref(row.channel?.id ?? ""))}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}

      <GroupedHeader>{t("audit.panel.tech")}</GroupedHeader>
      <GroupedList>
        <GroupedRow label={t("audit.panel.techAction")} sub={row.action} />
        {isCall && row.target.id ? <GroupedRow label={t("audit.panel.techTool")} sub={row.target.id} /> : null}
        {auditStr(row.details.kind) ? (
          <GroupedRow label={t("audit.panel.techKind")} sub={auditStr(row.details.kind) ?? ""} />
        ) : null}
        {said ? <GroupedRow label={t("audit.panel.techSaid")} sub={said} subLines={6} /> : null}
        {row.runId ? <GroupedRow label={t("audit.panel.techRun")} sub={row.runId} /> : null}
        <GroupedRow label={t("audit.panel.techId")} sub={row.id} />
        <GroupedRow icon="copy" label={t("audit.panel.copyLink")} onPress={() => void copy()} />
      </GroupedList>
    </SettingsPage>
  );
}

/** Who asked for a call: the person, the routine, or nobody (the agent on its own). */
function askedOf(t: TFunction, row: AuditRow) {
  const behind = auditStr(row.details.behind);
  if (behind === "person" && row.onBehalfOf) return row.onBehalfOf.name ?? t("audit.removed");
  if (behind === "routine") {
    const routine = auditRoutine(row);
    return routine ? t("audit.panel.routine", { name: routine }) : t("audit.behind.routineAny");
  }
  if (behind === "unattended") return t("audit.panel.nobody");
  return null;
}

/**
 * What was sent or kept, a field a row: its name in words ("Issue number", never `issue_number`, as the approval
 * card says it), then its value (a hidden one says so, with a lock).
 */
function KeyValues({ entries }: { entries: [string, unknown][] }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <GroupedList>
      {entries.map(([k, v]) =>
        v === AUDIT_HIDDEN ? (
          <GroupedRow
            key={k}
            label={humanize(k)}
            below={
              <View style={styles.outcome}>
                <LineIcon name="lock" size={13} color={c.faint} variant="caption" />
                <Text variant="caption" tone="faint">
                  {t("audit.panel.hidden")}
                </Text>
              </View>
            }
          />
        ) : (
          <GroupedRow key={k} label={humanize(k)} sub={auditValueText(v)} subLines={6} />
        ),
      )}
    </GroupedList>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  // The other settings screens' note: on the groups' edge, not indented past it.
  note: { paddingHorizontal: 4, paddingTop: 10 },
  // Under the page's 16 at its sides: the chips' own row runs from edge to edge.
  bleed: { marginHorizontal: -SCREEN_X },
  end: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  outcome: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  time: { fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: "600" },
  lead: { paddingHorizontal: SCREEN_X, paddingTop: 12, gap: 8 },
});
