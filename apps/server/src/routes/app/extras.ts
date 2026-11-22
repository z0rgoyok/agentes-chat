import type { PushSender } from "@agenteschat/adapters";
import type {
  ArtifactContent,
  ArtifactDeps,
  BrowserLive,
  ContextDeps,
  GifKey,
  GitHubAppSettings,
  GitProxyDeps,
  JevKey,
  McpConnect,
  ModelGateway,
  ResolveHost,
  RouterDeps,
  SandboxDeps,
  SpeechSettings,
  StorageDeps,
  StreamBroker,
  Talker,
  VoiceDeps,
} from "@agenteschat/engine";

export interface BlockActionContext {
  orgId: string;
  userId: string;
  artifactId: string;
  locale?: string;
}

/** Actions offered by a trusted server extension to the signed-in person viewing a live block. */
export interface BlockActions {
  /** Render the requested immutable version for the reader when this extension owns its content. */
  localize?(input: BlockActionContext & { version: number }): Promise<
    | {
        content: Extract<ArtifactContent, { kind: "block" }>;
        /** Only for extension-rendered HTML whose execution consent can span revisions. */
        rememberOpen?: boolean;
      }
    | undefined
  >;
  list(input: BlockActionContext): Promise<{ id: string; label: string }[]>;
  /** Authorize the person and validate the action against current application state before applying it. */
  invoke(input: BlockActionContext & { actionId: string }): Promise<void>;
}

/**
 * Backend services the app API needs beyond the core deps (owned by the
 * backend; extended per phase). Everything is optional so tests and the web
 * app's own routes don't have to provide them.
 */
export interface AppExtras {
  /** Outbound HTTP: OAuth token exchanges, provider key checks (tests inject a fake). */
  http?: typeof fetch;
  /** How to open MCP sessions (tests: in-process servers). */
  mcpConnect?: McpConnect;
  /** DNS for the SSRF guard on URLs people type (tests: fake). */
  resolveHost?: ResolveHost;
  /** Query embeddings for search (the Model Gateway's `embed`, which records usage). */
  embed?: ModelGateway["embed"];
  /** Context deps (cheap-model calls such as schedule parsing). */
  context?: ContextDeps;
  /** Org storage settings and the blob resolver (Drive, artifacts). */
  storage?: StorageDeps;
  artifacts?: ArtifactDeps;
  blockActions?: BlockActions | undefined;
  /** Agents' computers (ADR 0025): the machine hub, Run code settings and git; null/absent = none on this server. */
  sandbox?: SandboxDeps | null;
  /** The git proxy for agents' computers (ADR 0024); absent = off. */
  gitProxy?: GitProxyDeps;
  /** Outbound HTTP to GitHub for the desktop app's releases (ADR 0036; tests inject a fake GitHub). */
  desktopFetch?: typeof fetch;
  /** The agent browser's live view (ADR 0040): handoff changes switch its stream; absent = handoffs only. */
  browserLive?: BrowserLive;
  /** Agents' desktop and terminal streams on this server (ADR 0058): who watches; absent = none counted. */
  streams?: StreamBroker;
  /** Agents' conversation layer: fast replies while their task works or waits; absent = none. */
  talker?: Talker;
  /** The router of messages nobody mentioned ("Responder agora" routes one again); null/absent = routing off. */
  router?: RouterDeps | null;
  /**
   * The push relay's sender (ADR 0152, ADR 0178, `PUSH_RELAY_SERVE`): Firebase and APNs; absent = one made from
   * `FIREBASE_SERVICE_ACCOUNT` and `APNS_KEY`, null = no relay.
   */
  pushRelaySender?: PushSender | null;
  /** The installation's Jev key, for its owner's routes (ADR 0073); absent = those routes answer 404. */
  jevKey?: JevKey;
  /**
   * The installation's GIPHY key, for its owner's routes (ADR 0091, amended 2026-10-31); absent (agentes.chat's own
   * servers) = those routes answer 404.
   */
  gifKey?: GifKey;
  /** The server's GitHub App (ADR 0156): env or made from Settings; absent = `GITHUB_APP_*` alone. */
  githubApp?: GitHubAppSettings;
  /** Speech engines and what voice messages need (ADR 0100); absent: no voice messages. */
  speech?: SpeechSettings;
  voice?: VoiceDeps;
}
