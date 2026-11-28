import type { Agent, Approval, ConnectorDef } from "@agenteschat/client";
import {
  sendHelpers,
  useApprovals,
  useApprovalsDeciding,
  useCatalog,
  useChannels,
  useCustomServers,
  useDecideApproval,
  useDecideApprovals,
  usePostMessage,
  useRun,
  useRunApprovalNow,
} from "@agenteschat/client";
import {
  APPROVAL_REASON_MAX,
  approvalLines,
  approvalPhase,
  approveAllByAgent,
  approveAllScope,
  byAsked,
  type LinePlace,
  PHASE_STATUS,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase, approveAlwaysOffered } from "@agenteschat/client/lib/approval-kind";
import { approvalWords } from "@agenteschat/client/lib/approval-origin";
import {
  type ApprovalEffect,
  type ApprovalUndo,
  approvalEffects,
  approvalTarget,
  approvalText,
  stepsAround,
} from "@agenteschat/client/lib/approval-review";
import {
  aheadEndLine,
  approvalDoing,
  approvalOwnerOf,
  approvalWaitsFor,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { daysBetween, formatTime, nextLabel, relativeTime, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { formatDuration, type ToolItem, toolItemsSaved, toolPhrase, workFromSteps } from "@agenteschat/client/lib/work";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  cx,
  DetailsDialog,
  Disclosure,
  ExpiryFuse,
  type Fact,
  FactStrip,
  Icon,
  type IconName,
  Kbd,
  LimitLine,
  Locked,
  limitShown,
  overLimit,
  StepTrack,
  type StepTrackStep,
  Tip,
  WorkSweep,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  AheadLine,
  ApproveAlways,
  approvalAction,
  approvalReadsOnly,
  approvalRisk,
  approvalTitle,
  approvalValues,
  CancelAhead,
  decisionLabel,
} from "@/components/ApprovalItem";
import { WhenAsksLink } from "@/components/ApprovalsLevelDialog";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { DetailsLink } from "@/components/details-link";
import { EmailLetter } from "@/components/EmailLetter";
import { useOrg } from "@/components/org-context";
import { colorOf, prepareBurst } from "@/components/Sky";
import { TaskStepsBlock, useCallLogo } from "@/components/ToolCalls";
import { useDirectory } from "@/hooks/useDirectory";
import { useReveal } from "@/hooks/useReveal";
import { useTextLimit } from "@/hooks/useTextLimit";
import { TYPED_VALUES } from "@/i18n";
import { inlineWords, Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import "./approvals.css";

const TTL_MS = 24 * 3_600_000;
const URGENT_MS = 3_600_000;

/** Each request's place on its card (`approvalLine`), for the rows and the review under them. */
const LinesContext = createContext<ReadonlyMap<string, LinePlace>>(new Map());
const useLinePlace = (a: Approval) => useContext(LinesContext).get(a.id);
/** Where each of `list`'s requests stands (`approvalLines`), for the rows and reviews under it. */
export function ApprovalLinesProvider({ list, children }: { list: readonly Approval[]; children: ReactNode }) {
  const lines = useMemo(() => approvalLines([...list]), [list]);
  return <LinesContext.Provider value={lines}>{children}</LinesContext.Provider>;
}
/** A request with its place on its card ("Criar issue (1 de 2)"): two requests of one kind tell apart by it. */
const titleOnCard = (t: TFunction, b: Approval, place: Pick<LinePlace, "position" | "count"> | undefined) =>
  place && place.count > 1
    ? `${approvalTitle(t, b)} (${t("approvals.position", { n: place.position, total: place.count })})`
    : approvalTitle(t, b);
const usePhase = (a: Approval) => approvalPhase(a, Date.now(), useLinePlace(a));

/** In the order the agents asked (each card's requests together at its first, `approvalCards`). */
export function sortOpen(list: Approval[]) {
  return [...list].sort(byAsked);
}

const decidedAt = (a: Approval) => a.decidedAt ?? (a.status === "expired" ? a.expiresAt : a.createdAt);

/** A GitHub PR the action points at, when its values say so. */
function prLink(a: Approval) {
  if (a.connector !== "github") return null;
  const p = a.params ?? {};
  const pr = p.pullNumber ?? p.pull_number ?? p.pr ?? p.number;
  const owner = typeof p.owner === "string" ? p.owner : null;
  const repo = typeof p.repo === "string" ? p.repo : null;
  if (!repo || (typeof pr !== "number" && typeof pr !== "string")) return null;
  const full = owner && !repo.includes("/") ? `${owner}/${repo}` : repo;
  return /^[\w.-]+\/[\w.-]+$/.test(full) && /^\d+$/.test(String(pr)) ? `https://github.com/${full}/pull/${pr}` : null;
}

function groups(list: Approval[]): ["today" | "yesterday" | "earlier", Approval[]][] {
  const out: ["today" | "yesterday" | "earlier", Approval[]][] = [
    ["today", []],
    ["yesterday", []],
    ["earlier", []],
  ];
  for (const a of list) {
    const d = daysBetween(decidedAt(a), new Date());
    out[d <= 0 ? 0 : d === 1 ? 1 : 2]?.[1].push(a);
  }
  return out.filter(([, l]) => l.length > 0);
}

/** "github · acme" with the brand icon, or the app's own tool. */
type ApprovalVia = {
  kind: "mail" | "connector" | "own";
  name: string;
  account: string | null;
  def: ConnectorDef | null;
  /** A server connected by address: its own icon. */
  image?: string | null;
};

/** What an approval goes through: a mailbox, a server connected by address, a catalog connector, or the app itself. */
function useApprovalVia(approval: Approval): ApprovalVia {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  // A server connected by address (`custom:{connectionId}`): its own name, and the preset's icon when it came from one.
  const customId = approval.connector?.startsWith("custom:") ? approval.connector.slice("custom:".length) : null;
  const servers = useCustomServers(org.id, customId !== null);
  // An email goes through a mailbox, not a catalog connector ("email" has no entry): the box and its provider.
  if (approval.email)
    return { kind: "mail", name: approval.email.mailbox, account: approval.email.provider, def: null };
  if (!approval.connector) return { kind: "own", name: t("approvals.panel.builtIn"), account: null, def: null };
  const server = customId ? servers.data?.find((s) => s.id === customId) : undefined;
  const custom = server ? fromServer(server, catalog.data?.connectors ?? []) : null;
  const def = custom ? custom.def : (catalog.data?.connectors.find((c) => c.id === approval.connector) ?? null);
  const name = custom
    ? itemName(t, custom)
    : customId
      ? t("approvals.panel.orgConnector")
      : connectorName(t, def ?? { id: approval.connector, label: approval.connector });
  return { kind: "connector", name, account: approval.connectorAccount ?? null, def, image: custom?.image };
}

function ViaGlyph({ via }: { via: ApprovalVia }) {
  if (via.kind === "connector") return <ConnectorIcon def={via.def} image={via.image} label={via.name} />;
  return (
    <span className="ap-conn__own" aria-hidden="true">
      <Icon name={via.kind === "mail" ? "mail" : "shield"} size={14} />
    </span>
  );
}

export function ConnectorLine({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  return (
    <span className="ap-conn">
      <ViaGlyph via={via} />
      <b>{via.name}</b>
      {via.account && <span className="ap-conn__account">· {via.account}</span>}
    </span>
  );
}

/** Only the logo, its name in a tooltip and for screen readers (the approval sentence in Notificações). */
export function ConnectorMark({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  const label = via.account ? `${via.name} · ${via.account}` : via.name;
  return (
    // Focusable so a keyboard reaches the name in its tip.
    <Tip
      className="ap-conn-mark"
      role="img"
      aria-label={label}
      tabIndex={0}
      tip={label}
      look="ap-conn-mark__tip"
      align="center"
      delay={0}
    >
      <ViaGlyph via={via} />
    </Tip>
  );
}

/**
 * The exact action, in words (AprovacaoConector B): the connector and "Só lê" on one line, then its values
 * with labels; a list shows a few as chips, the details every one, and the tool's own name and values
 * behind "Detalhes técnicos". An email shows as the email itself.
 */
/** A value longer than this (a message, a command with its flags) takes a row of its own in the details, whole. */
const LONG_VALUE = 80;

export function ExactAction({
  approval,
  max,
  bare,
}: {
  approval: Approval;
  max?: number;
  /** Without the connector line and "Só lê" (the review's facts say both). */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  // An email shows as the email itself (folded in lists, whole in the details).
  if (approval.email) return <EmailLetter email={approval.email} full={!max} />;
  const full = max === undefined;
  const values = approvalValues(approval, full ? { long: true } : { max });
  return (
    <div className="ap-exact">
      {!bare && (
        <div className="ap-exact__via">
          <ConnectorLine approval={approval} />
          {approvalReadsOnly(approval) && <Chip icon="eye">{t("approvals.readsOnly")}</Chip>}
        </div>
      )}
      {values.length > 0 &&
        (full ? (
          <dl className="ap-exact__rows">
            {values.map(([label, value]) => (
              <div key={label} data-long={value.length > LONG_VALUE || undefined}>
                <dt>{label}</dt>
                <dd>{inlineWords(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="ap-exact__facts">
            {values.map(([label, value]) => (
              <Chip key={label}>
                {label}: {value}
              </Chip>
            ))}
          </div>
        ))}
      {full && (
        <details className="ap-exact__tech">
          <summary>{t("approvals.technical")}</summary>
          <pre>{`${approval.tool}\n${JSON.stringify(approval.params ?? {}, null, 2)}`}</pre>
        </details>
      )}
    </div>
  );
}

/** The time a decision has left ("23 h para decidir", "expira em 12 min"): an approval's, or any request's. */
export function expiryText(t: TFunction, a: Pick<Approval, "expiresAt">) {
  const left = timeLeft(t, a.expiresAt);
  if (!left) return t("approval.expired");
  return new Date(a.expiresAt).getTime() - Date.now() <= URGENT_MS
    ? t("approvals.leftUrgent", { time: left })
    : t("approvals.left", { time: left });
}

/** Approve: one click, or a hold for high risk (let go early and nothing happens). */
export function ApproveButton({ approval, block, tip }: { approval: Approval; block?: boolean; tip?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <HoldToApprove
      label={t(`approval.approve.${approvalAction(approval)}`)}
      high={approvalRisk(approval) === "high"}
      block={block}
      id={approval.id}
      tip={tip}
      pending={decide.isPending}
      onGo={(el) => {
        // Approved: a burst of the agent's pixels from its avatar.
        const burst = prepareBurst(el);
        decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
      }}
    />
  );
}

/**
 * The approve button itself: one click, or held for `high` risk; `id` lets A focus it. `tip`: what approving does, in
 * its tip (the bar under a request holds only its buttons).
 */
export function HoldToApprove({
  label,
  high,
  block,
  id,
  tip,
  pending,
  onGo,
}: {
  label: string;
  high: boolean;
  block?: boolean;
  id: string;
  tip?: string;
  pending: boolean;
  onGo: (el: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const tipped = (button: ReactElement) =>
    tip ? (
      <Tip tip={tip} look="ac-hint__bubble ac-glass" align="center" button>
        {button}
      </Tip>
    ) : (
      button
    );
  if (!high)
    return tipped(
      <Button
        variant="primary"
        size="sm"
        block={block}
        icon="check"
        data-approve={id}
        disabled={pending}
        loading={pending}
        onClick={(e) => onGo(e.currentTarget)}
      >
        {label}
      </Button>,
    );
  const start = (el: HTMLElement) => {
    if (timer.current || pending) return;
    held.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      held.current = true;
      setHolding(false);
      onGo(el);
    }, 1100);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return tipped(
    <Button
      variant="primary"
      size="sm"
      block={block}
      icon="check"
      className={cx("ap-hold", holding && "is-holding")}
      data-approve={id}
      aria-label={t("approvals.holdLabel", { action: label })}
      disabled={pending}
      loading={pending}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return;
        // The press is the button's until it ends: a hand that drifts past the edge is still holding.
        e.currentTarget.setPointerCapture(e.pointerId);
        start(e.currentTarget);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => {
        // A finger's long press would open the menu and cancel the hold.
        if (timer.current) e.preventDefault();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start(e.currentTarget);
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onClick={(e) => {
        // A plain click (no hold) only explains; the click that ends a finished hold says nothing.
        if (e.detail > 0 && !held.current && !timer.current && !pending) toast.show(t("approvals.holdHint"), "info");
        held.current = false;
      }}
    >
      {/* One label: a shorter one while held would shrink the button out from under the pointer. */}
      {t("approvals.hold")}
    </Button>,
  );
}

/**
 * "Aprovar tudo" / "Agora não para todos" over one card's requests: exactly the ones listed now that this person
 * may decide (one joining during the click is never approved unseen). Held when any of them is high risk.
 * Nothing when fewer than two are theirs: each item's own buttons do. `children` sit between the two ("Aprovar sempre").
 */
export function ApproveAll({
  items,
  label,
  refuseLabel,
  children,
}: {
  items: Approval[];
  label?: string;
  refuseLabel?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApprovals(org.id);
  const { ids } = approveAllScope(items);
  if (ids.length < 2) return null;
  const high = items.some((a) => ids.includes(a.id) && approvalRisk(a) === "high");
  return (
    <>
      <HoldToApprove
        label={label ?? t("approval.all.approve")}
        high={high}
        id={`all-${ids[0]}`}
        pending={decide.isPending}
        onGo={(el) => {
          const burst = prepareBurst(el);
          decide.mutate({ ids, decision: "approve" }, { onSuccess: burst });
        }}
      />
      {children}
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ ids, decision: "refuse" })}
      >
        {refuseLabel ?? t("approval.all.refuse")}
      </Button>
    </>
  );
}

/**
 * An approved request still waiting for one asked before it (`approvalLine`): that request by name, which opens in
 * place, and what moves it: deciding that one where this person may, or "Rodar este agora" when it is another run's
 * (`canRunNow`).
 */
export function HeldLine({ approval: a, waitsOn }: { approval: Approval; waitsOn: Approval }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  const runNow = useRunApprovalNow(org.id);
  const busy = useApprovalsDeciding(org.id, [a.id, waitsOn.id]);
  // Its own run's request is decided where it stands, beside it: only another run's gets buttons here.
  const other = waitsOn.runId !== a.runId;
  const decidable = other && waitsOn.status === "pending" && waitsOn.canDecide === true;
  const freeable = other && a.canRunNow === true;
  return (
    <span className="ap-held">
      <span className="ap-held__text">
        <Trans
          i18nKey="approval.held.waiting"
          components={{
            link: (
              <DetailsLink item={{ kind: "approval", id: waitsOn.id }} className="ac-link">
                {approvalTitle(t, waitsOn)}
              </DetailsLink>
            ),
          }}
        />
      </span>
      {(decidable || freeable) && (
        <span className="ac-acts ap-held__acts">
          {decidable && <ApproveButton approval={waitsOn} />}
          {decidable && (
            <Button
              size="sm"
              disabled={busy}
              loading={decide.isPending}
              onClick={() => decide.mutate({ id: waitsOn.id, decision: "refuse" })}
            >
              {t("approval.refuse")}
            </Button>
          )}
          {freeable && (
            <Button size="sm" disabled={busy} loading={runNow.isPending} onClick={() => runNow.mutate({ id: a.id })}>
              {t("approval.held.runNow")}
            </Button>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * "Aprovar todos" / "Recusar todos" per agent, over all of its cards: one line for each agent with two or more
 * requests this person may decide (`approveAllByAgent`), deciding exactly those, as each card's "Aprovar tudo" does.
 */
export function ApproveAllByAgent({ list }: { list: readonly Approval[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const groups = approveAllByAgent(list);
  if (groups.length === 0) return null;
  return (
    <ul className="ap-agents" aria-label={t("approval.byAgent.approve")}>
      {groups.map((g) => {
        const name = dir.agentById.get(g.agentId)?.name ?? t("channel.unknownAgent");
        return (
          <li key={g.agentId} className="ap-agents__row ac-tailrow">
            <span className="ap-agents__who ac-who">
              <AgentAvatar agentId={g.agentId} name={name} size="xs" />
              {t("approval.byAgent.head", { count: g.ids.length, name })}
            </span>
            <span className="ac-acts">
              <ApproveAll
                items={g.items}
                label={t("approval.byAgent.approve")}
                refuseLabel={t("approval.byAgent.refuse")}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Said when this person may decide only some of a card's requests: "Aprovar tudo" covers only those. */
export function approveAllPartial(t: TFunction, items: Approval[], who: string | undefined) {
  const { ids, waiting, blocked } = approveAllScope(items);
  if (blocked === 0 || ids.length === 0) return null;
  return t("approval.all.partial", {
    mine: ids.length,
    count: waiting,
    who: who ?? t("approval.all.partialAdmin"),
  });
}

const SUGGESTIONS = ["later", "review", "tests", "smaller"] as const;

/** Refuse with a reason the agent reads (and keeps as a lesson). */
export function RefuseBox({ approval, agent, onCancel }: { approval: Approval; agent?: Agent; onCancel: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const decide = useDecideApproval(org.id);
  const [reason, setReason] = useState("");
  const g = agentGrammar(agent?.name ?? "");
  const id = `ap-reason-${approval.id}`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const limit = useTextLimit(APPROVAL_REASON_MAX);
  const tooLong = overLimit(reason, limit);
  useEffect(() => ref.current?.focus(), []);
  const send = () =>
    !tooLong &&
    decide.mutate(
      { id: approval.id, decision: "refuse", reason: reason.trim() || undefined },
      { onSuccess: () => toast.show(t("approvals.refused", { name: g.name }), "info") },
    );
  return (
    <div className="ap-refuse">
      <Locked when={decide.isPending}>
        <label htmlFor={id}>{t("approvals.refuseLabel")}</label>
        <textarea
          id={id}
          ref={ref}
          rows={2}
          value={reason}
          placeholder={t("approvals.refusePlaceholder")}
          aria-invalid={tooLong || undefined}
          aria-describedby={limitShown(reason, limit) ? `${id}-limit` : undefined}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            if (e.key === "Escape") onCancel();
          }}
        />
        <LimitLine id={`${id}-limit`} value={reason} limit={limit} />
        <div className="ap-refuse__suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => setReason(t(`approvals.suggest.${s}`))}>
              {t(`approvals.suggest.${s}`)}
            </button>
          ))}
        </div>
        <div className="ap-refuse__row">
          <span className="ap-refuse__learn">{t("approvals.refuseLearn", { context: g.context, name: g.name })}</span>
          <span className="ap-refuse__acts">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("approvals.back")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              kbd={["⌘", "↵"]}
              disabled={tooLong}
              loading={decide.isPending}
              onClick={send}
            >
              {t("approvals.refuseConfirm")}
            </Button>
          </span>
        </div>
      </Locked>
    </div>
  );
}

/** Where a list row of a request goes: its agent, what it wants in one line, where and when, its time left. */
function ReqRow({ approval: a, selected, onOpen }: { approval: Approval; selected: boolean; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = usePhase(a);
  const place = useLinePlace(a);
  const via = useApprovalVia(a);
  const leftMs = new Date(a.expiresAt).getTime() - Date.now();
  // Its owner by name, a person's or a role's (ADR 0085, addendum of 2026-11-21): "Waiting for Engineering".
  const waits = approvalWaitsFor(a, dir.ownerName(approvalOwnerOf(a, agent)));
  const where = approvalTarget(a) ?? via.name;
  // On its way (waiting for you, in line, running): when it was asked; decided: who decided and when.
  const live = p === "waiting" || p === "queued" || p === "running";
  const end =
    p === "waiting" ? (
      <span className={cx("ap-li__left", leftMs <= URGENT_MS && "is-urgent")}>
        {a.canDecide
          ? (timeLeft(t, a.expiresAt) ?? t("approval.expired"))
          : waits
            ? t("approval.waitingFor", { name: waits })
            : t("approval.waitingAdmin")}
      </span>
    ) : (
      <PhaseMark approval={a} />
    );
  return (
    <button
      type="button"
      className={cx("ap-li ac-mediarow ac-mediarow--row", selected && "is-selected")}
      data-id={a.id}
      aria-current={selected || undefined}
      onClick={onOpen}
    >
      <span className="ac-mediarow__face">
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="sm"
          state={p === "waiting" || p === "queued" ? "waiting" : p === "running" ? "writing" : "idle"}
          expression={
            p === "done" ? "happy" : p === "refused" || p === "expired" || p === "notRun" ? "closed" : undefined
          }
        />
      </span>
      <span className="ac-mediarow__head">
        <span className="ap-li__line">
          {live ? (
            <Trans
              i18nKey="notifications.wait.wants"
              values={{ name, action: approvalDoing(t, a, i18n.language) }}
              components={{ b: <b /> }}
              {...TYPED_VALUES}
            />
          ) : (
            <b>{approvalTitle(t, a)}</b>
          )}
        </span>
      </span>
      <span className="ac-mediarow__end">{end}</span>
      <span className="ac-mediarow__body">
        <span className="ap-li__meta">
          <ViaGlyph via={via} />
          {where && <span className="ap-li__where">{where}</span>}
          <span className="ap-li__when">
            {/* Its place on its card, in the order the agent asked, when it shares one. */}
            {place && place.count > 1 && `${t("approvals.position", { n: place.position, total: place.count })} · `}
            {live
              ? relativeTime(t, i18n.language, a.createdAt)
              : decisionLabel(t, i18n.language, a, me.user.id, dir.memberById)}
          </span>
        </span>
      </span>
      {p === "waiting" && <ExpiryFuse left={Math.max(0, leftMs) / TTL_MS} color={colorOf(agent)} />}
    </button>
  );
}

const EFFECT_ICON: Record<ApprovalEffect, IconName> = {
  external: "send",
  production: "cloud",
  unsent: "archiveBox",
  readsOnly: "eye",
};
const UNDO_ICON: Record<ApprovalUndo, IconName> = { irreversible: "alert", reversible: "undo", deletable: "undo" };
/** Its text folds past this many characters ("Ver mais"). */
const TEXT_FOLD = 360;

/** Whether what it does can be undone, as a chip after the request's title (on the page and in the dialog). */
function UndoChip({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const { undo } = approvalEffects(a);
  if (!undo) return null;
  return (
    <Chip icon={UNDO_ICON[undo]} tone={undo === "irreversible" ? "waiting" : undefined} className="ap-review__undo">
      {t(`approvals.trait.${undo}`)}
    </Chip>
  );
}

/**
 * The request itself, under its head (the page's pane) or inside the details dialog: its facts, the outcome once
 * decided, why the agent asks, what it will write (an email as the email, a long text as it will read, else its
 * values), and how it got there (the run's steps as a track, unfolding into the reply's tool block).
 */
function ReviewBody({ approval: a, channel }: { approval: Approval; channel: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = usePhase(a);
  // Won't happen (refused, kept from running, expired, canceled): what it would have done, not what it did.
  const never = p === "refused" || p === "notRun" || p === "expired" || p === "canceled";
  const via = useApprovalVia(a);
  const [unfold, setUnfold] = useState(false);
  const textBox = useRef<HTMLDivElement>(null);
  const reveal = useReveal(textBox, unfold);
  const [steps, setSteps] = useState(false);
  const [tech, setTech] = useState(false);
  const { effect } = approvalEffects(a);
  const target = approvalTarget(a);
  const text = approvalText(a);
  const why = approvalWords(a);
  const pr = prLink(a);
  const leftMs = new Date(a.expiresAt).getTime() - Date.now();
  const owner = approvalOwnerOf(a, agent);
  const waits = approvalWaitsFor(a, dir.ownerName(owner));
  // A role answers for it (ADR 0085, addendum of 2026-11-21): who can decide reads that anyone holding it may, and the
  // first decision counts. A request that named its deciders (`approvers`) is theirs.
  const ownerRole = owner.ownerRoleId && !a.approvers?.label ? dir.roleName(owner.ownerRoleId) : undefined;
  const facts: Fact[] = [
    {
      key: "where",
      icon: <ViaGlyph via={via} />,
      label: t("approvals.review.where"),
      value: [via.name, target ?? via.account].filter(Boolean).join(" · "),
      title: [via.name, target ?? via.account].filter(Boolean).join(" · "),
    },
    ...(effect
      ? [
          {
            key: "effect",
            icon: EFFECT_ICON[effect],
            label: t("approvals.review.effect"),
            value: t(`approvals.review.effects.${effect}`),
            tone: effect === "production" ? ("waiting" as const) : undefined,
          },
        ]
      : []),
    p === "waiting"
      ? {
          key: "when",
          icon: a.canDecide ? "clock" : "person",
          label: a.canDecide ? t("approvals.review.deadline") : t("approvals.review.decides"),
          value: a.canDecide
            ? (timeLeft(t, a.expiresAt) ?? t("approval.expired"))
            : waits
              ? t("approval.waitingFor", { name: waits })
              : t("approval.waitingAdmin"),
          tone: a.canDecide && leftMs <= URGENT_MS ? "waiting" : undefined,
        }
      : {
          key: "when",
          icon:
            p === "done"
              ? "check"
              : p === "failed"
                ? "alert"
                : p === "queued"
                  ? "waiting"
                  : p === "notRun"
                    ? "block"
                    : "clock",
          label: t("approvals.review.state"),
          value: t(`approvals.status.${PHASE_STATUS[p]}`),
          tone: p === "done" ? "done" : p === "failed" ? "waiting" : undefined,
        },
    ...(p === "waiting" && a.canDecide && ownerRole
      ? [
          {
            key: "decides",
            icon: "person" as const,
            label: t("approvals.review.decides"),
            value: t("approvals.review.decidesRole", { role: ownerRole }),
          },
        ]
      : []),
  ];

  const logo = useCallLogo();
  const run = useRun(org.id, a.runId);
  const around = run.data ? stepsAround(run.data.steps, a) : null;
  const before = around ? toolItemsSaved(workFromSteps(around.before, run.data?.run)) : [];
  const after = around ? toolItemsSaved(workFromSteps(around.after, run.data?.run)) : [];
  const calls = (items: ToolItem[]) =>
    items
      .flatMap((i) => (i.kind === "call" ? [i.line] : []))
      .filter((l, i, all) => !(i === all.length - 1 && l.state === "stop"));
  const lines = calls(before);
  const afterLines = after.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const at = (iso: string) => formatTime(i18n.language, iso);
  const track: StepTrackStep[] = [
    ...lines.map((l) => ({
      key: l.key,
      icon: logo(l),
      label: toolPhrase(t, l, i18n.language),
      title: [toolPhrase(t, l, i18n.language), l.hint].filter(Boolean).join(" · "),
      state: l.state === "fail" ? ("failed" as const) : ("done" as const),
    })),
    {
      key: "asked",
      icon: "waiting",
      label: t("approvals.review.asked"),
      time: at(a.createdAt),
      state: p === "waiting" ? ("now" as const) : ("done" as const),
    },
    ...(a.decidedAt && p !== "waiting"
      ? [
          {
            key: "decided",
            icon: (a.status === "approved" ? "check" : a.status === "refused" ? "close" : "clock") as IconName,
            label: t(`approvals.status.${PHASE_STATUS[p]}`),
            time: at(a.decidedAt),
            state: a.status === "approved" ? ("after" as const) : ("done" as const),
          },
        ]
      : []),
    ...afterLines.map((l) => ({
      key: `after-${l.key}`,
      icon: logo(l),
      label: toolPhrase(t, l, i18n.language),
      title: [toolPhrase(t, l, i18n.language), l.hint].filter(Boolean).join(" · "),
      state: l.state === "fail" ? ("failed" as const) : ("after" as const),
    })),
  ];
  const durationMs = around ? workFromSteps(around.before, run.data?.run).durationMs : null;
  const folded = !unfold && ((text?.text.length ?? 0) > TEXT_FOLD || (text?.text.split("\n").length ?? 0) > 6);

  return (
    <div className="ap-review__body">
      <FactStrip facts={facts} className="ap-review__facts" />
      <AheadLine approval={a} className="ap-card__ahead" />
      <Outcome approval={a} agent={agent} />

      {/* One surface: the agent's why and what it will do as plain sections, how it got here one closed line. */}
      {why && (
        <section className="ap-review__sect" aria-label={t("approvals.review.why", { name })}>
          <h3 className="ac-grouphead">{t("approvals.review.why", { name })}</h3>
          <p className="ap-review__why">{inlineWords(why)}</p>
          {a.issue && (
            <Link
              className="ap-link"
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(a.issue.number) }}
            >
              #{a.issue.number} {a.issue.title}
            </Link>
          )}
        </section>
      )}

      <section className="ap-review__sect">
        <h3 className="ac-grouphead">
          {a.email
            ? t("approvals.review.email")
            : text
              ? t(
                  p === "done"
                    ? "approvals.review.textDone"
                    : never
                      ? "approvals.review.textNot"
                      : "approvals.review.text",
                )
              : t(
                  p === "done" || p === "failed"
                    ? "approvals.review.valuesDone"
                    : never
                      ? "approvals.review.valuesNot"
                      : "approvals.review.values",
                )}
        </h3>
        {a.email ? (
          <EmailLetter email={a.email} full />
        ) : text ? (
          <div>
            <div ref={textBox} className={cx("ap-review__text", folded && "is-folded")}>
              <Markdown source={text.text} variant="message" />
            </div>
            {folded && (
              <button
                type="button"
                className="ac-link folded-body__more"
                onClick={() => {
                  reveal();
                  setUnfold(true);
                }}
              >
                {t("channel.long.more")}
              </button>
            )}
          </div>
        ) : (
          <ExactAction approval={a} bare />
        )}
        {pr && (
          <a className="ap-link" href={pr} target="_blank" rel="noreferrer">
            {t("approvals.panel.openPr")}
          </a>
        )}
      </section>

      <Disclosure
        className="ap-review__trail"
        summary={[
          t("approvals.review.trail"),
          around ? t("chat.work.steps", { count: track.length }) : "",
          durationMs ? formatDuration(t, durationMs) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <StepTrack
          steps={track}
          className="ap-review__track"
          more={(count) => t("chat.work.steps", { count })}
          onMore={() => setSteps(true)}
          aria-label={t("approvals.review.trail")}
        />
        {steps && run.data && around && (
          <TaskStepsBlock
            steps={[...around.before, ...around.after]}
            run={run.data.run}
            working={false}
            agentName={name}
            color={colorOf(agent)}
          />
        )}
        {tech && text && (
          <pre className="ap-code ap-review__tech">
            <code>{`${a.tool}\n${JSON.stringify(a.params ?? {}, null, 2)}`}</code>
          </pre>
        )}
        {(channel || text || lines.length + afterLines.length > 0) && (
          <p className="ap-review__foot">
            {lines.length + afterLines.length > 0 && (
              <button type="button" className="ap-link" aria-expanded={steps} onClick={() => setSteps((o) => !o)}>
                {steps ? t("approvals.review.hideSteps") : t("approvals.review.showSteps")}
              </button>
            )}
            {text && (
              <button type="button" className="ap-link" aria-expanded={tech} onClick={() => setTech((o) => !o)}>
                {t("approvals.technical")}
              </button>
            )}
            {channel && (
              <Link
                className="ap-link"
                to="/org/$orgId/c/$channelId"
                params={{ orgId: org.id, channelId: a.channelId }}
                search={{ m: a.messageId ?? a.threadId ?? undefined }}
              >
                {t("approvals.panel.viewChannel", { channel })}
              </Link>
            )}
          </p>
        )}
      </Disclosure>
    </div>
  );
}

/**
 * The decision, in one bar of buttons: Refuse and Approve ("Aprovar sempre" before them where its kind offers it), what
 * each lets the agent do in its tip (Approve: once, with these values); refusing opens the reason in its place. Pinned
 * to the bottom of the page's pane; the details dialog's footer elsewhere. Nothing while it isn't yours to decide.
 */
function DecisionBar({
  approval: a,
  refusing,
  onRefuse,
  onCancelRefuse,
  also,
  floating,
}: {
  approval: Approval;
  refusing: boolean;
  onRefuse: () => void;
  onCancelRefuse: () => void;
  also?: string[];
  floating?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = usePhase(a);
  const place = useLinePlace(a);
  const waitsOn = place?.waitsOn;
  const deciding = useApprovalsDeciding(org.id, [a.id]);
  // Approved, its turn not come yet: it runs once what the agent asked before it is decided and done.
  if (p === "queued" && waitsOn)
    return (
      <div className={cx("ap-bar", floating && "ap-bar--float")}>
        <p className="ap-bar__text">
          <HeldLine approval={a} waitsOn={waitsOn} />
        </p>
      </div>
    );
  if (p === "running")
    return (
      <div className={cx("ap-bar", floating && "ap-bar--float")}>
        <p className="ap-bar__text ap-card__running">{t("approvals.running", { context: g.context, name })}</p>
        <WorkSweep color={colorOf(agent)} />
      </div>
    );
  if (p !== "waiting" || !a.canDecide) {
    const line = p === "waiting" ? requesterDecidesLine(t, a) : null;
    return line ? (
      <div className={cx("ap-bar", floating && "ap-bar--float")}>
        <p className="ap-bar__text">{line}</p>
      </div>
    ) : null;
  }
  if (refusing)
    return (
      <div className={cx("ap-bar ap-bar--refuse", floating && "ap-bar--float")}>
        <RefuseBox approval={a} agent={agent} onCancel={onCancelRefuse} />
      </div>
    );
  const note =
    approvalRisk(a) === "high"
      ? t("approvals.holdNote")
      : a.runAt
        ? t("approvals.clickNoteAhead", { when: nextLabel(i18n.language, a.runAt) })
        : t("approvals.review.grants", { name, doing: approvalDoing(t, a, i18n.language) });
  return (
    <div className={cx("ap-bar ap-bar--acts ac-tailrow", floating && "ap-bar--float")}>
      <WhenAsksLink approval={a} agent={agent} className="ap-bar__when" />
      <div className="ap-bar__acts ac-tail">
        <Locked when={deciding}>
          {approveAlwaysOffered(a) && <ApproveAlways approval={a} agent={agent} also={also} />}
          <Button size="sm" onClick={onRefuse}>
            {t("approval.refuse")}
            <Kbd>R</Kbd>
          </Button>
          <ApproveButton approval={a} tip={note} />
        </Locked>
      </div>
    </div>
  );
}

/** A decided request's state at the end of its list row: only its icon (the row's line already says who decided). */
function PhaseMark({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const p = usePhase(approval);
  const [icon, key]: [IconName, (typeof PHASE_STATUS)[keyof typeof PHASE_STATUS]] =
    p === "queued"
      ? ["waiting", "queued"]
      : p === "notRun"
        ? ["block", "notRun"]
        : p === "done"
          ? ["check", "approved"]
          : p === "scheduled"
            ? ["calendar", "scheduled"]
            : p === "failed"
              ? ["alert", "failed"]
              : p === "refused"
                ? ["close", "refused"]
                : p === "expired"
                  ? ["clock", "expired"]
                  : p === "running"
                    ? ["play", "running"]
                    : ["block", "canceled"];
  const label = t(`approvals.status.${key}`);
  return (
    <span className={cx("ap-li__state", `is-${p}`)} role="img" aria-label={label} title={label}>
      <Icon name={icon} size={16} />
    </span>
  );
}

/** Expired: ask the agent, in the same conversation, to ask again if it still makes sense. */
function AskAgain({ approval, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const post = usePostMessage(org.id, approval.channelId, {
    me: { id: me.user.id },
    mentioned: () => [approval.agentId],
    onSent: () => toast.show(t("approvals.againSent"), "info"),
  });
  if (!agent) return null;
  return (
    <Button
      size="sm"
      icon="repeat"
      loading={post.isPending}
      disabled={post.isPending || post.isSuccess}
      onClick={(e) => {
        e.stopPropagation();
        sendHelpers(post).send(
          t("approvals.againBody", { handle: agent.handle, title: approvalTitle(t, approval) }),
          approval.threadId,
        );
      }}
    >
      {t("approvals.again")}
    </Button>
  );
}

/** A request's details over whatever page is open (`DetailsHost`): a routine's run, an audit row. */
export function ApprovalDetailsDialog({ approvalId, onClose }: { approvalId: string; onClose: () => void }) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const channels = useChannels(org.id);
  const [refusing, setRefusing] = useState(false);
  const all = useMemo(() => approvals.data ?? [], [approvals.data]);
  const lines = useMemo(() => approvalLines(all), [all]);
  const approval = all.find((a) => a.id === approvalId);
  useEffect(() => {
    if (approvals.isSuccess && !approval) onClose();
  }, [approvals.isSuccess, approval, onClose]);
  if (!approval) return null;
  return (
    <LinesContext.Provider value={lines}>
      <ApprovalDetails
        approval={approval}
        channel={channels.data?.find((c) => c.id === approval.channelId)?.name ?? ""}
        refusing={refusing}
        onRefuse={() => setRefusing(true)}
        onCancelRefuse={() => setRefusing(false)}
        onClose={onClose}
      />
    </LinesContext.Provider>
  );
}

/** A request in the centered details dialog over another page: the same review as the Approvals page's pane. */
function ApprovalDetails({
  approval: a,
  channel,
  refusing,
  onRefuse,
  onCancelRefuse,
  onClose,
}: {
  approval: Approval;
  channel: string;
  refusing: boolean;
  onRefuse: () => void;
  onCancelRefuse: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = usePhase(a);
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      // Esc while a reason is being typed backs out of refusing first.
      onEscapeKeyDown={(e) => {
        if (refusing) {
          e.preventDefault();
          onCancelRefuse();
        }
      }}
      closeLabel={t("approvals.panel.close")}
      className="ap-dialog"
      eyebrow={t("approvals.panel.eyebrow")}
      icon={
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="md"
          state={p === "running" ? "writing" : p === "waiting" || p === "queued" ? "waiting" : "idle"}
          running={p === "running"}
          expression={p === "done" ? "happy" : undefined}
        />
      }
      title={
        <>
          {approvalTitle(t, a)} <UndoChip approval={a} />
        </>
      }
      subtitle={
        <span>
          <b className="ap-dialog__who">{name}</b>
          {" · "}
          {[agent?.role, channel ? `#${channel}` : "", relativeTime(t, i18n.language, a.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      footer={<DecisionBar approval={a} refusing={refusing} onRefuse={onRefuse} onCancelRefuse={onCancelRefuse} />}
    >
      <ReviewBody approval={a} channel={channel} />
    </DetailsDialog>
  );
}

/** What became of a decided request, as one card among the review's: its state, who decided and when, the action it
 * still offers (cancel a scheduled one, ask again), and what the action returned behind a link. */
function Outcome({ approval: a, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [returned, setReturned] = useState(false);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = usePhase(a);
  // Kept from running: the request asked before it whose refusal or expiry did that.
  const earlier = useApprovals(org.id).data?.find((x) => x.id === a.result?.notRunAfter);
  const earlierPlace = useContext(LinesContext).get(earlier?.id ?? "");
  if (p === "waiting") return null;
  const who =
    a.decidedByUserId === me.user.id
      ? t("approvals.panel.youLower")
      : (dir.memberById.get(a.decidedByUserId ?? "")?.name ?? "");
  const when = a.decidedAt ? relativeTime(t, i18n.language, a.decidedAt) : "";
  const approvedBy = t("approvals.panel.approvedBy", { name: who, when });
  const notRunLine = !earlier
    ? t("approvals.notRunEarlier")
    : earlier.status === "refused"
      ? t("approvals.notRunRefused", { title: titleOnCard(t, earlier, earlierPlace) })
      : t("approvals.notRunExpired", { title: titleOnCard(t, earlier, earlierPlace) });
  const [icon, title, subtitle]: [IconName, string, string | undefined] =
    // In line: the bar under the request says what it runs after.
    p === "queued"
      ? ["waiting", t("approvals.status.queued"), approvedBy]
      : p === "notRun"
        ? ["block", t("approvals.status.notRun"), notRunLine]
        : p === "running"
          ? ["play", t("approvals.panel.runningLine", { context: g.context, name }), approvedBy]
          : p === "done"
            ? ["check", t("approvals.panel.done"), approvedBy]
            : p === "failed"
              ? ["alert", t("approvals.panel.failed"), approvedBy]
              : p === "refused"
                ? [
                    "close",
                    t("approvals.panel.refusedBy", { name: who, when }),
                    a.reason ? `“${a.reason}”` : t("approvals.panel.noReason"),
                  ]
                : p === "scheduled"
                  ? [
                      "calendar",
                      a.runAt ? t("approval.ahead.scheduled", { when: nextLabel(i18n.language, a.runAt) }) : "",
                      approvedBy,
                    ]
                  : p === "expired"
                    ? ["clock", t("approvals.status.expired"), aheadEndLine(t, a) ?? t("approvals.expiredLine")]
                    : [
                        "block",
                        t("approvals.status.canceled"),
                        a.supersededById
                          ? t("approvals.supersededLine")
                          : (aheadEndLine(t, a) ?? t("approvals.canceledLine")),
                      ];
  // What the action returned; one kept from running returned nothing (its line above says why).
  const shownResult = p !== "notRun" && a.result?.text ? a.result.text : null;
  const action =
    p === "scheduled" && a.canCancel ? (
      <CancelAhead id={a.id} />
    ) : p === "expired" && aheadPhase(a) !== "lapsed" ? (
      <AskAgain approval={a} agent={agent} />
    ) : undefined;
  return (
    <Card className={cx("ap-review__card ap-outcome", `ap-outcome--${p}`)}>
      <CardHeader icon={icon} title={title} subtitle={subtitle} action={action} />
      {p === "refused" && a.reason && (
        <p className="ap-outcome__lesson">{t("approvals.lesson", { name, reason: a.reason })}</p>
      )}
      {returned && shownResult && (
        <pre className="ap-code ap-review__tech">
          <code>{shownResult}</code>
        </pre>
      )}
      {shownResult && (
        <p className="ac-card__foot ap-review__foot">
          <button type="button" className="ap-link" aria-expanded={returned} onClick={() => setReturned((o) => !o)}>
            {t("approvals.panel.returned")}
          </button>
        </p>
      )}
      {p === "running" && <WorkSweep color={colorOf(agent)} />}
    </Card>
  );
}

/** For the inbox's decided requests: the same rows, by the day each was decided. */
export { decidedAt as approvalDecidedAt, groups as decidedGroups, ReqRow as ApprovalRow };
