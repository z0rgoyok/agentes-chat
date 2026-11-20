import {
  type SidebarPins,
  useAgentGroups,
  useChannels,
  useDms,
  useSetSidebarView,
  useSidebarView,
} from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayOnePins, type PinKind, pinsOf, togglePin } from "@agenteschat/client/lib/sidebar-view";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";

/** Whether two pin sets hold the same ids in the same order. */
const samePins = (a: SidebarPins, b: SidebarPins) =>
  (["agents", "channels", "people"] as const).every(
    (kind) => a[kind].length === b[kind].length && a[kind].every((id, i) => id === b[kind][i]),
  );

/**
 * "Fixar no topo", the web sidebar's pins on the phone: the same per-person pins (`…/me/sidebar/view`), on Conversas'
 * strip (`PinnedStrip`) and on top of Agentes' Livres. Day one, the person's own agents. The same object while the
 * pins stay the same, so what is memoized on them holds.
 */
export function usePins(): {
  pins: SidebarPins;
  /** The person chose these pins (false: day one's default, the agents they made, nothing they did). */
  chosen: boolean;
  isPinned: (kind: PinKind, id: string) => boolean;
  toggle: (kind: PinKind, id: string) => void;
} {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const toast = useToast();
  const dir = useDirectory();
  const dms = useDms(orgId).data;
  const groups = useAgentGroups(orgId).data;
  const channels = useChannels(orgId).data;
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const kept = useRef<SidebarPins | null>(null);
  const shown = useMemo(() => {
    const lastActive = new Map<string, string>();
    for (const d of dms ?? [])
      if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
    const listed = dir.agents.filter((a) => listsAgent(org, a));
    const dayOne = meId
      ? dayOnePins(
          listed.filter((a) => !isRightHand(a)),
          meId,
          lastActive,
          groups,
        )
      : [];
    // A pin of something no longer in these lists holds no place.
    const known = {
      agents: listed.map((a) => a.id),
      channels: channels?.filter((c) => c.isMember).map((c) => c.id),
      people: [...dir.memberById.keys()],
    };
    const next = pinsOf(view, dayOne, known);
    // A DM's new message reorders day one's candidates without changing the pins: the pins of before stay.
    const pins = kept.current && samePins(kept.current, next) ? kept.current : next;
    kept.current = pins;
    return { pins, dayOne, known };
  }, [dms, dir.agents, dir.memberById, org, meId, groups, channels, view]);
  // `toggle` reads the latest of these: one function for every render.
  const latest = useRef({ shown, setView, t, toast });
  latest.current = { shown, setView, t, toast };
  const toggle = useCallback((kind: PinKind, id: string) => {
    const at = latest.current;
    if (!togglePin(at.shown.pins, kind, id)) {
      at.toast({ title: at.t(`sidebarPins.full.${kind}`), icon: "pin" });
      return;
    }
    at.setView((now) => {
      const from = pinsOf(now, at.shown.dayOne, at.shown.known);
      return { ...now, pins: togglePin(from, kind, id) ?? from };
    });
  }, []);
  const chosen = view.pins != null;
  return useMemo(
    () => ({
      pins: shown.pins,
      chosen,
      isPinned: (kind: PinKind, id: string) => shown.pins[kind].includes(id),
      toggle,
    }),
    [shown.pins, chosen, toggle],
  );
}
