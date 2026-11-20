import { randomBytes } from "node:crypto";
import type { BlobStore } from "@agenteschat/adapters";
import { count, type Database, eq, schema, sql } from "@agenteschat/db";
import { isAccentHex } from "@agenteschat/tokens/accent";
import { readImage } from "./avatars";
import { caches } from "./cache";
import { ConflictError, ValidationError } from "./errors";
import { normalizeHost } from "./net-guard";

const { hosts } = schema;

/** Where the pages on a registered host load its logo; the host is the request's own, never a parameter. */
export const HOST_LOGO_PATH = "/api/host-look/logo";

/** At most this many registered hosts on one server. */
export const HOSTS_MAX = 1000;

export type HostLook = typeof hosts.$inferSelect;

/**
 * The registered host a `Host` header names (ADR 0194), or null: the one resolver behind every check of a registered
 * host (the origin rule, sign-in, the links, the logo). Kept per process for 30 s and dropped on a write.
 */
export async function hostLook(db: Database, host: string | null | undefined): Promise<HostLook | null> {
  const h = normalizeHost(host);
  if (!h) return null;
  return (await caches.hosts.getOrLoad(
    h,
    async () => (await db.select().from(hosts).where(eq(hosts.host, h)))[0] ?? null,
  )) as HostLook | null;
}

/**
 * The one origin a registered host adds (ADR 0194): exactly `https://<host>`, and only on a request whose own `Host`
 * is that registered host, so a host's page never reaches another host's session. Forwarded-host headers are never
 * read. Null on any other request. The app API's CSRF check and the WebSocket upgrades take it through the
 * server's `requestOriginAllowed`, Better Auth through its `trustedOrigins`.
 */
export async function hostOrigin(db: Database, headers: Headers): Promise<string | null> {
  const look = await hostLook(db, headers.get("host"));
  return look ? `https://${look.host}` : null;
}

export const listHosts = (db: Database) => db.select().from(hosts).orderBy(hosts.host);

/** The host an operator names, or the refusal: not a hostname, or one of this server's own (`own`). */
function registrable(host: string, own: ReadonlySet<string>) {
  const h = normalizeHost(host);
  if (!h) throw new ValidationError("Not a hostname", "host.invalid");
  if (own.has(h)) throw new ValidationError("This server already answers on this host", "host.own");
  return h;
}

/**
 * Every write of `hosts` holds this one transaction lock: a replace and a delete of the same host never interleave
 * (a delete never comes back with a logo it removed), and two creates never both pass `HOSTS_MAX`.
 */
const lockHosts = (tx: Pick<Database, "execute">) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('hosts'))`);

/**
 * Registers a host or replaces its look (the operator's `PUT /hosts/{host}`). `accent`, `logo` and `poweredBy` left
 * out are left as they are (none, none and true on a new host); null clears `accent` and `logo`. The logo takes a workspace logo's checks (`readImage`). A new logo
 * is stored under a name of its own before the row, so no other write's cleanup can remove it; a file no committed row
 * holds any more is removed only after the commit.
 */
export async function putHost(
  deps: { db: Database; blobs: BlobStore },
  own: ReadonlySet<string>,
  host: string,
  input: {
    name: string;
    accent?: string | null;
    logo?: { contentType: string; base64: string } | null;
    poweredBy?: boolean;
  },
): Promise<HostLook> {
  const h = registrable(host, own);
  if (input.accent && !isAccentHex(input.accent)) throw new ValidationError("accent must be a #rrggbb color");
  let stored: string | null = null;
  if (input.logo) {
    const { body, type, file } = readImage(
      { imageBase64: input.logo.base64, contentType: input.logo.contentType },
      "logo",
    );
    stored = `host-logos/${h}/${randomBytes(4).toString("hex")}-${file}`;
    await deps.blobs.put(stored, body, { contentType: type });
  }
  let saved: { row: HostLook; before?: HostLook };
  try {
    saved = await deps.db.transaction(async (tx) => {
      await lockHosts(tx);
      const [before] = await tx.select().from(hosts).where(eq(hosts.host, h));
      if (!before) {
        const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(hosts);
        if (n >= HOSTS_MAX) throw new ConflictError(`At most ${HOSTS_MAX} hosts`, "host.too_many", { max: HOSTS_MAX });
      }
      const logo = input.logo === undefined ? (before?.logo ?? null) : stored;
      const accent = input.accent === undefined ? (before?.accent ?? null) : (input.accent?.toLowerCase() ?? null);
      const poweredBy = input.poweredBy ?? before?.poweredBy ?? true;
      const [row] = await tx
        .insert(hosts)
        .values({ host: h, name: input.name, accent, logo, poweredBy })
        .onConflictDoUpdate({
          target: hosts.host,
          set: { name: input.name, accent, logo, poweredBy, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error("host not saved");
      return { row, before };
    });
  } catch (error) {
    if (stored) await deps.blobs.delete(stored).catch(() => undefined);
    throw error;
  }
  caches.hosts.delete(h);
  const old = saved.before?.logo;
  if (old && old !== saved.row.logo) await deps.blobs.delete(old).catch(() => undefined);
  return saved.row;
}

/** Forgets a host and its stored logo (the operator's `DELETE /hosts/{host}`). False when it wasn't registered. */
export async function deleteHost(deps: { db: Database; blobs: BlobStore }, host: string): Promise<boolean> {
  const h = normalizeHost(host);
  if (!h) return false;
  const gone = await deps.db.transaction(async (tx) => {
    await lockHosts(tx);
    return (await tx.delete(hosts).where(eq(hosts.host, h)).returning())[0];
  });
  caches.hosts.delete(h);
  if (gone?.logo) await deps.blobs.delete(gone.logo).catch(() => undefined);
  return Boolean(gone);
}

/** The stored logo of the host a `Host` header names, or null (`HOST_LOGO_PATH`). */
export async function hostLogoFile(deps: { db: Database; blobs: BlobStore }, host: string | null | undefined) {
  const look = await hostLook(deps.db, host);
  if (!look?.logo) return null;
  return deps.blobs.get(look.logo);
}

/**
 * Where a person acting on `requestHost` is sent back to (ADR 0194): that host when it is a registered one, else
 * `publicUrl`. For the links a person follows from what they did there: a password reset, a confirmation, an
 * invitation.
 */
export async function baseUrlFor(db: Database, publicUrl: string, requestHost: string | null | undefined) {
  const look = await hostLook(db, requestHost);
  return look ? `https://${look.host}` : publicUrl.replace(/\/$/, "");
}
