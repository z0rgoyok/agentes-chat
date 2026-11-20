import type { AgentMailbox, MailAccount, MailPolicy } from "@agenteschat/client";
import { ApiError, useAgentMail, useMailAccounts, useSetAgentMail } from "@agenteschat/client";
import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { forbiddenText, knownErrorText } from "@agenteschat/client/lib/errors";
import {
  choiceOf,
  defaultPolicy,
  fromMailLevel,
  MAIL_ACTIONS,
  mailAccessOf,
  mailboxName,
  normalizePolicy,
  onlyForOwner,
  toMailLevel,
} from "@agenteschat/client/lib/mail";
import { Alert, Button, Card, Chip, InfoHint, Switch } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LevelRow, RulesToggle } from "@/components/AccessLevels";
import { MailIcon } from "@/components/MailConnect";
import { MailRulesPanel, rulesCount } from "@/components/MailRules";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Email (ADR 0038): one row per mailbox of the
 * organization, the same level as the other connectors (Sem acesso · Ler ·
 * Ler e escrever), "Pode apagar emails" (a level that writes) and the rules, opened from the name's line. Each mailbox saves on
 * its own ("Salvar"), outside the page's save bar. A mailbox still connecting
 * has no address and takes no access yet: its row says so and where to see it.
 * Only who connected a mailbox gives access to it; on anyone else's the row is
 * read-only, says who gives it, and admins and the agent's owner can remove it.
 * A right hand uses its person's own mailboxes for that person alone: the card's ⓘ says so, once.
 */
export function MailAccessCard() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, can } = useAgentEdit();
  // Someone else's mailbox shows only while this agent holds it (who manages connectors gets those, address-less).
  const accounts = useMailAccounts(org.id, true, { others: true });
  const mail = useAgentMail(org.id, agent.id, (accounts.data?.length ?? 0) > 0);
  const list = (accounts.data ?? []).filter(
    (a) => !a.ownerUserId || a.ownerUserId === me.user.id || a.agents.some((x) => x.agentId === agent.id),
  );
  // A server without email, or none connected: nothing to show here.
  if (list.length === 0) return null;
  const title = t("mail.agent.title");
  return (
    <Card as="section" className="agp-card" aria-labelledby="ac-mail">
      <CardHead
        id="ac-mail"
        icon="mail"
        title={title}
        hint={
          list.some((account) => onlyForOwner(account, agent, me.user.id))
            ? { name: t("common.about", { label: title }), text: t("mail.agent.onlyYouAll", { name: agent.name }) }
            : undefined
        }
      />
      <ul className="level-list" aria-label={t("mail.agent.title")}>
        {list.map((account) => {
          const name = account.address || mailboxName(t, account);
          const may = mailAccessOf(account, { userId: me.user.id, talks: canTalk(agent), managesAgent: can("levels") });
          return account.status === "pending" ? (
            <LevelRow
              key={account.id}
              icon={<MailIcon choice={choiceOf(account)} />}
              name={name}
              tag={
                <Chip icon="waiting" tone="waiting">
                  {t("mail.status.pending")}
                </Chip>
              }
              extra={<SeeInConnectors text={t("mail.agent.pending")} />}
              levels={["none"]}
              value="none"
            />
          ) : (
            <MailboxRow
              key={account.id}
              account={account}
              name={name}
              saved={mail.data?.find((m) => m.accountId === account.id) ?? null}
              loading={mail.isLoading}
              owner={
                account.ownerUserId === me.user.id ? null : (dir.memberById.get(account.ownerUserId ?? "")?.name ?? "")
              }
              editable={may.gives}
              removable={may.removes}
            />
          );
        })}
      </ul>
    </Card>
  );
}

/** What a mailbox's state means for the agent, and the way to Conectores, where it is fixed. */
function SeeInConnectors({ text }: { text: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <span className="muted">
      {text}{" "}
      <Link
        className="ac-link level-row__link"
        to="/org/$orgId/settings/$section"
        params={{ orgId: org.id, section: "connectors" }}
      >
        {t("mail.routine.openConnectors")}
      </Link>
    </span>
  );
}

interface Draft {
  level: Level;
  canDelete: boolean;
  policy: MailPolicy;
}

const draftOf = (saved: AgentMailbox | null): Draft => ({
  level: fromMailLevel(saved?.level),
  canDelete: saved?.canDelete ?? false,
  policy: saved ? { ...defaultPolicy(), ...saved.policy } : defaultPolicy(),
});

function MailboxRow({
  account,
  name,
  saved,
  loading,
  owner,
  editable,
  removable,
}: {
  account: MailAccount;
  name: string;
  saved: AgentMailbox | null;
  loading: boolean;
  /** Who connected it, when it isn't the viewer ("" = a name we don't know); null = the viewer's own. */
  owner: string | null;
  editable: boolean;
  removable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const rulesId = useId();
  const [rulesOpen, setRulesOpen] = useState(false);
  const set = useSetAgentMail(org.id);
  const base = JSON.stringify(draftOf(saved));
  const [edit, setEdit] = useState<{ from: string; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Remounts the rules (their typed-but-invalid text) after "Cancelar" or a save.
  const [round, setRound] = useState(0);
  const reset = () => {
    setEdit(null);
    setError(null);
    setRound((n) => n + 1);
  };
  // Edits stay until saved; a new server answer resets them.
  const draft = edit && edit.from === base ? edit.draft : draftOf(saved);
  const change = (next: Partial<Draft>) => {
    setError(null);
    setEdit({ from: base, draft: { ...draft, ...next } });
  };
  const dirty = JSON.stringify(draft) !== base;
  const asks =
    draft.level === "write" && !draft.policy.sendWithoutAsking
      ? MAIL_ACTIONS.approval.map((a) => t(`mail.action.${a}.name`))
      : [];
  const reconnect = account.status === "needs_reconnect";
  const save = (next: Draft = draft) =>
    set.mutate(
      {
        agentId: agent.id,
        accountId: account.id,
        input: { level: toMailLevel(next.level), canDelete: next.canDelete, policy: normalizePolicy(next.policy) },
      },
      {
        onSuccess: () => {
          reset();
          toast.show(
            next.level === "none" && !editable
              ? t("mail.agent.removed", { name: agent.name, address: name })
              : t("mail.agent.saved", { name: agent.name }),
          );
        },
        onError: (e) =>
          setError(
            e instanceof ApiError && e.status === 403
              ? forbiddenText(t, e)
              : (knownErrorText(t, e) ?? t("mail.agent.saveError.unknown")),
          ),
      },
    );
  const count = rulesCount(draft.policy);
  // The switch shows where the level writes, and wherever delete is on or was saved on: it never leaves under the
  // pointer, and a grant still in force stays in sight to be turned off.
  const showDelete = draft.level === "write" || draft.canDelete || Boolean(saved?.canDelete);
  const on = draft.level !== "none";
  const delId = `mail-del-${account.id}`;
  return (
    <LevelRow
      icon={<MailIcon choice={choiceOf(account)} />}
      name={name}
      tag={
        reconnect ? (
          <Chip icon="alert" tone="waiting">
            {t("mail.status.needs_reconnect")}
          </Chip>
        ) : undefined
      }
      side={
        on ? (
          <RulesToggle
            label={t("mail.agent.rulesOf", { address: name })}
            count={count}
            open={rulesOpen}
            controls={rulesId}
            onToggle={() => setRulesOpen((v) => !v)}
          />
        ) : undefined
      }
      extra={
        reconnect || owner !== null || (on && showDelete) ? (
          <>
            {reconnect && <SeeInConnectors text={t("mail.agent.needsReconnect")} />}
            {/* Why the level can't be changed here. */}
            {owner !== null && (
              <span className="muted">
                {owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown")}
              </span>
            )}
            {on && showDelete && (
              <span className="level-row__switch">
                <Switch
                  id={delId}
                  checked={draft.canDelete}
                  disabled={!editable}
                  aria-describedby={`${delId}-help`}
                  onCheckedChange={(canDelete) => change({ canDelete })}
                />
                <span className="ac-hintline">
                  <label htmlFor={delId}>{t("mail.agent.canDelete")}</label>
                  <InfoHint id={`${delId}-help`} name={t("common.about", { label: t("mail.agent.canDelete") })}>
                    {t("mail.agent.canDeleteHelp")}
                  </InfoHint>
                </span>
              </span>
            )}
            {!editable && removable && saved && saved.level !== "none" && (
              <Button
                variant="link"
                disabled={set.isPending}
                loading={set.isPending}
                onClick={() => save({ ...draftOf(saved), level: "none", canDelete: false })}
              >
                {t("mail.agent.remove")}
              </Button>
            )}
          </>
        ) : undefined
      }
      asks={asks}
      levels={LEVELS}
      value={draft.level}
      onChange={editable && !loading ? (level) => change({ level }) : undefined}
      locked
      changed={dirty}
      belowHidden={!(rulesOpen && on) && !dirty && !error}
      below={
        on || dirty || error ? (
          <div className="mail-agent">
            {/* Kept in the page while closed: what was typed in it stays, and the toggle's `aria-controls` resolves. */}
            {on && (
              <div id={rulesId} className="level-row__rulespanel" hidden={!rulesOpen}>
                <MailRulesPanel
                  key={round}
                  account={account}
                  policy={draft.policy}
                  onChange={(policy) => change({ policy })}
                  disabled={!editable}
                />
              </div>
            )}
            {error && <Alert>{error}</Alert>}
            {dirty && editable && (
              <div className="mail-agent__save">
                <span className="small muted">{t("mail.agent.unsaved")}</span>
                <Button size="sm" onClick={reset}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={set.isPending}
                  loading={set.isPending}
                  onClick={() => save()}
                >
                  {t("mail.agent.save")}
                </Button>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
