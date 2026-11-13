import { type Database, eq, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { UUID } from "./authority";
import { encodeCursor } from "./cursor";
import { cutText } from "./format";
import { redactCredentials } from "./tool-detail";

/**
 * Shared by the operator API's reads (ADR 0056): keyset paging, where a page ends at `[createdAt (ms), id]`, and
 * what a stored value may give an answer.
 */

// Cut to milliseconds (what a JS Date and a cursor carry), so paging compares exactly what it returned.
export const ms = (column: unknown) =>
  sql<Date>`date_trunc('milliseconds', ${column})`.mapWith((v: string | Date) => new Date(v));

// The stored time whole, microseconds included, which a JS Date drops: what a cursor carries when a page is ordered
// and continued by the stored column itself, which an index on it serves and no expression of it does.
export const micros = (column: unknown) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const UuidCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface PageQuery {
  limit: number;
  /** `next` of the previous page. */
  cursor?: string;
}

/** The first `limit` of the `limit + 1` rows read, and the cursor after them when there are more. */
export function pageOf<T>(rows: T[], limit: number, key: (last: T) => [Date, string]) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (rows.length <= limit || !last) return { items, next: null };
  const [at, id] = key(last);
  return { items, next: encodeCursor([at.toISOString(), id]) };
}

/** `(at, id)` before a page's cursor, for a list newest first. */
export const olderThan = (at: unknown, id: unknown, after: [string, string] | null) =>
  after ? sql`(${at}, ${id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined;

/**
 * One page, newest first, of rows read from several tables: each table gave its first `limit + 1` after the cursor,
 * so the first `limit` of them all are among these. Ids compare as the database orders them.
 */
export function mergedPage<T extends { createdAt: Date; id: string }>(lists: T[][], limit: number) {
  const rows = lists
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return pageOf(rows, limit, (r) => [r.createdAt, r.id]);
}

export const orgExists = async (db: Database, orgId: string) =>
  (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
  ).length > 0;

// What a JSON column or a job's name holds is returned only when shaped like what the code writes there: a code, an
// id. Anything else in its place reads as absent, so text never leaves through a field meant for a code.
export const CODE = /^[A-Za-z][\w.:/-]{0,99}$/;
export const codeOf = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : null);
export const uuidOf = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
/** An id or a name that may start with a digit (an account's id, a time zone, `owner/repository`): one word of it. */
const WORD = /^[\w.:/+-]{1,200}$/;
export const wordOf = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : null);
/** What a provider, a CLI or the server said went wrong: its start, with anything shaped like a credential masked. */
export const errorText = (text: string | null, max: number) => (text ? cutText(redactCredentials(text), max) : null);
