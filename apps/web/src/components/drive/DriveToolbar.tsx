import type { ArtifactKind } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import {
  DRIVE_GROUPS,
  DRIVE_SORTS,
  type DriveGroup,
  type DriveSort,
  type DriveView,
  type DriveWho,
} from "@agenteschat/client/lib/drive";
import {
  FilterMenu,
  type FilterMenuChip,
  type FilterOption,
  MenuCheckboxItem,
  MenuHeading,
  MenuSeparator,
  Segmented,
} from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { LayoutCards, ViewOptions } from "@/components/ViewOptions";

const toggled = <V extends string>(list: V[], value: V) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * The Drive's "Filtro", as the Tasks' one: who made it (agents, people, or someone in particular), the kind (with how
 * many there are of each) and the channel, in one menu; each filter in use is a chip with a ×.
 */
export function DriveFilters({
  who,
  onWho,
  authors,
  onAuthors,
  actors,
  kinds,
  onKinds,
  kindCounts,
  channelIds,
  onChannels,
  channels,
}: {
  who: DriveWho;
  onWho: (who: DriveWho) => void;
  /** `agent:<id>` or `person:<id>`. */
  authors: string[];
  onAuthors: (authors: string[]) => void;
  /** Every agent and person, each with its avatar as `leading`. */
  actors: FilterOption[];
  kinds: ArtifactKind[];
  onKinds: (kinds: ArtifactKind[]) => void;
  /** The kinds there are, in order, each with how many. */
  kindCounts: { kind: ArtifactKind; count: number }[];
  channelIds: string[];
  onChannels: (ids: string[]) => void;
  channels: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const chip = (key: string, icon: FilterMenuChip["icon"], filter: string, value: string, clear: () => void) => ({
    key,
    icon,
    text: t("drive.filterValue", { filter, value }),
    clearLabel: t("filters.clear", { name: value }),
    clear,
  });
  const nameOf = (key: string) => actors.find((a) => a.value === key)?.label;
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name;
  // Agents or people: one at a time (both is everyone).
  const pickWho = (w: Exclude<DriveWho, "all">) => onWho(who === w ? "all" : w);
  const chips: FilterMenuChip[] = [
    ...(who === "all"
      ? []
      : [chip("who", who === "agents" ? "agent" : "person", t("drive.who"), t(`drive.${who}`), () => onWho("all"))]),
    ...authors.flatMap((key) => {
      const name = nameOf(key);
      return name
        ? [
            chip(key, key.startsWith("agent:") ? "agent" : "person", t("drive.who"), name, () =>
              onAuthors(authors.filter((a) => a !== key)),
            ),
          ]
        : [];
    }),
    ...kinds.map((k) =>
      chip(`kind:${k}`, KIND_ICON[k], t("drive.kind"), t(`drive.kindMany.${k}`), () =>
        onKinds(kinds.filter((x) => x !== k)),
      ),
    ),
    ...channelIds.flatMap((id) => {
      const name = channelName(id);
      return name
        ? [chip(`channel:${id}`, "channel", t("drive.channel"), `#${name}`, () => onChannels(toggled(channelIds, id)))]
        : [];
    }),
  ];
  return (
    <FilterMenu label={t("drive.filters")} buttonText={t("drive.filterButton")} chips={chips}>
      <MenuHeading>{t("drive.who")}</MenuHeading>
      <MenuCheckboxItem icon="agent" checked={who === "agents"} onCheckedChange={() => pickWho("agents")}>
        {t("drive.agents")}
      </MenuCheckboxItem>
      <MenuCheckboxItem icon="person" checked={who === "people"} onCheckedChange={() => pickWho("people")}>
        {t("drive.people")}
      </MenuCheckboxItem>
      {actors.map((a) => (
        <MenuCheckboxItem
          key={a.value}
          leading={a.leading}
          checked={authors.includes(a.value)}
          onCheckedChange={() => onAuthors(toggled(authors, a.value))}
        >
          {a.label}
        </MenuCheckboxItem>
      ))}
      {kindCounts.length > 0 && (
        <>
          <MenuSeparator />
          <MenuHeading>{t("drive.kind")}</MenuHeading>
          {kindCounts.map(({ kind, count }) => (
            <MenuCheckboxItem
              key={kind}
              icon={KIND_ICON[kind]}
              hint={count}
              checked={kinds.includes(kind)}
              onCheckedChange={() => onKinds(toggled(kinds, kind))}
            >
              {t(`drive.kindMany.${kind}`)}
            </MenuCheckboxItem>
          ))}
        </>
      )}
      {channels.length > 0 && (
        <>
          <MenuSeparator />
          <MenuHeading>{t("drive.channel")}</MenuHeading>
          {channels.map((c) => (
            <MenuCheckboxItem
              key={c.id}
              icon="channel"
              checked={channelIds.includes(c.id)}
              onCheckedChange={() => onChannels(toggled(channelIds, c.id))}
            >
              {c.name}
            </MenuCheckboxItem>
          ))}
        </>
      )}
    </FilterMenu>
  );
}

/** The Drive's "Exibição", as the Tasks' one: grid or list, what groups the files, their order. */
export function DriveDisplay({
  view,
  onView,
  group,
  onGroup,
  sort,
  onSort,
  iconOnly = false,
}: {
  view: DriveView;
  onView: (view: DriveView) => void;
  group: DriveGroup;
  onGroup: (group: DriveGroup) => void;
  sort: DriveSort;
  onSort: (sort: DriveSort) => void;
  /** Its icon alone (a phone's toolbar). */
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  const viewName = t(view === "grid" ? "drive.viewGrid" : "drive.viewList");
  const groupName = t(`drive.group.${group}`);
  return (
    <ViewOptions
      label={t("drive.display")}
      buttonLabel={t("drive.displayValue", { view: viewName, group: groupName })}
      icon={view === "grid" ? "grid" : "list"}
      layout={viewName}
      detail={groupName}
      iconOnly={iconOnly}
    >
      <LayoutCards
        label={t("drive.view")}
        value={view}
        onChange={onView}
        options={(["grid", "list"] as const).map((v) => ({
          value: v,
          label: t(v === "grid" ? "drive.viewGrid" : "drive.viewList"),
          picture: v,
        }))}
      />
      <div className="view-options__row view-options__row--col">
        <span className="view-options__label">{t("drive.groupBy")}</span>
        <Segmented
          size="sm"
          label={t("drive.groupBy")}
          value={group}
          onValueChange={onGroup}
          options={DRIVE_GROUPS.map((g) => ({ value: g, label: t(`drive.group.${g}`) }))}
        />
      </div>
      <div className="view-options__row view-options__row--col">
        <span className="view-options__label">{t("drive.sortBy")}</span>
        <Segmented
          size="sm"
          label={t("drive.sortBy")}
          value={sort}
          onValueChange={onSort}
          options={DRIVE_SORTS.map((s) => ({ value: s, label: t(`drive.sort.${s}`) }))}
        />
      </div>
    </ViewOptions>
  );
}
