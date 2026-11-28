import {
  createSpeechEngine,
  type KeyWrapper,
  SPEECH_PROVIDERS,
  type SpeechCredentials,
  type SpeechEngine,
  SpeechError,
  type SpeechFetch,
  type SpeechProviderId,
  silentWav,
} from "@agenteschat/adapters";
import { and, type Database, eq, schema } from "@agenteschat/db";
import { openSecret, sealSecret } from "./crypto";
import { ValidationError } from "./errors";
import { pinnedOwner } from "./organizations";
import type { LocalSpeech } from "./speech-local";

const { instanceSecrets, organizationMembers, users } = schema;

/**
 * Which engines turn voice into text on this server (ADR 0100). The environment sets them on agentes.chat's servers
 * and may on any other; there, the installation's owner can also pick a provider and paste its key in Settings, kept
 * like the Jev key (ADR 0073): sealed, tried before it is kept, never returned. Read again behind a call once a minute
 * old, so a second replica sees a change, as the GIF key does.
 */
export interface SpeechKeyView {
  provider: SpeechProviderId | null;
  /** The key's last 4 characters, or the server's address. The key itself never leaves the server. */
  hint: string | null;
  /** `invalid`: a saved key that doesn't open on this server (another `AGENTES_SECRET`). */
  state: "off" | "ok" | "invalid";
  /** Engines set in this server's environment; they stay behind the saved one. */
  envProviders: SpeechProviderId[];
}

/**
 * Whether voice becomes text on this server: `ready` (an engine answers), `installing` (one is on its way here),
 * `failed` (the one set up here stopped and needs its owner) or `none`. Recording works in every state; without
 * `ready` a note goes as audio people play.
 */
export const SPEECH_STATES = ["ready", "installing", "none", "failed"] as const;
export type SpeechState = (typeof SPEECH_STATES)[number];

export interface SpeechSettings {
  ready(): Promise<void>;
  /** The engines to try, in order. */
  chain(): SpeechEngine[];
  available(): boolean;
  state(): SpeechState;
  view(): Promise<SpeechKeyView>;
  save(input: { provider: SpeechProviderId } & SpeechCredentials, userId: string): Promise<SpeechKeyView>;
  remove(): Promise<SpeechKeyView>;
}

const NAME = "speech";
const AAD = `instance-secret|${NAME}`;
const REREAD_MS = 60_000;

const invalid = (message: string) => new ValidationError(message, "speech_key_invalid");

/** The engines the environment sets, in the order it asks for. */
export function envSpeechEngines(
  order: string | undefined,
  credentials: Partial<Record<SpeechProviderId, SpeechCredentials>>,
  options: { fetch?: SpeechFetch } = {},
): SpeechEngine[] {
  const asked = order?.trim() ? order.split(",").map((id) => id.trim()) : [...SPEECH_PROVIDERS];
  return asked.flatMap((id) => {
    if (!(SPEECH_PROVIDERS as readonly string[]).includes(id)) return [];
    const provider = id as SpeechProviderId;
    const engine = createSpeechEngine(provider, credentials[provider] ?? {}, options);
    return engine ? [engine] : [];
  });
}

export function createSpeechSettings(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  envEngines: SpeechEngine[];
  /** agentes.chat's own servers read only the environment. */
  envOnly?: boolean;
  /** The helper on this computer, once its owner set it up (`speech-local.ts`). */
  local?: LocalSpeech | null;
  fetch?: SpeechFetch;
  now?: () => number;
}): SpeechSettings {
  const now = deps.now ?? Date.now;
  type Saved = { provider: SpeechProviderId; engine: SpeechEngine | null; hint: string; at: number };
  let saved: Saved | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;

  async function read() {
    const [row] = await deps.db.select().from(instanceSecrets).where(eq(instanceSecrets.name, NAME));
    readAt = now();
    if (!row) {
      saved = null;
      return;
    }
    const at = row.updatedAt.getTime();
    if (saved?.at === at) return;
    const stored = await openSecret(deps.keyWrappers, row, AAD)
      .then((text) => JSON.parse(text) as { provider: SpeechProviderId } & SpeechCredentials)
      .catch(() => null);
    saved = {
      provider: stored?.provider ?? "local",
      engine: stored ? createSpeechEngine(stored.provider, stored, { fetch: deps.fetch }) : null,
      hint: row.keyHint,
      at,
    };
  }
  const refresh = () => {
    if (deps.envOnly || now() - readAt < REREAD_MS) return Promise.resolve();
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  };
  const initial = refresh();
  initial.catch(() => {});

  const chain = () => {
    refresh().catch(() => {});
    const own = saved?.engine ?? null;
    const here = deps.local?.engine() ?? null;
    const first = [here, own].filter((e): e is SpeechEngine => e !== null);
    // The owner's own choices first, the helper on this computer before a key; the environment's `local` steps aside
    // for the helper's.
    return first.length
      ? [...first, ...deps.envEngines.filter((e) => !first.some((f) => f.id === e.id))]
      : deps.envEngines;
  };
  const snapshot = (): SpeechKeyView => ({
    provider: saved?.provider ?? null,
    hint: saved?.hint ?? null,
    state: !saved ? "off" : saved.engine ? "ok" : "invalid",
    envProviders: deps.envEngines.map((e) => e.id),
  });

  return {
    ready: () => initial,
    chain,
    available: () => chain().length > 0,
    state: () => {
      if (chain().length > 0) return "ready";
      const here = deps.local?.status().state;
      return here === "downloading" || here === "starting" ? "installing" : here === "failed" ? "failed" : "none";
    },
    async view() {
      await refresh();
      return snapshot();
    },
    async save(input, userId) {
      const { provider, apiKey, baseUrl, model } = input;
      const credentials = { apiKey: apiKey?.trim() || undefined, baseUrl: baseUrl?.trim() || undefined, model };
      const engine = createSpeechEngine(provider, credentials, { fetch: deps.fetch });
      if (!engine) throw invalid("This provider needs its key or address.");
      // A second of silence: a provider that refuses the key says so here, and it is never kept.
      try {
        await engine.file({ audio: silentWav(), contentType: "audio/wav", language: "pt", terms: [] });
      } catch (error) {
        const reason = error instanceof SpeechError ? error.reason : "busy";
        if (reason === "auth") throw invalid("The provider didn't accept this key.");
        if (provider === "local") throw invalid("Couldn't reach this server.");
      }
      const hint = provider === "local" ? (credentials.baseUrl ?? "") : (credentials.apiKey ?? "").slice(-4);
      const values = {
        ...(await sealSecret(deps.keyWrapper, JSON.stringify({ provider, ...credentials }), AAD)),
        keyHint: hint,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      await deps.db
        .insert(instanceSecrets)
        .values({ name: NAME, ...values })
        .onConflictDoUpdate({ target: instanceSecrets.name, set: values });
      saved = { provider, engine, hint, at: values.updatedAt.getTime() };
      readAt = now();
      return snapshot();
    },
    async remove() {
      await deps.db.delete(instanceSecrets).where(eq(instanceSecrets.name, NAME));
      saved = null;
      readAt = now();
      return snapshot();
    },
  };
}

/**
 * Who turns voice into text for this workspace: the installation's pinned owner (ADR 0073), when they are one of its
 * members, so a person can ask them by name. Null on agentes.chat's servers (their engines are set) and when the owner
 * isn't here.
 */
export async function speechOwnerIn(db: Database, orgId: string): Promise<{ userId: string; name: string } | null> {
  const owner = await pinnedOwner(db);
  if (!owner) return null;
  const [row] = await db
    .select({ name: users.name })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, owner)));
  return row ? { userId: owner, name: row.name } : null;
}

/** What the agents know of voice on this server (`voiceStatusText`). */
export interface VoiceStatus {
  state: SpeechState;
  /** Who chooses what turns voice into text here (`speechOwnerIn`), by name. */
  owner: string | null;
}

/**
 * One line of the workspace's facts while voice doesn't become text here, so an agent (the right hand above all)
 * answers from it instead of guessing; nothing once it does.
 */
export function voiceStatusText({ state, owner }: VoiceStatus): string {
  if (state === "ready") return "";
  const who = owner ? `${owner} (who runs this server)` : "Whoever runs this server";
  if (state === "installing") {
    return "Voice messages: on. The voice model is getting ready on this server: one recorded meanwhile reaches you as a note that you can't hear it, and the ones after it come as text.";
  }
  const why =
    state === "failed"
      ? "what turned voice into text on this server stopped"
      : "nothing on this server turns voice into text yet";
  return `Voice messages: people can record them, but ${why}, so one reaches you as a note that you can't hear it. ${who} turns it on in Settings › Voice.`;
}
