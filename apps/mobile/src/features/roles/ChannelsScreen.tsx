import type { Channel, ChannelInput, OrgRole } from "@agenteschat/client";
import { channelMembersQuery, keys, useApi, useChannelCategories, useChannels } from "@agenteschat/client";
import { sameList } from "@agenteschat/client/lib/agent-edit";
import { accessOf } from "@agenteschat/client/lib/channel-access";
import { errorText } from "@agenteschat/client/lib/errors";
import { managesChannel } from "@agenteschat/client/lib/permissions";
import { channelLeavers, isEveryone, roleLock, roleName, sortRoles } from "@agenteschat/client/lib/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { SettingsPage } from "../settings/parts";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import {
  channelAudienceLine,
  channelGroups,
  channelIntent,
  channelTicked,
  isGeneral,
  peopleNames,
  type WhoSees,
  whoSeesInput,
  whoSeesLines,
  whoSeesStart,
} from "./logic";
import { ask, CargoMark, Gone, rolesHref, useFail, useRolesData, Waiting } from "./parts";

/** Saves who sees a channel (the channel's own PATCH), then reads the channels and the cargos' reach again. */
function useSaveChannel() {
  const { orgId } = useRolesData();
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, input }: { channelId: string; input: ChannelInput }) =>
      api.chat.update(orgId, channelId, input),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
        qc.invalidateQueries({ queryKey: keys.roles(orgId) }),
      ]),
  });
}

/**
 * A cargo's Canais (P6): which channels its people see, grouped as the sidebar, each saying who sees it now. A tap
 * follows W5: a public one asks who sees it (P6b), a limited one saves at once (asking first when people leave), an
 * invite-only one asks before it opens. #general and channels the viewer doesn't manage say why on a tap.
 */
export function RoleChannelsScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const fail = useFail();
  const { orgId, org, data, people, failed, error, retry, viewer } = useRolesData();
  const channels = useChannels(orgId);
  const categories = useChannelCategories(orgId);
  const save = useSaveChannel();
  const api = useApi();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const title = t("mobile.roles.tabs.channels");
  if (!data || !people || !channels.data)
    return (
      <Waiting
        title={title}
        failed={failed || channels.isError}
        error={error ?? channels.error}
        retry={() => {
          retry();
          void channels.refetch();
        }}
      />
    );
  const role = data.roles.find((r) => r.id === roleId);
  if (!role) return <Gone title={title} />;
  const name = roleName(t, role);
  const locked = roleLock(org ?? { role: "member" }, role) !== null;
  const admin = !isEveryone(role) && role.permissions.includes("administrator");
  const groups = channelGroups(channels.data, categories.data ?? [], query);
  const onlyGeneral = channels.data.every(isGeneral);
  const header = isEveryone(role) ? t("mobile.roles.channels.headerBase") : t("mobile.roles.channels.header", { name });
  const send = (channel: Channel, input: ChannelInput) =>
    save.mutate({ channelId: channel.id, input }, { onSuccess: () => successHaptic(), onError: fail });
  const tap = async (channel: Channel) => {
    tapHaptic();
    const intent = channelIntent(role, channel, managesChannel(channel, viewer.userId, org));
    if (intent.kind === "fixed") return toast({ title: t("mobile.roles.channels.general"), icon: "lock" });
    if (intent.kind === "locked")
      return toast({ title: t("mobile.roles.channels.locked", { channel: channel.name }), icon: "lock" });
    if (intent.kind === "who") return router.push(rolesHref.channel(role.id, channel.id));
    if (intent.open) {
      const everyone = intent.open === "everyone";
      const sure = await ask(
        everyone
          ? {
              title: t("mobile.roles.channels.openAllTitle", { channel: channel.name }),
              text: t("mobile.roles.channels.openAllText"),
            }
          : {
              title: t("mobile.roles.channels.openTitle", { channel: channel.name, name }),
              text: t("mobile.roles.channels.openText", { name }),
            },
        t("common.cancel"),
        t("mobile.roles.channels.openAction"),
      );
      if (sure) send(channel, intent.input);
      return;
    }
    const a = accessOf(channel);
    if (a.mode === "roles" && a.roleIds.includes(role.id)) {
      // Taking it from the cargo: who is in only through it leaves, so that is asked first.
      try {
        const members = await qc.fetchQuery({ ...channelMembersQuery(api, orgId, channel.id), staleTime: 0 });
        const { leave } = channelLeavers(
          channel,
          { visibility: intent.input.visibility ?? "private", audienceRoleIds: intent.input.audienceRoleIds ?? [] },
          members.filter((m) => m.type === "person").map((m) => m.id),
          people,
          data.roles,
        );
        if (leave.length) {
          const sure = await ask(
            {
              title: t("mobile.roles.channels.leaveTitle", { channel: channel.name, name }),
              text: t("mobile.roles.channels.leave", {
                count: leave.length,
                names: peopleNames(t, leave, viewer.userId),
              }),
            },
            t("common.cancel"),
            t("mobile.roles.channels.leaveAction"),
            true,
          );
          if (!sure) return;
        }
      } catch (e) {
        return fail(e);
      }
    }
    send(channel, intent.input);
  };
  return (
    <SettingsPage title={title} subtitle={name}>
      <GroupedHeader hint={{ name: t("common.about", { label: header }), text: t("mobile.roles.channels.hint") }}>
        {header}
      </GroupedHeader>
      {admin ? (
        <View style={styles.note}>
          <Note icon="shield">{t("mobile.roles.channels.admin", { name })}</Note>
        </View>
      ) : (
        <>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.roles.channels.search")}
            accessibilityLabel={t("mobile.roles.channels.search")}
            returnKeyType="search"
          />
          {groups.map((g) => (
            <View key={g.id ?? "none"}>
              <GroupedHeader>{g.name ?? t("mobile.roles.channels.ungrouped")}</GroupedHeader>
              <GroupedList>
                {g.channels.map((c) => {
                  const fixed = isGeneral(c) || !managesChannel(c, viewer.userId, org);
                  return (
                    <GroupedRow
                      key={c.id}
                      icon={c.visibility === "public" ? "hash" : "lock"}
                      label={`#${c.name}`}
                      labelLines={0}
                      sub={channelAudienceLine(t, c, data.roles)}
                      subLines={2}
                      media
                      checked={channelTicked(role, c)}
                      faint={fixed}
                      disabled={locked || (save.isPending && save.variables?.channelId === c.id)}
                      onPress={() => void tap(c)}
                    />
                  );
                })}
              </GroupedList>
            </View>
          ))}
          {onlyGeneral ? (
            <>
              <GroupedFooter>{t("mobile.roles.channels.onlyGeneral")}</GroupedFooter>
              <GroupedList>
                <GroupedRow
                  icon="plus"
                  label={t("mobile.chats.createChannel")}
                  onPress={() => router.push("/new-channel")}
                />
              </GroupedList>
            </>
          ) : groups.length === 0 ? (
            <>
              <GroupedFooter>{t("mobile.roles.channels.noMatch", { q: query.trim() })}</GroupedFooter>
              <GroupedList>
                <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

/**
 * Quem vê #canal (P6b), pushed with Salvar: Todos, only some cargos (which), or only who is added, as the channel's own
 * details say it. The line under it says who leaves, who stops seeing it, or that its history opens.
 */
export function ChannelWhoScreen({ roleId, channelId }: { roleId: string; channelId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, data, people, failed, error: loadError, retry, viewer } = useRolesData();
  const channels = useChannels(orgId);
  const api = useApi();
  const members = useQuery(channelMembersQuery(api, orgId, channelId));
  const save = useSaveChannel();
  const [edit, setEdit] = useState<Partial<WhoSees>>({});
  const [error, setError] = useState<unknown>(null);
  const title = t("mobile.roles.channels.whoSees");
  const channel = channels.data?.find((c) => c.id === channelId);
  if (!data || !people || !channels.data)
    return (
      <Waiting title={title} failed={failed || channels.isError} error={loadError ?? channels.error} retry={retry} />
    );
  const from = data.roles.find((r) => r.id === roleId);
  if (!from || !channel) return <Gone title={title} />;
  const start = whoSeesStart(data.roles, channel, from);
  const who: WhoSees = { ...start, ...edit };
  const input = whoSeesInput(who);
  const now = accessOf(channel);
  const changed =
    input.visibility !== channel.visibility ||
    !sameList(input.audienceRoleIds ?? [], now.mode === "roles" ? now.roleIds : []);
  const roles: OrgRole[] = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const memberIds = (members.data ?? []).filter((m) => m.type === "person").map((m) => m.id);
  const choice = (mode: WhoSees["mode"], label: string, sub?: string) => (
    <GroupedRow
      key={mode}
      label={label}
      {...(sub ? { sub, subLines: 2 } : {})}
      checked={who.mode === mode}
      onPress={() => {
        tapHaptic();
        setEdit((e) => ({ ...e, mode }));
      }}
    />
  );
  return (
    <SettingsPage
      title={title}
      action={{
        label: t("common.save"),
        disabled: !changed || !members.data,
        onPress: () =>
          save.mutate(
            { channelId, input },
            {
              onSuccess: () => {
                successHaptic();
                goBack();
              },
              onError: setError,
            },
          ),
      }}
      busy={save.isPending}
    >
      {error ? (
        <View style={styles.note}>
          <Note icon="x">{errorText(t, error, i18n.language)}</Note>
        </View>
      ) : null}
      <GroupedHeader>{`#${channel.name}`}</GroupedHeader>
      <GroupedList>
        {choice("public", t("rolesPage.everyoneName"), t("mobile.roles.channels.allSub"))}
        {choice("roles", t("mobile.roles.someRoles"))}
        {choice("private", t("mobile.roles.channels.invited"), t("mobile.roles.channels.invitedSub"))}
      </GroupedList>
      {who.mode === "roles" ? (
        <>
          <GroupedHeader>{t("settings.section.roles")}</GroupedHeader>
          <GroupedList>
            {roles.map((r) => {
              const count = people.filter((p) => (p.roleIds ?? []).includes(r.id)).length;
              return (
                <GroupedRow
                  key={r.id}
                  leading={<CargoMark role={r} size={30} />}
                  label={r.name}
                  labelLines={0}
                  sub={count ? t("rolesPage.people", { count }) : t("mobile.roles.nobody")}
                  media
                  checked={who.roleIds.has(r.id)}
                  onPress={() => {
                    tapHaptic();
                    setEdit((e) => {
                      const next = new Set(e.roleIds ?? start.roleIds);
                      if (!next.delete(r.id)) next.add(r.id);
                      return { ...e, roleIds: next };
                    });
                  }}
                />
              );
            })}
          </GroupedList>
        </>
      ) : null}
      {members.data
        ? whoSeesLines(t, channel, who, memberIds, people, data.roles, viewer.userId).map((line) => (
            <GroupedFooter key={line}>{line}</GroupedFooter>
          ))
        : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
});
