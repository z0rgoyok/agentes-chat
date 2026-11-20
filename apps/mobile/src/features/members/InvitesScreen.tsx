import {
  type InvitationWithStatus,
  type InviteLink,
  type JoinRequest,
  useAllInvitations,
  useChannels,
  useInviteLinks,
  useJoinRequests,
  useMakeInviteLink,
  useMe,
  useRoles,
  useTurnOffInviteLink,
} from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatInt } from "@agenteschat/client/lib/format";
import { linkNeedsAttention } from "@agenteschat/client/lib/invite-start";
import { can } from "@agenteschat/client/lib/permissions";
import { everyoneOf, sortRoles } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Share, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, PersonAvatar, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { CargoMark, RowBones } from "../roles/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useMeId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { type ActionItem, ActionList, copyText, Loaded, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { useStartFields } from "./InviteFields";
import { InvitationSheet } from "./InviteSheets";
import {
  draftFrom,
  givesLine,
  invitationLine,
  invitationSender,
  linkLine,
  linkTitle,
  listedInvitations,
  requestLine,
} from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/**
 * Convites (ADR 0068, 0090, 0184), Configurações › Workspace › Pessoas: who waits on an answer, the links (each with
 * what it gives and how it stands) and the invitations sent by e-mail, the web's rows in two lines. A request opens
 * the review sheet, a link its sheet, an invitation its actions; the bar's "+" opens Convidar pessoas.
 */
export function InvitesScreen() {
  return (
    <SheetHostProvider>
      <Invites />
    </SheetHostProvider>
  );
}

function Invites() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const me = useMe().data?.user.name;
  const dir = useDirectory();
  const allowed = can(org, "invite_people");
  const requests = useJoinRequests(orgId, allowed);
  const links = useInviteLinks(orgId, allowed);
  const invitations = useAllInvitations(orgId, allowed);
  const roles = useRoles(orgId).data?.roles ?? [];
  const channels = useChannels(orgId).data ?? [];
  const make = useMakeInviteLink(orgId);
  // Being deleted, nothing here changes, as on the web.
  const frozen = settingsFrozen(org, "members");
  // Sent again from here: until when it works now.
  const [resent, setResent] = useState<Record<string, string>>({});
  const title = t("settings.section.invites");
  const known = { roles, channels, agents: dir.agents };
  const invite = () => router.push("/invite-people");

  if (!allowed)
    return (
      <SettingsPage title={title}>
        <GroupedFooter>{t("common.notAllowed")}</GroupedFooter>
      </SettingsPage>
    );

  const waiting = requests.data;
  const linkList = links.data;
  const sent = invitations.data ? listedInvitations(invitations.data) : undefined;
  const loaded = waiting && linkList && sent;
  const failedToLoad = !loaded && (requests.isError || links.isError || invitations.isError);
  const retry = () => {
    void requests.refetch();
    void links.refetch();
    void invitations.refetch();
  };
  const copyWorkspaceLink = async () => {
    try {
      const link = await make.mutateAsync();
      if (!(await copyText(link.url))) return toast({ title: t("mobile.app.failed"), icon: "x" });
      successHaptic();
      toast({ title: t("common.copied") });
    } catch (e) {
      toast({ title: errorText(t, e, i18n.language), icon: "x" });
    }
  };
  const openInvitation = (inv: InvitationWithStatus) =>
    sheet.open(
      <InvitationSheet
        invitation={inv}
        line={invitationLine(t, i18n.language, inv, roles, {
          resentUntil: resent[inv.id],
          sender: invitationSender(t, inv, me),
        })}
        resent={Boolean(resent[inv.id])}
        onResent={(id, until) => setResent((all) => ({ ...all, [id]: until }))}
      />,
    );
  // How it came on one line, what its link gives on the next: each wraps whole, nothing cut.
  const request = (r: JoinRequest) => {
    const gives = r.link ? givesLine(t, known, r.link) : [];
    return (
      <GroupedRow
        key={r.id}
        leading={<PersonAvatar name={r.name} size={30} />}
        label={r.name}
        labelLines={2}
        sub={requestLine(t, i18n.language, r, [])}
        subLines={0}
        {...(gives.length > 0 ? { belowText: gives.join(" · ") } : {})}
        media
        chevron
        onPress={() => router.push({ pathname: "/join-requests", params: { request: r.id } })}
      />
    );
  };

  return (
    <SettingsPage
      title={title}
      actions={[{ icon: "plus", sf: "plus", label: t("members.inviteTitle"), onPress: invite }]}
      // A pull reads who waits, the links and the invitations sent again.
      onRefresh={() => Promise.allSettled([requests.refetch(), links.refetch(), invitations.refetch()])}
    >
      <MembersFullNote />
      {failedToLoad ? (
        // A list that didn't load is not an empty one: what happened, and the way to ask again.
        <LoadFailed onRetry={retry} />
      ) : !loaded ? (
        // The rows' shape while they load: nothing jumps when they come.
        <>
          <Gap />
          <GroupedList>
            <RowBones />
            <RowBones name={56} />
            <RowBones name={34} />
          </GroupedList>
        </>
      ) : waiting.length + linkList.length + sent.length === 0 ? (
        <Loaded>
          <Gap />
          <GroupedList>
            <GroupedRow icon="plus" label={t("members.inviteTitle")} onPress={invite} />
            <GroupedRow
              icon="link"
              label={t("members.copyInviteLink")}
              disabled={make.isPending || frozen}
              onPress={() => void copyWorkspaceLink()}
            />
          </GroupedList>
          <GroupedFooter>{t("members.invitations.empty")}</GroupedFooter>
        </Loaded>
      ) : (
        <Loaded>
          <Locked when={frozen} readable>
            {waiting.length > 0 ? (
              <>
                <GroupedHeader>{`${t("members.waitingTitle")} · ${formatInt(i18n.language, waiting.length)}`}</GroupedHeader>
                <GroupedList>{waiting.map(request)}</GroupedList>
              </>
            ) : null}
            {linkList.length > 0 ? (
              <>
                <GroupedHeader>{`${t("invites.links")} · ${formatInt(i18n.language, linkList.length)}`}</GroupedHeader>
                <GroupedList>
                  {linkList.map((l) => (
                    <LinkRow key={l.id} link={l} onPress={() => sheet.open(<LinkSheet link={l} />)} />
                  ))}
                </GroupedList>
              </>
            ) : null}
            {sent.length > 0 ? (
              <>
                <GroupedHeader>{`${t("invites.emails")} · ${formatInt(i18n.language, sent.length)}`}</GroupedHeader>
                <GroupedList>
                  {sent.map((inv) => (
                    <GroupedRow
                      key={inv.id}
                      leading={<PersonAvatar name={inv.email} size={30} />}
                      label={inv.email}
                      labelLines={3}
                      sub={invitationLine(t, i18n.language, inv, roles, { resentUntil: resent[inv.id] })}
                      subLines={0}
                      media
                      chevron
                      onPress={() => openInvitation(inv)}
                    />
                  ))}
                </GroupedList>
              </>
            ) : null}
          </Locked>
        </Loaded>
      )}
    </SettingsPage>
  );
}

/**
 * A link's row: its first cargo's mark (Todos' for Membro), its cargos as the name, then how it stands, in amber when
 * it took all its people or has less than a day left.
 */
function LinkRow({ link, onPress }: { link: InviteLink; onPress: () => void }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const meId = useMeId();
  const roles = useRoles(orgId).data?.roles ?? [];
  const first = sortRoles(roles.filter((r) => (link.roleIds ?? []).includes(r.id)))[0] ?? everyoneOf(roles);
  const line = linkLine(t, i18n.language, link, meId);
  return (
    <GroupedRow
      {...(first ? { leading: <CargoMark role={first} size={30} /> } : {})}
      label={linkTitle(t, roles, link)}
      labelLines={0}
      sub={line}
      subLines={0}
      subTone={linkNeedsAttention(link) ? "amber" : "faint"}
      media
      chevron
      onPress={onPress}
    />
  );
}

/**
 * A link's sheet: its address (selectable), what it gives (Cargo, Canais, Agentes, as their fields show them), then
 * Copiar link, Compartilhar, Editar and Desativar link behind the system's confirmation, which counts the requests it
 * closes too. A link made before links could be shown again can only be turned off.
 */
function LinkSheet({ link }: { link: InviteLink }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const meId = useMeId();
  const roles = useRoles(orgId).data?.roles ?? [];
  const turnOff = useTurnOffInviteLink(orgId);
  const draft = { ...draftFrom(roles, link), addresses: [], note: "", expiresIn: null, maxUses: null };
  const gives = useStartFields(`sheet:${link.id}`, draft, { readOnly: true });
  const url = link.url;
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });
  const off = async () => {
    sheet.close();
    try {
      await turnOff.mutateAsync(link.id);
      toast({ title: t("invites.linkTurnedOff") });
    } catch (e) {
      failed(e);
    }
  };
  const confirmOff = () =>
    Alert.alert(t("members.link.turnOffTitle"), t("members.link.turnOffText", { count: link.waiting }), [
      { text: t("mobile.common.cancel"), style: "cancel" },
      { text: t("members.link.turnOff"), style: "destructive", onPress: () => void off() },
    ]);
  const actions: ActionItem[] = url
    ? [
        {
          key: "copy",
          icon: "copy",
          label: t("members.copyLink"),
          // A copy the system refused says so, as any button that did nothing would leave the person guessing.
          onPress: () =>
            void copyText(url).then((ok) => {
              sheet.close();
              if (!ok) return toast({ title: t("mobile.app.failed"), icon: "x" });
              successHaptic();
              toast({ title: t("common.copied") });
            }),
        },
        {
          key: "share",
          icon: "share",
          label: t("mobile.joinRequests.share"),
          onPress: () =>
            void Share.share({ message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url }) })
              .catch(() => undefined)
              .finally(sheet.close),
        },
        {
          key: "edit",
          icon: "pen",
          label: t("invites.edit"),
          // Pushed once the sheet is gone: a screen opened under its modal would wait behind it.
          onPress: () => sheet.close(() => router.push({ pathname: "/invite-link", params: { id: link.id } })),
        },
      ]
    : [];
  return (
    <>
      <SheetTitle title={t("members.link.title")} subtitle={linkLine(t, i18n.language, link, meId)} />
      {url ? (
        <View style={styles.url}>
          <Text variant="callout" selectable>
            {url}
          </Text>
        </View>
      ) : null}
      <GroupedList>{gives.fields}</GroupedList>
      {actions.length > 0 ? <ActionList items={actions} /> : null}
      <ActionList
        items={[
          {
            key: "off",
            icon: "x",
            label: t("members.link.turnOff"),
            danger: true,
            disabled: turnOff.isPending,
            onPress: confirmOff,
          },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  url: { paddingHorizontal: 16 },
});
