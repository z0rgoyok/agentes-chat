import { type ImportItemResult, keys, type MigrationBundle, useAgents, useApi } from "@agenteschat/client";
import {
  agentsSince,
  applyInChunks,
  blockedItems,
  bundleOrigin,
  choosable,
  githubRoot,
  type ImportCard,
  type ImportFailure,
  type ImportMethod,
  isGithubLink,
  itemId,
  NOT_GITHUB,
  picksOf,
} from "@agenteschat/client/lib/import/flow";
import { type ImportFile, parseImport } from "@agenteschat/client/lib/import/index";
import { PASTED } from "@agenteschat/client/lib/import/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMeId } from "../shared/hooks";
import { planIn } from "./import";
import { pickStore } from "./pick-store";

/** What the phone reads: picked files (already text), a GitHub link, or a pasted reply. */
export type PhoneImportInput = { files: ImportFile[] | Promise<ImportFile[]> } | { url: string } | { text: string };

/** What an import shows while its screens are open: the source, the read, the plan and the picks. */
interface ImportSession {
  card: ImportCard | null;
  busy: "reading" | "planning" | null;
  failure: ImportFailure | null;
  plan: {
    orgId: string;
    bundle: MigrationBundle;
    items: ImportItemResult[];
    from: ImportFailure["from"];
  } | null;
  applyError: unknown;
  pick: ReadonlySet<string>;
  progress: { done: number; total: number } | null;
  /** Connect with MCP or Prompt only, per source, once the person picks one (until then, the source's default). */
  methods: Partial<Record<ImportCard, ImportMethod>>;
  watching: boolean;
  /** The workspace's agents as read after a source's MCP steps first showed: only the ones made since then arrived. */
  seen: ReadonlySet<string> | null;
}

const EMPTY: ImportSession = {
  card: null,
  busy: null,
  failure: null,
  plan: null,
  applyError: null,
  pick: new Set(),
  progress: null,
  methods: {},
  watching: false,
  seen: null,
};

/**
 * The import is two screens (where from, then what the read found), so its state lives here while they show, as a
 * picker's choice does: the first screen opens it and closes it when it goes away. What finishes after that (a read, an
 * apply) changes nothing, since `update` only writes into an open session.
 */
const store = pickStore<ImportSession>();
/** What a read and an apply keep between their steps, never drawn: the read that counts, the items done, the input. */
const work = { run: 0, done: new Map<string, ImportItemResult>(), last: null as PhoneImportInput | null, since: 0 };

const patch = (change: Partial<ImportSession> | ((now: ImportSession) => Partial<ImportSession>)) =>
  store.update((now) => ({ ...now, ...(typeof change === "function" ? change(now) : change) }));

let sessionId = 0;

/** The import's first screen opens a session of its own: what an earlier visit read is gone. */
export function openAgentImport(): number {
  sessionId += 1;
  work.run += 1;
  work.done = new Map();
  work.last = null;
  store.open(EMPTY);
  return sessionId;
}

/** Its first screen went away: its session ends (one opened since, by a screen still sliding in, stays). */
export function closeAgentImport(id: number) {
  if (id !== sessionId) return;
  work.run += 1;
  store.close();
}

/** The open session, if any (a screen opened on its own finds none). */
export const agentImportNow = (): ImportSession | null => store.now();

/** Back from what the read found to where it comes from: the plan goes, a read still running is dropped. */
export function resetAgentImport() {
  work.run += 1;
  work.done = new Map();
  patch({ busy: null, failure: null, applyError: null, plan: null, seen: null });
}

/**
 * The web's import flow (`useImportFlow`) for the phone's import screens: read into a bundle, plan it on the server (a
 * dry run), the person picks, apply in chunks. Nothing is written before `apply`. Both screens read the same session.
 */
export function useAgentImport(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const session = useSyncExternalStore(store.subscribe, store.now) ?? EMPTY;
  const { card, busy, failure, plan, applyError, pick, progress, methods, watching, seen } = session;
  const planned = planIn(plan, orgId);
  const me = useMeId();
  const agents = useAgents(orgId);
  // From a read that ended after watching started: the cache may miss an agent made while the socket was down.
  const fresh = watching && !agents.isFetching && agents.dataUpdatedAt >= work.since ? agents.data : undefined;
  useEffect(() => {
    if (!seen && fresh) patch({ seen: new Set(fresh.map((a) => a.id)) });
  }, [seen, fresh]);
  const arrived = seen && me && agents.data ? agentsSince(agents.data, seen, me) : [];
  const { refetch } = agents;
  /** Watches for the agents an AI app creates through MCP (`arrived`) until the returned stop. */
  const watch = useCallback(() => {
    work.since = Date.now();
    patch({ watching: true });
    void refetch();
    return () => patch({ watching: false });
  }, [refetch]);
  const setCard = (next: ImportCard | null) =>
    patch((now) => ({ card: next, ...(next !== now.card ? { seen: null } : {}) }));

  const read = async (input: PhoneImportInput) => {
    work.run += 1;
    const mine = work.run;
    const current = () => mine === work.run;
    const from: ImportFailure["from"] = "url" in input ? "link" : "text" in input ? "paste" : "files";
    let step: ImportFailure["step"] = "read";
    work.last = input;
    patch({ failure: null, busy: "reading" });
    try {
      let files: ImportFile[];
      let root: string | null = null;
      if ("url" in input) {
        if (!isGithubLink(input.url)) throw NOT_GITHUB;
        const res = await api.agents.importFromGithub(orgId, input.url);
        files = res.files.map((f) => ({ name: f.path, text: f.text }));
        root = githubRoot(input.url);
      } else if ("text" in input) {
        files = [{ name: PASTED, text: input.text }];
      } else {
        files = await input.files;
      }
      if (!current()) return;
      step = "plan";
      const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
      step = "parse";
      const bundle = parseImport(files, { models: list.models.map((m) => m.id), root });
      if (!current()) return;
      step = "plan";
      patch({ busy: "planning" });
      const dry = await api.imports.apply(orgId, { bundle, dryRun: true });
      if (!current()) return;
      work.done = new Map();
      const origin = bundleOrigin(bundle).card;
      patch((now) => ({
        plan: { orgId, bundle, items: dry.items, from },
        pick: new Set(dry.items.filter(choosable).map(itemId)),
        card: origin,
        ...(origin !== now.card ? { seen: null } : {}),
      }));
    } catch (cause) {
      if (current()) patch({ failure: { from, step, cause } });
    } finally {
      if (current()) patch({ busy: null });
    }
  };

  const blocked = planned ? blockedItems(planned.bundle, planned.items, pick) : new Map();
  const picks = planned ? picksOf(planned.items, pick, blocked) : [];

  /** Applies what is picked. `null`: it failed (`applyError`). */
  const apply = async (): Promise<ImportItemResult[] | null> => {
    if (!planned || picks.length === 0) return [];
    patch({ applyError: null, progress: { done: 0, total: picks.length } });
    try {
      return await applyInChunks(api, planned.orgId, { bundle: planned.bundle, pick: picks }, work.done, (n) =>
        patch({ progress: { done: n, total: picks.length } }),
      );
    } catch (e) {
      patch({ applyError: e });
      return null;
    } finally {
      patch({ progress: null });
      void qc.invalidateQueries({ queryKey: keys.org(planned.orgId) });
    }
  };

  return {
    card,
    setCard,
    methods,
    setMethod: (c: ImportCard, method: ImportMethod) =>
      patch((now) => ({ failure: null, methods: { ...now.methods, [c]: method } })),
    watch,
    arrived,
    /** The read the MCP step counts from failed: nothing can show as arrived until `refetch` works. */
    watchError: watching && !seen && agents.isError && !agents.isFetching ? agents.error : null,
    rewatch: () => void refetch(),
    busy,
    failure,
    planned,
    applyError,
    blocked,
    picks,
    progress,
    read,
    apply,
    retry: () => (work.last ? read(work.last) : Promise.resolve()),
    /** Stops waiting for a read: what it finds is dropped. */
    cancel: () => {
      work.run += 1;
      patch({ busy: null });
    },
    toggle: (ids: readonly string[], on: boolean) =>
      patch((now) => {
        const next = new Set(now.pick);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return { pick: next };
      }),
  };
}

export type AgentImport = ReturnType<typeof useAgentImport>;
