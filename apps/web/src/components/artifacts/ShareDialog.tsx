import type { AccessLevel, Artifact, ArtifactAccess, ArtifactAccessRow } from "@agenteschat/client";
import { useRoles, useSetArtifactAccess } from "@agenteschat/client";
import { onlyItsConversation } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  type AccessBase,
  AccessDialog,
  type AccessLevel as AccessOption,
  type AccessSubject,
  Avatar,
  Button,
  Icon,
  RoleMark,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { artifactLink, useAuthorName } from "@/components/artifacts/viewer-context";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";

/**
 * Compartilhar, for any file (ADR 0157), and Copiar link: a link copies at once when everyone it may reach opens it;
 * one only a private conversation sees opens the dialog, which says so beside its own Copiar link.
 */
export function useFileShare() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const [target, setTarget] = useState<Artifact | null>(null);
  return {
    open: (a: Artifact) => setTarget(a),
    copyLink: (a: Artifact, version?: number) => {
      if (onlyItsConversation(a)) setTarget(a);
      else
        void copyText(artifactLink(window.location.origin, org.id, a.id, version), () => toast.show(t("share.copied")));
    },
    dialog: target ? <ShareDialog key={target.id} artifact={target} onClose={() => setTarget(null)} /> : null,
  };
}

type Row = "view" | "edit";
type Group = "users" | "roles" | "agentRows";

/** A file from an older server: everyone where it lives edits it, nobody more sees it. */
const PLACE_ONLY: ArtifactAccess = {
  place: "edit",
  workspace: "none",
  users: [],
  roles: [],
  agents: "edit",
  agentRows: [],
  limited: false,
};

interface Draft {
  place: Row;
  workspace: AccessLevel;
  agents: AccessLevel;
  users: Record<string, Row>;
  roles: Record<string, Row>;
  agentRows: Record<string, Row>;
}

const recordOf = (rows: ArtifactAccessRow[]): Record<string, Row> =>
  Object.fromEntries(rows.map((r) => [r.id, r.level]));
const listOf = (rows: Record<string, Row>): ArtifactAccessRow[] =>
  Object.entries(rows).map(([id, level]) => ({ id, level }));

/**
 * Compartilhar (ADR 0157, 0202), as the wiki's Acesso: one list with a level for each row. Always there: who reads it
 * where it lives (a file of the Drive itself: its maker, who always edits), the whole workspace and the agents (every
 * agent of the workspace, or the agents where it lives); added: people, roles and agents, each to view or edit.
 * Whoever may not change it sees the list as it is. Copiar link stays at the foot.
 */
export function ShareDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const toast = useToast();
  const authorName = useAuthorName();
  const save = useSetArtifactAccess(org.id);
  const access = artifact.access ?? PLACE_ONLY;
  const [draft, setDraft] = useState<Draft>(() => ({
    place: access.place,
    workspace: access.workspace,
    agents: access.agents,
    users: recordOf(access.users),
    roles: recordOf(access.roles),
    agentRows: recordOf(access.agentRows),
  }));
  const aud = artifact.audience;
  const drive = aud.kind === "workspace";
  const publicChannel = aud.kind === "channel" && !aud.private;
  const maker = artifact.createdBy;
  const mine = maker.type === "person" && maker.id === me.user.id;
  const makerName = authorName(maker);
  const readOnly = !artifact.canShare || artifact.myAccess === "view";
  const names: Record<AccessLevel, string> = {
    none: t("share.level.none"),
    view: t("share.level.view"),
    edit: t("share.level.edit"),
  };
  const level = (value: AccessLevel): AccessOption<AccessLevel> => ({ value, label: names[value] });
  const where =
    aud.kind === "dm"
      ? aud.between
        ? t("share.whereDmBetween", { names: joinNames(aud.between.map(authorName), t) })
        : aud.with
          ? t("share.whereDm", { name: authorName(aud.with) })
          : t("share.whereDmGone")
      : aud.kind === "channel"
        ? t("share.whereChannel", { name: aud.name })
        : mine
          ? t("share.you", { name: makerName })
          : makerName;
  const base: AccessBase<AccessLevel>[] = [
    drive
      ? {
          id: "place",
          name: where,
          detail: t("share.madeIt"),
          lead: <ActorAvatar size="sm" actor={maker} name={makerName} />,
          level: "edit",
          levels: [level("edit")],
          onChange: () => {},
        }
      : {
          id: "place",
          name: where,
          detail: t("share.placeText"),
          lead: <Icon name={aud.kind === "dm" ? "message" : "channel"} size={20} />,
          level: draft.place,
          levels: [level("view"), level("edit")],
          onChange: (v) => setDraft((d) => ({ ...d, place: v === "view" ? "view" : "edit" })),
        },
    ...(publicChannel
      ? []
      : [
          {
            id: "workspace",
            name: t(modeKey(org, "share.everyone")),
            detail: t(modeKey(org, "share.everyoneText")),
            lead: <Icon name="audienceEveryone" size={20} />,
            level: draft.workspace,
            levels: [level("none"), level("view"), level("edit")],
            onChange: (workspace: AccessLevel) => setDraft((d) => ({ ...d, workspace })),
          },
        ]),
    {
      id: "agents",
      name: drive ? t("share.agentsAll") : t("share.agentsHere"),
      detail: drive ? t("share.agentsAllText") : t("share.agentsHereText"),
      lead: <Icon name="agent" size={20} />,
      level: draft.agents,
      levels: [level("none"), level("view"), level("edit")],
      onChange: (agents) => setDraft((d) => ({ ...d, agents })),
    },
  ];
  // A personal workspace's family picks people: roles only when one is worth it or already listed (ADR 0159).
  const offersRoles = rolePicksInSight(org, roles.data?.roles ?? [], Object.keys(draft.roles));
  const subjects: AccessSubject[] = [
    ...dir.members
      .filter((m) => !(drive && maker.type === "person" && m.userId === maker.id))
      .map((m) => ({
        id: `u:${m.userId}`,
        name: m.userId === me.user.id ? t("share.you", { name: m.name }) : m.name,
        detail: m.email,
        group: t("share.groupPeople"),
        lead: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
      })),
    ...(offersRoles ? sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))) : []).map((r) => ({
      id: `r:${r.id}`,
      name: r.name,
      detail: t("share.role"),
      group: t("share.groupRoles"),
      lead: <RoleMark color={r.color} icon={r.icon} size={24} />,
    })),
    ...dir.agents.map((a) => ({
      id: `a:${a.id}`,
      name: a.name,
      detail: t("share.agent"),
      group: t("share.groupAgents"),
      lead: <AgentAvatar agent={a} size="sm" name={a.name} />,
    })),
  ];
  const parts = (s: AccessSubject): { group: Group; id: string } => ({
    group: s.id[0] === "u" ? "users" : s.id[0] === "r" ? "roles" : "agentRows",
    id: s.id.slice(2),
  });
  const baseOf = (group: Group) => (group === "agentRows" ? draft.agents : draft.workspace);
  // As the wiki: with everyone editing a row says nothing; with everyone viewing a row can only edit.
  const levelsFor = (s: AccessSubject) =>
    baseOf(parts(s).group) === "view" ? [level("edit")] : [level("view"), level("edit")];
  const levelOf = (s: AccessSubject) => {
    const { group, id } = parts(s);
    const value = draft[group][id];
    if (!value || baseOf(group) === "edit" || (baseOf(group) === "view" && value !== "edit")) return undefined;
    return value;
  };
  return (
    <AccessDialog<AccessLevel>
      title={t("share.title", { name: artifact.title })}
      note={
        // Copiar link of a file only its conversation sees opens here: the link opens for no one else.
        onlyItsConversation(artifact)
          ? drive
            ? mine
              ? t("share.onlyYouLink")
              : t("share.onlyMakerLink", { name: makerName })
            : t("share.onlyHere")
          : readOnly
            ? t(drive ? "share.readOnlyDrive" : "share.readOnly")
            : undefined
      }
      base={base}
      subjects={subjects}
      levelOf={levelOf}
      levelsFor={levelsFor}
      onLevelChange={(s, value) => {
        const { group, id } = parts(s);
        const key = group === "agentRows" ? "agents" : "workspace";
        setDraft((d) => {
          const rows = { ...d[group] };
          if (value === null || value === "none") delete rows[id];
          else rows[id] = value === "view" ? "view" : "edit";
          // Adding someone while everyone edits means limiting it, in plain sight, until Salvar (as the wiki).
          const limits = value !== null && value !== "none" && d[key] === "edit";
          return { ...d, [group]: rows, ...(limits ? { [key]: "none" } : {}) };
        });
      }}
      labels={{
        add: t(offersRoles ? "share.addAll" : "share.addAllPersonal"),
        addList: t(offersRoles ? "share.addAll" : "share.addAllPersonal"),
        addSearch: t(offersRoles ? "share.addAllSearch" : "share.addAllSearchPersonal"),
        noResults: t("share.noResults"),
        removeOf: (name) => t("share.remove", { name }),
        levelOf: (name) => t("share.levelOf", { name }),
        close: t("common.close"),
        cancel: t("common.cancel"),
        save: t("common.save"),
      }}
      footerStart={
        <Button
          icon="link"
          onClick={() =>
            void copyText(artifactLink(window.location.origin, org.id, artifact.id), () =>
              toast.show(t("share.copied")),
            )
          }
        >
          {t("share.copyLink")}
        </Button>
      }
      readOnly={readOnly}
      saving={save.isPending}
      onSave={() =>
        save.mutate(
          {
            id: artifact.id,
            access: {
              place: draft.place,
              workspace: draft.workspace,
              users: listOf(draft.users),
              roles: listOf(draft.roles),
              agents: draft.agents,
              agentRows: listOf(draft.agentRows),
            },
          },
          {
            onSuccess: () => {
              toast.show(t("share.saved"), "success");
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
          },
        )
      }
      onClose={onClose}
    />
  );
}
