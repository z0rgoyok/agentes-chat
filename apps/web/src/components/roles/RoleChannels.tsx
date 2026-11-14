import type { Channel, OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { channelMembersQuery, keys, useApi, useChannelCategories, useChannels } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { managesChannel } from "@agenteschat/client/lib/permissions";
import {
  channelLeavers,
  channelReach,
  isEveryone,
  ROLES_SEARCH_FROM,
  roleLock,
  roleName,
  roleSees,
  sortRoles,
} from "@agenteschat/client/lib/roles";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  fold,
  GroupHeading,
  HintLine,
  Icon,
  List,
  SavedNote,
  SearchField,
  Tip,
  Toolbar,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewChannelDialog } from "@/components/NewChannelDialog";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { Names, WhoChip } from "./parts";
import { WhoSeesDialog } from "./WhoDialogs";

type ChannelInput = { visibility: "public" | "private"; audienceRoleIds: string[] };

/** A question before a channel's change: who leaves it, or who starts seeing it and its history. */
type Ask =
  | { kind: "remove"; channel: Channel; next: ChannelInput; leaving: Person[] }
  | { kind: "open"; channel: Channel; next: ChannelInput };

/**
 * A cargo's Canais (W5): which channels its people see and may join, a checklist grouped as the sidebar is, each row
 * with who sees it now. A change goes through the channel's own (visibility and cargos, ADR 0125); one that takes
 * people out of it, or opens it with its history, asks first. Todos' are the public ones.
 */
export function RoleChannels({ role, data, people }: { role: OrgRole; data: OrgRoles; people: Person[] }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useChannels(org.id).data ?? [];
  const categories = useChannelCategories(org.id).data ?? [];
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const [sees, setSees] = useState<{ channel: Channel; start: Set<string> } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  const save = useMutation({
    mutationFn: ({ channel, next }: { channel: Channel; next: ChannelInput }) =>
      api.chat.update(org.id, channel.id, next),
    onSuccess: () => setSaved(true),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.channels(org.id) }),
        qc.invalidateQueries({ queryKey: keys.roles(org.id) }),
      ]),
  });
  const base = isEveryone(role);
  const name = roleName(t, role);
  const lock = roleLock(org, role) !== null;
  if (!base && role.permissions.includes("administrator"))
    return (
      <div className="roles-tab">
        <p className="roles-adminnote ac-iconline">
          <Icon name="shield" size={16} />
          <span>{t("rolesPage.channels.admin", { name })}</span>
        </p>
      </div>
    );
  const roles = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const byId = new Map(roles.map((r) => [r.id, r]));
  // Who sees a channel has no rank rule (`channelRoleIds`): narrowing one starts with every other cargo ticked, the
  // viewer's own and those above it too.
  const others = roles.filter((r) => r.id !== role.id);
  const general = (c: Channel) => c.name === "general";
  const q = fold(query.trim());
  const shown = channels.filter((c) => !q || fold(c.name).includes(q));
  const known = new Set(categories.map((c) => c.id));
  const loose = shown.filter((c) => !c.categoryId || !known.has(c.categoryId));
  const order = (list: Channel[]) =>
    [...list].sort(
      (a, b) =>
        Number(general(b)) - Number(general(a)) ||
        (a.position ?? 0) - (b.position ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const groups = [
    { id: "loose", name: t("shell.channels"), list: order(loose) },
    ...[...categories]
      .sort((a, b) => a.position - b.position)
      .map((g) => ({ id: g.id, name: g.name, list: order(shown.filter((c) => c.categoryId === g.id)) })),
  ].filter((g) => g.list.length > 0);
  const membersOf = async (c: Channel) =>
    (await qc.fetchQuery(channelMembersQuery(api, org.id, c.id))).filter((m) => m.type === "person").map((m) => m.id);

  const change = async (c: Channel, on: boolean) => {
    const reach = channelReach(c);
    if (!on && reach.kind === "everyone") {
      setSees({ channel: c, start: new Set(others.map((r) => r.id)) });
      return;
    }
    if (base) {
      if (on) setAsk({ kind: "open", channel: c, next: { visibility: "public", audienceRoleIds: [] } });
      return;
    }
    if (!on && reach.kind === "roles") {
      const next: ChannelInput = {
        visibility: "private",
        audienceRoleIds: reach.roleIds.filter((id) => id !== role.id),
      };
      try {
        const { leave } = channelLeavers(c, next, await membersOf(c), people, data.roles);
        if (leave.length > 0) setAsk({ kind: "remove", channel: c, next, leaving: leave });
        else save.mutate({ channel: c, next });
      } catch (e) {
        toast.show(errorText(t, e), "error");
      }
      return;
    }
    if (on && reach.kind === "roles") {
      save.mutate({ channel: c, next: { visibility: "private", audienceRoleIds: [...reach.roleIds, role.id] } });
      return;
    }
    if (on && reach.kind === "private")
      setAsk({ kind: "open", channel: c, next: { visibility: "private", audienceRoleIds: [role.id] } });
  };

  const row = (c: Channel) => {
    const reach = channelReach(c);
    const on = general(c) || roleSees(role, c);
    const mine = managesChannel(c, me.user.id, org);
    const busy = save.isPending && save.variables?.channel.id === c.id;
    const why = general(c)
      ? t("rolesPage.channels.general")
      : !mine
        ? t("rolesPage.channels.notYours", { channel: c.name })
        : undefined;
    const id = `role-${role.id}-channel-${c.id}`;
    const chip =
      reach.kind === "everyone" ? (
        <WhoChip everyone />
      ) : reach.kind === "roles" ? (
        <WhoChip roles={reach.roleIds.flatMap((rid) => (byId.has(rid) ? [byId.get(rid) as OrgRole] : []))} />
      ) : (
        <WhoChip icon="lock" />
      );
    const box = (
      <label htmlFor={id} className="roles-check ac-actrow__text" data-off={why || lock ? "" : undefined}>
        <Checkbox
          id={id}
          checked={on}
          disabled={Boolean(why) || lock || busy}
          onCheckedChange={(next) => void change(c, next)}
        />
        <Icon name={c.visibility === "private" ? "lock" : "channel"} size={18} />
        <span className="roles-check__name">#{c.name}</span>
      </label>
    );
    return (
      <div key={c.id} className="ac-list__row ac-actrow roles-checkrow">
        {why ? (
          <Tip tip={why} look="ac-msg__note-tip ac-glass" className="ac-actrow__text">
            {box}
          </Tip>
        ) : (
          box
        )}
        {chip}
      </div>
    );
  };

  return (
    <div className="roles-tab">
      <p className="roles-tabline">
        <HintLine name={t("common.about", { label: t("rolesPage.tabs.channels") })} hint={t("rolesPage.channels.hint")}>
          {base ? t("rolesPage.channels.lineBase") : t("rolesPage.channels.line", { name })}
        </HintLine>
      </p>
      <Toolbar
        size="sm"
        search={
          channels.length > ROLES_SEARCH_FROM ? (
            <SearchField
              size="sm"
              value={query}
              placeholder={t("rolesPage.channels.search")}
              aria-label={t("rolesPage.channels.search")}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel={t("filters.clearSearch")}
            />
          ) : undefined
        }
        actions={<SavedNote shown={saved} label={t("common.saved")} />}
      />
      {channels.length <= 1 ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.channels.onlyGeneral")}</span>
          {!lock && (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setCreating(true)}>
              {t("newChannel.title")}
            </Button>
          )}
        </p>
      ) : groups.length === 0 ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.channels.noMatch", { q: query.trim() })}</span>
          <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
            {t("filters.clearSearch")}
          </Button>
        </p>
      ) : (
        <div className="ac-groups">
          {groups.map((g) => (
            <section key={g.id} className="section section--tight" aria-label={g.name}>
              <GroupHeading title={g.name} count={g.list.length} />
              <List className="roles-checks">{g.list.map(row)}</List>
            </section>
          ))}
        </div>
      )}
      <WhoSeesDialog
        channel={sees?.channel ?? null}
        start={sees?.start ?? new Set()}
        onClose={() => setSees(null)}
        data={data}
        people={people}
      />
      <Dialog
        open={ask !== null}
        onOpenChange={(open) => !open && setAsk(null)}
        title={
          ask?.kind === "remove"
            ? t("rolesPage.channels.removeTitle", { channel: ask.channel.name, name })
            : ask && base
              ? t("rolesPage.channels.openAllTitle", { channel: ask.channel.name })
              : ask
                ? t("rolesPage.channels.openTitle", { channel: ask.channel.name, name })
                : ""
        }
        description={
          ask?.kind === "open"
            ? base
              ? t("rolesPage.channels.openAllText")
              : t("rolesPage.channels.openText", { name })
            : undefined
        }
        closeLabel={t("common.close")}
        width={440}
      >
        {ask?.kind === "remove" && (
          <DialogBody>
            <p className="roles-line ac-iconline">
              <Icon name="members" size={16} />
              <span>
                {t("rolesPage.channels.leave")} <Names names={ask.leaving.map((p) => p.name)} bold />.
              </span>
            </p>
          </DialogBody>
        )}
        <DialogFooter>
          <Button onClick={() => setAsk(null)}>{t("common.cancel")}</Button>
          <Button
            variant={ask?.kind === "remove" ? "danger" : "primary"}
            onClick={() => {
              if (ask) save.mutate({ channel: ask.channel, next: ask.next });
              setAsk(null);
            }}
          >
            {ask?.kind === "remove" ? t("rolesPage.remove") : t("rolesPage.channels.open")}
          </Button>
        </DialogFooter>
      </Dialog>
      <NewChannelDialog open={creating} onOpenChange={setCreating} roleIds={base ? undefined : [role.id]} />
    </div>
  );
}
