import type { Actor, Issue, IssuePriority, IssuesView } from "@agenteschat/client";
import {
  DONE_RECENT_DAYS,
  ISSUE_CARD_FIELDS,
  ISSUES_DONE,
  ISSUES_GROUPS,
  ISSUES_SORTS,
  type IssuesViewChange,
  isDefaultIssuesView,
  issueAssigneeKeys,
  PRIORITY_ORDER,
} from "@agenteschat/client/lib/issues-view";
import {
  Button,
  FilterMenu,
  Icon,
  type IconName,
  MenuCheckboxItem,
  MenuHeading,
  MenuSeparator,
  Segmented,
  Switch,
} from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, NO_ACTOR, useActors } from "@/components/actors";
import { useFilterCopy } from "@/components/filters";
import { useOrg } from "@/components/org-context";
import { LayoutCards, ViewOptions } from "@/components/ViewOptions";

/** Each priority's mark: the chips', and a flag for the normal one (which has no chip). */
export const PRIORITY_ICON: Record<IssuePriority, IconName> = { high: "arrowUp", normal: "flag", low: "dash" };

const toggled = <V extends string>(list: V[], value: V) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * "Filtro" and the filters in use. One menu filters by assignee (me, each agent and person with a task here, nobody),
 * by priority and by label (the ones the tasks here have); each filter in use shows as a chip that opens the same menu, with a × to take it off.
 */
export function IssueFilters({
  view,
  issues,
  onChange,
}: {
  view: IssuesView;
  /** The tasks loaded: who has one is who the menu offers. */
  issues: Issue[];
  onChange: (change: IssuesViewChange) => void;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const actors = useActors();
  const copy = useFilterCopy();
  const mine: Actor = { type: "person", id: me.user.id };
  const keys = new Set([...issues.flatMap(issueAssigneeKeys), ...view.assignees]);
  keys.delete(actorKey(mine));
  keys.delete(NO_ACTOR);
  // Agents first, then people, each by name.
  const kind = (a: Actor) => (a.type === "agent" ? 0 : 1);
  const others = [...keys]
    .map((k) => actorFromKey(k))
    .filter((a): a is Actor => a !== null)
    .sort((a, b) => kind(a) - kind(b) || actors.name(a).localeCompare(actors.name(b), i18n.language));
  const nameOf = (key: string) => {
    const actor = actorFromKey(key);
    return actor ? actors.name(actor) : t("issues.noAssignee");
  };
  const labels = [...new Set([...issues.flatMap((i) => i.labels), ...view.labels])].sort((a, b) =>
    a.localeCompare(b, i18n.language),
  );
  const who: { key: string; label: string; actor: Actor | null }[] = [
    { key: actorKey(mine), label: t("issues.me"), actor: mine },
    ...others.map((a) => ({ key: actorKey(a), label: actors.name(a), actor: a })),
    { key: NO_ACTOR, label: t("issues.noAssignee"), actor: null },
  ];
  const items = (
    <>
      <MenuHeading>{t("issues.assigneeFilter")}</MenuHeading>
      {who.map((o) => (
        <MenuCheckboxItem
          key={o.key}
          checked={view.assignees.includes(o.key)}
          onCheckedChange={() => onChange({ assignees: toggled(view.assignees, o.key) })}
          leading={
            o.actor ? <ActorAvatar actor={o.actor} name={o.label} size="xs" /> : <Icon name="person" size={16} />
          }
        >
          {o.label}
        </MenuCheckboxItem>
      ))}
      <MenuSeparator />
      <MenuHeading>{t("issues.priorityFilter")}</MenuHeading>
      {PRIORITY_ORDER.map((p) => (
        <MenuCheckboxItem
          key={p}
          icon={PRIORITY_ICON[p]}
          checked={view.priorities.includes(p)}
          onCheckedChange={() => onChange({ priorities: toggled(view.priorities, p) })}
        >
          {t(`issues.priority.${p}`)}
        </MenuCheckboxItem>
      ))}
      {labels.length > 0 && (
        <>
          <MenuSeparator />
          <MenuHeading>{t("issues.labelFilter")}</MenuHeading>
          {labels.map((l) => (
            <MenuCheckboxItem
              key={l}
              checked={view.labels.includes(l)}
              onCheckedChange={() => onChange({ labels: toggled(view.labels, l) })}
            >
              {l}
            </MenuCheckboxItem>
          ))}
        </>
      )}
    </>
  );
  const chips: { key: string; icon: IconName; filter: string; value: string; clear: () => void }[] = [
    ...view.assignees.map((k) => ({
      key: k,
      icon: "person" as const,
      filter: t("issues.assigneeFilter"),
      value: nameOf(k),
      clear: () => onChange({ assignees: view.assignees.filter((x) => x !== k) }),
    })),
    ...view.priorities.map((p) => ({
      key: p,
      icon: "alert" as const,
      filter: t("issues.priorityFilter"),
      value: t(`issues.priority.${p}`),
      clear: () => onChange({ priorities: view.priorities.filter((x) => x !== p) }),
    })),
    ...view.labels.map((l) => ({
      key: `label:${l}`,
      icon: "pin" as const,
      filter: t("issues.labelFilter"),
      value: l,
      clear: () => onChange({ labels: view.labels.filter((x) => x !== l) }),
    })),
  ];
  return (
    <FilterMenu
      label={t("issues.filters")}
      buttonText={t("issues.filterButton")}
      chips={chips.map((c) => ({
        key: c.key,
        icon: c.icon,
        text: t("issues.filterValue", { filter: c.filter, value: c.value }),
        clearLabel: copy.clearOf(c.value),
        clear: c.clear,
      }))}
    >
      {items}
    </FilterMenu>
  );
}

/**
 * "Exibição": the button reads the layout and the grouping ("Quadro · Etapa") and opens the choices: board or list,
 * group by stage, assignee or priority, the order inside each group, what the cards show, which finished tasks show,
 * canceled tasks, groups with no task. Every
 * change is kept for the person in this workspace at once; "Voltar ao padrão" when it differs from the default.
 */
export function DisplayButton({
  view,
  onChange,
}: {
  view: IssuesView;
  /** `null`: back to the default. */
  onChange: (change: IssuesViewChange | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const layoutName = t(view.layout === "board" ? "issues.board" : "issues.list");
  const groupName = t(`issues.display.by.${view.group}`);
  return (
    <ViewOptions
      label={t("issues.display.title")}
      buttonLabel={t("issues.display.label", { layout: layoutName, group: groupName })}
      icon={view.layout === "board" ? "grid" : "list"}
      layout={layoutName}
      detail={groupName}
    >
      <LayoutCards
        label={t("issues.display.layout")}
        value={view.layout}
        onChange={(layout) => onChange({ layout })}
        options={(["board", "list"] as const).map((l) => ({
          value: l,
          label: t(l === "board" ? "issues.board" : "issues.list"),
          picture: l,
        }))}
      />
      <div className="view-options__row">
        <span className="view-options__label">{t("issues.display.group")}</span>
        <Segmented
          size="sm"
          label={t("issues.display.group")}
          value={view.group}
          onValueChange={(group) => onChange({ group })}
          options={ISSUES_GROUPS.map((g) => ({ value: g, label: t(`issues.display.by.${g}`) }))}
        />
      </div>
      <div className="view-options__row view-options__row--col">
        <span className="view-options__label">{t("issues.display.sort")}</span>
        <Segmented
          size="sm"
          label={t("issues.display.sort")}
          value={view.sort}
          onValueChange={(sort) => onChange({ sort })}
          options={ISSUES_SORTS.map((s) => ({ value: s, label: t(`issues.display.order.${s}`) }))}
        />
      </div>
      <div className="view-options__row view-options__row--col">
        <span className="view-options__label" id={`${id}-fields`}>
          {t("issues.display.fields")}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggles that read their group's name, not a fieldset */}
        <div className="view-options__fields" role="group" aria-labelledby={`${id}-fields`}>
          {ISSUE_CARD_FIELDS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant="ghost"
              icon={view.fields[f] ? "check" : undefined}
              aria-pressed={view.fields[f]}
              onClick={() => onChange({ fields: { ...view.fields, [f]: !view.fields[f] } })}
            >
              {t(`issues.display.field.${f}`)}
            </Button>
          ))}
        </div>
      </div>
      <div className="view-options__row view-options__row--col">
        <span className="view-options__label">{t("issues.display.done")}</span>
        <Segmented
          size="sm"
          label={t("issues.display.done")}
          value={view.done}
          onValueChange={(done) => onChange({ done })}
          options={ISSUES_DONE.map((d) => ({
            value: d,
            label: t(`issues.display.doneIs.${d}`, { days: DONE_RECENT_DAYS }),
          }))}
        />
      </div>
      <div className="view-options__row">
        <label className="view-options__label" htmlFor={`${id}-canceled`}>
          {t("issues.showCanceled")}
        </label>
        <Switch
          id={`${id}-canceled`}
          checked={view.showCanceled}
          onCheckedChange={(showCanceled) => onChange({ showCanceled })}
        />
      </div>
      <div className="view-options__row">
        <label className="view-options__label" htmlFor={`${id}-empty`}>
          {t("issues.display.hideEmpty")}
        </label>
        <Switch id={`${id}-empty`} checked={view.hideEmpty} onCheckedChange={(hideEmpty) => onChange({ hideEmpty })} />
      </div>
      <div className="view-options__foot">
        <span>
          <Icon name="check" size={14} />
          {t("issues.display.saved")}
        </span>
        {!isDefaultIssuesView(view) && (
          <button type="button" className="ac-link view-options__reset" onClick={() => onChange(null)}>
            {t("issues.display.reset")}
          </button>
        )}
      </div>
    </ViewOptions>
  );
}
