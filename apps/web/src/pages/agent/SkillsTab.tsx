import type { AgentSkill, Skill } from "@agenteschat/client";
import {
  useAgentLearnsSkills,
  useAgentSkills,
  useSetAgentLearnsSkills,
  useSkillAction,
  useSkillSuggestions,
  useSkills,
} from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, Card, EmptyState, GroupHeading, Menu, MenuItem, Switch } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SkillMark, skillLine, skillTitle } from "@/components/skills/common";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";
import { ReadOnlyNote } from "./pieces";
import "@/components/skills/skills.css";

/**
 * What an agent knows: its skills as rows (what each is for and how often it used it this week), each taken away from
 * its "…" with Undo; the library's skills that would help it, from its week's work; and whether it learns on its
 * own. "Teach" opens Skills for this agent. Changes apply at once (no save bar), as on Skills.
 */
export function SkillsCard() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const { agent, g, can } = useAgentEdit();
  const editable = can("skills");
  const skills = useAgentSkills(org.id, agent.id);
  const library = useSkills(org.id);
  const suggestions = useSkillSuggestions(org.id, agent.id, editable);
  const learns = useAgentLearnsSkills(org.id, agent.id);
  const setLearns = useSetAgentLearnsSkills(org.id, agent.id);
  const action = useSkillAction(org.id);
  const mine = (skills.data ?? [])
    .filter((s) => s.enabled)
    .sort((a, b) => (b.agentWeekUses ?? 0) - (a.agentWeekUses ?? 0) || skillTitle(a).localeCompare(skillTitle(b)));
  const byId = new Map((library.data ?? []).map((s) => [s.id, s]));
  const offers = (suggestions.data ?? []).flatMap((o) => {
    const s = byId.get(o.skillId);
    return s && !mine.some((m) => m.id === s.id) ? [{ skill: s, why: o.why }] : [];
  });
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");

  const set = (s: Skill, on: boolean, undoable = true) =>
    action.mutate(
      { type: "assign", agentId: agent.id, skills: [{ skillId: s.id, enabled: on }] },
      {
        onSuccess: () => {
          if (!undoable) return;
          toast.show(
            t(on ? "skills.page.taught" : "skills.agentTab.removed", { skill: skillTitle(s), ...g }),
            "success",
            { label: t("skills.undo"), run: () => set(s, !on, false) },
          );
        },
      },
    );
  const teach = () => void navigate({ to: "/org/$orgId/skills", params: { orgId: org.id }, search: { for: agent.id } });
  const usage = (s: AgentSkill) => {
    const n = s.agentWeekUses ?? 0;
    if (n > 0) return t("skills.agentTab.week", { count: n });
    if (s.agentLastUsedAt)
      return t("skills.agentTab.lastUsed", { when: relativeTime(t, i18n.language, s.agentLastUsedAt) });
    return t("skills.agentTab.notYet");
  };
  // A MediaRow, as the other lists in an agent's cards: the face, the name over when to use it, its uses and actions.
  const row = (s: Skill, end: ReactNode, sub: ReactNode, by?: string) => (
    <li key={s.id} className="ac-mediarow sk-arow">
      <span className="ac-mediarow__face">
        <SkillMark skill={s} size="md" />
      </span>
      <span className="ac-mediarow__head">
        <span className="sk-arow__name">
          <Link className="sk-row__link" to="/org/$orgId/skills/$skillId" params={{ orgId: org.id, skillId: s.id }}>
            {skillTitle(s)}
          </Link>
          {by && <span className="sk-by">· {by}</span>}
        </span>
        <span className="ac-mediarow__meta">{sub}</span>
      </span>
      <span className="ac-mediarow__end ac-mediarow__end--wrap">{end}</span>
    </li>
  );

  return (
    <Card as="section" className="agp-card sk-agent" aria-labelledby="ac-skills">
      <CardHead
        id="ac-skills"
        icon="book"
        title={t("skills.agentTab.title", g)}
        subtitle={t("skills.agentTab.sub", g)}
        action={
          editable && (
            <Button size="sm" icon="plus" onClick={teach}>
              {t("skills.page.teach")}
            </Button>
          )
        }
      />
      {skills.isLoading ? (
        <LoadingList count={3} avatar={false} />
      ) : skills.isError ? (
        <span className="muted">{t("skills.unavailable")}</span>
      ) : mine.length === 0 ? (
        <EmptyState
          size="panel"
          agent={lookOf(agent) ?? true}
          title={t("skills.agentTab.emptyTitle", g)}
          actions={
            editable && (
              <Button variant="primary" icon="plus" onClick={teach}>
                {t("skills.page.teach")}
              </Button>
            )
          }
        >
          {t("skills.agentTab.empty", g)}
        </EmptyState>
      ) : (
        <ul className="sk-arows" aria-label={t("skills.agentTab.title", g)}>
          {mine.map((s) =>
            row(
              s,
              <>
                <span className="sk-state" data-s="muted">
                  {usage(s)}
                </span>
                <Menu
                  align="end"
                  label={t("agent.moreActions")}
                  trigger={
                    <Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("agent.moreActions")} />
                  }
                >
                  <MenuItem
                    icon="book"
                    onSelect={() =>
                      void navigate({ to: "/org/$orgId/skills/$skillId", params: { orgId: org.id, skillId: s.id } })
                    }
                  >
                    {t("skills.agentTab.open")}
                  </MenuItem>
                  {editable && (
                    <MenuItem icon="close" onSelect={() => set(s, false)}>
                      {t("skills.agentTab.takeAway", g)}
                    </MenuItem>
                  )}
                </Menu>
              </>,
              skillLine(s),
              s.ownerUserId
                ? s.ownerUserId === me.user.id
                  ? t("skills.page.onlyYours")
                  : t("skills.personal.of", { name: dir.memberById.get(s.ownerUserId)?.name ?? "" })
                : s.origin === "agent" && s.ownerAgentId === agent.id
                  ? t("skills.agentTab.learnedHere", g)
                  : undefined,
            ),
          )}
        </ul>
      )}
      {editable && offers.length > 0 && (
        <>
          <GroupHeading level={3} title={t("skills.agentTab.couldLearn")} className="sk-agent__group" />
          <ul className="sk-arows sk-arows--offer">
            {offers.map(({ skill: s, why }) =>
              row(
                s,
                <Button size="sm" disabled={action.isPending} onClick={() => set(s, true)}>
                  {t("skills.page.teach")}
                </Button>,
                why,
                s.agentIds?.[0]
                  ? t("skills.agentTab.usedBy", { name: nameOf(s.agentIds[0]) })
                  : t("skills.agentTab.team"),
              ),
            )}
          </ul>
        </>
      )}
      <div className="sk-agent__self">
        <Switch
          id="sk-learns"
          checked={learns.data ?? true}
          disabled={!editable}
          onCheckedChange={(on) => setLearns.mutate(on)}
        />
        <span>
          <label htmlFor="sk-learns">{t("skills.agentTab.learns", g)}</label>
          <small>{t("skills.agentTab.learnsHelp", g)}</small>
        </span>
      </div>
    </Card>
  );
}

/** The Skills tab: what the agent knows, what it could learn and whether it learns on its own. */
export function SkillsTab() {
  return (
    <>
      <ReadOnlyNote field="skills" />
      <SkillsCard />
    </>
  );
}
