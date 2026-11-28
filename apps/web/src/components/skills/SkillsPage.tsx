import type { Skill } from "@agenteschat/client";
import { useAgentSkills, useSkillAction, useSkillSettings, useSkills } from "@agenteschat/client";
import { cardInstallAgent, cardInstallOf } from "@agenteschat/client/lib/action-cards";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { skillRemovalText, skillScopes, skillsSplit } from "@agenteschat/client/lib/skills";
import {
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  Icon,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  PageHeader,
  SearchField,
  Select,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { InstallSkillDialog } from "@/components/Skills";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { SkillFaces, SkillMark, skillLine, skillTitle } from "./common";
import { TeachSkillDialog } from "./TeachSkillDialog";
import "./skills.css";

type Filter = "all" | "agents" | "mine";

/** The GitHub repository a skill was installed from (`owner/repo`), to group the skills of one together. */
const repoOf = (s: Pick<Skill, "source" | "sourceUrl">) => {
  if (s.source !== "url" || !s.sourceUrl) return null;
  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(s.sourceUrl);
  return m ? `${m[1]}/${m[2]?.replace(/\.git$/, "")}` : null;
};

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Skills, a page of its own: what the team knows, by how much the agents used it this week, each with who knows it.
 * "For" picks an agent: then each row says whether it already knows the skill, or teaches it in one click. "Teach
 * something new" writes a skill from the person's own words; a GitHub link or a .zip still come in from the footer.
 * `install`/`connected`/`agent`: back from connecting GitHub while reading a link (the dialog reads it again).
 */
export function SkillsPage({
  forAgentId,
  install,
  connected,
  agent: cardAgent,
  teach: teachAtStart = false,
}: {
  forAgentId?: string;
  install?: string;
  connected?: string;
  agent?: string;
  teach?: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const admin = can(org, "manage_agents");
  const dir = useDirectory(org.id);
  const skills = useSkills(org.id);
  const settings = useSkillSettings(org.id, admin);
  const action = useSkillAction(org.id);
  const look = useRightHandLook();
  const forAgent = forAgentId ? dir.agentById.get(forAgentId) : undefined;
  const agentSkills = useAgentSkills(org.id, forAgentId ?? "", Boolean(forAgent));
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [teaching, setTeaching] = useState(teachAtStart);
  const [installing, setInstalling] = useState<"github" | "zip" | null>(install ? "github" : null);
  const [returned, setReturned] = useState(install);
  // Kept from the first render: the address loses `connected` once it is cleaned up below, before GitHub's
  // connections have loaded for its confirmation.
  const [returnedConnected] = useState(connected === "github");
  const [returnedFor] = useState(() =>
    cardInstallAgent(cardInstallOf(sessionStore.get(STORAGE_KEYS.skillInstallFor)), install, cardAgent),
  );
  const [removing, setRemoving] = useState<Skill | null>(null);
  /** The repositories whose skills are open in the list. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (install) {
      sessionStore.remove(STORAGE_KEYS.skillInstallFor);
      void navigate({
        to: ".",
        search: (s: Record<string, unknown>) => ({ ...s, install: undefined, connected: undefined, agent: undefined }),
        replace: true,
      });
    }
  }, [install, navigate]);

  const everything = skills.data ?? [];
  const scopes = skillScopes(everything, me.user.id);
  const split = skillsSplit(dir.members.length, everything);
  // Who may add: the team's library is who manages agents'; anyone keeps skills of their own where skills split.
  const mayTeach = admin || split;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const personName = (id: string) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson");
  const has = new Set((agentSkills.data ?? []).filter((s) => s.enabled).map((s) => s.id));

  const listed = useMemo(() => {
    const pool = forAgent ? [...scopes.team, ...scopes.mine] : [...scopes.team, ...scopes.mine, ...scopes.others];
    const query = fold(q.trim());
    return pool
      .filter((s) => !query || fold(`${skillTitle(s)} ${s.name} ${s.summary ?? ""} ${s.description}`).includes(query))
      .sort((a, b) => (b.weekUses ?? 0) - (a.weekUses ?? 0) || skillTitle(a).localeCompare(skillTitle(b)));
  }, [scopes.team, scopes.mine, scopes.others, q, forAgent]);
  const learned = listed.filter((s) => s.origin === "agent");
  const mine = listed.filter((s) => s.ownerUserId === me.user.id);
  const shown = filter === "agents" ? learned : filter === "mine" ? mine : listed;

  const teach = (s: Skill) => {
    if (!forAgent) return;
    action.mutate(
      { type: "assign", agentId: forAgent.id, skills: [{ skillId: s.id, enabled: true }] },
      {
        onSuccess: () =>
          toast.show(t("skills.page.taught", { skill: skillTitle(s), ...agentGrammar(forAgent.name) }), "success", {
            label: t("skills.undo"),
            run: () =>
              action.mutate({ type: "assign", agentId: forAgent.id, skills: [{ skillId: s.id, enabled: false }] }),
          }),
      },
    );
  };

  const stateOf = (s: Skill) => {
    if (s.pendingUpdate && !s.pendingUpdate.dismissed)
      return (
        <span className="sk-state" data-s="wait">
          {t(s.pendingUpdate.edited ? "skills.page.chooseVersion" : "skills.waitingChip")}
        </span>
      );
    return null;
  };
  const byLine = (s: Skill) => {
    if (s.ownerUserId)
      return (
        <span className="sk-by">
          ·{" "}
          {s.ownerUserId === me.user.id
            ? t("skills.page.onlyYours")
            : t("skills.personal.of", { name: personName(s.ownerUserId) })}
        </span>
      );
    if (s.origin === "agent" && s.ownerAgentId)
      return <span className="sk-by">· {t("skills.page.learnedBy", agentGrammar(nameOf(s.ownerAgentId)))}</span>;
    return null;
  };

  const row = (s: Skill, inGroup = false) => {
    const others = Boolean(s.ownerUserId && s.ownerUserId !== me.user.id);
    const weekUses = s.weekUses ?? 0;
    return (
      <li key={s.id} className="sk-row" data-for={forAgent ? true : undefined} data-in-group={inGroup || undefined}>
        <SkillMark skill={s} />
        <span className="sk-row__text">
          <span className="sk-row__name ac-captop">
            {others ? (
              <b>{skillTitle(s)}</b>
            ) : (
              <Link className="sk-row__link" to="/org/$orgId/skills/$skillId" params={{ orgId: org.id, skillId: s.id }}>
                {skillTitle(s)}
              </Link>
            )}
            {byLine(s)}
          </span>
          {!others && <small>{skillLine(s)}</small>}
        </span>
        <SkillFaces ids={s.agentIds ?? []} nameOf={nameOf} />
        {!forAgent && (
          <span className="sk-num tabular" data-zero={weekUses === 0 || undefined}>
            {weekUses > 0 ? weekUses : "—"}
          </span>
        )}
        <span className="sk-row__end">
          {forAgent ? (
            has.has(s.id) ? (
              <span className="sk-state" data-s="ok">
                {t("skills.page.knows")}
              </span>
            ) : (
              <Button size="sm" disabled={action.isPending} onClick={() => teach(s)}>
                {t("skills.page.teach")}
              </Button>
            )
          ) : others && admin ? (
            <Menu
              align="end"
              label={t("agent.moreActions")}
              trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("agent.moreActions")} />}
            >
              <MenuItem icon="trash" danger onSelect={() => setRemoving(s)}>
                {t("skills.remove")}
              </MenuItem>
            </Menu>
          ) : (
            stateOf(s)
          )}
        </span>
      </li>
    );
  };

  /** A repository's skills in one line (`owner/repo · N skills`), opening to them; one skill alone stays a row. */
  const groupRow = (repo: string, skills: Skill[]) => {
    const open = opened.has(repo);
    const who = [...new Set(skills.flatMap((s) => s.agentIds ?? []))];
    const uses = skills.reduce((n, s) => n + (s.weekUses ?? 0), 0);
    return [
      <li key={`repo:${repo}`} className="sk-row sk-group" data-for={forAgent ? true : undefined}>
        <span className="connector-icon connector-icon--mono connector-icon--lg sk-mark" aria-hidden="true">
          <Icon name="repo" size={20} />
        </span>
        <span className="sk-row__text">
          <span className="sk-row__name ac-captop">
            <b>{repo}</b>
            <span className="sk-by">· {t("skills.page.inRepo", { count: skills.length })}</span>
          </span>
          <small>{skills.map(skillTitle).join(", ")}</small>
        </span>
        <SkillFaces ids={who} nameOf={nameOf} />
        {!forAgent && (
          <span className="sk-num tabular" data-zero={uses === 0 || undefined}>
            {uses > 0 ? uses : "—"}
          </span>
        )}
        {/* Opens the repository's skills: the chevron, and the whole row through it. */}
        <span className="sk-row__end">
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={open ? "chevronUp" : "chevronDown"}
            className="sk-group__toggle"
            aria-label={repo}
            aria-expanded={open}
            onClick={() =>
              setOpened((o) => {
                const next = new Set(o);
                if (open) next.delete(repo);
                else next.add(repo);
                return next;
              })
            }
          />
        </span>
      </li>,
      ...(open ? skills.map((s) => row(s, true)) : []),
    ];
  };
  /** Rows in the list's order, the skills of one repository together under its line. */
  const rows = (items: Skill[]) => {
    const byRepo = new Map<string, Skill[]>();
    for (const s of items) {
      const repo = repoOf(s);
      if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), s]);
    }
    const done = new Set<string>();
    return items.flatMap((s) => {
      const repo = repoOf(s);
      const group = repo ? byRepo.get(repo) : undefined;
      if (!repo || !group || group.length < 2 || q.trim()) return [row(s)];
      if (done.has(repo)) return [];
      done.add(repo);
      return groupRow(repo, group);
    });
  };

  const list = (items: Skill[]) =>
    items.length === 0 ? (
      <p className="small muted sk-none">{q ? t("skills.noResults", { q }) : t("skills.page.noneHere")}</p>
    ) : (
      <ul className="sk-list" aria-label={t("skills.title")}>
        <li className="sk-colhead" aria-hidden="true">
          <span>{t("skills.page.colSkill")}</span>
          <span>{t("skills.page.colWho")}</span>
          {!forAgent && <span>{t("skills.page.colWeek")}</span>}
          <span />
        </li>
        {rows(items)}
      </ul>
    );

  const teachButton = mayTeach && (
    <Button variant="primary" icon="plus" onClick={() => setTeaching(true)}>
      {t("skills.page.teachNew")}
    </Button>
  );
  const agentOptions = [
    { value: "", label: t("skills.page.forEveryone") },
    ...dir.agents.map((a) => ({
      value: a.id,
      label: a.name,
      leading: <AgentAvatar agentId={a.id} name={a.name} size="xs" />,
    })),
  ];

  return (
    <div className="page page--full sk-page">
      <PageHeader
        title={t("skills.title")}
        meta={
          forAgent ? t("skills.page.metaFor", agentGrammar(forAgent.name)) : t("skills.page.meta", { org: org.name })
        }
        actions={
          <>
            <span className="sk-for">
              <span className="small muted">{t("skills.page.for")}</span>
              <Select
                aria-label={t("skills.page.for")}
                value={forAgent?.id ?? ""}
                onValueChange={(id) =>
                  void navigate({ to: "/org/$orgId/skills", params: { orgId: org.id }, search: id ? { for: id } : {} })
                }
                options={agentOptions}
              />
            </span>
            <SearchField
              className="sk-search"
              aria-label={t("skills.search")}
              placeholder={t("skills.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
            {!forAgent && (admin || mayTeach) && (
              <Menu
                align="end"
                label={t("agent.moreActions")}
                trigger={<Button variant="ghost" iconOnly icon="more" aria-label={t("agent.moreActions")} />}
              >
                {admin && settings.data && (
                  <MenuCheckboxItem
                    icon="bulb"
                    checked={settings.data.agentsImprove}
                    onCheckedChange={(on) => action.mutate({ type: "settings", settings: { agentsImprove: on } })}
                    description={t("skills.agentsImproveHelp")}
                  >
                    {t("skills.agentsImprove")}
                  </MenuCheckboxItem>
                )}
                {admin && settings.data && mayTeach && <MenuSeparator />}
                {mayTeach && (
                  <>
                    <MenuItem icon="link" onSelect={() => setInstalling("github")}>
                      {t("skills.page.fromLink")}
                    </MenuItem>
                    <MenuItem icon="upload" onSelect={() => setInstalling("zip")}>
                      {t("skills.page.fromZip")}
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
            {teachButton}
          </>
        }
      />

      {skills.isLoading && <LoadingList count={5} avatar={false} />}
      {skills.isSuccess && everything.length === 0 && (
        <EmptyState size="page" agent={look} title={t("skills.emptyTitle")} actions={teachButton}>
          {t("skills.emptyText")}
        </EmptyState>
      )}
      {skills.isSuccess &&
        everything.length > 0 &&
        (forAgent ? (
          list(listed)
        ) : (
          <Tabs
            value={filter}
            onValueChange={setFilter}
            label={t("skills.page.filters")}
            items={[
              { value: "all", label: t("skills.page.all"), count: listed.length },
              ...(learned.length > 0 || filter === "agents"
                ? [{ value: "agents" as const, label: t("skills.page.learned"), count: learned.length }]
                : []),
              ...(split ? [{ value: "mine" as const, label: t("skills.page.mine"), count: mine.length }] : []),
            ]}
          >
            <TabPanel value={filter}>{list(shown)}</TabPanel>
          </Tabs>
        ))}
      {mayTeach && everything.length > 0 && !forAgent && (
        <p className="small muted sk-foot">
          {t("skills.page.haveOne")}{" "}
          <button type="button" className="ac-link" onClick={() => setInstalling("github")}>
            {t("skills.page.fromLinkLower")}
          </button>{" "}
          {t("skills.page.or")}{" "}
          <button type="button" className="ac-link" onClick={() => setInstalling("zip")}>
            {t("skills.page.fromZipLower")}
          </button>
          .
        </p>
      )}

      <TeachSkillDialog
        open={teaching}
        onOpenChange={setTeaching}
        agentIds={forAgent ? [forAgent.id] : []}
        personalOnly={!admin}
        split={split}
        onSaved={(id) => void navigate({ to: "/org/$orgId/skills/$skillId", params: { orgId: org.id, skillId: id } })}
        onFromLink={() => {
          setTeaching(false);
          setInstalling("github");
        }}
        onFromZip={() => {
          setTeaching(false);
          setInstalling("zip");
        }}
      />
      <InstallSkillDialog
        open={installing !== null}
        only={installing ?? undefined}
        onOpenChange={(o) => {
          if (!o) {
            setInstalling(null);
            setReturned(undefined);
          }
        }}
        onInstalled={(id) =>
          void navigate({ to: "/org/$orgId/skills/$skillId", params: { orgId: org.id, skillId: id } })
        }
        initialUrl={returned}
        connected={returned !== undefined && returnedConnected}
        forAgentId={returned !== undefined ? returnedFor : forAgent?.id}
        scope={split ? (admin ? "team" : "personal") : undefined}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("skills.removeTitle", { name: removing ? skillTitle(removing) : "" })}
        description={skillRemovalText(t, [])}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={action.isPending}
            loading={action.isPending}
            onClick={() =>
              removing &&
              action.mutate(
                { type: "remove", id: removing.id },
                {
                  onSuccess: () => {
                    toast.show(t("skills.removed", { name: skillTitle(removing) }));
                    setRemoving(null);
                  },
                },
              )
            }
          >
            {t("skills.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
