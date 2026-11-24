import {
  type Approval,
  applyCodeSessionEvent,
  applyComputerEvent,
  applyDashboardEvent,
  applyIssueEvent,
  applyLiveEvent,
  applyMachineEvent,
  applyNotificationEvent,
  applyUnreadEvent,
  applyWorkspaceEvent,
  cacheApproval,
  isNotificationEvent,
  keys,
  readConversationListsNow,
  refreshMission,
  refreshProposals,
  type ThreadFollowEvent,
  type ThreadInfo,
} from "@agenteschat/client";
import { playSound, soundForEvent } from "@agenteschat/client/lib/sounds";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { countReconnect } from "@/lib/perf";
import { feedIsland, island } from "../island/island";
import { useConnection, useOrgId } from "./hooks";

/**
 * Events for the signed-in person, whatever screen is open: requests they
 * can decide, the inbox and its badge, missions waiting on them, computers going offline or back. Keeps
 * Início, Atividade and the tab badges live, and "Seguir" in step across
 * devices.
 */
export function useUserEvents() {
  const connection = useConnection();
  const orgId = useOrgId();
  const qc = useQueryClient();
  useEffect(() => {
    if (!connection) return;
    const offUser = connection.onUserEvent((event) => {
      if ((event.type === "approval.created" || event.type === "approval.decided") && "approval" in event) {
        cacheApproval(qc, orgId, event.approval as Approval);
        void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
      }
      if (isNotificationEvent(event)) {
        applyNotificationEvent(qc, orgId, event);
        // The island at the top (ADR 0071 §9): what reaches me while the app is open, and what I settled elsewhere.
        feedIsland(event);
        // Something new reached you somewhere: the conversation list's unread and last lines, at once, unless its
        // message's `channel.activity` already put them in. A fetch under way serves a burst (the undo of "Clear all"
        // restores row by row); a new one stands for the burst read the message's own `channel.activity` queued.
        if (event.type === "notification.upserted") {
          readConversationListsNow(qc, orgId, event.notification.source.messageId);
          // Its sound (ADR 0070); the push covers the app in the background.
          const sound = soundForEvent(event, AppState.currentState !== "active");
          if (sound) playSound(sound);
        }
      }
      // Unread marks: a message where you are, and your reads and mutes from any device.
      applyUnreadEvent(qc, orgId, event);
      // "Seguir" changed on one of your devices.
      if (event.type === "thread.follow" && "threadId" in event) {
        const follow = event as ThreadFollowEvent;
        qc.setQueryData<ThreadInfo>(keys.threadInfo(orgId, follow.threadId), (t) =>
          t ? { ...t, following: follow.following } : t,
        );
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      }
      // Org events about the computers, as on the web: one went offline or came back (and the agents waiting for
      // it, "Computador desconectado"), paused, renamed, removed, its agents moved; an agent switched computers.
      applyMachineEvent(qc, orgId, event);
      applyComputerEvent(qc, orgId, event);
      // A device, a phone's state or holder, or a request to join changed: the devices list (it names no computer).
      if (event.type === "devices.changed") void qc.invalidateQueries({ queryKey: keys.devices(orgId) });
      // The workspace's standing (the suspended screen comes and goes), its own computer on its way, the groups of
      // agents (Agentes' sections), and the lists anyone may have open (Drive, Wiki, calendar, routines, memory).
      applyWorkspaceEvent(qc, orgId, event);
      // Dashboards and widgets (ADR 0135): a board changed, a widget updated, failed or was removed.
      applyDashboardEvent(qc, orgId, event);
      // Who is in a Drive file now (ADR 0196 §5): the cards showing it ask again.
      applyLiveEvent(qc, orgId, event);
      // Org event: someone changed the task board's columns or projects. Deleting a column moves its tasks and
      // a project's name is on its cards, so the tasks refresh too (both live under the same key).
      if (event.type === "issue.columns" || event.type === "issue.projects")
        void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
      applyIssueEvent(qc, orgId, event);
      // A code session I'm in changed (ADR 0215): its worktree, name or pull request.
      applyCodeSessionEvent(qc, orgId, event);
      // A change I asked the right hand for was decided by someone else (ADR 0137): "Aplicado por …" on my card.
      if (event.type === "proposal.created") void refreshProposals(qc, orgId);
      if (event.type === "proposal.decided") {
        void refreshProposals(qc, orgId);
        void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      }
      if (event.type.startsWith("mission.") && "missionId" in event && typeof event.missionId === "string")
        refreshMission(qc, orgId, event.missionId);
    });
    // Missed while offline (the inbox, the requests, the standing, the computers, the lists): `RealtimeProvider` reads
    // everything again on a reconnect; reading them here too would only start those reads over. Counted for the app's
    // vitals.
    const offReconnect = connection.onReconnect(countReconnect);
    return () => {
      offUser();
      offReconnect();
      // In the background, or another workspace: its notices go (the inbox keeps them).
      island.clear();
    };
  }, [connection, orgId, qc]);
}
