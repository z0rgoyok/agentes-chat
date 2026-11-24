import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sessions, users } from "./auth";

/**
 * Devices that receive push notifications (ADR 0035, ADR 0071). Per person, not per organization: one
 * device hears every organization its person belongs to (the payload carries `orgId`). A token belongs
 * to one person at a time: registering it again moves it to whoever is signed in. Tokens the push
 * service reports as gone are deleted.
 *
 * Android phones carry their FCM registration token (ADR 0152), iPhones their APNs device token with the app
 * it belongs to (ADR 0178). Browsers
 * (`web`) carry their Web Push subscription: the endpoint in `token` and its keys in `webKeys`, and belong
 * to the session that turned them on (`sessionId`).
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** An Android phone's FCM token, an iPhone's APNs device token (hex), or a browser's endpoint. */
    token: text().notNull().unique(),
    /** `ios | android | web`, validated in code. */
    platform: text().$type<"ios" | "android" | "web">().notNull(),
    /** A browser's subscription keys pushes are encrypted to (RFC 8291): `p256dh` and `auth`, base64url. */
    webKeys: jsonb().$type<{ p256dh: string; auth: string }>(),
    /**
     * A browser's session (ADR 0071): it hears pushes only while that session lasts, and goes with it
     * (signing out, everywhere too). Phones have none.
     */
    sessionId: text().references(() => sessions.id, { onDelete: "cascade" }),
    /** An iPhone's app: its bundle id, the APNs topic its pushes go to (ADR 0178). Null: the sender's first app. */
    appId: text(),
    /** An iPhone development build, whose token is the APNs sandbox's. */
    apnsSandbox: boolean().notNull().default(false),
    /** The device's language (`pt-BR`, `en`…): picks the push text. */
    locale: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last time the device registered it (each launch, each page load). */
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId), index().on(t.sessionId)],
);

/**
 * iPhones that show their person's agents at work in a Live Activity (ADR 0210). Per person, not per organization,
 * as `push_devices`: one activity shows their work in every workspace. One row per app install (`installId`): the
 * token that starts an activity with the app closed (push-to-start), the running activity's id and its own token,
 * and what was last sent to it. Tokens Apple reports as gone are cleared.
 */
export const liveActivityDevices = pgTable(
  "live_activity_devices",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The app install's own id: registering again from it updates this row. */
    installId: text().notNull(),
    /** The app's push-to-start token (hex, iOS 17.2+): starts an activity when none runs. */
    pushToStartToken: text(),
    /** The running activity's id and its push token (hex): what updates and ends it. Null: none known. */
    activityId: text(),
    activityToken: text(),
    /** The app group's widgets directory, where the app writes the agents' faces (`faces/<agentId>.png`). */
    widgetsDir: text().notNull(),
    /** The app's bundle id (its APNs topic is `<appId>.push-type.liveactivity`). Null: the sender's first app. */
    appId: text(),
    /** A development build, whose tokens are the APNs sandbox's. */
    apnsSandbox: boolean().notNull().default(false),
    /** The device's language (`pt-BR`, `en`…), for a person who has none of their own. */
    locale: text().notNull(),
    /** When a push-to-start went and no activity token came back yet: no second start for a while. */
    startedAt: timestamp({ withTimezone: true }),
    /** The props last sent (the JSON string the activity shows); null when it shows nothing of ours. */
    lastSent: text(),
    lastSentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Every write moves it: a refresh writes only over the row as it read it. */
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.installId)],
);

/**
 * This installation's own push identity (ADR 0071, ADR 0152): one row, made on first use. Not a tenant's, so
 * no `org_id`. The Web Push (VAPID, RFC 8292) key pair the server made for itself, the private part
 * sealed with the installation's key (`AGENTES_SECRET`); and, when its Android pushes go through the push
 * relay, the credentials the relay gave it (the secret sealed the same way).
 */
export const instancePush = pgTable(
  "instance_push",
  {
    id: integer().primaryKey().default(1),
    /** VAPID public key: an uncompressed P-256 point, base64url (what browsers get as `applicationServerKey`). */
    vapidPublicKey: text(),
    /** VAPID private key (JWK `d`), sealed. */
    vapidPrivateKey: text(),
    /** The push relay these credentials are for (`PUSH_RELAY_URL`): another one means registering again. */
    relayUrl: text(),
    /** This installation's id at the push relay. */
    relayInstanceId: text(),
    /** Its secret at the push relay, sealed. */
    relaySecret: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_push_one_row", sql`${t.id} = 1`)],
);

/**
 * The installations that send their Android pushes through this server's push relay (ADR 0152,
 * `PUSH_RELAY_SERVE`). They register on their own, with no account: an id and a secret, of which only
 * the SHA-256 is kept. Not a tenant's, so no `org_id`. No message is stored: only how many went.
 */
export const pushRelayInstances = pgTable("push_relay_instances", {
  id: uuid()
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7()),
  /** SHA-256 (hex) of the installation's secret. */
  secretHash: text().notNull().unique(),
  /** Messages it sent through the relay. */
  sent: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Last time it called the relay (moved at most once a minute). */
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Set by the relay's operator: its requests are refused (`blocked`) from then on. */
  blockedAt: timestamp({ withTimezone: true }),
});
