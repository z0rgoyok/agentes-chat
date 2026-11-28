import { randomBytes } from "node:crypto";
import {
  EGRESS_ONLY_PROTOCOL,
  EGRESS_SHARE,
  EGRESS_SHARE_PROTOCOL,
  lenderCarries,
  parseStreamControl,
  STREAM_CLOSE,
  type StreamHello,
} from "@agenteschat/adapters";
import { and, type Database, desc, eq, gte, isNull, schema, sql } from "@agenteschat/db";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { borrowsInternet, EGRESS_VIA_SHOWN_MS, getMachineById, serverLending, usesOnlyLent } from "./machines";
import { runByApp } from "./runner-update";
import type { ClaimedStream, StreamSocket } from "./streams";

const { machines } = schema;

/** A borrower's `machines.egress_via` and a lender's `egress_lent_at` are written at most this often. */
const VIA_WRITE_MS = 60_000;
/**
 * A lent computer that said it carries enough now, is paused, or didn't answer in time (asleep, its socket not yet
 * seen gone) is passed over this long: the next ask goes to another, or out the usual way at once.
 */
const FULL_MS = 60_000;
const PASS_OVER = new Set(["no_slot", "paused", "timeout"]);
/**
 * Bytes queued toward one side before the connection ends as too slow: Bun drops what a socket is sent past 16 MiB
 * queued. A computer that hears `pause` never gets there.
 */
const BUFFERED_MAX = 16 * 1024 * 1024;
/**
 * Queued toward one side past `HOLD_AT`, or that side's computer saying it can't write what reaches it fast enough
 * (`pause`): the other computer is told to stop reading (`pause`) until it is back under `RELEASE_AT` (`resume`).
 * Bun's server socket can't stop reading, so the computer that produces the bytes does.
 */
const HOLD_AT = 2 * 1024 * 1024;
const RELEASE_AT = 512 * 1024;
/** Bun says nothing when a socket drains: a held side is looked at this often. */
const HOLD_POLL_MS = 10;
const PAUSE = JSON.stringify({ type: "pause" });
const RESUME = JSON.stringify({ type: "resume" });
/** How long the server waits for the lent computer to reach the site and dial its data socket. */
const DIAL_MS = EGRESS_SHARE.connectMs + 5_000;
/** Who may lend in a workspace, read again at most this often. */
const CANDIDATES_MS = 5_000;

/**
 * The computers of a workspace that lend it their internet now (ADR 0237): people's own (`connected`), with the
 * switch on, new enough to, newest pick first (turned on or picked last, else paired last). Where this server lends,
 * those the agentes.chat app runs come before Terminal installs: a person's own desktop over a box in a server room.
 * `only`: the workspace uses only that one's internet (amendment 2026-11-27 c).
 */
export async function lendingComputers(db: Database, orgId: string) {
  const rows = await db
    .select({
      id: machines.id,
      name: machines.name,
      pairedByUserId: machines.pairedByUserId,
      os: machines.os,
      protocol: machines.protocol,
      executors: sql<{ app?: true }>`jsonb_strip_nulls(jsonb_build_object('app', ${machines.executors}->'app'))`,
      only: machines.egressOnly,
    })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.kind, "connected"),
        eq(machines.egressShare, true),
        gte(machines.protocol, EGRESS_SHARE_PROTOCOL),
        isNull(machines.deletedAt),
      ),
    )
    .orderBy(desc(sql`coalesce(${machines.egressShareAt}, ${machines.createdAt})`));
  if (!serverLending()) return rows;
  return rows.sort((a, b) => Number(desktopApp(b)) - Number(desktopApp(a)));
}

/** Said by its runner, or an older one off Linux (`runByApp`): an old Linux runner that doesn't say comes after. */
const desktopApp = (m: Parameters<typeof runByApp>[0]) =>
  m.executors?.app === true || (m.os !== "linux" && runByApp(m));

type Lender = Awaited<ReturnType<typeof lendingComputers>>[number];

/**
 * Where the workspace's agents use only lent internet (amendment 2026-11-27 c): just the computers lent "only" may
 * carry it, and none online means no internet. Otherwise every lending computer.
 */
const carriers = (rows: Lender[]) => {
  const only = rows.filter((r) => r.only);
  return { rows: only.length > 0 ? only : rows, only: only[0] ?? null };
};

/**
 * Tells `orgId`'s borrowing computers (`borrowsInternet`, `EGRESS_ONLY_PROTOCOL`) whether it uses only lent internet
 * now (`egress.only`). One offline hears it in its next `welcome`.
 */
export async function tellBorrowersOnly(deps: { db: Database; hub: Pick<MachineCaller, "call"> }, orgId: string) {
  const [on, rows] = await Promise.all([
    usesOnlyLent(deps.db, orgId),
    deps.db
      .select()
      .from(machines)
      .where(and(eq(machines.orgId, orgId), gte(machines.protocol, EGRESS_ONLY_PROTOCOL), isNull(machines.deletedAt))),
  ]);
  await Promise.all(
    rows
      .filter(borrowsInternet)
      .map((m) => deps.hub.call(m.id, { op: "egress.only", on }, { timeoutMs: 5_000 }).catch(() => undefined)),
  );
}

const closeCodeFor = (error: unknown) => {
  if (!(error instanceof MachineRequestError)) return STREAM_CLOSE.unreachable;
  if (error.code === "not_allowed" || error.code === "bad_request") return STREAM_CLOSE.refused;
  if (error.code === "not_found") return STREAM_CLOSE.notFound;
  return STREAM_CLOSE.unreachable;
};

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // A socket that broke is cleaned up by its close.
  }
};

interface Leg {
  socket: StreamSocket;
  peer: Leg | null;
  closed: boolean;
  /** Its computer said `pause`: what reaches it backs up on its side. */
  full: boolean;
  /** Its computer was told `pause`, until `resume`. */
  held: ReturnType<typeof setInterval> | null;
}

const newLeg = (socket: StreamSocket, peer: Leg | null = null): Leg => ({
  socket,
  peer,
  closed: false,
  full: false,
  held: null,
});

/**
 * Lent connections on this server (ADR 0237). A borrowing computer's data socket names a destination in its hello
 * (`claim` with `egress`), or the server itself asks for one for an organization's agents (`connect`): the server
 * picks the computer that lends, asks it to dial (`egress.dial`), and pairs the data socket it opens with the first,
 * bytes passed as they come. Nothing lent now, or a refusal, closes the first socket with a code read as "go out your
 * usual way" (`unreachable`, `forbidden`: this computer doesn't borrow) or "not carried" (`refused`, `notFound`).
 * Both sockets must reach this server process.
 */
export function createEgressRelay(deps: {
  db: Database;
  hub: Pick<MachineCaller, "call" | "status">;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** The lent computer's data socket we wait for, by its stream id: the workspace computer's side waiting for it. */
  const pending = new Map<string, { deviceId: string; leg: Leg }>();
  const full = new Map<string, number>();
  const candidates = new Map<string, { at: number; rows: Promise<Awaited<ReturnType<typeof lendingComputers>>> }>();
  const viaWritten = new Map<string, { deviceId: string; at: number }>();
  const lentWritten = new Map<string, number>();

  const end = (leg: Leg, code: number = STREAM_CLOSE.normal, reason = "") => {
    if (leg.closed) return;
    leg.closed = true;
    clearInterval(leg.held ?? undefined);
    quietly(() => leg.socket.close(code, reason));
    if (leg.peer) end(leg.peer);
  };

  /** Tells `producer`'s computer to stop or go on reading, by what waits toward its peer. */
  const settle = (producer: Leg) => {
    const to = producer.peer;
    if (producer.closed || !to) return;
    const hold = to.full || to.socket.buffered() > (producer.held ? RELEASE_AT : HOLD_AT);
    if (hold === (producer.held !== null)) return;
    quietly(() => producer.socket.send(hold ? PAUSE : RESUME));
    if (hold) producer.held = setInterval(() => settle(producer), HOLD_POLL_MS);
    else {
      clearInterval(producer.held ?? undefined);
      producer.held = null;
    }
  };

  const pass = (from: Leg, data: string | Uint8Array) => {
    const to = from.peer;
    if (!to || to.closed) return;
    if (typeof data === "string") {
      const control = parseStreamControl(data);
      if (control?.type !== "pause" && control?.type !== "resume") return;
      from.full = control.type === "pause";
      return settle(to);
    }
    if (to.socket.buffered() > BUFFERED_MAX) return end(from, STREAM_CLOSE.tooSlow, "too slow");
    quietly(() => to.socket.send(data));
    settle(from);
  };

  const claimed = (leg: Leg): ClaimedStream => ({
    data: (data) => pass(leg, data),
    closed: () => end(leg),
  });

  const lenders = (orgId: string) => {
    const hit = candidates.get(orgId);
    if (hit && now() - hit.at < CANDIDATES_MS) return hit.rows;
    const rows = lendingComputers(deps.db, orgId);
    candidates.set(orgId, { at: now(), rows });
    rows.catch(() => candidates.delete(orgId));
    return rows;
  };

  /**
   * The lending computer for `orgId` now that carries `port` (any, when null), never `borrowerId` itself. `older`:
   * only lenders on an app that carries the web alone are online. `only`: the workspace uses only lent internet
   * (`carriers`), the computer it names.
   */
  async function pick(orgId: string, borrowerId: string | null, port: number | null) {
    let older = false;
    const { rows, only } = carriers(await lenders(orgId));
    for (const row of rows) {
      if (row.id === borrowerId || (full.get(row.id) ?? 0) > now()) continue;
      if (!(await deps.hub.status(row.id).catch(() => null))?.online) continue;
      if (port === null || lenderCarries(row.protocol, port)) return { device: row, older, only };
      older = true;
    }
    return { device: null, older, only };
  }

  /** Who carried the last connection, on the borrower's row (the server itself has none), and when, on the lender's. */
  async function noteVia(borrowerId: string | null, deviceId: string) {
    const at = new Date(now()).toISOString();
    const last = borrowerId ? viaWritten.get(borrowerId) : undefined;
    if (borrowerId && !(last && last.deviceId === deviceId && now() - last.at < VIA_WRITE_MS)) {
      viaWritten.set(borrowerId, { deviceId, at: now() });
      const via = machines.egressVia;
      // `since` stays while the same computer goes on lending (other server processes write `at` too); a new one, or
      // one back after the apps stopped saying it, starts it again.
      await deps.db
        .update(machines)
        .set({
          egressVia: sql`jsonb_build_object('machineId', ${deviceId}::text, 'at', ${at}::text, 'since',
            case when ${via}->>'machineId' = ${deviceId}::text
              and (${via}->>'at')::timestamptz > ${at}::timestamptz - make_interval(secs => ${EGRESS_VIA_SHOWN_MS / 1000})
            then ${via}->'since' else to_jsonb(${at}::text) end)`,
        })
        .where(eq(machines.id, borrowerId));
    }
    if (now() - (lentWritten.get(deviceId) ?? Number.NEGATIVE_INFINITY) < VIA_WRITE_MS) return;
    lentWritten.set(deviceId, now());
    await deps.db
      .update(machines)
      .set({ egressLentAt: new Date(at) })
      .where(eq(machines.id, deviceId));
  }

  async function open(
    leg: Leg,
    borrower: { orgId: string; machineId: string | null },
    target: { host: string; port: number },
  ) {
    const { device, older, only } = await pick(borrower.orgId, borrower.machineId, target.port);
    if (leg.closed) return;
    // Not "none lends": that would send the borrower its usual way, which a workspace lent "only" never takes.
    if (!device && only && !older) return end(leg, STREAM_CLOSE.notFound, `${only.name} is offline`);
    // Not "none lends": the borrower keeps asking for its web connections, which that computer carries.
    if (!device && older) return end(leg, STREAM_CLOSE.refused, "the lending computer carries the web only");
    if (!device) return end(leg, STREAM_CLOSE.unreachable, "no computer lends its internet now");
    const streamId = randomBytes(32).toString("base64url");
    pending.set(streamId, { deviceId: device.id, leg });
    try {
      await deps.hub.call(device.id, { op: "egress.dial", streamId, ...target }, { timeoutMs: DIAL_MS });
    } catch (error) {
      if (error instanceof MachineRequestError && PASS_OVER.has(error.code)) full.set(device.id, now() + FULL_MS);
      end(leg, only ? STREAM_CLOSE.notFound : closeCodeFor(error), "the lent connection didn't open");
      return;
    } finally {
      pending.delete(streamId);
    }
    // Answered once its data socket was ready: no pair by now means none is coming.
    if (!leg.peer)
      return end(leg, only ? STREAM_CLOSE.notFound : STREAM_CLOSE.unreachable, "the lent connection didn't open");
    await noteVia(borrower.machineId, device.id).catch((error) =>
      deps.log?.warn("egress via write failed", { machineId: borrower.machineId, error: String(error) }),
    );
  }

  /** A borrowing computer's request: only one that borrows (`borrowsInternet`) gets a lent connection. */
  async function openFor(leg: Leg, machineId: string, target: { host: string; port: number }) {
    const machine = await getMachineById(deps.db, machineId);
    if (!machine || machine.deletedAt || !borrowsInternet(machine)) {
      return end(leg, STREAM_CLOSE.forbidden, "this computer doesn't borrow a lent connection");
    }
    await open(leg, { orgId: machine.orgId, machineId: machine.id }, target);
  }

  return {
    /**
     * `StreamBrokerDeps.claim`: a workspace computer's request (`hello.egress`), answered `stream.ready` once paired
     * (`readyLater`), or the lent computer's data socket for one of them. Null: neither.
     */
    claim(hello: StreamHello, machineId: string, socket: StreamSocket): ClaimedStream | null {
      if (hello.egress) {
        const leg = newLeg(socket);
        void openFor(leg, machineId, hello.egress).catch((error) => {
          deps.log?.warn("egress relay failed", { machineId, error: String(error) });
          end(leg, STREAM_CLOSE.internal, "internal");
        });
        return { ...claimed(leg), readyLater: true };
      }
      const wait = pending.get(hello.streamId);
      if (!wait || wait.deviceId !== machineId || wait.leg.closed) return null;
      pending.delete(hello.streamId);
      const leg = newLeg(socket, wait.leg);
      wait.leg.peer = leg;
      quietly(() => wait.leg.socket.send(JSON.stringify({ type: "stream.ready" })));
      return claimed(leg);
    },
    /**
     * The server's own connection to `target` for an organization's agents (`egress-fetch.ts`), over `socket`: its
     * first text frame is `stream.ready` once a lent connection carries it, or it closes as a data socket would.
     */
    connect(orgId: string, target: { host: string; port: number }, socket: StreamSocket): ClaimedStream {
      const leg = newLeg(socket);
      void (async () => {
        // A workspace lent "only" (amendment 2026-11-27 c): its agents' reads of pages go through it on the Cloud too.
        if (!serverLending() && !carriers(await lenders(orgId)).only)
          return end(leg, STREAM_CLOSE.forbidden, "this server lends no connection to itself");
        await open(leg, { orgId, machineId: null }, target);
      })().catch((error) => {
        deps.log?.warn("egress relay failed", { orgId, error: String(error) });
        end(leg, STREAM_CLOSE.internal, "internal");
      });
      return claimed(leg);
    },
    /**
     * How `orgId`'s agents' reads of pages go now: `lent`, a computer lends it its internet; `only`, the computer it
     * uses only the internet of (`carriers`), which then never goes the usual way.
     */
    lending: async (orgId: string) => {
      const { device, only } = await pick(orgId, null, null);
      return { lent: device !== null, only: only ? { machineId: only.id, name: only.name } : null };
    },
  };
}

export type EgressRelay = ReturnType<typeof createEgressRelay>;
