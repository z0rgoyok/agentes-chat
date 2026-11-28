import type { VaultItem, VaultItemKind, VaultScope } from "@agenteschat/client";
import { useVault } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  List,
  Menu,
  MenuItem,
  PageHeader,
  SearchField,
  Segmented,
  Select,
  Toolbar,
} from "@agenteschat/ui";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SelectionBar } from "@/components/SelectionBar";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import { hostOf, matchesQuery, sortItems } from "./lib";
import { AgentFaces } from "./VaultAccess";
import { VaultBulkAccessDialog, VaultBulkDeleteDialog } from "./VaultBulk";
import { VaultConnections } from "./VaultConnections";
import { VaultEnvDialog } from "./VaultEnvDialog";
import { VaultImportDialog } from "./VaultImportDialog";
import { ItemChips, VaultItemDialog, VaultTile } from "./VaultItemDialog";
import { VaultNewDialog } from "./VaultNewDialog";
import "./vault.css";

/*
 * Settings › Vault (ADR 0144): the logins, keys and contact details agents use without seeing a password or a key.
 * One view at a time (Team, Personal, Connections, each with its count), a search and a kind filter over the items, a
 * row per item (what it is, who may use it, when it was last used) that opens its details. "Select" turns the rows into
 * checkboxes, to change who has access to many items at once or delete them (a passwords import, say).
 */

type Tab = "team" | "personal" | "connections";
type KindFilter = "all" | VaultItemKind;

/**
 * The line under an item's name: where and as whom (login), the variable (key), the description (contact: the list
 * carries no contact's fields, only its page does, ADR 0144 §7).
 */
function Subtitle({ item }: { item: VaultItem }) {
  const parts: ReactNode[] =
    item.kind === "login"
      ? [hostOf(item.website), item.username]
      : item.kind === "key"
        ? [
            item.keyName ? (
              <code key="name" className="vlt-code">
                {item.keyName}
              </code>
            ) : null,
            item.description,
          ]
        : [item.description];
  const shown = parts.filter(Boolean);
  return (
    <span className="vlt-row__sub">
      {shown.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two or three fixed parts of one line
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </span>
  );
}

/** Who may use it, short: every agent, one by name, or how many. */
function useAgentsShort() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (item: VaultItem) => {
    if (item.access.allAgents) return t("vault.access.allAgents");
    const names = item.access.agentIds.map((id) => dir.agentById.get(id)?.name).filter(Boolean);
    if (names.length === 0) return null;
    return names.length === 1 ? (names[0] as string) : t("vault.row.agents", { count: names.length });
  };
}

/** `picked`: the list is choosing items, and this one is chosen or not; the row is its checkbox's label then. */
function VaultRow({ item, onOpen, picked }: { item: VaultItem; onOpen: () => void; picked?: PickState }) {
  const { t, i18n } = useTranslation();
  const agents = useAgentsShort()(item);
  const id = useId();
  const body = (
    <>
      <VaultTile kind={item.kind} />
      <span className="vlt-row__text">
        <span className="vlt-row__name">
          <span className="vlt-row__title">{item.title}</span>
          <ItemChips item={item} />
        </span>
        <Subtitle item={item} />
      </span>
      <span className="vlt-row__who">
        {agents ? (
          <>
            <AgentFaces access={item.access} />
            <span>{agents}</span>
          </>
        ) : (
          <span className="vlt-row__none">{t("vault.access.noAgents")}</span>
        )}
      </span>
      <span className="vlt-row__used">
        {item.lastUsedAt
          ? t("vault.row.used", { when: relativeTime(t, i18n.language, item.lastUsedAt) })
          : t("vault.row.never")}
      </span>
    </>
  );
  if (picked)
    return (
      <label className="ac-list__row vlt-row" htmlFor={id}>
        {body}
        <Checkbox id={id} className="vlt-row__pick" checked={picked.on} onCheckedChange={picked.toggle} />
      </label>
    );
  return (
    <button type="button" className="ac-list__row vlt-row" onClick={onOpen}>
      {body}
      <Icon name="chevronRight" size={16} className="vlt-row__chev" />
    </button>
  );
}

interface PickState {
  on: boolean;
  toggle: () => void;
}

export function VaultSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const vault = useVault(org.id);
  const look = useRightHandLook();
  const [tab, setTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "new" | "import" | "env">(null);
  // Choosing items to change or delete at once: null while the rows open their details.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [bulk, setBulk] = useState<null | "access" | "delete">(null);
  const data = vault.data;
  const items = data?.items ?? [];
  const team = items.filter((i) => i.scope === "team");
  const personal = items.filter((i) => i.scope === "personal");
  // Opens where there is something for this person: the team's, unless they have none to see and can't add one.
  const current: Tab = tab ?? (data && !data.canManageTeam && team.length === 0 ? "personal" : "team");
  const scope: VaultScope = current === "personal" ? "personal" : "team";
  const canManageTeam = data?.canManageTeam ?? false;
  // The team's items are the shared ones in a personal workspace (ADR 0159): the same items, its own word.
  const teamTab = t(modeKey(org, "vault.tab.team"));
  const inTab = current === "personal" ? personal : team;
  const shown = sortItems(
    inTab.filter((i) => (kind === "all" || i.kind === kind) && matchesQuery(i, query)),
    i18n.language,
  );
  const filtered = query.trim() !== "" || kind !== "all";
  // The kind filter only where it can narrow something: a view that holds more than one kind.
  const kinds = new Set(inTab.map((i) => i.kind)).size;
  const open = (which: "new" | "import" | "env") => () => setDialog(which);
  const addsInList =
    !!data && current !== "connections" && inTab.length === 0 && (current === "personal" || canManageTeam);
  // Only who edits this view's items chooses them: their own, or the team's with the permission.
  const choosable = current === "personal" || (current === "team" && canManageTeam);
  const chosen = picked ? shown.filter((i) => picked.has(i.id)) : [];
  const toggle = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pickTab = (next: Tab) => {
    setTab(next);
    setPicked(null);
    // Each view starts unfiltered: a search or a kind from the other one would hide what this one holds.
    setQuery("");
    setKind("all");
  };

  const list = () => {
    if (shown.length > 0)
      return (
        <List className="vlt-list" aria-label={scope === "team" ? teamTab : t("vault.tab.personal")}>
          {shown.map((item) => (
            <VaultRow
              key={item.id}
              item={item}
              onOpen={() => setOpenId(item.id)}
              {...(picked ? { picked: { on: picked.has(item.id), toggle: () => toggle(item.id) } } : {})}
            />
          ))}
        </List>
      );
    if (filtered)
      return (
        <EmptyState
          size="panel"
          actions={
            <Button
              onClick={() => {
                setQuery("");
                setKind("all");
              }}
            >
              {t("vault.list.clearFilters")}
            </Button>
          }
        >
          {t("vault.list.noMatch")}
        </EmptyState>
      );
    const adds = (
      <Button variant="primary" icon="plus" onClick={open("new")}>
        {t("vault.new.open")}
      </Button>
    );
    if (current === "personal")
      return (
        <EmptyState size="page" agent={look} title={t("vault.list.personalEmpty")} actions={adds}>
          {t("vault.list.personalEmptyText")}
        </EmptyState>
      );
    return (
      <EmptyState
        size="page"
        agent={look}
        title={canManageTeam ? t(modeKey(org, "vault.list.teamEmpty")) : t("vault.list.sharedEmpty")}
        actions={canManageTeam && adds}
      >
        {canManageTeam ? t("vault.list.teamEmptyText") : t(modeKey(org, "vault.list.sharedEmptyText"))}
      </EmptyState>
    );
  };

  return (
    <div className="vlt">
      <PageHeader
        level={2}
        title={t("settings.section.vault")}
        meta={t("settings.sectionText.vault")}
        actions={
          <>
            {/* Two things come from a file: a passwords export (logins) and a .env (keys). */}
            <Menu
              align="end"
              label={t("vault.import.open")}
              trigger={<Button icon="upload">{t("vault.import.open")}</Button>}
            >
              <MenuItem icon="globe" onSelect={open("import")}>
                {t("vault.import.title")}
              </MenuItem>
              <MenuItem icon="key" onSelect={open("env")}>
                {t("vault.env.open")}
              </MenuItem>
            </Menu>
            {/* The empty list takes over this button: one way in, in the middle of the page. */}
            {!addsInList && (
              <Button variant="primary" icon="plus" onClick={open("new")}>
                {t("vault.new.open")}
              </Button>
            )}
          </>
        }
      />
      {vault.isPending ? (
        <LoadingList count={4} trailing />
      ) : vault.isError || !data ? (
        <ErrorState error={vault.error} onRetry={() => void vault.refetch()} />
      ) : (
        <div className="vlt-body">
          <Segmented<Tab>
            label={t("vault.tab.label")}
            value={current}
            onValueChange={pickTab}
            options={[
              { value: "team", label: teamTab, count: team.length },
              { value: "personal", label: t("vault.tab.personal"), count: personal.length },
              { value: "connections", label: t("vault.tab.connections"), count: data.connections.length },
            ]}
          />
          {current === "connections" ? (
            <VaultConnections overview={data} />
          ) : (
            <>
              {current === "personal" && personal.length > 0 && (
                <p className="vlt-tabnote ac-iconline">
                  <Icon name="lock" size={14} />
                  <span>{t("vault.list.personalNote")}</span>
                </p>
              )}
              {inTab.length > 0 && (
                <Toolbar
                  search={
                    <SearchField
                      value={query}
                      placeholder={t("vault.list.search")}
                      aria-label={t("vault.list.search")}
                      onChange={(e) => setQuery(e.target.value)}
                      onClear={() => setQuery("")}
                      clearLabel={t("vault.list.clearSearch")}
                    />
                  }
                  actions={
                    <>
                      {choosable && shown.length > 0 && (
                        <Button
                          size="sm"
                          icon={picked ? "close" : "checks"}
                          onClick={() => setPicked(picked ? null : new Set())}
                        >
                          {picked ? t("vault.bulk.clear") : t("vault.bulk.select")}
                        </Button>
                      )}
                      {(kinds > 1 || kind !== "all") && (
                        <Select<KindFilter>
                          size="sm"
                          className="vlt-kind"
                          value={kind}
                          onValueChange={setKind}
                          aria-label={t("vault.list.kind")}
                          align="end"
                          options={[
                            { value: "all", label: t("vault.list.kindAll") },
                            { value: "login", label: t("vault.kindPlural.loginTitle") },
                            { value: "key", label: t("vault.kindPlural.keyTitle") },
                            { value: "contact", label: t("vault.kindPlural.contactTitle") },
                          ]}
                        />
                      )}
                    </>
                  }
                />
              )}
              {list()}
              {picked && (
                <SelectionBar label={t("vault.bulk.selection")}>
                  <span className="drive-selbar__count">{t("vault.bulk.selected", { count: chosen.length })}</span>
                  {chosen.length < shown.length && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="checks"
                      onClick={() => setPicked(new Set(shown.map((i) => i.id)))}
                    >
                      <span className="drive-selbar__label">{t("vault.bulk.selectAll", { count: shown.length })}</span>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="audiencePeople"
                    disabled={chosen.length === 0}
                    onClick={() => setBulk("access")}
                  >
                    <span className="drive-selbar__label">{t("vault.bulk.access")}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="drive-selbar__danger"
                    disabled={chosen.length === 0}
                    onClick={() => setBulk("delete")}
                  >
                    <span className="drive-selbar__label">{t("vault.bulk.delete")}</span>
                  </Button>
                  <span className="drive-selbar__sep" aria-hidden="true" />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="close"
                    aria-label={t("vault.bulk.clear")}
                    title={t("vault.bulk.clear")}
                    onClick={() => setPicked(null)}
                  />
                </SelectionBar>
              )}
            </>
          )}
          {openId && <VaultItemDialog key={openId} itemId={openId} overview={data} onClose={() => setOpenId(null)} />}
        </div>
      )}
      {dialog === "new" && (
        <VaultNewDialog
          canManageTeam={canManageTeam}
          scope={scope}
          onClose={() => setDialog(null)}
          onImportEnv={open("env")}
          onCreated={(item) => {
            toast.show(t("vault.new.saved"));
            setDialog(null);
            setTab(item.scope);
          }}
        />
      )}
      {bulk === "access" && chosen.length > 0 && (
        <VaultBulkAccessDialog
          scope={scope}
          items={chosen}
          onClose={() => setBulk(null)}
          onDone={() => {
            setBulk(null);
            setPicked(null);
          }}
        />
      )}
      {bulk === "delete" && chosen.length > 0 && (
        <VaultBulkDeleteDialog
          items={chosen}
          onClose={() => setBulk(null)}
          onDone={() => {
            setBulk(null);
            setPicked(null);
          }}
        />
      )}
      {dialog === "import" && (
        <VaultImportDialog canManageTeam={canManageTeam} scope={scope} onClose={() => setDialog(null)} />
      )}
      {dialog === "env" && data && (
        <VaultEnvDialog
          overview={data}
          scope={scope}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            pickTab(saved);
          }}
        />
      )}
    </div>
  );
}
