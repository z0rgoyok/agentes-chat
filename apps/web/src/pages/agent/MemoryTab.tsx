import type { Memory, Proposal } from "@agenteschat/client";
import {
  useForgetRightHandLearned,
  useLearnedSkills,
  useMemory,
  useMemoryAction,
  useProposals,
  useSetTeamWeekPrefs,
  useSettings,
  useTeamWeekPrefs,
  useUpdateSettings,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine, pendingOnAgent, proposalTitle, proposalWhy } from "@agenteschat/client/lib/proposals";
import { isRightHand, memoryAudienceGroups } from "@agenteschat/client/lib/right-hand";
import { canMakeTeamMemory } from "@agenteschat/client/lib/team-memory";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogFooter,
  Diff,
  diffLines,
  EmptyState,
  Field,
  GroupHeading,
  Icon,
  type IconName,
  InfoHint,
  Locked,
  overLimit,
  SearchField,
  Segmented,
  Switch,
  Textarea,
  Toolbar,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useTextLimit } from "@/hooks/useTextLimit";
import { useLandOn } from "@/lib/land-on";
import { lookOf } from "@/lib/look";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import {
  filterMemories,
  type MemoryTab as Kind,
  memorySource,
  memoryTabOf,
  NoMemories,
  usageLabel,
} from "@/pages/MemoryPage";
import { CardHead, useAgentEdit } from "./context";

/**
 * A change to this agent's instructions (or a skill) the agent's review is weighing (ADR 0219): why and the diff, and
 * "Reviewing…" in its head. Nobody decides it: it is applied or left out in a moment, and then it leaves this list.
 */
function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  return (
    <Card as="article" className="agp-card agp-prop" aria-labelledby={`prop-${proposal.id}`}>
      <CardHeader
        id={`prop-${proposal.id}`}
        icon="document"
        title={proposalTitle(t, proposal, org, () => agent.name)}
        action={<State icon="waiting">{t("proposals.reviewing")}</State>}
      />
      <p className="agp-why">
        <b>{t("proposals.why")}:</b> {proposalWhy(t, proposal)}
      </p>
      <Diff
        aria-label={t("proposals.changeLabel")}
        addedLabel={t("proposals.added")}
        removedLabel={t("proposals.removed")}
        lines={diffLines(proposal.before.split("\n"), proposal.after.split("\n"))}
      />
    </Card>
  );
}

/** A state in a memory's quiet line: its mark and its word, no pill. */
function State({ icon, waiting, children }: { icon: IconName; waiting?: boolean; children: ReactNode }) {
  return (
    <span className="agp-mem__state" data-tone={waiting ? "waiting" : undefined}>
      <Icon name={icon} size={14} />
      {children}
    </span>
  );
}

/** A memory's trust, only where it is a state: from outside, or verified (a person or an outcome). */
function Trust({ m }: { m: Memory }) {
  const { t } = useTranslation();
  if (m.lowTrust)
    return (
      <State icon="alert" waiting>
        {t("memory.lowTrust")}
      </State>
    );
  return m.verified ? <State icon="check">{t("memory.verified")}</State> : null;
}

/**
 * One thing it learned (Aprendizados): its plain summary first, the technical detail folded under it; where, how
 * sure, how used; Editar (a person's version) or Esquecer.
 */
function LearnedRow({ m }: { m: Memory }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const act = useMemoryAction(org.id, agent.id);
  const [draft, setDraft] = useState<string | null>(null);
  const limit = useTextLimit(FIELD_LIMITS.memory);
  const tooLong = draft !== null && overLimit(draft, limit);
  const save = () =>
    draft !== null &&
    !tooLong &&
    act.mutate(
      { type: "edit", id: m.id, text: draft },
      {
        onSuccess: () => {
          setDraft(null);
          toast.show(t("agentPage.memory.saved"));
        },
      },
    );
  return (
    <li className="agp-mem" data-item-id={m.id}>
      {draft === null ? (
        m.summary ? (
          <>
            <span>{inlineWords(m.summary)}</span>
            <details className="agp-mem__details">
              <summary className="small muted">{t("agentPage.memory.details")}</summary>
              <p className="small">{memoryLine(t, m)}</p>
            </details>
          </>
        ) : (
          <span>{memoryLine(t, m)}</span>
        )
      ) : (
        <Locked when={act.isPending}>
          <Field label={t("agentPage.memory.edit")} id={`learned-${m.id}`}>
            <Textarea rows={3} limit={limit} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
        </Locked>
      )}
      <span className="agp-mem__meta">
        <Trust m={m} />
        {m.disputed && (
          <State icon="alert" waiting>
            {t("agentPage.memory.disputed")}
          </State>
        )}
        <span>
          {m.howTo ? t("agentPage.memory.howTo") : t(`memory.kinds.${m.kind}`)} · {usageLabel(t, m)} ·{" "}
          {m.channelId ? (
            <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: m.channelId }}>
              {memorySource(t, i18n.language, m)}
            </Link>
          ) : (
            memorySource(t, i18n.language, m)
          )}
        </span>
      </span>
      <span className="agp-row">
        {draft === null ? (
          <>
            {/* Tornar do time (ADR 0167): who reviews memory makes it every agent's, its copies archived. */}
            {can(org, "review_memory") && canMakeTeamMemory(m) && (
              <Button
                variant="link"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ type: "team", id: m.id }, { onSuccess: () => toast.show(t("teamMemory.made")) })
                }
              >
                {t("teamMemory.make")}
              </Button>
            )}
            <Button variant="link" onClick={() => setDraft(m.text)}>
              {t("agentPage.memory.edit")}
            </Button>
            <Button
              variant="link"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { type: "archive", id: m.id, archived: true },
                  { onSuccess: () => toast.show(t("agentPage.memory.forgotten")) },
                )
              }
            >
              {t("agentPage.memory.forget")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!draft.trim() || tooLong}
              loading={act.isPending}
              onClick={save}
            >
              {t("agentPage.memory.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t("agentPage.memory.cancel")}
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

/** Rules people gave it (who, when, the text), each with Remover for its giver, the agent's owner and admins. */
function RulesCard({ rules }: { rules: Memory[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const act = useMemoryAction(org.id, agent.id);
  return (
    <Card as="section" className="agp-card" aria-labelledby="mem-rules">
      <CardHead
        id="mem-rules"
        icon="flag"
        title={t("agentPage.memory.rules")}
        hint={{
          name: t("common.about", { label: t("agentPage.memory.rules") }),
          text: t(isRightHand(agent) ? "agentPage.memory.rulesNoteRightHand" : "agentPage.memory.rulesNote"),
        }}
      />
      <ul className="agp-list agp-mems">
        {rules.map((m) => (
          <li key={m.id} className="agp-mem" data-item-id={m.id}>
            <span>{memoryLine(t, m)}</span>
            <span className="agp-mem__meta">
              <span>
                {t("agentPage.memory.ruleBy", {
                  name: m.origin?.name ?? t("memory.origin.someone"),
                  date: formatShortDate(i18n.language, m.origin?.at ?? m.updatedAt),
                })}
              </span>
              {m.removable && (
                <Button
                  variant="link"
                  onClick={() =>
                    act.mutate(
                      { type: "archive", id: m.id, archived: true },
                      { onSuccess: () => toast.show(t("agentPage.memory.ruleRemoved")) },
                    )
                  }
                >
                  {t("agentPage.memory.removeRule")}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The right hand's learning, on top of its Memory tab: the person's own switch, Forget all (only their own), and for
 * who configures the workspace, the workspace's switch. Nobody reads anyone else's memories, admins included.
 */
function RightHandLearningCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const prefs = useTeamWeekPrefs(org.id).data;
  const setPrefs = useSetTeamWeekPrefs(org.id);
  const settings = useSettings(org.id).data;
  const setSettings = useUpdateSettings(org.id);
  const forget = useForgetRightHandLearned(org.id, agent.id);
  const [asking, setAsking] = useState(false);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const workspaceOn = settings?.rightHandLearns !== false;
  return (
    <Card as="section" className="agp-card" aria-labelledby="mem-learning">
      <CardHead id="mem-learning" icon="bulb" title={t("agentPage.memory.learning.title")} />
      <div className="settings-rows">
        <PrefRow
          id="mem-learn-mine"
          icon="person"
          label={t("agentPage.memory.learning.fromYou")}
          hint={t("agentPage.memory.learning.fromYouHint")}
          status={!workspaceOn ? t("agentPage.memory.learning.workspaceOff") : undefined}
          control={
            <Switch
              aria-label={t("agentPage.memory.learning.fromYou")}
              checked={workspaceOn && !prefs?.learnOff}
              disabled={!prefs || !workspaceOn}
              onCheckedChange={(on) => setPrefs.mutate({ learnOff: !on }, { onError: failed })}
            />
          }
        />
        <PrefRow
          id="mem-learn-forget"
          icon="trash"
          label={t("agentPage.memory.learning.forgetAll")}
          hint={t("agentPage.memory.learning.forgetAllHint")}
          control={
            <Button size="sm" variant="danger" onClick={() => setAsking(true)}>
              {t("agentPage.memory.forget")}
            </Button>
          }
        />
        {can(org, "configure") && settings && (
          <PrefRow
            id="mem-learn-workspace"
            icon="audienceEveryone"
            label={t("agentPage.memory.learning.workspace")}
            hint={t("agentPage.memory.learning.workspaceHint")}
            value={t("rightHand.settings.groupWorkspace")}
            control={
              <Switch
                aria-label={t("agentPage.memory.learning.workspace")}
                checked={workspaceOn}
                disabled={setSettings.isPending}
                onCheckedChange={(on) => setSettings.mutate({ rightHandLearns: on }, { onError: failed })}
              />
            }
          />
        )}
      </div>
      <Dialog
        open={asking}
        onOpenChange={(o) => !o && setAsking(false)}
        title={t("agentPage.memory.learning.forgetTitle")}
        description={t("agentPage.memory.learning.forgetText")}
        closeLabel={t("common.close")}
        width={460}
      >
        <DialogFooter>
          <Button disabled={forget.isPending} onClick={() => setAsking(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={forget.isPending}
            disabled={forget.isPending}
            onClick={() =>
              forget.mutate(undefined, {
                onSuccess: () => {
                  toast.show(t("agentPage.memory.learning.forgotten"));
                  setAsking(false);
                },
                onError: failed,
              })
            }
          >
            {t("agentPage.memory.learning.forgetAll")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

/**
 * The right hand's list in its groups ("Only you", "Everyone in #eng"); any other agent's as one list.
 */
function AudienceGroups({ list, row }: { list: Memory[]; row: (m: Memory) => ReactNode }) {
  const { t } = useTranslation();
  const { agent } = useAgentEdit();
  if (!isRightHand(agent)) return <ul className="agp-list agp-mems">{list.map(row)}</ul>;
  return (
    <div className="ac-groups">
      {memoryAudienceGroups(list).map((group) => {
        const title =
          group.key === "you"
            ? t("agentPage.memory.learning.onlyYou")
            : group.channel
              ? t("agentPage.memory.learning.everyoneIn", { channel: group.channel })
              : t("agentPage.memory.learning.everyone");
        return (
          <div key={group.key}>
            <GroupHeading level={3} title={title} />
            <ul className="agp-list agp-mems" aria-label={title}>
              {group.items.map(row)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * What the agent learned on its own, newest first: what matters to people (preferences, facts, decisions), then how
 * it works (its playbook: how-tos, lessons and notes it keeps for itself, none of them in the chat) and the skills it
 * made.
 */
function LearnedList({ list }: { list: Memory[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const skills = useLearnedSkills(org.id, agent.id).data ?? [];
  if (list.length === 0 && skills.length === 0)
    return (
      <EmptyState
        size="panel"
        agent={lookOf(agent) ?? true}
        title={t("agentPage.memory.learnedEmptyTitle")}
        actions={<AskAgentButton agent={agent} variant="primary" />}
      >
        {t("agentPage.memory.learnedEmpty")}
      </EmptyState>
    );
  const people = list.filter((m) => !m.playbook);
  const playbook = list.filter((m) => m.playbook);
  const how = t("agentPage.memory.playbook", g);
  return (
    <div className="ac-groups">
      {people.length > 0 && <AudienceGroups list={people} row={(m) => <LearnedRow key={m.id} m={m} />} />}
      {playbook.length > 0 && (
        <div>
          <GroupHeading
            level={3}
            title={
              <span className="ac-hintline">
                <span>{how}</span>
                <InfoHint name={t("common.about", { label: how })}>{t("agentPage.memory.playbookNote")}</InfoHint>
              </span>
            }
          />
          <ul className="agp-list agp-mems" aria-label={how}>
            {playbook.map((m) => (
              <LearnedRow key={m.id} m={m} />
            ))}
          </ul>
        </div>
      )}
      {skills.length > 0 && (
        // The skills it made are on its Skills tab, with the rest of what it knows.
        <p className="small muted">
          {t("skills.agentTab.madeMoved", { count: skills.length, ...g })}{" "}
          <Link
            className="ac-link"
            to="/org/$orgId/agents/$agentId"
            params={{ orgId: org.id, agentId: agent.id }}
            search={{ tab: "skills" }}
          >
            {t("skills.agentTab.seeSkills")}
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * Memory: changes the agent's review is weighing, then what the agent knows (facts and decisions, lessons, archived)
 * with search. `item`: the memory or skill a link opened it at.
 */
export function MemoryTab({ item }: { item?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const skills = useLearnedSkills(org.id, agent.id).data ?? [];
  const [picked, setKind] = useState<Kind | "learned" | null>(null);
  const [q, setQ] = useState("");
  const list = memory.data ?? [];
  // What a link named: its list shows until the person picks one, and it is landed on. What the agent learned goes
  // to Aprendizados, where it is edited or forgotten.
  const linked = list.find((m) => m.id === item);
  const linkedSkill = skills.some((s) => s.id === item);
  const linkedKind = linked?.learned && !linked.archived ? "learned" : linked ? memoryTabOf(linked) : null;
  const kind = picked ?? linkedKind ?? (linkedSkill ? "learned" : "known");
  const cols = useRef<HTMLDivElement>(null);
  useLandOn(cols, item, Boolean(linked));
  const navigate = useNavigate();
  useEffect(() => {
    if (linkedSkill && item)
      void navigate({ to: "/org/$orgId/skills/$skillId", params: { orgId: org.id, skillId: item }, replace: true });
  }, [linkedSkill, item, navigate, org.id]);
  const pending = pendingOnAgent(proposals.data ?? [], agent.id);
  // What the agents (or people) applied to it (ADR 0219), in Agent improvements.
  const applied = (proposals.data ?? []).filter((p) => p.agentId === agent.id && p.status === "accepted" && !p.stale);
  const learned = list
    .filter(
      (m) =>
        m.learned &&
        !m.archived &&
        (!q.trim() || `${m.summary ?? ""} ${m.text}`.toLowerCase().includes(q.trim().toLowerCase())),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (k: Kind | "learned") =>
    k === "learned" ? list.filter((m) => m.learned && !m.archived).length : filterMemories(list, k, "").length;
  const shown = kind === "learned" ? [] : filterMemories(list, kind, q);
  const rules = list.filter((m) => m.kind === "rule" && !m.archived);
  // The strip's "verificados" counts among the facts and decisions it sits under, not every memory.
  const known = filterMemories(list, "known", "");
  return (
    <>
      <section className="agp-memstats" aria-label={t("agentPage.memory.counts")}>
        {[
          {
            label: t("memory.tabs.known"),
            value: known.length,
            sub: t("agentPage.memory.verified", { count: known.filter((m) => m.verified).length }),
          },
          {
            label: t("agentPage.memory.lessons"),
            value: count("lessons"),
            sub: t(isRightHand(agent) ? "agentPage.memory.fromTeamRightHand" : "agentPage.memory.fromTeam"),
          },
          {
            label: t("agentPage.memory.improvements"),
            value: applied.length,
            sub: t("agentPage.memory.improvementsApplied"),
          },
        ].map((stat) => (
          <p key={stat.label} className="agp-memstat">
            <b className="ac-num">{stat.value}</b>
            <span>{stat.label}</span>
            <small>{stat.sub}</small>
          </p>
        ))}
      </section>
      <div className="agp-cols agp-cols--one" ref={cols}>
        <div className="agp-col">
          {pending.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
          {isRightHand(agent) && <RightHandLearningCard />}
          {rules.length > 0 && <RulesCard rules={rules} />}
          <Card as="section" className="agp-card" aria-labelledby="mem-known">
            <CardHead
              id="mem-known"
              icon="book"
              title={t("memory.title", g)}
              action={
                <Link
                  className="agp-more"
                  to="/org/$orgId/agents/$agentId/memory"
                  params={{ orgId: org.id, agentId: agent.id }}
                >
                  {t("agentPage.memory.full")}
                  <Icon name="arrowRight" size={14} />
                </Link>
              }
            />
            <Toolbar
              size="sm"
              search={
                <SearchField
                  size="sm"
                  aria-label={t("memory.search")}
                  placeholder={t("memory.search")}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                />
              }
            >
              <Segmented
                size="sm"
                label={t("memory.tabsLabel")}
                value={kind}
                onValueChange={setKind}
                options={(["known", "lessons", "learned", "archived"] as const).map((k) => ({
                  value: k,
                  label: t(
                    k === "lessons"
                      ? "agentPage.memory.lessons"
                      : k === "learned"
                        ? "agentPage.memory.learned"
                        : `memory.tabs.${k}`,
                  ),
                  // Shown only when there is something to count.
                  hint: count(k) || undefined,
                }))}
              />
            </Toolbar>
            {memory.isLoading ? (
              <LoadingLine width={260} />
            ) : memory.isError && !memory.data ? (
              <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
            ) : kind === "learned" ? (
              <LearnedList list={learned} />
            ) : shown.length === 0 ? (
              <NoMemories agent={agent} q={q} none={list.length === 0} onClear={() => setQ("")} />
            ) : (
              <AudienceGroups
                list={shown}
                row={(m) => (
                  <li key={m.id} className="agp-mem" data-item-id={m.id}>
                    <span>{memoryLine(t, m)}</span>
                    <span className="agp-mem__meta">
                      <Trust m={m} />
                      {m.pinned && <State icon="pin">{t("memory.pinned")}</State>}
                      <span>
                        {m.kind !== "fact" && kind !== "lessons" && `${t(`memory.kinds.${m.kind}`)} · `}
                        {usageLabel(t, m)} · {memorySource(t, i18n.language, m)}
                      </span>
                    </span>
                  </li>
                )}
              />
            )}
          </Card>
          <p className="page__note">
            <HelpLink slug="memory">{t("memory.how")}</HelpLink>
          </p>
        </div>
      </div>
    </>
  );
}
