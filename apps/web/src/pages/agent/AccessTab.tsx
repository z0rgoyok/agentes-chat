import { useAgentAccess, useCatalog, useTakeConnectionOffAgent } from "@agenteschat/client";
import { type AccessResource, asksAt, LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import { errorText } from "@agenteschat/client/lib/errors";
import { can as orgCan } from "@agenteschat/client/lib/permissions";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button, Card, EmptyState, Icon, Menu, MenuItem, SearchField, Segmented, Toolbar } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LevelRow,
  levelText,
  NoConnectors,
  ResourceIcon,
  resourceName,
  toolLabel,
  useConnectedById,
} from "@/components/AccessLevels";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { LoadingLine } from "@/components/Loading";
import { PersonalOf } from "@/components/OwnerScope";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useFocusHome } from "@/hooks/useFocusHome";
import { SKILLS_AREA } from "@/lib/agent-edit";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { ApprovalRulesCard } from "./ApprovalRulesCard";
import { ApprovalsLevelCard } from "./ApprovalsLevelCard";
import { CardHead, ChangedTag, useAgentEdit, WasLine } from "./context";
import { DatabaseAccessCard } from "./DatabaseAccess";
import { MailAccessCard } from "./MailAccess";
import { ReadOnlyNote } from "./pieces";
import { MergeReposBlock, ReposBlock } from "./Repos";
import { SkillsCard } from "./SkillsTab";

type AccessFilter = "all" | "on" | "ask";

/**
 * Ferramentas e acesso: one level per connector and built-in area. Saved with the save bar. The skills, and the
 * level of their built-in area, have a tab of their own (`SkillsTab`). In a personal workspace (ADR 0159 §3) it comes
 * in two parts: `basic` (its apps and mailboxes, the "Can use" tab) and `advanced` (built-in areas, databases, rules
 * and skills, in the Advanced tab). Connections: the team's, then the
 * viewer's own personal ones; another person's personal one the agent holds shows, for who may take it off, with
 * only Desligar (ADR 0099 addendum).
 */
export function AccessTab({ part = "all" }: { part?: "all" | "basic" | "advanced" }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const { agent, g, viewer, draft, setLevel, can, changeOf, resources: every, accessState } = useAgentEdit();
  // The skills' own level is on the Skills tab; Advanced, which holds the skills too, keeps it with the other areas.
  const resources = part === "advanced" ? every : every.filter((r) => r.id !== SKILLS_AREA);
  // Other people's personal connections this agent holds, for who may take them off (`seesOthersOnAgent`).
  const seesOthers = viewer !== "member" || orgCan(org, "manage_connectors");
  const othersTree = useAgentAccess(org.id, agent.id, seesOthers, { others: true });
  const theirs = seesOthers
    ? (othersTree.data?.connectors ?? []).filter((c) => c.ownerUserId && c.ownerUserId !== me.user.id)
    : [];
  const items = useConnectedById();
  const personalOf = (r: AccessResource) => Boolean(r.connectionId && items.get(r.connectionId)?.ownerUserId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const editable = can("levels");
  const level = (r: AccessResource) => draft.levels[r.id] ?? "none";
  const isGithub = (r: AccessResource) => r.kind === "connector" && r.connector === "github";
  const asksOf = (r: AccessResource) => asksAt(r, level(r)).map((x) => toolLabel(t, r, x));
  const needle = q.trim().toLowerCase();
  const shown = resources.filter((r) => {
    if (needle && !resourceName(t, r, items).toLowerCase().includes(needle)) return false;
    if (filter === "on") return level(r) !== "none";
    if (filter === "ask") return asksOf(r).length > 0;
    return true;
  });
  // Someone else's connection here is on (the agent holds it) and asks its person, never this page.
  const theirsShown = filter === "ask" ? [] : theirs.filter((c) => !needle || c.label.toLowerCase().includes(needle));
  const count = {
    all: resources.length + theirs.length,
    on: resources.filter((r) => level(r) !== "none").length + theirs.length,
    ask: resources.filter((r) => asksOf(r).length > 0).length,
  };
  // The team's first, then the viewer's own personal ones.
  const connectors = shown
    .filter((r) => r.kind === "connector")
    .sort((a, b) => Number(personalOf(a)) - Number(personalOf(b)));
  const noConnectors = resources.every((r) => r.kind !== "connector") && theirs.length === 0;
  const builtins = shown.filter((r) => r.kind === "builtin");
  const row = (r: AccessResource) => {
    const name = resourceName(t, r, items);
    const key = `levels:${r.id}`;
    const changed = Boolean(changeOf(key));
    return (
      <LevelRow
        key={r.id}
        icon={<ResourceIcon resource={r} items={items} name={name} />}
        name={name}
        hint={personalOf(r) ? t("connectors.personal.worksWhenAsked") : levelText(t, r, level(r), g)}
        asks={asksOf(r)}
        levels={r.levels}
        value={level(r)}
        onChange={editable ? (l) => setLevel(r.id, l) : undefined}
        changed={changed || (isGithub(r) && Boolean(changeOf("repos")))}
        tag={changed ? <ChangedTag changeKey={key} /> : undefined}
        // Under the name, where its lines start: a long name keeps its tile beside its own lines only.
        meta={
          personalOf(r) ? (
            <span className="level-row__owner ac-iconline">
              <Icon name="lock" size={14} />
              <span>{t("vault.tab.personal")}</span>
            </span>
          ) : undefined
        }
        extra={changed ? <WasLine changeKey={key} /> : undefined}
        below={
          isGithub(r) && level(r) !== "none" ? (
            <>
              <ReposBlock />
              <MergeReposBlock />
            </>
          ) : undefined
        }
      />
    );
  };
  const empty = (
    <EmptyState
      size="inline"
      actions={
        <Button
          size="sm"
          onClick={() => {
            setQ("");
            setFilter("all");
          }}
        >
          {t("filters.clearAll")}
        </Button>
      }
    >
      {needle ? t("agentPage.access.noMatch", { q }) : t("agentPage.access.noneHere")}
    </EmptyState>
  );
  // The team's connectors at once: a personal one stays at what its person chose.
  const allConnectors = (l: Level) => {
    for (const r of resources) if (r.kind === "connector" && !personalOf(r) && r.levels.includes(l)) setLevel(r.id, l);
  };
  // It holds the viewer's own connections too: not "da <org>" (a personal workspace's own words stay).
  const connectorsTitle = isPersonal(org) ? t("agentPage.access.connectorsPersonal") : t("connectors.title");
  useFocusHome("ac-connectors-card", ["ac-connectors"]);
  const basic = part !== "advanced";
  const advanced = part !== "basic";
  return (
    <>
      {basic && <ReadOnlyNote field="levels" />}
      {part === "all" && (
        <Toolbar
          size="sm"
          search={
            <SearchField
              size="sm"
              aria-label={t("agentPage.access.search")}
              placeholder={t("agentPage.access.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
          }
        >
          <Segmented
            size="sm"
            label={t("agentPage.access.filter")}
            value={filter}
            onValueChange={setFilter}
            options={(["all", "on", "ask"] as const).map((f) => ({
              value: f,
              label: t(`agentPage.access.filters.${f}`),
              // What a filter narrows to. "Todos" needs no number, and without it the three fit a phone's width.
              hint: f === "all" ? undefined : count[f] || undefined,
            }))}
          />
        </Toolbar>
      )}
      <div className="agp-cols">
        <div className="agp-col">
          {accessState === "loading" ? (
            <Card className="agp-card">
              <LoadingLine width={260} />
            </Card>
          ) : accessState === "unavailable" ? (
            <Card className="agp-card">
              <span className="muted">{t("access.unavailable")}</span>
            </Card>
          ) : (
            <>
              {basic && (
                <Card as="section" id="ac-connectors-card" className="agp-card" aria-labelledby="ac-connectors">
                  <CardHead
                    id="ac-connectors"
                    icon="plug"
                    title={connectorsTitle}
                    hint={
                      advanced
                        ? { name: t("common.about", { label: connectorsTitle }), text: t("agentPage.access.fineTune") }
                        : undefined
                    }
                    // Every connector at once: a quiet action ending on the rows' own edge.
                    action={
                      editable &&
                      !noConnectors && (
                        <Menu
                          label={t("agentPage.access.setAll")}
                          trigger={<Button variant="link">{t("agentPage.access.setAll")}</Button>}
                        >
                          {LEVELS.map((l) => (
                            <MenuItem key={l} onSelect={() => allConnectors(l)}>
                              {t(`access.level.${l}`)}
                            </MenuItem>
                          ))}
                        </Menu>
                      )
                    }
                  />
                  {noConnectors ? (
                    <NoConnectors look={lookOf(agent) ?? true} />
                  ) : connectors.length + theirsShown.length ? (
                    <ul className="level-list" aria-label={t("access.kind.connectors")}>
                      {connectors.map(row)}
                      <OthersPersonalRows agent={agent} rows={theirsShown} />
                    </ul>
                  ) : (
                    empty
                  )}
                  {viewer === "admin" && !needle && !noConnectors && (
                    <Link
                      className="newag__addrow ac-iconline"
                      to="/org/$orgId/settings/$section"
                      params={{ orgId: org.id, section: "connectors" }}
                    >
                      <Icon name="plug" />
                      {t("newAgent.connectOther")}
                    </Link>
                  )}
                </Card>
              )}
              {basic && <MailAccessCard />}
              {advanced && <DatabaseAccessCard />}
              {advanced && (
                <Card as="section" className="agp-card" aria-labelledby="ac-builtin">
                  <CardHead id="ac-builtin" icon="agent" title={t("agentPage.access.builtin")} />
                  {builtins.length ? (
                    <ul className="level-list" aria-label={t("access.kind.builtin")}>
                      {builtins.map(row)}
                    </ul>
                  ) : (
                    empty
                  )}
                </Card>
              )}
            </>
          )}
        </div>
        <div className="agp-col">
          {basic && <ApprovalsLevelCard />}
          {advanced && <ApprovalRulesCard />}
          {part === "advanced" && <SkillsCard />}
        </div>
      </div>
    </>
  );
}

/**
 * Other people's personal connections this agent holds: whose each is, and Desligar, for who manages connectors or
 * agents and the agent's owner. Their tools and level stay their person's, so the row shows none.
 */
function OthersPersonalRows({
  agent,
  rows,
}: {
  agent: { id: string; name: string };
  rows: { connectionId: string; connector: string; label: string; ownerUserId?: string | null }[];
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const catalog = useCatalog();
  const dir = useDirectory(org.id);
  const takeOff = useTakeConnectionOffAgent(org.id);
  return rows.map((c) => {
    const def = catalog.data?.connectors.find((d) => d.id === c.connector) ?? null;
    const owner = (c.ownerUserId && dir.memberById.get(c.ownerUserId)?.name) || t("channel.unknownPerson");
    return (
      <li key={c.connectionId} className="level-row level-row--meta ac-mediarow">
        <span className="ac-mediarow__face">
          <ConnectorIcon def={def} label={c.label} />
        </span>
        <span className="ac-mediarow__head">
          <span className="level-row__name">{c.label}</span>
          <span className="ac-mediarow__meta level-row__owner ac-iconline">
            <Icon name="lock" size={14} />
            <PersonalOf name={owner} />
          </span>
        </span>
        <span className="ac-mediarow__end">
          <Button
            size="sm"
            aria-label={t("connectors.personal.turnOffName", { name: c.label })}
            disabled={takeOff.isPending}
            loading={takeOff.isPending && takeOff.variables?.connectionId === c.connectionId}
            onClick={() =>
              takeOff.mutate(
                { connectionId: c.connectionId, agentId: agent.id },
                {
                  onSuccess: () => toast.show(t("connectors.personal.takenOff", { name: c.label, agent: agent.name })),
                  onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
                },
              )
            }
          >
            {t("connectors.personal.turnOff")}
          </Button>
        </span>
      </li>
    );
  });
}
