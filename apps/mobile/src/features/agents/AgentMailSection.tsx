import { type AgentMailbox, useAgentMail, useMailAccounts, useSetAgentMail } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import { canTalk, managesAgent } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { defaultPolicy, mailAccessOf, mailboxName, onlyForOwner, toMailLevel } from "@agenteschat/client/lib/mail";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { pickLevel } from "../connectors/pick-level";
import { useDirectory, useMeId, useOrgId, useOwnsAgent } from "../shared/hooks";

const toLevel = (l: AgentMailbox["level"]): Level => (l === "read_write" ? "write" : l);

/** One connected mailbox as a row of the agent's "Can use". */
export interface MailboxLine {
  id: string;
  address: string;
  /** Its level in words, the row's value. */
  level: string;
  /** On a mailbox someone else connected: who gives access to it, which is why its level can't be changed here. */
  sub: string | null;
  /** On one's own with the right hand: that it serves only them, behind the row's ⓘ. */
  hint: { name: string; text: string } | null;
  /** On one's own mailbox: a tap opens the app's level picker. */
  onPress: (() => void) | null;
  /** On someone else's, for admins and the agent's owner while it has access: take it away. */
  remove: { label: string; busy: boolean; onPress: () => void } | null;
}

/**
 * The agent's access to each connected mailbox (ADR 0038), as rows for its profile's "Can use" (beside its apps,
 * so what it can use is one list). Only who connected a mailbox gives access to it: on their own a tap picks the
 * level; on anyone else's the row says who gives it, and admins and the agent's owner may remove it. Rules stay on
 * the web. None while the mailboxes load, and none asked for while `enabled` is off (who doesn't see the agent's
 * details).
 */
export function useAgentMailboxes(agentId: string, enabled = true): MailboxLine[] {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const owns = useOwnsAgent();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  // Someone else's mailbox shows only while this agent holds it (who manages connectors gets those, named by label).
  const accounts = useMailAccounts(orgId, enabled, { others: true });
  const list = (accounts.data ?? []).filter(
    (a) =>
      a.status !== "pending" &&
      (!a.ownerUserId || a.ownerUserId === meId || a.agents.some((x) => x.agentId === agentId)),
  );
  const mail = useAgentMail(orgId, agentId, enabled && list.length > 0);
  const set = useSetAgentMail(orgId);
  if (!enabled || list.length === 0 || !mail.data) return [];
  // Who manages it (the server's `canManage`) or its owner (or one who holds its owner role, ADR 0085, addendum of
  // 2026-11-21) takes a mailbox away.
  const manages = managesAgent(agent) || owns(agent);
  const save = (accountId: string, saved: AgentMailbox | undefined, level: Level) =>
    set.mutate(
      {
        agentId,
        accountId,
        input: {
          level: toMailLevel(level),
          canDelete: level === "none" ? false : (saved?.canDelete ?? false),
          policy: saved?.policy ?? defaultPolicy(),
        },
      },
      { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
    );
  return list.map((account): MailboxLine => {
    const saved = mail.data?.find((m) => m.accountId === account.id);
    const level = toLevel(saved?.level ?? "none");
    const may = mailAccessOf(account, { userId: meId, talks: canTalk(agent), managesAgent: manages });
    const owner = account.ownerUserId ? dir.memberById.get(account.ownerUserId)?.name : undefined;
    const theirs = account.ownerUserId !== meId;
    return {
      id: account.id,
      address: account.address || mailboxName(t, account),
      level: t(`access.level.${level}`),
      sub: theirs ? (owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown")) : null,
      hint:
        !theirs && onlyForOwner(account, agent, meId)
          ? {
              name: t("common.about", { label: account.address }),
              text: t("mail.agent.onlyYou", { name: agent?.name ?? "" }),
            }
          : null,
      onPress:
        may.gives && !set.isPending
          ? () =>
              void pickLevel(t, account.address, level).then((picked) => {
                if (picked && picked !== level) save(account.id, saved, picked);
              })
          : null,
      remove:
        !may.gives && may.removes && level !== "none"
          ? { label: t("mail.agent.remove"), busy: set.isPending, onPress: () => save(account.id, saved, "none") }
          : null,
    };
  });
}
