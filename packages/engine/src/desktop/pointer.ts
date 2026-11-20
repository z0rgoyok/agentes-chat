import type { AgentPointer, RunnerFrame } from "@agenteschat/adapters";
import { type Stream, screenOf } from "../streams";

/** Screens a computer keeps a last pointer for: it names them itself, so only its newest few are kept. */
const SCREENS_PER_COMPUTER = 64;

/**
 * A person with a screen open, and the agent they opened it for (the right hand's seat is shown under its agent);
 * `shared`: the right hand's shared seat (ADR 0175), which a person may have open beside their own.
 */
export interface DesktopPointerViewer {
  orgId: string;
  userId: string;
  agentId: string;
  shared?: true;
}

/** The user event the apps draw the agent's cursor from; `replay` marks the last one, sent as a view opens. */
export type DesktopPointerEvent = {
  type: "agent.desktop.pointer";
  agentId: string;
  shared?: true;
  pointer: AgentPointer & { replay?: true };
};

const eventFor = (viewer: DesktopPointerViewer, pointer: DesktopPointerEvent["pointer"]): DesktopPointerEvent => ({
  type: "agent.desktop.pointer",
  agentId: viewer.agentId,
  ...(viewer.shared ? { shared: true } : {}),
  pointer,
});

/**
 * The agent's pointer on its desktop (ADR 0062): each report to who has that screen open now, and the newest one per
 * screen kept in memory where its computer's socket is, sent once to a person whose view of it opens. A screen is
 * the agent's, or a seat of the right hand (ADR 0175), by the id its computer says it under. Forgotten when the
 * server stops that desktop or the computer's socket closes here; never written anywhere.
 */
export function createDesktopPointers(deps: {
  viewers(screenId: string, machineId: string): DesktopPointerViewer[];
  send(viewer: DesktopPointerViewer, event: DesktopPointerEvent): void;
}) {
  const last = new Map<string, Map<string, AgentPointer>>();
  return {
    report(
      machineId: string,
      { type: _type, agentId: screenId, ...pointer }: Extract<RunnerFrame, { type: "desktop.pointer" }>,
    ) {
      const screens = last.get(machineId) ?? new Map<string, AgentPointer>();
      last.set(machineId, screens);
      screens.delete(screenId);
      screens.set(screenId, pointer);
      const oldest = screens.keys().next().value;
      if (screens.size > SCREENS_PER_COMPUTER && oldest !== undefined) screens.delete(oldest);
      for (const viewer of deps.viewers(screenId, machineId)) deps.send(viewer, eventFor(viewer, pointer));
    },

    /** A person's stream of a screen opened (or changed mode): where the agent's pointer rests on it. */
    opened(stream: Pick<Stream, "orgId" | "userId" | "agentId" | "scope" | "machineId" | "request" | "shared">) {
      if (stream.request.kind !== "desktop" || !stream.machineId) return;
      const kept = last.get(stream.machineId)?.get(screenOf(stream));
      if (!kept) return;
      const { orgId, userId, agentId } = stream;
      const viewer = { orgId, userId, agentId, ...(stream.shared ? { shared: true as const } : {}) };
      deps.send(viewer, eventFor(viewer, { ...kept, replay: true }));
    },

    /** The server stopped that desktop: a new one starts with no pointer on it. */
    stopped(machineId: string, screenId: string) {
      last.get(machineId)?.delete(screenId);
    },

    /** The computer's socket closed here: its screens' pointers are forgotten. */
    closed(machineId: string) {
      last.delete(machineId);
    },
  };
}

export type DesktopPointers = ReturnType<typeof createDesktopPointers>;
