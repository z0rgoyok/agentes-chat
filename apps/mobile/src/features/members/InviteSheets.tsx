import {
  type InvitationWithStatus,
  useAuthConfig,
  useResendInvitation,
  useRevokeInvitation,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { useTranslation } from "react-i18next";
import { Alert, Share } from "react-native";
import { useOrg } from "@/providers/org";
import { Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { SheetTitle } from "../shared/PromptForm";
import { type ActionItem, ActionList, copyText, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { invitationExpired, sentWords } from "./logic";

/**
 * A sent invitation's actions (ADR 0090, 0184): its link at any time, the same as the email's, sent again with that
 * link, Editar (what it gives: Editar convite), and Cancelar with the note on why: one that leaked stops only here. One
 * sent before links lasted has no link to copy; sending it again gives it one. An expired one is renewed or taken off
 * the list.
 */
export function InvitationSheet({
  invitation: inv,
  line,
  resent,
  onResent,
}: {
  invitation: InvitationWithStatus;
  /** Its roles, who sent it and when it stops working. */
  line: string;
  /** Sent again from here already. */
  resent: boolean;
  onResent: (id: string, until: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const resend = useResendInvitation(orgId);
  const revoke = useRevokeInvitation(orgId);
  const emails = sendsEmail(useAuthConfig().data);
  const words = sentWords(emails);
  const email = inv.email;
  const url = inv.url ?? null;
  const expired = invitationExpired(inv) && !resent;
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });

  // Toasts wait for the sheet to go: they'd sit under its modal. Awaited, not `mutate`'s callbacks, which an unmounted
  // sheet would never run.
  const copy = async () => {
    if (!url) return;
    const ok = await copyText(url);
    sheet.close();
    // A copy the system refused says so: a button that does nothing leaves the person guessing.
    if (!ok) return toast({ title: t("mobile.app.failed"), icon: "x" });
    successHaptic();
    toast({ title: t(`members.invitations.${words.copied}`, { email }) });
  };
  const sendAgain = async () => {
    sheet.close();
    try {
      const res = await resend.mutateAsync(inv.id);
      onResent(inv.id, res.expiresAt);
      successHaptic();
      const date = formatShortDate(i18n.language, res.expiresAt);
      toast({
        title: expired
          ? t(emails ? "members.invitations.renewed" : "members.invitations.renewedNoEmail", { email })
          : t(`members.invitations.${url ? words.resent : words.newLink}`, { email, date }),
      });
    } catch (e) {
      failed(e);
    }
  };
  const cancelIt = async () => {
    sheet.close();
    try {
      await revoke.mutateAsync(inv.id);
      toast({ title: t(expired ? "members.invitations.dropped" : "members.invitations.cancelled", { email }) });
    } catch (e) {
      failed(e);
    }
  };
  const confirmCancel = () =>
    Alert.alert(t("mobile.invitePeople.cancelTitle", { email }), t("mobile.invitePeople.cancelText"), [
      { text: t("mobile.common.back"), style: "cancel" },
      { text: t("members.invitations.cancel"), style: "destructive", onPress: () => void cancelIt() },
    ]);

  if (expired)
    return (
      <>
        <SheetTitle title={email} subtitle={line} />
        <ActionList
          items={[
            {
              key: "renew",
              icon: "replay",
              label: t("members.invitations.renew"),
              disabled: resend.isPending,
              onPress: () => void sendAgain(),
            },
          ]}
        />
        <ActionList
          items={[
            {
              key: "drop",
              icon: "x",
              label: t("members.invitations.drop"),
              danger: true,
              disabled: revoke.isPending,
              onPress: () => void cancelIt(),
            },
          ]}
        />
      </>
    );

  const actions: ActionItem[] = [
    ...(url
      ? [
          { key: "copy", icon: "copy" as const, label: t("members.copyLink"), onPress: () => void copy() },
          {
            key: "share",
            icon: "share" as const,
            label: t("mobile.joinRequests.share"),
            onPress: () =>
              void Share.share({ message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url }) })
                .catch(() => undefined)
                .finally(sheet.close),
          },
        ]
      : []),
    {
      key: "again",
      icon: "send",
      label: emails ? t("mobile.invitePeople.sendAgain") : t("members.invitations.renew"),
      disabled: (resent && !inv.undelivered) || resend.isPending,
      onPress: () => void sendAgain(),
    },
    {
      key: "edit",
      icon: "pen",
      label: t("invites.edit"),
      // Pushed once the sheet is gone: a screen opened under its modal would wait behind it.
      onPress: () => sheet.close(() => router.push({ pathname: "/invite-edit", params: { id: inv.id } })),
    },
  ];
  return (
    <>
      <SheetTitle title={email} subtitle={line} />
      <ActionList items={actions} />
      <ActionList
        items={[
          {
            key: "cancel",
            icon: "x",
            label: t("members.invitations.cancel"),
            danger: true,
            onPress: confirmCancel,
          },
        ]}
      />
      {/* Sending again keeps a lasting link: one that reached the wrong person stops only here. */}
      {url ? (
        <Text variant="footnote" tone="faint">
          {t("members.invitations.linkStays")}
        </Text>
      ) : null}
    </>
  );
}
