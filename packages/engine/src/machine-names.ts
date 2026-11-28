import type { PubSub } from "@agenteschat/adapters";
import { and, type Executor, eq, isNull, ne, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { isFeminineName } from "@agenteschat/i18n/format";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { emailLocale } from "./email";
import { firstName } from "./format";
import { cleanMachineName, publishMachineUpdated } from "./machines";

const { machines, notifications, users } = schema;

/**
 * A computer's name until someone renames it: its model and the first name of who connected it, in that person's
 * language ("MacBook Pro do Tomás", "Tomás's MacBook Pro"), never its host name ("Tomass-MacBook-Pro.local",
 * "DESKTOP-AB12CD3", "instance-20260101-0000"). The workspace's own computer has its own (`managedMachineName`).
 */

/** A host name without its network suffix ("Rui-MacBook-Pro.local" → "Rui-MacBook-Pro"). */
const hostCore = (s: string) => s.trim().replace(/\.(local|lan|home|localdomain|internal)\.?$/i, "");

/**
 * `name` is what the computer's host name made of it (nobody chose it): empty, the host name itself as a runner sends
 * it when nobody gave `--name`, or one with `.local`. A name with a space, or another case, someone typed.
 */
export const hostnameLike = (name: string, hostname: string) => {
  const n = name.trim();
  return (
    !n || /\.local\.?$/i.test(n) || (!/\s/.test(n) && hostname.trim() !== "" && hostCore(n) === hostCore(hostname))
  );
};

/** Apple's names, as macOS writes them into a Mac's default host name ("Tomass-MacBook-Pro", "MacBook-Air-de-Ana"). */
const MAC_MODELS: [RegExp, string][] = [
  [/macbook-?pro|\bmbp\b/, "MacBook Pro"],
  [/macbook-?air|\bmba\b/, "MacBook Air"],
  [/macbook/, "MacBook"],
  [/mac-?mini/, "Mac mini"],
  [/mac-?studio/, "Mac Studio"],
  [/mac-?pro/, "Mac Pro"],
  [/imac/, "iMac"],
];

/** What a runner reads as the model where nobody filled it in, or of a virtual machine: never shown. */
const NO_MODEL =
  /o\.?e\.?m|system product name|system manufacturer|default string|to be filled|not applicable|not specified|^none$|^unknown$|^type1|virtual|vmware|kvm|qemu|bochs|standard pc|compute engine|droplet|hvm domu|xen|openstack|amazon ec2|parallels|hyper-v/i;

/**
 * The model a runner reported ("MacBook Pro", "Dell Inspiron 15 3520", "ThinkPad X1 Carbon Gen 9"), when it reads as
 * one: a word of letters alone (never a part number like "20XW004KUS"), no filler a maker leaves, no virtual machine.
 * Empty otherwise.
 */
export function reportedModel(model: string | null | undefined) {
  const m = cleanMachineName(model).replace(/\s+/g, " ").slice(0, 40).trim();
  return m && /(^|[\s(-])\p{L}{2,}(?=[\s)-]|$)/u.test(m) && !NO_MODEL.test(m) ? m : "";
}

/** The model a name says: the reported one, else the Mac's from its host name, else "Mac" or "PC" by its system. */
export function machineModel(device: { hostname: string; os: string; model?: string | null }) {
  const reported = reportedModel(device.model);
  if (reported) return reported;
  const host = device.hostname.toLowerCase();
  const mac = MAC_MODELS.find(([pattern]) => pattern.test(host))?.[1];
  if (mac || device.os === "darwin") return mac ?? "Mac";
  return device.os === "windows" ? "PC" : "";
}

/**
 * The name a computer gets when it joins (`owner`: who connected it, with their language): "MacBook Pro do Tomás",
 * "Tomás's PC", "Computador Linux da Ana". With no owner: its model, else its host name without `.local`.
 */
export function defaultMachineName(
  device: { hostname: string; os: string; model?: string | null },
  owner: { name: string; locale: AppLocale } | null,
) {
  const model = machineModel(device);
  const name = owner ? firstName(owner.name) : "";
  if (!owner || !name) return cleanMachineName(model || device.hostname.replace(/\.local\.?$/i, "")) || "Computer";
  const key = model ? "model" : device.os === "linux" ? "linux" : "other";
  return cleanMachineName(
    serverText(
      owner.locale,
      `machines.defaultName.${key}`,
      { name, model },
      isFeminineName(name) ? "female" : undefined,
    ),
  );
}

/** Who connected a computer, as `defaultMachineName` needs them; null for nobody or a person gone. */
export async function machineOwner(db: Executor, userId: string | null | undefined) {
  if (!userId) return null;
  const [row] = await db.select({ name: users.name, locale: users.locale }).from(users).where(eq(users.id, userId));
  return row ? { name: row.name, locale: emailLocale(row.locale) } : null;
}

/** `name`, or "name 2", "name 3"… when another computer of the workspace already has it. */
export async function distinctMachineName(db: Executor, orgId: string, name: string, except?: string) {
  const taken = new Set(
    (
      await db
        .select({ name: machines.name })
        .from(machines)
        .where(
          and(
            eq(machines.orgId, orgId),
            isNull(machines.deletedAt),
            sql`lower(${machines.name}) like lower(${`${name}%`})`,
            ...(except ? [ne(machines.id, except)] : []),
          ),
        )
    ).map((r) => r.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const next = `${name.slice(0, 80 - String(n).length - 1)} ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/**
 * Computers connected before names were made this way, still called by their host name: each takes the name
 * `defaultMachineName` gives it, in its owner's language, and the inbox items naming it follow. A computer someone
 * renamed keeps its name. Open apps hear each new name (`machine.updated`). Returns how many changed.
 */
export async function friendlyMachineNames(db: Executor, pubsub?: PubSub) {
  const rows = await db
    .select({
      id: machines.id,
      orgId: machines.orgId,
      name: machines.name,
      hostname: machines.hostname,
      os: machines.os,
      pairedByUserId: machines.pairedByUserId,
    })
    .from(machines)
    .where(and(eq(machines.kind, "connected"), isNull(machines.deletedAt)));
  let changed = 0;
  for (const m of rows) {
    if (!hostnameLike(m.name, m.hostname)) continue;
    const next = await distinctMachineName(
      db,
      m.orgId,
      defaultMachineName(m, await machineOwner(db, m.pairedByUserId)),
      m.id,
    );
    if (next === m.name) continue;
    await db.update(machines).set({ name: next, updatedAt: new Date() }).where(eq(machines.id, m.id));
    const renamed = (column: typeof notifications.source | typeof notifications.latest, key: string) =>
      sql`case when ${column}->>${key} = ${m.name} then jsonb_set(${column}, ${`{${key}}`}::text[], to_jsonb(${next}::text)) else ${column} end`;
    await db
      .update(notifications)
      .set({ source: renamed(notifications.source, "label"), latest: renamed(notifications.latest, "title") })
      .where(and(eq(notifications.orgId, m.orgId), sql`${notifications.source}->>'machineId' = ${m.id}`));
    await publishMachineUpdated(pubsub, m.orgId, m.id, { name: next });
    changed++;
  }
  return changed;
}
