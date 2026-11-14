import {
  DESKTOP_PROTOCOL,
  DESKTOP_SWITCH_PROTOCOL,
  type DesktopMode,
  type PubSub,
  type RateLimiter,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, type Database, eq, gt, inArray, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import {
  agentUsesScreen,
  BROWSER_HANDOFF_TOPIC,
  type BrowserHandoffView,
  browserOnDesktop,
  CONTROL_GRACE_MS,
  handoffViewFor,
  noteComputerTaken,
  openHandoffOn,
  requireBrowserAccess,
  screenAccess,
  setControlDeadline,
  touchControl,
} from "./browser/handoff";
import { HANDOFF_KEEPALIVE_MS } from "./browser/live";
import { TtlCache } from "./cache";
import { auditPhoneStream, authorizePhoneStream, recheckPhoneStream } from "./devices";
import { ForbiddenError, NotFoundError } from "./errors";
import { agentHolds, type HoldView, holdView, liveHold, releaseHold } from "./machine-holds";
import type { MachineCaller, MachineHub } from "./machine-hub";
import {
  computerDriving,
  type DriveRefusal,
  getMachine,
  machineOnline,
  mayDriveComputer,
  publishMachineAgentsChanged,
  requireComputerDriver,
} from "./machines";
import { can, requireActiveMembership } from "./organizations";
import { isRightHand, isRightHandId } from "./right-hand";
import { SHARED_SEAT, seatName, seatOf, toolMachineId, viewerScope, viewerSeat } from "./right-hand-seats";
import { getSandboxSettings, SANDBOX_SCOPE } from "./sandbox";
import { closedRefusal, OrgDeletingError, orgStanding, standingRefusal } from "./standing";
import type { Stream, StreamBroker, StreamInput, StreamTarget } from "./streams";
import { grantedScopeKeys, grantKey } from "./tools/scopes";

const { agents, browserHandoffs, sessions } = schema;

const refused = (code: number, reason: string) => ({ refused: code, reason });

/**
 * Who may watch an agent's desktop (ADR 0058 §4): the browser's rule on the `desktop` screen, and whoever
 * may drive its computer (`requireBrowserAccess`).
 */
export const requireDesktopAccess = (db: Database, userId: string, orgId: string, agentId: string, shared = false) =>
  requireBrowserAccess(db, userId, orgId, agentId, undefined, "desktop", shared);

/**
 * The computer a person's stream of an agent goes to, or why it can't: the
 * agent's own computer, with its socket on this server (streams don't cross
 * servers), on protocol 18 or later, its switch for that kind on and the
 * runner able to serve it; for a desktop, an agent that may use one.
 */
export async function desktopTarget(
  db: Database,
  hub: Pick<MachineHub, "isLocal">,
  orgId: string,
  agentId: string,
  kind: Exclude<StreamRequest["kind"], "phone">,
  /** Who asks: the right hand's desktop and terminal are each person's own seat (`viewerScope`). */
  viewerId: string,
  /** Tells the workspace's computers of a seat just made. */
  told?: (orgId: string) => Promise<void>,
  /** Off for a screen's state: the right hand's seat is made by opening it, never by asking how it is. */
  make = true,
  /** The right hand's shared seat, not the viewer's own. */
  shared = false,
): Promise<StreamTarget> {
  // A kind that is off for the agent is refused below without making the right hand's seat: one that ended with its
  // last grant stays ended, and the computer makes no user for a refusal. A seat's terminal is the right hand's
  // computer too: off with its commands (its grant, the workspace's switch).
  const off =
    kind === "desktop"
      ? !(await agentUsesScreen(db, orgId, agentId, "desktop"))
      : (await isRightHandId(db, orgId, agentId)) && !(await runsCommands(db, orgId, agentId));
  const agent = await viewerScope(db, orgId, agentId, viewerId, told, make && !off, shared);
  if (!agent) return refused(STREAM_CLOSE.notFound, "no_agent");
  // Why the right hand has no seat here, for the apps to say: no computer of the workspace's own, or one that runs
  // every agent as one user.
  if ("reason" in agent) {
    return refused(STREAM_CLOSE.notFound, agent.reason === "not_system" ? "not_system" : "no_home");
  }
  if (off) {
    return kind === "desktop"
      ? refused(STREAM_CLOSE.notFound, "no_desktop")
      : refused(STREAM_CLOSE.refused, "not_allowed");
  }
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!machine) return refused(STREAM_CLOSE.notFound, "no_computer");
  if (!hub.isLocal(machine.id)) {
    return refused(STREAM_CLOSE.unreachable, machineOnline(machine) ? "other_server" : "offline");
  }
  if (machine.protocol < DESKTOP_PROTOCOL) return refused(STREAM_CLOSE.refused, "runner_outdated");
  if (!machine.access?.tools[kind]) return refused(STREAM_CLOSE.refused, "not_allowed");
  if (!machine.executors?.[kind]?.available) return refused(STREAM_CLOSE.refused, `${kind}_unavailable`);
  return {
    machineId: machine.id,
    ...(agent.scope ? { agent: agent.scope } : { unmade: true }),
    ...(kind === "desktop" && machine.protocol >= DESKTOP_SWITCH_PROTOCOL ? { switches: true } : {}),
  };
}

/** Whether the agent may run commands now: its `sandbox:run` grant, and the workspace's switch for them. */
async function runsCommands(db: Database, orgId: string, agentId: string) {
  const keys = await grantedScopeKeys(db, orgId, agentId);
  return keys.has(grantKey(null, SANDBOX_SCOPE)) && (await getSandboxSettings(db, orgId)).enabled;
}

/**
 * Whether the person may have this stream now, as `authorizeStream` decides and the broker checks again
 * every 30 s while it is open: watching follows the desktop's rule, control and the terminal its computer's
 * driver. While someone controls the desktop, or the browser showing the same window, nobody else sees it;
 * control is only theirs, on the desktop's own handoff (`control`: its id). Nobody has one in a closed
 * workspace (suspended, or being deleted: `closedRefusal`).
 */
async function streamAccess(
  db: Database,
  input: Pick<StreamInput, "userId" | "orgId" | "agentId" | "request" | "shared">,
): Promise<{ refused: number; reason: string } | { driven: string | null; control: string | null }> {
  const { userId, orgId, agentId, request } = input;
  const shared = input.shared === true;
  const closed = closedRefusal(await orgStanding(db, orgId));
  if (closed) return refused(STREAM_CLOSE.forbidden, closed instanceof OrgDeletingError ? "deleting" : "suspended");
  let driven: string | null = null;
  try {
    if (request.kind === "terminal" || request.mode === "control") {
      driven = (await requireComputerDriver(db, userId, orgId, agentId, shared)).id;
    } else await requireDesktopAccess(db, userId, orgId, agentId, shared);
  } catch (error) {
    if (error instanceof ForbiddenError) return refused(STREAM_CLOSE.forbidden, "forbidden");
    if (error instanceof NotFoundError) return refused(STREAM_CLOSE.notFound, "not_found");
    throw error;
  }
  if (request.kind !== "desktop") return { driven, control: null };
  const open = await openHandoffOn(db, orgId, agentId, "desktop", viewerSeat(input));
  const controller = open?.status === "active" ? open.controllerUserId : null;
  if (controller && controller !== userId) return refused(STREAM_CLOSE.hidden, "someone_in_control");
  if (request.mode === "watch") return { driven, control: null };
  // The browser's handoff too, its window on this screen: who may drive the computer (checked above) helps there.
  if (!open || controller !== userId) return refused(STREAM_CLOSE.controlEnded, "not_in_control");
  return { driven, control: open.id };
}

export interface StreamPolicyDeps {
  db: Database;
  hub: Pick<MachineHub, "isLocal">;
  rateLimiter?: RateLimiter;
  pubsub?: PubSub;
}

/**
 * Whether a person's stream may open, and where (the broker's `authorize`):
 * at most `opensPerMinute` opens a minute per person, `streamAccess`, then the
 * computer (`desktopTarget`). A control stream opening is its holder back: the
 * grace of their control starts again. A held agent's desktop (or one in a
 * workspace on hold) may be watched while it runs; starting it is new work. A phone's screen goes by its own rule
 * (`authorizePhoneStream`).
 */
export async function authorizeStream(deps: StreamPolicyDeps, input: StreamInput): Promise<StreamTarget> {
  if (input.request.kind === "phone") return authorizePhoneStream(deps, input);
  const rate = await deps.rateLimiter?.consume(`stream-open:${input.userId}`, {
    limit: STREAM_LIMITS.opensPerMinute,
    windowMs: 60_000,
  });
  if (rate && !rate.allowed) return refused(STREAM_CLOSE.tooMany, "rate_limited");
  const access = await streamAccess(deps.db, input);
  if ("refused" in access) return access;
  const target = await desktopTarget(
    deps.db,
    deps.hub,
    input.orgId,
    input.agentId,
    input.request.kind,
    input.userId,
    (org) => publishMachineAgentsChanged(deps.pubsub, org),
    true,
    input.shared === true,
  );
  if (!("machineId" in target)) return target;
  // Nothing opens on a computer without who it is for there.
  if (!target.agent) return refused(STREAM_CLOSE.notFound, "no_computer");
  // The agent moved to another computer meanwhile: who drives that one wasn't checked.
  if (access.driven && target.machineId !== access.driven) return refused(STREAM_CLOSE.forbidden, "forbidden");
  if (access.control) await touchControl(deps.db, access.control, input.userId, new Date(), true).catch(() => {});
  // A shell as the agent's user reaches what its screen does (the owner's sign-in): its owner hears it the same way.
  if (input.request.kind === "terminal") {
    await noteComputerTaken(deps, {
      orgId: input.orgId,
      agentId: input.agentId,
      actorId: input.userId,
      shared: input.shared === true,
    }).catch(() => {});
  }
  if (input.request.kind === "desktop" && (await standingRefusal(deps.db, input.orgId, input.agentId))) {
    return { ...target, held: true };
  }
  return target;
}

/**
 * The broker's `reauthorize`, as its handoff changed: whether a desktop stream may go on in `mode` on the same
 * sockets (ADR 0058 §17), as `authorizeStream` decides for one that opens in it, on the computer it runs on. Control
 * is new work, not for a held agent, and its holder is back: the grace of their control starts again.
 */
export async function reauthorizeStream(db: Database, stream: Stream, mode: DesktopMode) {
  const access = await streamAccess(db, { ...stream, request: { kind: "desktop", mode } });
  if ("refused" in access) return access;
  if (access.driven && access.driven !== stream.machineId) return refused(STREAM_CLOSE.forbidden, "forbidden");
  if (mode === "control") {
    if (await standingRefusal(db, stream.orgId, stream.agentId)) return refused(STREAM_CLOSE.refused, "held");
    if (access.control) await touchControl(db, access.control, stream.userId, new Date(), true).catch(() => {});
  }
  return null;
}

/**
 * The broker's `recheck`: the stream's close when its person lost it (`streamAccess`) or signed out (the
 * session it was opened with is gone or expired, read from the database); a control stream still open keeps
 * its holder's control alive (`touchControl`).
 */
export async function recheckStream(db: Database, stream: Stream) {
  if (stream.sessionToken) {
    const [alive] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.token, stream.sessionToken), gt(sessions.expiresAt, new Date())));
    if (!alive) return refused(STREAM_CLOSE.forbidden, "signed_out");
  }
  if (stream.request.kind === "phone") return recheckPhoneStream(db, stream);
  const access = await streamAccess(db, stream);
  if ("refused" in access) return access;
  if (access.control) await touchControl(db, access.control, stream.userId).catch(() => {});
  return null;
}

/**
 * The broker's `onClosed`: the audit, and a control stream's holder keeps control `CONTROL_GRACE_MS` from
 * now to come back (another stream of theirs keeps it longer).
 */
export async function streamClosed(db: Database, s: Stream) {
  if (s.request.kind === "desktop" && s.request.mode === "control") {
    const open = await openHandoffOn(db, s.orgId, s.agentId, "desktop", viewerSeat(s));
    if (open?.status === "active" && open.controllerUserId === s.userId) {
      await setControlDeadline(db, open.id, s.userId, new Date(Date.now() + CONTROL_GRACE_MS)).catch(() => {});
    }
  }
  await auditStream(db, s);
}

/**
 * In an audit row's details: the right hand's shared seat was opened, where every channel's work is, not the person's
 * own. `scope`: who the computer took the agent for, a seat's id only for the right hand.
 */
const sharedSeatDetail = (opened: { shared?: boolean; agentId: string; scope?: { id: string } | undefined }) =>
  opened.shared && opened.scope && opened.scope.id !== opened.agentId ? { seat: SHARED_SEAT } : {};

/** A stream that ran, in the org's audit log (ADR 0058 §12): who, which agent and computer, how long, how many bytes. */
export async function auditStream(db: Database, s: Stream) {
  if (s.request.kind === "phone") return auditPhoneStream(db, s);
  const action =
    s.request.kind === "terminal"
      ? "terminal.session"
      : s.request.mode === "control"
        ? "desktop.controlled"
        : "desktop.watched";
  await recordAudit(db, {
    orgId: s.orgId,
    actor: { type: "person", id: s.userId },
    action,
    target: { type: "agent", id: s.agentId },
    details: {
      machineId: s.machineId,
      seconds: Math.round((Date.now() - (s.readyAt ?? s.openedAt)) / 1000),
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      // A browser card's view of this screen (ADR 0058 §7): watch only.
      ...(s.preview ? { preview: true } : {}),
      ...sharedSeatDetail(s),
    },
  });
}

// ── The desktop's REST (`routes/app/desktop.ts`) ──────────────────────────────

export interface DesktopDeps {
  db: Database;
  hub?: MachineCaller;
  streams?: Pick<StreamBroker, "count">;
}

/** The REST reaches a computer through whichever server holds its socket (`hub.call`), unlike a stream. */
const ANYWHERE = { isLocal: () => true };
const NO_SCREEN = ["no_agent", "no_desktop", "no_computer", "no_home", "not_system", "not_allowed"];

/**
 * An agent's desktop as one person sees it: whether it can be shown and runs, who controls it, what they may
 * do. Not running is not "off": opening a stream starts it, and then it stays on (ADR 0058 §1).
 */
export interface DesktopStatus {
  /** Whether it can be shown now, else why (a stream's refusal reason: `not_allowed`, `offline`…). */
  available: boolean;
  reason: string | null;
  /** What the computer says it lacks (what to install). */
  detail: string | null;
  running: boolean;
  startedAt: string | null;
  /** Who is in control (of the desktop, or of the browser showing the same window), and that handoff. */
  controllerUserId: string | null;
  handoff: BrowserHandoffView | null;
  /** People watching it through this server. */
  viewers: number;
  /** This person may take control. */
  canControl: boolean;
  /** Why not (`driveRefusal`), so the apps can say it; null when they may. */
  controlRefusal: DriveRefusal | null;
  /** The agent is held, or its workspace on hold: people may watch, nobody takes control. */
  held: boolean;
  /** The agent's browser runs on this desktop (ADR 0058 §7): its browser card shows this screen. */
  browserOnDesktop: boolean;
}

/**
 * `GET …/agents/{agentId}/desktop`: for whoever may watch it. Who may see the agent's browser but whose roles don't
 * give them its whole computer gets a screen that can't be shown (`browser_only`), so the apps show the browser. The
 * apps ask it while a view of the computer is open: that keeps the workspace's own computer wanted, and wakes it from
 * standby (ADR 0161).
 */
export async function desktopStatus(
  deps: DesktopDeps,
  userId: string,
  orgId: string,
  agentId: string,
  /** The right hand's shared seat's, not this person's own. */
  shared = false,
): Promise<DesktopStatus> {
  const { db } = deps;
  if ((await screenAccess(db, userId, orgId, agentId, undefined, "desktop", shared)).refusal === "level") {
    await requireBrowserAccess(db, userId, orgId, agentId, undefined, "browser", shared);
    const served = await desktopTarget(db, ANYWHERE, orgId, agentId, "desktop", userId, undefined, false, shared);
    if ("machineId" in served) void deps.hub?.wake?.(served.machineId, "view").catch(() => {});
    // An agent with no screen to show isn't one whose browser alone they get.
    const none = "refused" in served && NO_SCREEN.includes(served.reason) ? served.reason : null;
    return {
      available: false,
      reason: none ?? "browser_only",
      detail: null,
      running: false,
      startedAt: null,
      controllerUserId: null,
      handoff: null,
      viewers: 0,
      canControl: false,
      controlRefusal: none ? null : "role",
      held: await standingRefusal(db, orgId, agentId).then((refusal) => refusal !== null),
      browserOnDesktop: false,
    };
  }
  await requireDesktopAccess(db, userId, orgId, agentId, shared);
  const [served, open, controlRefusal, held, onDesk] = await Promise.all([
    desktopTarget(db, ANYWHERE, orgId, agentId, "desktop", userId, undefined, false, shared),
    openHandoffOn(db, orgId, agentId, "desktop", viewerSeat({ userId, shared })),
    computerDriving(db, userId, orgId, agentId, shared).then(
      (d) => d.refusal,
      (): DriveRefusal => "not_allowed",
    ),
    standingRefusal(db, orgId, agentId).then((refusal) => refusal !== null),
    browserOnDesktop(db, orgId, agentId),
  ]);
  if ("machineId" in served) void deps.hub?.wake?.(served.machineId, "view").catch(() => {});
  const online = "machineId" in served && deps.hub ? (await deps.hub.status(served.machineId))?.online === true : false;
  const desktop: StreamTarget = "refused" in served || online ? served : refused(STREAM_CLOSE.unreachable, "offline");
  let running = false;
  let startedAt: string | null = null;
  // A seat not made yet has no screen running: nothing is asked of the computer for it.
  if ("machineId" in desktop && desktop.agent && deps.hub) {
    try {
      const reply = await deps.hub.call<"desktop.session.status">(
        desktop.machineId,
        { op: "desktop.session.status", agent: desktop.agent },
        { timeoutMs: 5_000 },
      );
      running = reply.running;
      startedAt = reply.startedAt ?? null;
    } catch {
      // Not known now: a stream finds out (and starts it).
    }
  }
  const reasonOf = (t: StreamTarget) => ("refused" in t ? t.reason : null);
  let detail: string | null = null;
  if (reasonOf(desktop) === "desktop_unavailable") {
    const [agent] = await db
      .select({ orgId: agents.orgId, machineId: agents.machineId, builtin: agents.builtin })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    const machineId = await toolMachineId(db, agent);
    const machine = machineId ? await getMachine(db, orgId, machineId) : null;
    detail = machine?.executors?.desktop?.reason?.slice(0, 500) ?? null;
  }
  return {
    available: "machineId" in desktop,
    reason: reasonOf(desktop),
    detail,
    running,
    startedAt,
    controllerUserId: open?.status === "active" ? open.controllerUserId : null,
    handoff: open ? await handoffViewFor(db, open) : null,
    viewers: deps.streams?.count(("machineId" in desktop && desktop.agent?.id) || agentId, "desktop") ?? 0,
    canControl: controlRefusal === null,
    controlRefusal,
    held,
    browserOnDesktop: "machineId" in desktop && onDesk,
  };
}

/** How long one capture answers everyone asking: however many ask, the computer takes at most one in this time. */
const PICTURE_TTL_MS = 4_000;
/** A picture counts as watching in the audit log, once per person and agent in this time. */
const PICTURE_AUDIT_MS = 3600_000;

export interface DesktopPicture {
  /** A JPEG, base64. */
  data: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface DesktopPictureView {
  picture: DesktopPicture | null;
  /** Why none: `stopped` (its screen isn't running), `hidden` (someone else is in control), `unavailable`. */
  reason: "stopped" | "hidden" | "unavailable" | null;
}

// ponytail: the agent's screen only, through `desktop.capture` (desktop use); a computer without screens, or a person
// with its browser alone, shows the live view's button instead. `browser.capture` boxes every element, for a judge.
// Few: a picture is hundreds of KB, and an expired one stays in memory until a newer one pushes it out.
const pictures = new TtlCache<DesktopPictureView>(PICTURE_TTL_MS, 64);
const capturing = new Map<string, Promise<DesktopPictureView>>();
const pictureAudits = new TtlCache<true>(PICTURE_AUDIT_MS);

/**
 * `GET …/agents/{agentId}/desktop/picture`: a recent picture of an agent's screen, for whoever may watch it now (a
 * watching stream's own check, so someone else in control hides it too). It never starts a screen: one that isn't
 * running answers `stopped`, and a capture marks a running one used, as a viewer keeps it from being parked.
 */
export async function desktopPicture(
  deps: DesktopDeps,
  userId: string,
  orgId: string,
  agentId: string,
  /** The right hand's shared seat's, not this person's own. */
  shared = false,
): Promise<DesktopPictureView> {
  const { db, hub } = deps;
  const access = await streamAccess(db, {
    userId,
    orgId,
    agentId,
    request: { kind: "desktop", mode: "watch" },
    shared,
  });
  if ("refused" in access) {
    if (access.reason === "someone_in_control") return { picture: null, reason: "hidden" };
    if (access.refused === STREAM_CLOSE.notFound) throw new NotFoundError("Agent not found");
    throw new ForbiddenError("You may not watch this agent's computer");
  }
  const served = await desktopTarget(db, ANYWHERE, orgId, agentId, "desktop", userId, undefined, false, shared);
  if ("refused" in served || !hub) return { picture: null, reason: "unavailable" };
  if (!served.agent) return { picture: null, reason: "stopped" };
  // By who the computer takes it for: each person's seat of the right hand has its own picture.
  const key = `${orgId}:${served.agent?.id ?? agentId}`;
  let view = pictures.get(key);
  if (!view) {
    // Those asking while a capture runs wait for it: the computer's queue is the agent's own too.
    let capture = capturing.get(key);
    if (!capture) {
      capture = capturePicture(hub, served)
        .then((taken) => {
          pictures.set(key, taken);
          return taken;
        })
        .finally(() => capturing.delete(key));
      capturing.set(key, capture);
    }
    view = await capture;
  }
  // Once an hour per person and screen: the shared seat's picture is another screen than the person's own seat's.
  const audited = `${userId}:${served.agent.id}`;
  const scopeDetail = sharedSeatDetail({ shared, agentId, scope: served.agent });
  if (view.picture && !pictureAudits.get(audited)) {
    pictureAudits.set(audited, true);
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "desktop.watched",
      target: { type: "agent", id: agentId },
      details: { machineId: served.machineId, picture: true, seconds: 0, ...scopeDetail },
    });
  }
  return view;
}

async function capturePicture(
  hub: MachineCaller,
  { machineId, agent }: Extract<StreamTarget, { machineId: string }>,
): Promise<DesktopPictureView> {
  try {
    const status = await hub.call<"desktop.session.status">(
      machineId,
      { op: "desktop.session.status", agent },
      { timeoutMs: 5_000 },
    );
    if (!status.running) return { picture: null, reason: "stopped" };
    const shot = await hub.call<"desktop.capture">(machineId, { op: "desktop.capture", agent }, { timeoutMs: 10_000 });
    const picture = {
      data: shot.data,
      width: shot.width,
      height: shot.height,
      capturedAt: new Date().toISOString(),
    };
    return { picture, reason: null };
  } catch {
    // The computer went away, paused, or doesn't serve desktop use: the apps offer the live screen instead.
    return { picture: null, reason: "unavailable" };
  }
}

// ── Control on this server ────────────────────────────────────────────────────

export interface DesktopControlDeps {
  db: Database;
  pubsub?: PubSub;
  hub: Pick<MachineHub, "call" | "isLocal">;
  streams: Pick<StreamBroker, "closeWhere" | "some" | "switchWhere" | "switches">;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * The desktops' side of handoffs on this server (ADR 0058 §5). When control
 * of an agent's desktop, or of the browser showing the same window, changes
 * hands (on any server), the streams here that may no longer show it close:
 * everyone else's while someone is in control (4409), and a control stream
 * whose holder lost control (4410). Their panels open again once it is handed
 * back. Where the viewer and the computer both can (ADR 0058 §17), the holder's
 * own streams change mode in place instead: those watching go on in control
 * when they take it, and theirs in control go on watching when it ends. It also
 * keeps the desktops of open handoffs from idling.
 */
export function createDesktopControl(deps: DesktopControlDeps) {
  /** Last keep-alive per open handoff. */
  const touched = new Map<string, number>();

  /**
   * `person`: on the right hand, whose seat's handoff changed (ADR 0175): only that person's streams of their own
   * seat show that screen, and with nobody named only the streams of its shared seat.
   */
  async function enforce(orgId: string, agentId: string, person: string | null) {
    const seats = await isRightHandId(deps.db, orgId, agentId);
    const ofAgent = (s: Stream) =>
      s.orgId === orgId &&
      s.agentId === agentId &&
      s.request.kind === "desktop" &&
      (person ? s.userId === person && !s.shared : !seats || s.shared === true);
    if (!deps.streams.some(ofAgent)) return;
    const open = await openHandoffOn(deps.db, orgId, agentId, "desktop", person ?? (seats ? SHARED_SEAT : null));
    const controller = open?.status === "active" ? open.controllerUserId : null;
    // The browser's holder drives the screen too where they may drive the computer (`streamAccess`).
    const onDesktop =
      controller &&
      (open?.screen === "desktop" || (await mayDriveComputer(deps.db, controller, orgId, agentId, !person)))
        ? controller
        : null;
    deps.streams.closeWhere(
      (s) => ofAgent(s) && controller !== null && s.userId !== controller,
      STREAM_CLOSE.hidden,
      "someone_in_control",
    );
    const mode = (s: Stream) => (s.request.kind === "desktop" ? s.request.mode : null);
    const ended = (s: Stream) => ofAgent(s) && mode(s) === "control" && s.userId !== onDesktop;
    deps.streams.switchWhere(ended, "watch");
    deps.streams.closeWhere((s) => ended(s) && !deps.streams.switches(s), STREAM_CLOSE.controlEnded, "control_ended");
    if (onDesktop) deps.streams.switchWhere((s) => ofAgent(s) && s.userId === onDesktop, "control");
  }

  const off = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    if (event.type !== "browser.handoff.changed") return;
    if (typeof event.orgId !== "string" || typeof event.agentId !== "string") return;
    const { orgId, agentId } = event;
    const person = typeof event.seatUserId === "string" ? event.seatUserId : null;
    void enforce(orgId, agentId, person).catch((error) =>
      deps.log?.warn("desktop control change failed", { agentId, error: String(error) }),
    );
  });

  return {
    /**
     * Keeps the desktops of open desktop handoffs running (worker, every
     * minute): a start every `HANDOFF_KEEPALIVE_MS` counts as use (and starts
     * one that stopped, after a reboot), so the runner never parks a desktop
     * a person was asked to work on (it parks only ones untouched for an hour).
     */
    async keepAlive(now = Date.now()) {
      const open = await deps.db
        .select({
          id: browserHandoffs.id,
          orgId: browserHandoffs.orgId,
          agentId: browserHandoffs.agentId,
          machineId: browserHandoffs.machineId,
          handle: agents.handle,
          name: agents.name,
          builtin: agents.builtin,
        })
        .from(browserHandoffs)
        .innerJoin(agents, eq(agents.id, browserHandoffs.agentId))
        .where(
          and(
            eq(browserHandoffs.screen, "desktop"),
            inArray(browserHandoffs.status, ["pending", "active"]),
            // A person's seat's desktop is started by that person opening it.
            isNull(browserHandoffs.seatUserId),
          ),
        );
      const ids = new Set(open.map((h) => h.id));
      for (const id of touched.keys()) if (!ids.has(id)) touched.delete(id);
      // Only computers held here (each server keeps its own).
      const due = open.filter(
        (h) => deps.hub.isLocal(h.machineId) && now - (touched.get(h.id) ?? 0) >= HANDOFF_KEEPALIVE_MS,
      );
      for (const h of due) touched.set(h.id, now);
      await Promise.all(
        due.map(async (h) => {
          // The right hand's own id reaches no computer (ADR 0175): a handoff of its with no person is its shared
          // seat's.
          const seat = isRightHand(h) ? await seatOf(deps.db, h.orgId, SHARED_SEAT, false) : null;
          if (isRightHand(h) && !seat) return;
          const agent = seat
            ? { id: seat.id, handle: h.handle, name: seatName(h.name, { userId: SHARED_SEAT, person: null }) }
            : { id: h.agentId, handle: h.handle, name: h.name };
          await deps.hub
            .call(h.machineId, { op: "desktop.session.start", agent }, { timeoutMs: 30_000 })
            .catch(() => {});
        }),
      );
      return due.length;
    },

    /** Stops hearing handoff changes (shutdown, tests). */
    close() {
      off?.();
    },
  };
}

export type DesktopControl = ReturnType<typeof createDesktopControl>;

// ── What the agent keeps running (ADR 0176) ───────────────────────────────────

export interface AgentHolds {
  holds: HoldView[];
  /** This person may stop them: who may use the agent's computer, and the admins of computers. */
  canStop: boolean;
}

/** Who may stop what the agent keeps running: whoever may use its computer as the agent, and computers' admins. */
async function mayStopHolds(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  return can(membership, "control_computers") || (await mayDriveComputer(db, userId, orgId, agentId));
}

/** `GET …/agents/{agentId}/holds`: for whoever may watch the agent's computer (its screen or its browser). */
export async function agentHoldsFor(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  agentId: string,
): Promise<AgentHolds> {
  const { db } = deps;
  if ((await screenAccess(db, userId, orgId, agentId, undefined, "desktop")).refusal) {
    await requireBrowserAccess(db, userId, orgId, agentId);
  }
  const [rows, canStop] = await Promise.all([
    agentHolds(deps, orgId, agentId),
    mayStopHolds(db, userId, orgId, agentId),
  ]);
  return { holds: rows.map(holdView), canStop };
}

/** `DELETE …/agents/{agentId}/holds/{holdId}`: a person's Stop, which ends the program (or closes the browser) too. */
export async function stopAgentHold(
  deps: { db: Database; pubsub?: PubSub; hub?: MachineCaller },
  userId: string,
  orgId: string,
  agentId: string,
  holdId: string,
): Promise<void> {
  const { db } = deps;
  if (!(await mayStopHolds(db, userId, orgId, agentId))) {
    throw new ForbiddenError(
      "Only people who may use this agent's computer, and admins, can stop what it keeps running",
    );
  }
  const row = await liveHold(deps, orgId, agentId, holdId);
  if (!row) throw new NotFoundError("Nothing of this agent's runs under that hold now");
  const hub = deps.hub;
  await releaseHold(
    {
      db,
      ...(deps.pubsub ? { pubsub: deps.pubsub } : {}),
      call: (machineId, request) => {
        if (!hub) throw new NotFoundError("Connected computers are not available on this server");
        return hub.call(machineId, request);
      },
    },
    row,
    { reason: "stopped_by_person", userId },
  );
}
