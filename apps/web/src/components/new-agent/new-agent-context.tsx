import { can } from "@agenteschat/client/lib/permissions";
import { type AgentAppearance, Button } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { lazyDialog } from "@/lib/lazy-dialog";
import { NEW_AGENT_EVENT } from "./events";
import type { Draft, Pick } from "./NewAgentDialog";
import type { ProposalReview } from "./ProposalReview";

/*
 * "Criar agente" as the workspace's shell holds it (ADR 0164): the request, its provider, the buttons that open it and
 * the way back from connecting an app. The dialog itself (`NewAgentDialog.tsx`, with the catalog of apps and the
 * mailbox and database steps) comes when it opens.
 */

const LazyNewAgentDialog = lazyDialog(() => import("./NewAgentDialog").then((m) => m.NewAgentDialog));
const LazyAgentFlight = lazyDialog(() => import("./NewAgentDialog").then((m) => m.AgentFlight));

type Look = Required<AgentAppearance>;

export interface NewAgentRequest {
  /** A channel's "Criar agente": it starts in that channel too. */
  channelId?: string | null;
  /** Back from connecting an app elsewhere (OAuth): the card as it was, and the app that just connected. */
  resume?: { sel: Pick; drafts: Partial<Record<Pick, Draft>>; connected: string | null };
  /** A plan account of the person's own just connected ("Criar um agente com este plano"): it thinks with that one. */
  accountId?: string;
  /** "Edit first" on an agent's proposal (ADR 0081): its card filled in with the draft, the proposal beside it. */
  proposal?: ProposalReview;
}

/**
 * Connecting an app from the card may sign in on the provider's page, which reloads the app: the card waits here for
 * the way back (`?newAgent=resume`, plus the server's `?connected=`), for an hour, in this tab only.
 */
const RESUME_KEY = "agentes:new-agent";
export const RESUME_PARAM = "newAgent";
const RESUME_TTL = 60 * 60 * 1000;
interface Saved {
  org: string;
  at: number;
  channelId: string | null;
  sel: Pick;
  drafts: Partial<Record<Pick, Draft>>;
  /** The app being connected (catalog id). */
  pending: string;
  /** The proposal being reviewed, if it was one. */
  proposal?: ProposalReview | null;
}

export function saveForReturn(saved: Omit<Saved, "at">) {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...saved, at: Date.now() }));
  } catch {
    // No storage (a private window): back from the provider the card starts over.
  }
}

export function forgetReturn() {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    // Nothing kept.
  }
}

/** The card to reopen when this page is the way back from connecting one of its apps; takes its parameters out. */
function takeResume(orgId: string): NewAgentRequest | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (url.searchParams.get(RESUME_PARAM) !== "resume") return null;
  const connected = url.searchParams.get("connected");
  for (const param of [RESUME_PARAM, "connected", "outcome"]) url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null") as Saved | null;
  } catch {
    saved = null;
  }
  forgetReturn();
  if (!saved || saved.org !== orgId || Date.now() - saved.at > RESUME_TTL) return null;
  return {
    channelId: saved.channelId,
    resume: { sel: saved.sel, drafts: saved.drafts, connected: connected === saved.pending ? connected : null },
    ...(saved.proposal ? { proposal: saved.proposal } : {}),
  };
}

export interface Flight {
  agentId: string;
  look: Look;
  from: DOMRect;
}

const NewAgentContext = createContext<{ open: (request?: NewAgentRequest) => void } | null>(null);

/** Opens the new agent's dialog. Null outside the workspace shell (an isolated page in a test). */
export const useNewAgent = () => useContext(NewAgentContext);

/** The dialog for the whole workspace (the sidebar, the pages and the menus open it), and the new agent's flight. */
export function NewAgentProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const [request, setRequest] = useState<(NewAgentRequest & { n: number }) | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const open = useCallback(
    (next?: NewAgentRequest) => {
      // Who may not create agents gets the page's own words about it.
      if (!can(org, "create_agents")) {
        void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } });
        return;
      }
      setRequest((current) => ({ ...(next ?? {}), n: (current?.n ?? 0) + 1 }));
    },
    [org, navigate],
  );
  const value = useMemo(() => ({ open }), [open]);
  useEffect(() => {
    const onAsk = (e: Event) => open((e as CustomEvent<NewAgentRequest | null>).detail ?? undefined);
    window.addEventListener(NEW_AGENT_EVENT, onAsk);
    return () => window.removeEventListener(NEW_AGENT_EVENT, onAsk);
  }, [open]);
  // Back from connecting one of the card's apps on the provider's page: the card as it was.
  useEffect(() => {
    const back = takeResume(org.id);
    if (back) setRequest({ ...back, n: 1 });
  }, [org.id]);
  return (
    <NewAgentContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        {request && (
          <LazyNewAgentDialog
            key={request.n}
            request={request}
            onClose={() => setRequest(null)}
            onCreated={(f) => {
              setRequest(null);
              if (f) setFlight(f);
            }}
          />
        )}
        {flight && <LazyAgentFlight flight={flight} onDone={() => setFlight(null)} />}
      </Suspense>
    </NewAgentContext.Provider>
  );
}

/** Opens the new agent's dialog; outside the shell (a test's page), the full form. */
function useOpenNewAgent() {
  const { org } = useOrg();
  const navigate = useNavigate();
  const dialog = useNewAgent();
  return (request?: NewAgentRequest) =>
    dialog ? dialog.open(request) : void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } });
}

/** "Criar agente" on a page (Equipe, the agents' access): the new agent's dialog (ADR 0164). */
export function CreateAgentButton() {
  const { t } = useTranslation();
  const open = useOpenNewAgent();
  return (
    <Button variant="primary" icon="plus" onClick={() => open()}>
      {t("shell.createAgent")}
    </Button>
  );
}

/** "Criar agente" as a link beside a heading (Membros). */
export function CreateAgentLink() {
  const { t } = useTranslation();
  const open = useOpenNewAgent();
  return (
    <button type="button" className="ac-link" onClick={() => open()}>
      {t("shell.createAgent")}
    </button>
  );
}
