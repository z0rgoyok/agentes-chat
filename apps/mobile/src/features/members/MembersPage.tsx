import {
  type Person,
  type RemovalPreview,
  useApi,
  useCancelSuggestion,
  useMySuggestions,
  usePeople,
  useRemoveMember,
  useRoles,
} from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { removalLines } from "@agenteschat/client/lib/removal";
import { isBelow, leaves, removes } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, PersonAvatar, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentAi } from "../ai/AgentAiScreen";
import { Page } from "../me/parts";
import { useOpenDm } from "../new/useOpenDm";
import { RowBones, rolesHref } from "../roles/parts";
import { chooseAction, Gap } from "../settings/parts";
import { Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useMeId } from "../shared/hooks";
import { errorHaptic, Loaded, successHaptic, useLatest } from "../shared/parts";
import { invitersOf, memberActions, memberLine, membersByName, outsideLine, whenWords } from "./logic";

/** What leads each of a person's actions in their row's menu. */
const ACT_ICON = { roles: "shield", leave: "out", remove: "trash" } as const;
/**
 * How long a removal's preview (what goes with the person) is reused: it is read as the row's menu opens, so Remove
 * confirms at once, and it is read again for any later removal.
 */
const REMOVAL_FRESH_MS = 30_000;

/** The preview of removing someone, as the confirmation reads it. */
const removalQuery = (api: ReturnType<typeof useApi>, orgId: string, userId: string) => ({
  queryKey: ["org", orgId, "removal", userId],
  queryFn: () => api.orgs.removal(orgId, userId),
  staleTime: REMOVAL_FRESH_MS,
});

/**
 * Membros (ADR 0090): whoever may invite gets "Convidar pessoas" on top (what waits on them, the links and the
 * invitations sent are Convites', its own screen beside this one); a member who may not invite suggests someone.
 * Then the people, each with their roles (ADR 0085).
 */
export function MembersPage() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const meId = useMeId();
  const people = usePeople(orgId);
  const rolesQ = useRoles(orgId);
  const roles = rolesQ.data?.roles ?? [];
  const invites = can(org, "invite_people");
  const list = people.data;
  const remove = useRemoveFlow();
  const openDm = useOpenDm();
  const viewer = { role: org?.role ?? "member", rank: org?.rank, userId: meId ?? "", permissions: org?.permissions };
  // Being deleted, inviting and removing are greyed out, as on the web; leaving stays (the server takes it then too).
  const frozen = settingsFrozen(org, "members");
  // Remover do workspace for whoever may, Sair on one's own row (not the last owner); the server checks it again.
  const removable = (m: Person) =>
    m.userId === meId ? leaves(viewer, list ?? []) : !frozen && removes(viewer, m, roles);
  // Their cargos (P11): who manages people, for someone below them (or themselves), with a cargo to give.
  const givesCargos = (m: Person) =>
    !frozen && can(org, "manage_members") && isBelow(viewer, m, roles) && roles.some((r) => r.givable);
  // Sorted once per list: the page draws again on every change of anyone's presence.
  const sorted = useMemo(() => (list ? membersByName(list, i18n.language) : []), [list, i18n.language]);
  // A row's menu, the same function for every row and render (the rows are memoized).
  const message = useLatest((m: Person) => void openDm({ userId: m.userId }));
  const openMenu = useLatest((m: Person, acts: MemberAct[]) => {
    const run = {
      roles: () => router.push(rolesHref.person(m.userId)),
      remove: () => void remove(m),
    };
    const removes = acts.includes("remove") || acts.includes("leave");
    // What goes with them is read while the menu opens: Remove asks at once.
    if (removes) void qc.prefetchQuery(removalQuery(api, orgId, m.userId));
    chooseAction(
      m.name,
      acts.map((a) => ({
        icon: ACT_ICON[a],
        label: t(a === "roles" ? "rolesPage.rolesCta" : a === "leave" ? "members.remove.leave" : "members.remove.item"),
        destructive: a === "remove" || a === "leave",
        onPress: run[a === "leave" ? "remove" : a],
      })),
      t("common.cancel"),
    );
  });

  return (
    <Page
      title={
        isPersonal(org)
          ? t("settings.section.membersPersonal")
          : invites
            ? t("settings.section.members")
            : t("members.title")
      }
      // A pull reads the people and their roles again.
      onRefresh={() => Promise.allSettled([people.refetch(), rolesQ.refetch()])}
    >
      <Gap />
      <Locked when={frozen} readable>
        {invites ? (
          <GroupedList>
            <GroupedRow icon="plus" label={t("members.inviteTitle")} onPress={() => router.push("/invite-people")} />
          </GroupedList>
        ) : (
          <Suggestions />
        )}
      </Locked>

      <GroupedHeader>{list ? `${t("members.people")} · ${list.length}` : t("members.people")}</GroupedHeader>
      {list ? (
        <Loaded>
          <GroupedList>
            {sorted.map((m) => (
              <MemberRow
                key={m.userId}
                person={m}
                mine={m.userId === meId}
                sub={memberLine(t, i18n.language, m, roles)}
                removable={Boolean(removable(m))}
                cargos={givesCargos(m)}
                ring={c.raised}
                onMenu={openMenu}
                onMessage={message}
                leading
              />
            ))}
          </GroupedList>
        </Loaded>
      ) : people.isError ? (
        // A list that didn't load is not a spinner forever: what happened, and the way to ask again (or the pull).
        <LoadFailed onRetry={() => void people.refetch()} />
      ) : (
        // The rows' shape while they load: nothing jumps when they come.
        <GroupedList>
          <RowBones />
          <RowBones name={56} />
          <RowBones name={34} />
        </GroupedList>
      )}
    </Page>
  );
}

type MemberAct = ReturnType<typeof memberActions>[number];

/**
 * A person on Members: their face with its presence, their name (marked as you on one's own row), their line and,
 * for an outside collaborator, whom they work for; a message button for anyone else, and a tap opens the actions
 * the viewer has on them, if any. Drawn again only when what it shows changes.
 */
const MemberRow = memo(function MemberRow({
  person: m,
  mine,
  sub,
  removable,
  cargos,
  ring,
  onMenu,
  onMessage,
}: {
  person: Person;
  mine: boolean;
  sub: string;
  removable: boolean;
  cargos: boolean;
  /** The surface the face's presence badge is ringed in. */
  ring: string;
  onMenu: (m: Person, acts: MemberAct[]) => void;
  onMessage: (m: Person) => void;
  /** Always with a face: GroupedList reads it to start the hairline after the face's column, as a GroupedRow's. */
  leading: boolean;
}) {
  const { t } = useTranslation();
  const acts = memberActions(mine, removable, cargos);
  const outside = outsideLine(t, m);
  return (
    <GroupedRow
      leading={<Face who={{ type: "person", id: m.userId }} size={30} live={false} presence ring={ring} />}
      label={mine ? `${m.name}${t("common.youSuffix")}` : m.name}
      sub={sub}
      {...(outside ? { belowText: outside } : {})}
      {...(mine
        ? {}
        : {
            buttons: [{ icon: "chat", label: t("profile.messageTo", { name: m.name }), onPress: () => onMessage(m) }],
          })}
      {...(acts.length > 0 ? { more: true, onPress: () => onMenu(m, acts) } : {})}
    />
  );
});

/**
 * "Remover do workspace" (or "Sair do workspace"): what goes with the person, as the server reads it, in the system's
 * confirmation; then the removal, and the person's own leaving goes back to the start.
 */
export function useRemoveFlow() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const meId = useMeId();
  const toast = useToast();
  const remove = useRemoveMember(orgId);
  const orgName = org?.name ?? "";
  const failed = (e: unknown) => {
    errorHaptic();
    toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
  };
  return async (m: Pick<Person, "userId" | "name">) => {
    const mine = m.userId === meId;
    let lines: string[];
    let preview: RemovalPreview;
    try {
      // Read as the row's menu opened: the confirmation shows at once, and waits only for a read still on its way.
      preview = await qc.fetchQuery(removalQuery(api, orgId, m.userId));
      lines = removalLines(t, preview, { name: m.name, org: orgName, mine, meId: meId ?? "" });
    } catch (e) {
      return failed(e);
    }
    const go = async () => {
      try {
        await remove.mutateAsync(m.userId);
        successHaptic();
        const lost = mine ? undefined : preview.losePlan[0];
        toast({
          title: mine
            ? t("members.remove.left", { org: orgName })
            : t("members.remove.done", { name: m.name, org: orgName }),
          ...(lost ? { action: { label: t("usageCard.chooseBrain"), onPress: () => openAgentAi(lost.id) } } : {}),
        });
        if (mine) router.replace("/");
      } catch (e) {
        failed(e);
      }
    };
    Alert.alert(
      mine
        ? t("members.remove.leaveTitle", { org: orgName })
        : t("members.remove.title", { name: m.name, org: orgName }),
      lines.join("\n\n"),
      [
        { text: t("mobile.common.back"), style: "cancel" },
        {
          text: mine
            ? t("members.remove.confirmLeave", { org: orgName })
            : t("members.remove.confirm", { name: m.name }),
          style: "destructive",
          onPress: () => void go(),
        },
      ],
    );
  };
}

/**
 * A member who may not invite (ADR 0090 §7): "Sugerir pessoa", which reaches the people who invite as a request, who
 * they are, and the suggestions still waiting, each to take back.
 */
function Suggestions() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const people = usePeople(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const waiting = useMySuggestions(orgId).data ?? [];
  const cancel = useCancelSuggestion(orgId);
  const inviters = invitersOf(people, roles);

  const cancelIt = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      successHaptic();
      toast({ title: t("members.suggest.cancelled") });
    } catch (e) {
      errorHaptic();
      toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
    }
  };
  const confirmCancel = (id: string, email: string) =>
    Alert.alert(t("members.suggest.cancelOf", { email }), undefined, [
      { text: t("mobile.common.back"), style: "cancel" },
      { text: t("common.cancel"), style: "destructive", onPress: () => void cancelIt(id) },
    ]);

  return (
    <>
      <GroupedList>
        <GroupedRow icon="plus" label={t("members.suggest.button")} onPress={() => router.push("/suggest-person")} />
      </GroupedList>
      <GroupedFooter>
        {inviters.length > 0
          ? t("members.suggest.lead", { count: inviters.length, names: namesText(t, inviters, 2) })
          : t("members.suggest.leadNoNames")}
      </GroupedFooter>
      {waiting.length > 0 ? (
        <>
          <GroupedHeader>{t("members.suggest.mine")}</GroupedHeader>
          <GroupedList>
            {waiting.map((s) => (
              <GroupedRow
                key={s.id}
                leading={<PersonAvatar name={s.email} size={30} />}
                label={s.email}
                labelLines={2}
                sub={t("members.suggest.waiting", { when: whenWords(t, i18n.language, s.createdAt) })}
                media
                {...(s.note ? { belowText: s.note } : {})}
                more
                disabled={cancel.isPending}
                onPress={() => confirmCancel(s.id, s.email)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}
