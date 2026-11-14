import type { Approval } from "../api/types";
import { approveAlwaysOffered } from "./approval-kind";
import { approvalOriginShort, approvalWhy } from "./approval-origin";

/** The longest reason a person gives with a decision. Mirror: `APPROVAL_REASON_MAX` in packages/engine approvals.ts. */
export const APPROVAL_REASON_MAX = 1000;

/** In the order the agent asked: by when, then by id (time-ordered), so two asked in the same instant keep theirs. */
export const byAsked = (a: Pick<Approval, "createdAt" | "id">, b: Pick<Approval, "createdAt" | "id">) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The requests on one approval card, oldest first: the card's own (`first`) and every request of the agent
 * that joined it in that conversation (same `messageId`, server side `openApprovalCard`).
 */
export function approvalCardItems(list: readonly Approval[] | undefined, messageId: string, first?: Approval) {
  const byId = new Map<string, Approval>();
  // The first copy of an id wins: callers put the freshest list first.
  for (const a of [...(list ?? []), ...(first ? [first] : [])])
    if ((a.messageId === messageId || a === first) && !byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()].sort(byAsked);
}

/**
 * What "Aprovar tudo" covers: the items still waiting that this person may decide, as listed now (the ids
 * sent, so one joining during the click is never approved unseen), and how many waiting ones they can't.
 */
export function approveAllScope(items: readonly Approval[], now = Date.now()) {
  const waiting = items.filter((a) => a.status === "pending" && new Date(a.expiresAt).getTime() > now);
  const ids = waiting.filter((a) => a.canDecide).map((a) => a.id);
  return { ids, waiting: waiting.length, blocked: waiting.length - ids.length };
}

/** A request past its deadline reads as expired, before the server's event says so. */
export const asOfNow = (a: Approval, now = Date.now()): Approval =>
  a.status === "pending" && Date.parse(a.expiresAt) <= now ? { ...a, status: "expired" } : a;

/** The card's shared deadline: the earliest of its waiting items (null: nothing waits). */
export function cardDeadline(items: readonly Approval[]): string | null {
  const pending = items.filter((a) => a.status === "pending").map((a) => a.expiresAt);
  return pending.length ? pending.reduce((a, b) => (a < b ? a : b)) : null;
}

/**
 * A list of approvals as their cards (Aprovações, the phone's list), in the order the agents asked: requests sharing a
 * card come together at the place of its first one, each card's in the order asked; one without a card stands alone.
 */
export function approvalCards(list: readonly Approval[]): Approval[][] {
  const cards = new Map<string, Approval[]>();
  for (const a of [...list].sort(byAsked)) {
    const key = a.messageId ?? a.id;
    const card = cards.get(key);
    if (card) card.push(a);
    else cards.set(key, [a]);
  }
  return [...cards.values()];
}

/**
 * Approved and free to run for this long without being done: its run ended without it (or it ran before results
 * were kept), so it stops reading as running.
 */
export const RUNNING_FOR_MS = 15 * 60_000;

/** Where a request stands in its card's line (`approvalLine`). */
export interface LinePlace {
  /** Its place among the card's requests in the order asked (1 = the first), and how many the card holds. */
  position: number;
  count: number;
  /** Approved and not done yet: the request it still waits for (asked before it, or its own run's other one). */
  waitsOn: Approval | null;
  /** `waitsOn`'s own place on the card (1 = the first): two requests of one kind tell apart by it ("1 de 2"). */
  waitsOnAt: number | null;
  /** Approved and free to run since then: its decision, or the last request it waited for settling. */
  freeSince: string | null;
}

/** When nothing more happens to a request: decided other than approved, or approved and done (null: not yet). */
function settledAt(a: Approval): string | null {
  if (a.status === "pending") return null;
  if (a.status === "approved") return a.result ? (a.executedAt ?? a.decidedAt ?? a.createdAt) : null;
  return a.decidedAt ?? (a.status === "expired" ? a.expiresAt : a.createdAt);
}

/**
 * The order on one card (ADR 0182, the server's `approval-order.ts`): the agent's actions run in the order it asked,
 * whatever the order they were decided in. An approved action still to do waits for its own run's requests still
 * waiting for a person (the run goes on once all of them are decided), and for every request of another run asked
 * before its run's place (its earliest action still to do) that isn't settled: waiting for a person, or approved with
 * no result yet. Actions approved ahead and a mission's requests stand outside the line.
 */
export function approvalLine(card: readonly Approval[]): Map<string, LinePlace> {
  const items = [...card].sort(byAsked);
  const lined = (a: Approval) => Boolean(a.runId) && !a.runAt;
  const toDo = (a: Approval) => a.status === "approved" && !a.executedAt && !a.result && lined(a);
  const out = new Map<string, LinePlace>();
  items.forEach((a, i) => {
    let waitsOn: Approval | null = null;
    let freeSince: string | null = null;
    if (toDo(a)) {
      const place = items.findIndex((x) => x.runId === a.runId && toDo(x));
      // The first in the line it waits for: its own run's request still waiting, or another run's asked before it.
      waitsOn =
        items.find(
          (b, j) =>
            b.id !== a.id &&
            lined(b) &&
            (b.runId === a.runId
              ? b.status === "pending"
              : j < place && (b.status === "pending" || (b.status === "approved" && !b.result))),
        ) ?? null;
      if (!waitsOn) {
        const times = items
          .filter((b, j) => b.id !== a.id && lined(b) && (j < place || b.runId === a.runId))
          .map(settledAt)
          .filter((x): x is string => x !== null);
        freeSince = [a.decidedAt ?? a.createdAt, ...times].reduce((x, y) => (x > y ? x : y));
      }
    }
    const waitsOnAt = waitsOn ? items.indexOf(waitsOn) + 1 : null;
    out.set(a.id, { position: i + 1, count: items.length, waitsOn, waitsOnAt, freeSince });
  });
  return out;
}

/** `approvalLine` of every card in a list, by request id. */
export function approvalLines(list: readonly Approval[]): Map<string, LinePlace> {
  return new Map(approvalCards(list).flatMap((card) => [...approvalLine(card)]));
}

/**
 * What a request on a shared card says for itself: its why and where it came from, where they differ from the
 * card's lead request (one that joined from another turn or run keeps its own explanation).
 */
export function itemOwnWords(a: Approval, lead: Approval) {
  const why = approvalWhy(a);
  const origin = approvalOriginShort(a);
  return {
    why: why && why !== approvalWhy(lead) ? why : null,
    origin: origin && JSON.stringify(origin) !== JSON.stringify(approvalOriginShort(lead)) ? origin : null,
  };
}

/** "Aprovar sempre" on a shared card: once per kind, on the first request where it is offered. */
export function approveAlwaysOn(items: readonly Approval[]): Set<string> {
  const kinds = new Map<string, string>();
  for (const a of items) {
    const kind = JSON.stringify(a.approveAlways);
    if (approveAlwaysOffered(a) && !kinds.has(kind)) kinds.set(kind, a.id);
  }
  return new Set(kinds.values());
}

// The same "Aprovar sempre" kind too: a SQL write (none offered) never folds among reads, its SQL hidden.
const kindOf = (a: Approval) => JSON.stringify([a.agentId, a.tool, a.title, a.connectorAccount, a.approveAlways]);
const sameKind = (a: Approval, b: Approval) => kindOf(a) === kindOf(b);

/**
 * A key for each run of `approvalRuns` that stays the same while its requests are decided one by one (its first id
 * doesn't), so an unfolded run stays open: its kind, and which run of that kind on the card (a lone request is its id;
 * one decided out of a run doesn't shift the count).
 */
export function runKeys(runs: readonly Approval[][]): string[] {
  const seen = new Map<string, number>();
  return runs.map((run) => {
    const [first] = run;
    if (!first || run.length < 2) return first?.id ?? "";
    const kind = kindOf(first);
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    return `${kind}#${n}`;
  });
}

/**
 * A card's items as they are drawn: several waiting requests of one kind in a row (same agent, tool, action and
 * "Aprovar sempre" kind) come together as one run ("3 pedidos de Ada para Executar sql"), anything else stands alone. A run this person may decide
 * only one of stands apart again: "Aprovar todos" would cover just that one.
 */
export function approvalRuns(items: readonly Approval[]): Approval[][] {
  const runs: Approval[][] = [];
  for (const a of items) {
    const run = runs.at(-1);
    const head = run?.[0];
    if (run && head && a.status === "pending" && head.status === "pending" && sameKind(head, a)) run.push(a);
    else runs.push([a]);
  }
  return runs.flatMap((run) => (run.length > 1 && approveAllScope(run).ids.length === 1 ? run.map((a) => [a]) : [run]));
}

/**
 * The other requests "Aprovar sempre" on `a` approves with it: those on its card that this person may decide and that
 * the same rule covers. The rule is per connection, which the agent's tool name says, so the same server tool on
 * another account keeps asking, as does a write among SQL reads.
 */
export function approveAlwaysAlso(card: readonly Approval[], a: Approval): string[] {
  if (!a.approveAlways) return [];
  return card.filter((x) => x.id !== a.id && x.status === "pending" && x.canDecide && sameKind(x, a)).map((x) => x.id);
}

/**
 * A digest card's approvals as it draws them (the right hand's summary of what waits on a person): `routine`, the
 * ones one tap approves together. Routine is the server's word (`Approval.routine`), never worked out here, and the
 * tap sends `only: "routine"` so the server has the last say. Fewer than two routine ones are no group: each keeps its
 * own card.
 */
export function digestGroups(items: readonly Approval[], now = Date.now()) {
  const routine = items.filter((a) => asOfNow(a, now).status === "pending" && a.canDecide && a.routine === true);
  return { routine: routine.length > 1 ? routine : [] };
}

/**
 * What a digest's first line counts: how many of its approvals still wait, how many of them go in the routine group
 * and how many are left to read one by one.
 */
export function digestCounts(items: readonly Approval[], now = Date.now()) {
  const waiting = items.filter((a) => asOfNow(a, now).status === "pending").length;
  const routine = digestGroups(items, now).routine.length;
  return { waiting, routine, careful: waiting - routine };
}

/** How many rows of a routine group show before "Ver os outros". */
const DIGEST_ROWS = 3;
/** Up to this many different things a row's requests hold are said under it. More, and "Um por um" reads them. */
const DIGEST_DETAILS = 3;

export interface DigestRow {
  /** Its first request's id. */
  id: string;
  title: string;
  agentId: string;
  /** How many requests it stands for ("Criar página × 10"). */
  count: number;
  /** What its requests hold, each once, while they are few enough to say whole. Else nothing. */
  detail: string;
}

/**
 * A routine group's rows: the requests of one agent that read the same (`titleOf`) are one row with how many. The
 * first rows show and the rest wait behind one "Ver os outros" (`hidden`: the requests it holds back), unless that
 * would hide a single row. `folds`: there are rows to hold back, so shown whole (`all`) it can close again.
 */
export function digestRows(
  routine: readonly Approval[],
  titleOf: (a: Approval) => string,
  detailOf: (a: Approval) => string,
  all = false,
) {
  const byKey = new Map<string, DigestRow & { details: Set<string> }>();
  for (const a of routine) {
    const title = titleOf(a);
    const key = `${a.agentId}\n${title}`;
    const row = byKey.get(key) ?? { id: a.id, title, agentId: a.agentId, count: 0, detail: "", details: new Set() };
    row.count += 1;
    const detail = detailOf(a);
    if (detail) row.details.add(detail);
    byKey.set(key, row);
  }
  const rows: DigestRow[] = [...byKey.values()].map(({ details, ...row }) => {
    return { ...row, detail: details.size <= DIGEST_DETAILS ? [...details].join(", ") : "" };
  });
  const folds = rows.length > DIGEST_ROWS + 1;
  const shown = all || !folds ? rows : rows.slice(0, DIGEST_ROWS);
  return { rows: shown, hidden: rows.slice(shown.length).reduce((n, r) => n + r.count, 0), folds };
}
