import type { Database } from "@agenteschat/db";
import type { JsonSchema } from "../../tools/json-schema";
import type { ToolContext, ToolOutput } from "../../tools/types";
import type { ConnectionSecret } from "../connections";

/**
 * What a connector of our own (ADR 0170) gives `connectors/native/index.ts` and `connections.ts`. A service file
 * imports no engine module at run time: what it needs comes in its `NativeCall`, so `connections.ts` can import its
 * hooks without a cycle.
 */

/** Why a vendor's answer failed, as the agent reads it (`data.code`). */
export type NativeErrorCode =
  | "connector.needs_reconnect"
  | "connector.rate_limited"
  | "connector.capped"
  | "connector.refused"
  | "connector.unknown_result"
  | "connector.failed";

export class NativeError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
    /** When a limit lifts (`connector.rate_limited`). */
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

/** A file from the Drive, as the agent may read it. */
export interface NativeFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface NativeConnection {
  id: string;
  orgId: string;
  label: string;
  accountLabel: string | null;
  accountId: string | null;
}

/** One tool call's means: the connection's fresh secret, the network, the database, the agent's Drive. */
export interface NativeCall {
  secret: ConnectionSecret;
  connection: NativeConnection;
  http: typeof fetch;
  db: Database;
  ctx: ToolContext;
  /** An uploaded Drive file by its id, read as the agent (refused when it may not read it). */
  file(id: string): Promise<NativeFile>;
  /** A link of ours to that file the vendor can fetch for an hour, or null when the internet can't reach this server. */
  mediaLink?(id: string): Promise<string | null>;
}

export interface NativeTool {
  description: string;
  /** Its input's `properties` and `required`: always an object with no other fields. */
  input: { properties: Record<string, JsonSchema>; required?: string[] };
  /** What it returns is other people's words (messages, mentions, replies): read as data. */
  external?: true;
  /**
   * The most the call may cost, in nano-US$, where the vendor bills this server per call (X): checked against the
   * workspace's `connectorUsdPerMonth` before it runs. What it did cost comes back as the output's `costNanoUsd`.
   */
  most?(input: Record<string, unknown>): number;
  run(input: Record<string, unknown>, call: NativeCall): Promise<ToolOutput>;
}

export interface NativeToken {
  accessToken: string;
  /** Seconds; none: it doesn't end (Meta's system-user tokens). */
  expiresIn?: number;
}

/** The OAuth app the server registered with the vendor, when the service signs in with one. */
export interface NativeApp {
  clientId: string;
  clientSecret: string;
}

export interface NativeService {
  tools: Record<string, NativeTool>;
  /** The account a sign-in or a pasted key reaches (`@handle` and the vendor's id), once after it. */
  account?(secret: ConnectionSecret, http: typeof fetch): Promise<{ label: string; id: string }>;
  /** Right after the code: a longer-lived token for the short one (Threads' 60 days). */
  exchange?(token: NativeToken, app: NativeApp, http: typeof fetch): Promise<NativeToken>;
  /** A token renewed by a call of its own rather than OAuth's refresh grant (Threads), `refreshBefore` ms ahead. */
  refresh?(secret: ConnectionSecret, app: NativeApp | undefined, http: typeof fetch): Promise<NativeToken>;
  refreshBefore?: number;
  /** Tells the vendor the connection is gone, best effort. */
  revoke?(secret: ConnectionSecret, http: typeof fetch, app?: NativeApp): Promise<void>;
  /**
   * Right after a connection is stored: what the service sets up with it (Telegram: its webhook, at `publicBase` when
   * the internet reaches this server). The secret it returns replaces the stored one.
   */
  connected?(
    secret: ConnectionSecret,
    connection: NativeConnection,
    http: typeof fetch,
    publicBase: string | null,
  ): Promise<ConnectionSecret | undefined>;
}

/** Small pages: some vendors bill per item returned. */
export const PAGE_DEFAULT = 10;
export const PAGE_MAX = 50;

export const pageSize = (v: unknown) => Math.min(Math.max(Math.trunc(Number(v)) || PAGE_DEFAULT, 1), PAGE_MAX);

export const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A read's answer, as JSON the agent reads. */
export const json = (data: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  content: JSON.stringify(data),
  ...extra,
});
