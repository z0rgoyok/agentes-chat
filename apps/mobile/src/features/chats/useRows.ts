import { useChannels } from "@agenteschat/client";
import { WORK_TICK_MS } from "@agenteschat/client/lib/agent-work";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useDirectory, useNow, useOrgId, useWhen } from "../shared/hooks";
import { useConversations } from "../shared/queries";
import { usePresenceOf } from "../status/hooks";
import type { ConversationRow } from "./logic";
import type { AgentRowState } from "./now";
import { type RowContext, type RowFacts, reuseByKey, rowFacts, samePlain } from "./rowFacts";

/**
 * The lists of conversations as their screens draw them: rows kept by key while nothing in them changes, and what each
 * says worked out once per screen (`useRowFacts`), so a row's memoized drawing redraws only when its own changed.
 */

/** `rows` with the objects of the last time wherever nothing in a row changed. */
export function useStableRows(rows: ConversationRow[]): ConversationRow[] {
  const before = useRef<ReadonlyMap<string, ConversationRow>>(new Map());
  return useMemo(() => {
    const next = reuseByKey(before.current, rows);
    before.current = next.byKey;
    return next.list;
  }, [rows]);
}

/** Conversas' rows (`useConversations`), each kept while nothing in it changes. */
export function useConversationRows() {
  const list = useConversations();
  const rows = useStableRows(list.rows);
  return { ...list, rows };
}

/**
 * What each row says (`rowFacts`), from what the screen reads once for all of them: who everyone is, their presence and
 * work, the channels' names and one clock ticking once a minute for the whole list. A row's facts are the same object
 * while nothing in them changes.
 */
export function useRowFacts(): (row: ConversationRow, agent?: AgentRowState) => RowFacts {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const presence = usePresenceOf();
  const channels = useChannels(useOrgId()).data;
  const { org } = useOrg();
  const when = useWhen();
  const now = useNow(WORK_TICK_MS);
  const ctx = useMemo<RowContext>(() => {
    const names = new Map((channels ?? []).map((c) => [c.id, c.name]));
    return {
      t,
      locale: i18n.language,
      now,
      dir,
      presence,
      channelName: (id) => names.get(id),
      org,
      short: when.short,
    };
  }, [t, i18n.language, now, dir, presence, channels, org, when]);
  const kept = useRef(new Map<string, RowFacts>());
  return useCallback(
    (row: ConversationRow, agent?: AgentRowState) => {
      const next = rowFacts(row, agent, ctx);
      const old = kept.current.get(row.key);
      if (old && samePlain(old, next)) return old;
      kept.current.set(row.key, next);
      return next;
    },
    [ctx],
  );
}
