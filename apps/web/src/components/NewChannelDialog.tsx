import { type Channel, keys, type OrgRole, useAgentGroups, useChannels, useRoles } from "@agenteschat/client";
import {
  accessInput,
  accessValid,
  type ChannelAccess,
  type ChannelAccessMode,
} from "@agenteschat/client/lib/channel-access";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  RoleMark,
  Select,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { usePersonalView } from "@/hooks/usePersonalView";
import { GroupFace } from "./GroupFace";
import { memberOf, PeoplePicker, type PickKey } from "./MemberPicker";
import { useOrg } from "./org-context";
import { RoleChecklist } from "./roles/RoleChecklist";
import { SectorSelect } from "./SectorSelect";

const ACCESS_MODES: ChannelAccessMode[] = ["public", "roles", "private"];

/** A team's three words for who sees a channel, the same as a cargo's "Quem vê #canal" says them. */
const TEAM_ACCESS = {
  public: "rolesPage.everyoneName",
  roles: "rolesPage.who.some",
  private: "rolesPage.sees.private",
} as const;

/**
 * "Quem pode entrar": Todos, Só alguns cargos or Só quem for adicionado (ADR 0125), the words a cargo's Canais uses.
 * The second shows the roles picked, each removable, and "Escolher cargos", which ticks them in a dialog of their own
 * (it opens by itself while none is picked). Creating a channel and its details share it. A personal workspace says
 * the open and closed ones plainly ("Everyone here can join", "Only who I add") and offers the cargos only when a
 * role is worth it or it is the channel's (ADR 0158); what each one does is the same.
 */
export function ChannelAccessChoice({
  value,
  onChange,
  idPrefix,
  showError,
}: {
  value: ChannelAccess;
  onChange: (next: ChannelAccess) => void;
  idPrefix: string;
  /** Say that a role is missing (after a try to save). */
  showError?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const candidates = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const [choosing, setChoosing] = useState(false);
  const pickedRoles = candidates.filter((r) => value.roleIds.includes(r.id));
  const modes = ACCESS_MODES.filter(
    (mode) => mode !== "roles" || value.mode === "roles" || rolePicksInSight(org, roles.data?.roles ?? []),
  );
  const personal = isPersonal(org);
  const label = (mode: ChannelAccessMode) =>
    !personal
      ? TEAM_ACCESS[mode]
      : mode === "roles"
        ? ("newChannel.roles" as const)
        : modeKey(org, `newChannel.${mode}` as const);
  const desc = (mode: ChannelAccessMode) =>
    mode === "roles"
      ? ("newChannel.rolesDesc" as const)
      : !personal && mode === "private"
        ? ("rolesPage.sees.privateDesc" as const)
        : modeKey(org, `newChannel.${mode}Desc` as const);
  return (
    <div className="channel-access">
      {/* A dropdown, as "Setor" above it: three cards side by side broke their words in a narrow dialog. */}
      <Field
        label={t("newChannel.visibility")}
        id={`${idPrefix}-vis`}
        hint={{
          name: t("common.about", { label: t("newChannel.visibility") }),
          text: t(desc(value.mode)),
        }}
        labelAside={
          value.mode === "roles" && (
            <button type="button" className="ac-link ac-link--muted small" onClick={() => setChoosing(true)}>
              {pickedRoles.length > 0 ? t("newChannel.rolesChange") : t("newChannel.rolesChoose")}
            </button>
          )
        }
      >
        <Select
          value={value.mode}
          onValueChange={(mode) => {
            onChange({ ...value, mode });
            if (mode === "roles" && value.roleIds.length === 0) setChoosing(true);
          }}
          options={modes.map((mode) => ({
            value: mode,
            label: t(label(mode)),
            description: t(desc(mode)),
          }))}
        />
      </Field>
      {value.mode === "roles" && pickedRoles.length > 0 && (
        <TokenList label={t("newChannel.rolesPick")}>
          {pickedRoles.map((r) => (
            <li key={r.id}>
              <Token
                leading={<RoleMark color={r.color} icon={r.icon} size={18} />}
                removeLabel={t("common.removeName", { name: r.name })}
                onRemove={() => onChange({ ...value, roleIds: value.roleIds.filter((id) => id !== r.id) })}
              >
                {r.name}
              </Token>
            </li>
          ))}
        </TokenList>
      )}
      {value.mode === "roles" && (
        <span className={`small ${showError && !accessValid(value) ? "ac-field__error" : "muted"}`}>
          {showError && !accessValid(value) ? t("newChannel.rolesNeeded") : t("newChannel.rolesLeave")}
        </span>
      )}
      {choosing && (
        <ChannelRolesDialog
          roles={candidates}
          loaded={roles.isSuccess}
          initial={value.roleIds}
          idPrefix={idPrefix}
          onPick={(roleIds) => onChange({ ...value, mode: "roles", roleIds })}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** The roles a channel opens to, ticked in a dialog of their own: "Pronto" puts them on the field. */
function ChannelRolesDialog({
  roles,
  loaded,
  initial,
  idPrefix,
  onPick,
  onClose,
}: {
  roles: readonly OrgRole[];
  loaded: boolean;
  initial: readonly string[];
  idPrefix: string;
  onPick: (roleIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(initial));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("newChannel.rolesPick")}
      description={t("newChannel.rolesDesc")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
        <div className="people-picker__results" role="region" aria-label={t("newChannel.rolesPick")}>
          {roles.length === 0 && loaded ? (
            <p className="small muted">{t("newChannel.rolesNone")}</p>
          ) : (
            <RoleChecklist
              roles={roles}
              picked={draft}
              idPrefix={`${idPrefix}-pick`}
              onToggle={(id, on) =>
                setDraft((d) => {
                  const next = new Set(d);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
            />
          )}
        </div>
        <span className="small muted">{t("newChannel.rolesLeave")}</span>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            onPick([...draft]);
            onClose();
          }}
        >
          {t("newChannel.rolesDone")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Same rule as the backend (CHANNEL_NAME_PATTERN): lower case, digits, - or _. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** What people type → a channel name ("Marketing Brasil" → "marketing-brasil"). */
export const toChannelName = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);

/**
 * What people type → a personal workspace's group conversation name (ADR 0159): as written, its runs of spaces folded
 * to one, at most 80. A trailing space stays while typing; `trim` when it is sent.
 */
export const toGroupName = (value: string) => value.replace(/\s+/g, " ").replace(/^ /, "").slice(0, 80);

/** Same rule as the backend (`personalChannelName`): something written, never `dm-`. */
const groupNameOk = (name: string) => {
  const clean = name.trim().replace(/^#+\s*/, "");
  return clean.length > 0 && clean.length <= 80 && !clean.toLowerCase().startsWith("dm-");
};

/**
 * Why a channel can't take `name`: a team's must be lower case, digits, - or _; a personal workspace's group
 * conversation (`personal`) any name on one line. Taken in any case, as the backend checks (`requireChannelNameFree`).
 */
export function channelNameError(name: string, taken: Set<string>, personal = false): "invalid" | "taken" | null {
  if (!(personal ? groupNameOk(name) : CHANNEL_NAME.test(name))) return "invalid";
  const wanted = name.trim().toLowerCase();
  if ([...taken].some((n) => n.toLowerCase() === wanted)) return "taken";
  return null;
}

/**
 * "Criar canal", in one column: name, topic, its sector (once the workspace has one), who can join, then the initial members (people and
 * agents: search and a list that scrolls in its own box). The footer, with the count and Criar, stays in view. A
 * personal workspace calls it a group conversation, and alone leaves out who can join while it is the default, open to
 * everyone here (ADR 0159): the same channel either way.
 */
export function NewChannelDialog({
  open,
  onOpenChange,
  roleIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened from a cargo's Canais: it starts limited to these cargos. */
  roleIds?: string[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const { solo } = usePersonalView();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [access, setAccess] = useState<ChannelAccess>(
    roleIds?.length ? { mode: "roles", roleIds } : { mode: "public", roleIds: [] },
  );
  const sectors = useAgentGroups(org.id).data ?? [];
  const [groupId, setGroupId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      // Who it starts with goes along: the server decides from them whether its agents answer in threads.
      return api.chat.createChannel(org.id, {
        name: name.trim(),
        topic: topic.trim() || undefined,
        ...accessInput(access),
        ...(groupId ? { groupId } : {}),
        ...(selected.size > 0 ? { members: [...selected].map(memberOf) } : {}),
      });
    },
    onSuccess: async (channel) => {
      // In the list at once, so its page opens on it without waiting for the list to be read again.
      qc.setQueryData<Channel[]>(keys.channels(org.id), (list) =>
        list && !list.some((c) => c.id === channel.id) ? [...list, channel] : list,
      );
      void qc.invalidateQueries({ queryKey: keys.channels(org.id) });
      if (groupId) void qc.invalidateQueries({ queryKey: keys.agentGroups(org.id) });
      onOpenChange(false);
      await navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: channel.id } });
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cargos it opens with are read once per opening
  useEffect(() => {
    if (!open) return;
    setName("");
    setTopic("");
    setAccess(roleIds?.length ? { mode: "roles", roleIds } : { mode: "public", roleIds: [] });
    setGroupId(null);
    setSelected(new Set());
    setTouched(false);
    create.reset();
  }, [open, create.reset]);
  const taken = useHeldWhile(new Set((channels.data ?? []).map((c) => c.name)), create.isPending || create.isSuccess);
  // A personal workspace's group conversation takes its name as written and shows its agents as its face (ADR 0159).
  const personal = isPersonal(org);
  const error = channelNameError(name, taken, personal);
  const pickedAgents = [...selected].filter((k) => k.startsWith("agent:")).map((k) => k.slice(6));

  const nameField = (
    <Field
      label={t("newChannel.name")}
      id="ch-name"
      example={personal ? undefined : t("newChannel.nameHelp", { name: name || "canal" })}
      error={
        touched || (name && error === "taken")
          ? error === "invalid"
            ? t(modeKey(org, "newChannel.nameInvalid"))
            : error === "taken"
              ? t(modeKey(org, "newChannel.nameTaken"), { name: name.trim() })
              : undefined
          : undefined
      }
    >
      <Input
        value={name}
        onChange={(e) => setName(personal ? toGroupName(e.target.value) : toChannelName(e.target.value))}
        placeholder={t(modeKey(org, "newChannel.namePlaceholder"))}
        maxLength={personal ? 80 : undefined}
        autoFocus
      />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(modeKey(org, "newChannel.title"))}
      closeLabel={t("common.close")}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!error && accessValid(access)) create.mutate();
        }}
      >
        <Locked when={create.isPending}>
          <DialogBody>
            {personal ? (
              <div className="group-namerow">
                <GroupFace agentIds={pickedAgents} size={62} />
                {nameField}
              </div>
            ) : (
              nameField
            )}
            <Field label={t("newChannel.topic")} id="ch-topic">
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("newChannel.topicPlaceholder")}
              />
            </Field>
            {sectors.length > 0 && (
              <Field
                label={t("agentGroups.group")}
                id="ch-sector"
                hint={{
                  name: t("common.about", { label: t("agentGroups.group") }),
                  text: t("channelCategories.categoryHelp"),
                }}
              >
                <SectorSelect value={groupId} onChange={setGroupId} />
              </Field>
            )}
            {!(solo && access.mode === "public") && (
              <ChannelAccessChoice value={access} onChange={setAccess} idPrefix="ch" showError={touched} />
            )}
            <PeoplePicker
              label={t(modeKey(org, "newChannel.members"))}
              searchLabel={t("newChannel.membersSearch")}
              emptyText={(q) => t("newChannel.membersEmpty", { q })}
              selected={selected}
              onChange={setSelected}
              channel
            />
          </DialogBody>
        </Locked>
        <DialogFooter bar note={t("newChannel.selected", { count: selected.size })}>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={create.isPending} loading={create.isPending}>
            {personal ? t("newChannel.createPersonal") : t("newChannel.create", { name: name || "canal" })}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
