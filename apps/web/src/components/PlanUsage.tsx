import type { AiAccounts, PlanAccountInfo, PlanAccountUsage, PlanUseKind } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, useModels, usePlanUsage } from "@agenteschat/client";
import { removableLogins } from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatPercent, formatTokensShort, formatUsd, joinNames } from "@agenteschat/client/lib/format";
import { accountKinds } from "@agenteschat/client/lib/plan-usage";
import { planName } from "@agenteschat/client/lib/plans";
import { AUTO, apiProviderOf } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  agentGradient,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogFooter,
  Disclosure,
  EmptyState,
  Icon,
  InfoHint,
  List,
  Meter,
  PLAN_ALMOST,
  PlanMeter,
  ProviderLogo,
  planLevel,
  planLine,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";

import { PlanHold, usePlanHold } from "@/components/ai/plan-hold";
import { useConnectAi, useMayConnectAi } from "@/components/connect-ai-context";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import {
  accountName,
  accountOwner,
  accountShares,
  accountWhere,
  accountWhose,
  groupUsageAccounts,
  loginsText,
  noWindowsText,
  planMeterText,
  servesText,
  shareCells,
  splitUsage,
} from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { PlanModels } from "./PlanModels";
import "./plan-usage.css";

/*
 * The usage views (ADR 0063): an account's head, shared with the agent's
 * "Uso" tab, and Configurações › IA e uso: the workspace's plan accounts, each
 * window with every agent's estimated part, and the API per agent. Money
 * only where the server sent it (`view_usage`).
 */

/** An en space between a row's name, its plan and whose it is: it ends a line unseen where a margin would indent the next. */
const WIDE_SPACE = "\u2002";

/** An account's head: the maker's mark (it names the maker), its name and plan, and whose it is. */
export function AccountHead({ account, extra }: { account: PlanAccountInfo; extra?: string | null }) {
  const { t } = useTranslation();
  const sub = [accountWhose(t, account), extra].filter(Boolean).join(" · ");
  return (
    <div className="plan-acct ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
      </span>
      <span className="ac-mediarow__head">
        <span className="plan-acct__name">
          {accountName(t, account)}
          {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
          {account.signedOut && (
            <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
          )}
        </span>
      </span>
      {sub && <span className="ac-mediarow__body plan-acct__sub">{sub}</span>}
    </div>
  );
}

/**
 * Configurações › IA e uso, "Contas": every plan account of the workspace as one row that opens. The API per agent is
 * `ApiCard`, its own card, only where the workspace bills per use.
 */
export function PlanUsageCards() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const usage = usePlanUsage(org.id);
  const mine = useAiAccounts(org.id);
  const look = useRightHandLook();
  const connectAi = useConnectAi();
  const mayConnect = useMayConnectAi();
  const hold = usePlanHold();
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (usage.isLoading) {
    return (
      <Card>
        <LoadingList count={3} avatar={false} trailing />
      </Card>
    );
  }
  if (!usage.data) {
    return (
      <Card>
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      </Card>
    );
  }
  const { money } = usage.data;
  // The viewer's own logins of one account are one row, as their plans group them.
  const accounts = groupUsageAccounts(usage.data.accounts, mine.data);
  const several = new Set(accounts.map((a) => a.machineId)).size > 1;
  // One Grok login per agent is what connecting the same account for every agent left behind (issue #319): the batch
  // removal takes them all at once, and only ever the viewer's own.
  const grokLogins = removableLogins(mine.data?.accounts ?? [], "grok");
  return (
    <Card aria-labelledby="sec-usage-plans">
      <CardHeader
        id="sec-usage-plans"
        icon="computer"
        title={t("usageViews.accounts.title")}
        hint={{ name: t("common.about", { label: t("usageViews.accounts.title") }), text: t("usageViews.estimate") }}
      />
      {/* What comes first: an invitation to connect a plan would contradict it. */}
      {hold && <PlanHold hold={hold} />}
      {accounts.length === 0 && !hold && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("aiAccounts.page.emptyTitle")}
          actions={
            connectAi &&
            mayConnect && (
              <Button variant="primary" icon="plus" onClick={() => connectAi.open({})}>
                {t("aiAccounts.page.connect")}
              </Button>
            )
          }
        >
          {t(mayConnect ? "usageViews.accounts.empty" : "aiAccounts.page.emptyViewer")}
        </EmptyState>
      )}
      {accounts.length > 0 && (
        <List className="plan-rows">
          {accounts.map((a) => (
            <AccountRow
              key={a.key}
              account={a}
              money={money}
              computer={several ? computerNameOf(t, org.name, a.machineName, isPersonal(org)) : null}
            />
          ))}
        </List>
      )}
      {grokLogins.length > 1 && <RemoveGrokLogins logins={grokLogins} />}
    </Card>
  );
}

/**
 * A plan account as a row that opens. Closed: its maker's mark, its name and plan, whose it is and one meter, the
 * window closest to its limit, with what matters near the limit on a line under them. Open: every window with when it
 * renews (the head's meter fades), near the limit why when handoffs led, then one quiet "Detalhes" holding its agents
 * and kinds in columns (the bars split by agent while it is open), the month's tokens and its address; for its owner,
 * what they do with it. Every row starts closed: the head's meter and its limit line already say where it stands.
 */
function AccountRow({
  account,
  money,
  computer,
}: {
  account: PlanAccountUsage;
  money: boolean;
  computer: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const text = planMeterText(t, i18n.language);
  const line = account.usage ? planLine(account.usage, text) : null;
  const [open, setOpen] = useState(false);
  // What the row holds leaves the page once it has closed, so a closed list of many accounts stays light.
  const [held, setHeld] = useState(false);
  const body = useId();
  // Split by agent only while the agents that explain the colours are open under the bars.
  const [details, setDetails] = useState(false);
  const shares = accountShares(account);
  const window = shares.window ? text.short(shares.window) : null;
  const hasShares = shares.shown.length > 0;
  const where = accountWhere(t, account, computer);
  const hasDetails = hasShares || account.monthTokens > 0 || Boolean(where);
  // Whose it is, who uses it and how many logins it stands for: each moves to the next line whole.
  const facts = [accountOwner(t, account), servesText(t, account), loginsText(t, account)].filter((f): f is string =>
    Boolean(f),
  );
  const owner = facts.length > 0;
  const chips = Boolean(account.plan) || Boolean(account.signedOut);
  return (
    <div className="plan-row" data-open={open || undefined}>
      <button
        type="button"
        // The kit's line of a row that opens under it: the row's room is above the line and below what it unfolds.
        className="plan-row__head ac-foldrow__head"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => {
          if (!open) setHeld(true);
          setOpen(!open);
        }}
      >
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
        {/* Two parts: one line of words on a wide row, and on a phone the name beside the mark with the plan and
            whose it is under both. The space that parts them ends the name, so neither starts with it. */}
        <span className="plan-acct__name">
          <span className="plan-row__title">
            {accountName(t, account)}
            {(chips || owner) && WIDE_SPACE}
          </span>
          {(chips || owner) && (
            <span className="plan-row__facts">
              {account.plan && <span className="plan-acct__chip">{planName(account.plan)}</span>}
              {account.plan && account.signedOut && WIDE_SPACE}
              {account.signedOut && (
                <span className="plan-acct__chip plan-acct__chip--out">{t("usageViews.signedOut")}</span>
              )}
              {chips && owner && WIDE_SPACE}
              {facts.map((f, i) => (
                <Fragment key={f}>
                  {i > 0 && " "}
                  <span className="plan-row__owner">{i > 0 ? `· ${f}` : f}</span>
                </Fragment>
              ))}
            </span>
          )}
        </span>
        {line?.top && (
          <span
            className="ac-planmeter ac-planmeter--compact plan-row__meter"
            data-level={planLevel(line.top.used, line.state === "limited")}
          >
            <span className="ac-planmeter__line">{`${text.short(line.top)} ${line.top.used}%`}</span>
            <Meter value={line.top.used} max={100} label={text.window(line.top)} marks={[PLAN_ALMOST]} />
          </span>
        )}
        <Icon name="chevronRight" size={16} className="plan-row__chevron" />
        {line?.alert && (
          <span
            className="ac-planmeter__state plan-row__alert"
            data-level={planLevel(line.top?.used ?? 0, line.state === "limited")}
          >
            {/* Each window's bar says when it renews: near the limit the warning keeps just its words. */}
            {line.state === "limited" ? line.alert : text.almost}
          </span>
        )}
      </button>
      <div
        id={body}
        className="plan-row__fold"
        inert={!open}
        aria-hidden={!open}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && !open) setHeld(false);
        }}
      >
        <div className="plan-row__body">
          {held && (
            <>
              {account.usage ? (
                <>
                  <PlanMeter
                    usage={
                      details
                        ? splitUsage(account.usage, (id) => agentGradient(colorOf(dir.agentById.get(id))))
                        : account.usage
                    }
                    text={text}
                  />
                  <PlanModels usage={account.usage} provider={account.provider} />
                </>
              ) : (
                <p className="plan-empty">{noWindowsText(t, account)}</p>
              )}
              {line && line.state !== "ok" && <HandoffNudge account={account} />}
              {hasDetails && (
                <Disclosure summary={t("common.details")} onOpenChange={setDetails} className="plan-details">
                  {hasShares && (
                    <>
                      <AgentShares shares={shares} window={window} />
                      <KindShares account={account} window={window} />
                    </>
                  )}
                  {(account.monthTokens > 0 || where) && (
                    <div className="plan-details__facts">
                      {account.monthTokens > 0 && (
                        <span>
                          {t("usageViews.monthTokens", {
                            tokens: formatTokensShort(t, i18n.language, account.monthTokens),
                          })}
                          {money && typeof account.equivalentUsd === "number" && (
                            <>
                              {" · "}
                              <span className="ac-hintline">
                                <span>
                                  {t("usageViews.equivalent", {
                                    amount: formatUsd(i18n.language, account.equivalentUsd),
                                  })}
                                </span>
                                <InfoHint name={t("common.about", { label: t("usageViews.apiPrice") })}>
                                  {t("usageViews.apiPriceHint")}
                                </InfoHint>
                              </span>
                            </>
                          )}
                        </span>
                      )}
                      {where && <span className="plan-acct__sub">{where}</span>}
                    </div>
                  )}
                </Disclosure>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A list's label over its columns: the window's short name heads the shares. */
function SharesHead({ label, window }: { label: string; window: string | null }) {
  return (
    <p className="plan-group__label plan-shares__cols">
      <span>{label}</span>
      {window && <span className="plan-shares__share">{window}</span>}
    </p>
  );
}

/** One row's columns after its face: the name, its share of the window, its tokens this month. */
function ShareCells({ name, cells }: { name: string; cells: ReturnType<typeof shareCells> }) {
  return (
    <>
      <b>{name}</b>
      {cells.share && <span className="plan-shares__share">{cells.share}</span>}
      <span className="plan-shares__tokens">{cells.tokens}</span>
    </>
  );
}

/** The account's agents, biggest share first, in columns; past the first few, one row that opens the rest in place. */
function AgentShares({ shares, window }: { shares: ReturnType<typeof accountShares>; window: string | null }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  return (
    <div className="plan-group">
      <SharesHead label={t("shell.agents")} window={window} />
      <div className="plan-shares">
        {(open ? [...shares.shown, ...shares.rest] : shares.shown).map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          return (
            <Link
              key={a.agentId}
              className="plan-shares__row plan-shares__cols"
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: a.agentId }}
              search={{ tab: "usage" }}
            >
              <AgentAvatar agentId={a.agentId} size="xs" name={name} />
              <ShareCells name={name} cells={shareCells(t, i18n.language, window, a)} />
            </Link>
          );
        })}
        {!open && shares.rest.length > 0 && (
          <button
            type="button"
            className="plan-shares__row plan-shares__cols"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            <span />
            <ShareCells
              name={t("usageViews.moreAgents", { count: shares.rest.length })}
              cells={shareCells(t, i18n.language, window, { share: shares.restShare, tokens: shares.restTokens })}
            />
          </button>
        )}
      </div>
    </div>
  );
}

const KIND_ICONS = { handoffs: "swap", people: "person", routines: "routines" } as const satisfies Record<
  PlanUseKind,
  string
>;

/** Under the agents, what the account's use was for, in the same columns. */
function KindShares({ account, window }: { account: PlanAccountUsage; window: string | null }) {
  const { t, i18n } = useTranslation();
  const kinds = accountKinds(account);
  if (kinds.length === 0) return null;
  return (
    <div className="plan-group">
      <SharesHead label={t("usage.kinds.label")} window={window} />
      <div className="plan-shares plan-kinds">
        {kinds.map((k) => (
          <div key={k.kind} className="plan-shares__row plan-shares__cols">
            <span className="plan-kinds__icon">
              <Icon name={KIND_ICONS[k.kind]} size={16} />
            </span>
            <ShareCells
              name={t(`usage.kinds.${k.kind}`)}
              cells={shareCells(t, i18n.language, window, { share: k.percent, tokens: k.tokens })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Near or at the limit, when handoffs led the week: one line on why, with the way to ask the agent that took most of
 * them directly. Far from the limit it would only be noise.
 */
function HandoffNudge({ account }: { account: PlanAccountUsage }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const target = account.hint ? dir.agentById.get(account.hint.agentId) : undefined;
  if (!target) return null;
  return (
    <p className="plan-kinds__hint">
      {t("usage.hint.handoffs")}{" "}
      <Link
        className="ac-link ac-link--muted"
        to="/org/$orgId/dm/agent/$agentId"
        params={{ orgId: org.id, agentId: target.id }}
      >
        {t("usage.hint.message", { name: target.name })}
      </Link>
    </p>
  );
}

/** "US$ 0,32 de US$ 50,00 (padrão do workspace)": the closing "(…)" wraps as one piece, not split across lines. */
function noteWhole(text: string) {
  const m = /^(.*\S)\s+(\(.+\))$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]} <span className="plan-api__note">{m[2]}</span>
    </>
  );
}

/** The API per agent this month: each one's share of its budget, and the money where the server sent it. */
export function ApiCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const data = usePlanUsage(org.id).data;
  const dir = useDirectory(org.id);
  const provider = apiProviderOf(AUTO, useModels().data?.models ?? []);
  if (!data || data.api.length === 0) return null;
  return (
    <Card aria-labelledby="sec-usage-api">
      <CardHeader id="sec-usage-api" icon="key" mark={provider} title={t("usageViews.api.title")} />
      <div className="plan-api">
        {data.api.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? a.name;
          // The server's percent has one decimal, so a tiny spend comes as 0: the money, when sent, is exact.
          const percent = a.costUsd !== undefined && a.budgetUsd ? (a.costUsd / a.budgetUsd) * 100 : a.budgetPercent;
          return (
            <Link
              key={a.agentId}
              className="plan-api__row"
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: a.agentId }}
              search={{ tab: "usage" }}
            >
              <AgentAvatar agentId={a.agentId} size="sm" name={name} />
              <span className="plan-api__name">
                <b>{name}</b>
                <small>{t("usageViews.tokens", { tokens: formatTokensShort(t, i18n.language, a.tokens) })}</small>
              </span>
              <span className="plan-api__meter">
                <Meter value={Math.min(100, percent)} max={100} label={t("settings.usageAgentMeter", { name })} />
              </span>
              <span className="plan-api__value">
                {t("usageViews.budgetShare", { percent: formatPercent(i18n.language, percent) })}
                {a.costUsd !== undefined && a.budgetUsd !== undefined && (
                  <small>
                    {noteWhole(
                      t(a.budgetIsDefault ? "settings.usageAgentLineDefault" : "settings.usageAgentLine", {
                        spent: formatUsd(i18n.language, a.costUsd),
                        budget: formatUsd(i18n.language, a.budgetUsd),
                      }),
                    )}
                  </small>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * "Remover todos os logins do Grok" (issue #319): connecting one account for every agent used to leave one login per
 * agent, and nobody removes eighteen of them one by one. One confirmation takes every Grok login the viewer owns, on
 * every computer; another person's stays (the server refuses those anyway), and so does every other program's.
 */
function RemoveGrokLogins({ logins }: { logins: AiAccounts["accounts"] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const computers = joinNames([...new Set(logins.map((l) => l.computer))], t);
  const remove = async () => {
    setBusy(true);
    try {
      for (const l of logins) await api.machines.removeAccount(org.id, l.machineId, l.id);
      toast.show(t("aiAccounts.page.removeAllDone", { n: logins.length }));
      setOpen(false);
      for (const key of [keys.planUsage(org.id), keys.aiAccounts(org.id), keys.agents(org.id), keys.aiStatus(org.id)])
        void qc.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="link" className="ac-link--danger" disabled={busy} onClick={() => setOpen(true)}>
        {t("aiAccounts.page.removeAllGrok")}
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && setOpen(false)}
          title={t("aiAccounts.page.removeAllTitle", { n: logins.length })}
          description={t("aiAccounts.page.removeAllText", { computers })}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={busy} disabled={busy} onClick={() => void remove()}>
              {t("aiAccounts.page.removeAllGrok")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
