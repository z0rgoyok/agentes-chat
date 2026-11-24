import { useAgentSkills } from "@agenteschat/client";
import { asksAt } from "@agenteschat/client/lib/access-levels";
import { Button, Card, Chip, EmptyState, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  LevelRow,
  levelText,
  ResourceIcon,
  resourceName,
  toolLabel,
  useConnectedById,
} from "@/components/AccessLevels";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SkillPicker } from "@/components/Skills";
import { SKILLS_AREA } from "@/lib/agent-edit";
import { lookOf } from "@/lib/look";
import { CardHead, ChangedTag, useAgentEdit, WasLine } from "./context";
import { ReadOnlyNote } from "./pieces";

/**
 * An agent's skills: the library as pills, saved with the save bar. `level` adds the built-in area's own level
 * (whether the agent uses its skills at all) on top; a personal workspace's Advanced keeps that row with the other
 * built-in areas.
 */
export function SkillsCard({ level = false }: { level?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, draft, set, setLevel, can, changeOf, resources } = useAgentEdit();
  const items = useConnectedById();
  const skills = useAgentSkills(org.id, agent.id);
  const library = skills.data ?? [];
  const enabled = new Set(draft.skills ?? []);
  const editable = can("skills") && draft.skills !== undefined;
  const area = level ? resources.find((r) => r.id === SKILLS_AREA) : undefined;
  const areaKey = `levels:${SKILLS_AREA}`;
  const areaChanged = Boolean(changeOf(areaKey));
  const areaLevel = draft.levels[SKILLS_AREA] ?? "none";
  return (
    <Card
      as="section"
      className="agp-card"
      data-changed={changeOf("skills") ? true : undefined}
      aria-labelledby="ac-skills"
    >
      <CardHead id="ac-skills" icon="book" title={t("skills.agentTitle")} changeKeys={["skills"]} lock="skills" />
      <span className="small muted">{t("newAgent.skillsHelp", g)}</span>
      {area && (
        <ul className="level-list" aria-label={t("access.kind.builtin")}>
          <LevelRow
            icon={<ResourceIcon resource={area} items={items} name={resourceName(t, area, items)} />}
            name={resourceName(t, area, items)}
            hint={levelText(t, area, areaLevel, g)}
            asks={asksAt(area, areaLevel).map((x) => toolLabel(t, area, x))}
            levels={area.levels}
            value={areaLevel}
            onChange={can("levels") ? (l) => setLevel(area.id, l) : undefined}
            changed={areaChanged}
            tag={areaChanged ? <ChangedTag changeKey={areaKey} /> : undefined}
            extra={areaChanged ? <WasLine changeKey={areaKey} /> : undefined}
          />
        </ul>
      )}
      {skills.isLoading ? (
        <LoadingLine width={200} />
      ) : skills.isError ? (
        <span className="muted">{t("skills.unavailable")}</span>
      ) : library.length === 0 ? (
        <EmptyState
          size="panel"
          agent={lookOf(agent) ?? true}
          title={t("skills.emptyTitle")}
          actions={
            can("skills") && (
              <Button asChild variant="primary" icon="plus">
                <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "skills" }}>
                  {t("skills.install")}
                </Link>
              </Button>
            )
          }
        >
          {t("skills.emptyText")}
        </EmptyState>
      ) : editable ? (
        <SkillPicker
          skills={library}
          selected={enabled}
          onChange={(next) => set("skills", [...next].sort())}
          idPrefix="agp-skill"
        />
      ) : enabled.size > 0 ? (
        <span className="agp-chips">
          {library
            .filter((s) => enabled.has(s.id))
            .map((s) => (
              <Chip key={s.id} icon="book">
                {s.name}
              </Chip>
            ))}
        </span>
      ) : (
        <span className="small muted">{t("skills.agentEmpty", { name: agent.name })}</span>
      )}
      <WasLine changeKey="skills" />
      {can("skills") && library.length > 0 && (
        <Link className="agp-more" to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "skills" }}>
          <Icon name="book" size={14} />
          {t("agentPage.access.library")}
        </Link>
      )}
    </Card>
  );
}

/** The Skills tab: the agent's skills and whether it uses them. */
export function SkillsTab() {
  return (
    <>
      <ReadOnlyNote field="skills" />
      <SkillsCard level />
    </>
  );
}
