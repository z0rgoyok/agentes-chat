import {
  type AccessLevel,
  ApiError,
  type ArtifactAccess,
  type ArtifactAccessRow,
  useArtifact,
  useRoles,
  useSetArtifactAccess,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { filePath } from "@agenteschat/client/lib/message-links";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GroupedFooter,
  Locked,
  RoleMark,
  SheetBar,
  SheetScreen,
  SkeletonList,
  useToast,
} from "@/ui";
import { AccessList, type AccessListRow } from "../shared/AccessList";
import { Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { copyText, successHaptic } from "../shared/parts";

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
 * Compartilhar on the phone (ADR 0157, 0202), the web's dialog on the shared `AccessList`, as the wiki's Acesso: who
 * reads it where it lives (a file of the Drive itself: its maker, who always edits), the whole workspace and the
 * agents, then roles, people and agents, each a level a tap walks through; Salvar keeps it. Whoever may not change it
 * sees the list as it is. Copiar link stays at the foot.
 */
export function FileShareSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const query = useArtifact(orgId, id);
  const a = query.data;
  if (!a) {
    return (
      // The rows' shape while the file's details come; a file that's gone says so, a failure offers to try again.
      <SheetScreen>
        {query.error instanceof ApiError && query.error.status === 404 ? (
          <EmptyState size="inline" icon="file" title={t("errors.artifact.notFound")} />
        ) : query.isError ? (
          <LoadFailed onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonList rows={4} />
        )}
      </SheetScreen>
    );
  }
  return <Form key={a.id} artifact={a} onClose={onClose} />;
}

function Form({
  artifact: a,
  onClose,
}: {
  artifact: NonNullable<ReturnType<typeof useArtifact>["data"]>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const roles = useRoles(orgId);
  const save = useSetArtifactAccess(orgId);
  const access = a.access ?? PLACE_ONLY;
  const [draft, setDraft] = useState<Draft>(() => ({
    place: access.place,
    workspace: access.workspace,
    agents: access.agents,
    users: recordOf(access.users),
    roles: recordOf(access.roles),
    agentRows: recordOf(access.agentRows),
  }));
  const aud = a.audience;
  const drive = aud.kind === "workspace";
  const publicChannel = aud.kind === "channel" && !aud.private;
  const maker = a.createdBy;
  const mine = maker.type === "person" && maker.id === meId;
  const makerName = dir.nameOf(maker);
  const readOnly = !a.canShare || a.myAccess === "view";
  const levelName = (level: AccessLevel) => t(`share.level.${level}`);
  const where =
    aud.kind === "dm"
      ? aud.between
        ? t("share.whereDmBetween", { names: joinNames(aud.between.map(dir.nameOf), t) })
        : aud.with
          ? t("share.whereDm", { name: dir.nameOf(aud.with) })
          : t("share.whereDmGone")
      : aud.kind === "channel"
        ? t("share.whereChannel", { name: aud.name })
        : mine
          ? t("share.you", { name: makerName })
          : makerName;
  // Who may only look gets each row at its level alone: a tap changes nothing.
  const walk = (level: AccessLevel, levels: AccessLevel[]) => (readOnly ? [level] : levels);
  const baseRows: AccessListRow<AccessLevel>[] = [
    drive
      ? {
          key: "place",
          icon: "person",
          leading: <Face who={maker} size={26} live={false} />,
          label: where,
          hint: t("share.madeIt"),
          level: "edit",
          levels: ["edit"],
          onChange: () => {},
        }
      : {
          key: "place",
          icon: aud.kind === "dm" ? "chat" : "hash",
          label: where,
          hint: t("share.placeText"),
          level: draft.place,
          levels: walk(draft.place, ["view", "edit"]),
          onChange: (v) => setDraft((d) => ({ ...d, place: v === "view" ? "view" : "edit" })),
        },
    ...(publicChannel
      ? []
      : [
          {
            key: "workspace",
            icon: "globe" as const,
            label: t(modeKey(org, "share.everyone")),
            hint: t(modeKey(org, "share.everyoneText")),
            level: draft.workspace,
            levels: walk(draft.workspace, ["none", "view", "edit"]),
            onChange: (workspace: AccessLevel) => setDraft((d) => ({ ...d, workspace })),
          },
        ]),
    {
      key: "agents",
      icon: "person",
      label: drive ? t("share.agentsAll") : t("share.agentsHere"),
      hint: drive ? t("share.agentsAllText") : t("share.agentsHereText"),
      level: draft.agents,
      levels: walk(draft.agents, ["none", "view", "edit"]),
      onChange: (agents) => setDraft((d) => ({ ...d, agents })),
    },
  ];
  const row = (group: Group, key: string, label: string, hint?: string): AccessListRow<AccessLevel> => {
    const base = group === "agentRows" ? draft.agents : draft.workspace;
    const baseKey = group === "agentRows" ? "agents" : "workspace";
    const level: AccessLevel = draft[group][key] ?? "none";
    const set = (next: AccessLevel) =>
      setDraft((d) => {
        const rows = { ...d[group] };
        if (next === "none") delete rows[key];
        else rows[key] = next === "view" ? "view" : "edit";
        return { ...d, [group]: rows };
      });
    // With everyone editing, a tap adds them, and adding someone means limiting it: "everyone" drops until Salvar.
    if (base === "edit") {
      return {
        key,
        icon: "person",
        label,
        ...(hint ? { hint } : {}),
        level: "none",
        levels: walk("none", ["none", "view"]),
        ...(readOnly ? {} : { action: t("share.addRow") }),
        onChange: (next) => {
          set(next);
          if (next !== "none") setDraft((d) => ({ ...d, [baseKey]: "none" }));
        },
      };
    }
    // With everyone viewing, a row is only "this one edits too".
    const shown: AccessLevel = base === "view" && level !== "edit" ? "view" : level;
    return {
      key,
      icon: "person",
      label,
      ...(hint ? { hint } : {}),
      level: shown,
      levels: walk(shown, base === "view" ? ["view", "edit"] : ["none", "view", "edit"]),
      onChange: set,
    };
  };
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const people = [...dir.memberById.values()].filter(
    (m) => !(drive && maker.type === "person" && m.userId === maker.id),
  );
  const copy = async () => {
    if (await copyText(`${serverUrl().replace(/\/+$/, "")}${filePath(orgId, a.id)}`)) {
      successHaptic();
      toast({ title: t("share.copied"), icon: "link" });
    } else toast({ title: t("mobile.app.failed"), icon: "x" });
  };
  const keep = () =>
    save.mutate(
      {
        id: a.id,
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
          successHaptic();
          toast({ title: t("share.saved") });
          onClose();
        },
        onError: (e) => toast({ title: errorText(t, e, i18n.language), icon: "x" }),
      },
    );
  return (
    <SheetScreen>
      {/* A task sheet: the close plate and the title in its bar, as every task sheet has them (no "Concluído" under it). */}
      <SheetBar inset title={t("share.title", { name: a.title })} onClose={onClose} />
      <Locked when={save.isPending} style={styles.fields}>
        {readOnly ? <GroupedFooter>{t(drive ? "share.readOnlyDrive" : "share.readOnly")}</GroupedFooter> : null}
        {/* The access lists keep their own 16 at the sides: out of the sheet's padding, as on the wiki's Acesso. */}
        <View style={styles.bleed}>
          <AccessList levelName={levelName} rows={baseRows} />
          <AccessList
            title={t("share.groupRoles")}
            levelName={levelName}
            rows={roleList.map((r) => ({
              ...row("roles", r.id, r.name, t("share.role")),
              leading: <RoleMark color={r.color} icon={r.icon} size={24} />,
            }))}
          />
          <AccessList
            title={t("share.groupPeople")}
            levelName={levelName}
            rows={people.map((m) => ({
              ...row("users", m.userId, m.userId === meId ? t("share.you", { name: m.name }) : m.name, m.email),
              leading: <Face who={{ type: "person", id: m.userId }} size={26} live={false} />,
            }))}
          />
          <AccessList
            title={t("share.groupAgents")}
            levelName={levelName}
            rows={dir.agents.map((ag) => ({
              ...row("agentRows", ag.id, ag.name),
              leading: <Face who={{ type: "agent", id: ag.id }} size={26} live={false} />,
            }))}
          />
        </View>
        <GroupedFooter>{t(modeKey(org, "share.admins"))}</GroupedFooter>
        {readOnly ? null : <Button variant="primary" wide label={t("common.save")} onPress={keep} />}
        <Button variant="secondary" wide icon="link" label={t("share.copyLink")} onPress={() => void copy()} />
      </Locked>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 16 },
  bleed: { marginHorizontal: -16 },
});
