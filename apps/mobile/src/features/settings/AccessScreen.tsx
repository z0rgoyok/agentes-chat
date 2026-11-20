import { type Agent, useAgents } from "@agenteschat/client";
import {
  type AccessResource,
  asksAt,
  type Level,
  type LevelState,
  levelOf,
  resourcesOf,
} from "@agenteschat/client/lib/access-levels";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { addsConnectors, can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Segmented, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { mayCreate } from "../new/logic";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useErrorToast } from "../shared/hooks";
import { errorHaptic } from "../shared/parts";
import { resourceName, useAgentsAccess, useConnectedById, useSetLevels } from "./hooks";
import { type AccessKind, AREA_ICON, accessColumns } from "./logic";
import { chooseAction, SettingsPage } from "./parts";

/**
 * Agentes e acesso (admins), as the web's matrix: agents × the connected services (or the built-in areas), each a
 * level. On the phone each agent is a group and each service a row: a tap lists its levels (Sem acesso, Ler, Ler e
 * escrever) in the app's short menu, the one in use checked, and a pick saves right away. The switch between services
 * and built-in areas stays on top, where the list's change never moves it. Sensitive actions keep asking at any level
 * (the row says so); fine-tuning tool by tool is the connector's Ferramentas. Only the agents this person manages
 * (the server's `canManage`): "Editar qualquer agente" doesn't reach someone's private agent (ADR 0085 addendum).
 */
export function AccessScreen() {
  const { t } = useTranslation();
  const failed = useErrorToast();
  const { orgId, org } = useOrg();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const all = agents.data ?? [];
  const list = all.filter((a) => managesAgent(a));
  const access = useAgentsAccess(list, admin);
  const items = useConnectedById();
  const set = useSetLevels();
  const [kind, setKind] = useState<AccessKind>("connector");
  const [pending, setPending] = useState<Record<string, Level>>({});
  const first = list.map((a) => access.byAgent.get(a.id)).find((x) => x !== undefined);
  const columns = accessColumns(first, kind);
  const table = first !== undefined && columns.length > 0 && !access.loading;
  const busyAgents = new Set(Object.keys(pending).map((k) => k.split("|")[0]));

  const setLevel = (agent: Agent, r: AccessResource, level: Level) => {
    if (busyAgents.has(agent.id)) return;
    const k = `${agent.id}|${r.id}`;
    setPending((p) => ({ ...p, [k]: level }));
    set.mutate(
      { agentId: agent.id, changes: { [r.id]: level } },
      {
        onError: (e) => {
          errorHaptic();
          failed(e);
        },
        onSettled: () =>
          setPending((p) => {
            const next = { ...p };
            delete next[k];
            return next;
          }),
      },
    );
  };
  // The levels this service or area has, in the app's short menu: the one in use checked, a pick saves.
  const chooseLevel = (agent: Agent, r: AccessResource, name: string, current: LevelState) =>
    chooseAction(
      name,
      r.levels.map((level) => ({
        label: t(`access.level.${level}`),
        checked: level === current,
        onPress: () => {
          if (level !== current) setLevel(agent, r, level);
        },
      })),
      t("common.cancel"),
    );

  if (!admin || (all.length > 0 && list.length === 0)) {
    return (
      <SettingsPage title={t("settings.section.access")}>
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title={t("settings.section.access")}>
      {/* What the page is, its matrix's explanation behind the ⓘ (the bar's title already names it). */}
      <GroupedFooter
        hint={{ name: t("common.about", { label: t("access.matrixTitle") }), text: t("access.matrixHint") }}
      >
        {t("settings.sectionText.access")}
      </GroupedFooter>
      <View style={styles.switch}>
        <Segmented
          wide
          items={[
            { key: "connector", label: t("access.kind.connectors") },
            { key: "builtin", label: t("access.kind.builtin") },
          ]}
          value={kind}
          onChange={(k) => setKind(k as AccessKind)}
        />
      </View>
      {access.unavailable ? <GroupedFooter>{t("access.unavailable")}</GroupedFooter> : null}
      {agents.isError && !agents.data ? <LoadFailed onRetry={() => void agents.refetch()} /> : null}
      {agents.isLoading || (list.length > 0 && access.loading) ? <SkeletonList rows={4} /> : null}
      {agents.isSuccess && all.length === 0 ? (
        <FirstUse
          place="agents"
          size="panel"
          acts={mayCreate(org, "agent")}
          label={t("mobile.homeNow.first.create")}
          onPress={() => router.push("/new-agent")}
        />
      ) : null}
      {first && columns.length === 0 && kind === "connector" ? (
        <FirstUse
          place="access"
          size="panel"
          acts={addsConnectors(org)}
          label={t("mobile.empty.access.action")}
          onPress={() => router.push("/connectors")}
        />
      ) : null}
      {table
        ? list.map((a) => {
            const tree = access.byAgent.get(a.id);
            const mine = tree ? resourcesOf(tree) : [];
            return (
              <View key={a.id}>
                <GroupedHeader>{a.role ? `${a.name} · ${a.role}` : a.name}</GroupedHeader>
                <GroupedList>
                  {columns.map((col) => {
                    const name = resourceName(t, col, items);
                    const item = col.connectionId ? items.get(col.connectionId) : undefined;
                    const lead = col.connectionId
                      ? {
                          leading: <ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} size={30} />,
                        }
                      : { icon: AREA_ICON[col.area ?? ""] ?? "circle" };
                    const r = mine.find((x) => x.id === col.id);
                    if (!r) return <GroupedRow key={col.id} {...lead} label={name} value={t("access.level.none")} />;
                    const level = pending[`${a.id}|${r.id}`] ?? levelOf(r);
                    const asks = asksAt(r, level).length > 0;
                    return (
                      <GroupedRow
                        key={col.id}
                        {...lead}
                        label={name}
                        {...(asks ? { sub: t("access.asksLegend") } : {})}
                        value={t(`access.level.${level}`)}
                        menu
                        disabled={busyAgents.has(a.id)}
                        onPress={() => chooseLevel(a, r, name, level)}
                      />
                    );
                  })}
                </GroupedList>
              </View>
            );
          })
        : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  // The switch on the groups' edge, a header's room above it.
  switch: { paddingTop: 20, paddingBottom: 4 },
});
