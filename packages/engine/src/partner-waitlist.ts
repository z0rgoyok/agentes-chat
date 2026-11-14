import type { EmailSender } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { rethrowEmailError } from "./email";
import { ValidationError } from "./errors";
import { enqueue } from "./outbox";
import { normalizeWaitlistEmail } from "./waitlist";

const { partnerWaitlistEntries } = schema;

export const PARTNER_WAITLIST_CONTACT_JOB = "partner_waitlist.contact";

/** An answer's key: what the page names the question, kept as the contact property `partner_<key>`. */
const ANSWER_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const PARTNER_ANSWERS_MAX = 30;
/** Also the options picked, joined: the email provider takes 1,000 characters a property. */
export const PARTNER_ANSWER_MAX_CHARS = 500;
export const PARTNER_ANSWER_MAX_PICKS = 10;
/** Keys the contact already uses for the entry itself, so an answer never overwrites them. */
const RESERVED_KEYS = new Set(["waitlist", "name", "whatsapp", "locale", "source", "joined_at", "updated_at"]);
/** Digits, spaces and `+ ( ) . -`: E.164 (`+5511912345678`) or a number as typed. */
const PHONE = /^[\d\s()+.-]{8,40}$/;

export type PartnerAnswers = Record<string, string | string[]>;

/** The answers kept: known shape, trimmed, empty ones dropped. Throws on a bad key or size. */
function cleanAnswers(raw: PartnerAnswers | undefined): PartnerAnswers {
  const out: PartnerAnswers = {};
  const entries = Object.entries(raw ?? {});
  if (entries.length > PARTNER_ANSWERS_MAX) throw new ValidationError("Too many answers", "invalid_request");
  for (const [key, value] of entries) {
    if (!ANSWER_KEY.test(key) || RESERVED_KEYS.has(key))
      throw new ValidationError(`Unknown answer: ${key}`, "invalid_request");
    if (Array.isArray(value)) {
      const picks = [...new Set(value.map((v) => v.trim()).filter(Boolean))];
      if (picks.length > PARTNER_ANSWER_MAX_PICKS || picks.join(", ").length > PARTNER_ANSWER_MAX_CHARS)
        throw new ValidationError(`Answer too long: ${key}`, "invalid_request");
      if (picks.length) out[key] = picks;
    } else {
      const text = value.trim();
      if (text.length > PARTNER_ANSWER_MAX_CHARS)
        throw new ValidationError(`Answer too long: ${key}`, "invalid_request");
      if (text) out[key] = text;
    }
  }
  return out;
}

/**
 * Puts someone on the partner program's waiting list (the landing page's
 * partner page), or updates their entry when the email is there already: the
 * latest form wins, and the first join date stays. No confirmation email: the
 * form itself is the opt-in, and the team talks to each one before the program
 * opens. The email provider gets the contact through the outbox
 * (`partner_waitlist.contact`).
 */
export async function joinPartnerWaitlist(
  db: Database,
  input: { email: string; name: string; whatsapp: string; locale?: string; answers?: PartnerAnswers },
  now = new Date(),
): Promise<void> {
  const email = normalizeWaitlistEmail(input.email);
  if (!email) throw new ValidationError("Use an email like name@company.com", "invalid_email");
  const name = input.name.trim();
  if (!name || name.length > 120) throw new ValidationError("Tell us your name", "invalid_name");
  const whatsapp = input.whatsapp.trim();
  // E.164 holds 15 digits at most, with the country code.
  const digits = whatsapp.replace(/\D/g, "").length;
  if (!PHONE.test(whatsapp) || digits < 8 || digits > 15)
    throw new ValidationError("Use a WhatsApp number with its country code, like +5511912345678", "invalid_whatsapp");
  const answers = cleanAnswers(input.answers);
  const locale = appLocale([input.locale], true) ?? "en";

  await db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(partnerWaitlistEntries)
      .values({ email, name, whatsapp, locale, answers, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: partnerWaitlistEntries.email,
        set: { name, whatsapp, locale, answers, updatedAt: now },
      })
      .returning({ id: partnerWaitlistEntries.id });
    if (!entry) return;
    await enqueue(tx, {
      orgId: null,
      kind: PARTNER_WAITLIST_CONTACT_JOB,
      payload: { entryId: entry.id },
      dedupeKey: `${PARTNER_WAITLIST_CONTACT_JOB}:${entry.id}:${now.getTime()}`,
    });
  });
}

/**
 * Saves an entry as a contact in the email provider (MillionSend), every key
 * prefixed `partner_` so it never touches the product's waiting list
 * (`waitlist`, `locale`, `source`), whose segments would otherwise send them
 * the product's launch emails: `partner_waitlist` ("joined"), `partner_name`,
 * `partner_whatsapp`, `partner_locale`, `partner_source`,
 * `partner_joined_at`, `partner_updated_at`, and one `partner_<key>` per
 * answer (the options picked, joined by ", "). Read now, not when the job was
 * queued, so a late job never undoes a newer form. The provider merges
 * properties, so an answer left out of a later form keeps its old value
 * there; the entry here has the latest. A provider without contacts: nothing.
 */
export async function savePartnerWaitlistContact(db: Database, email: EmailSender, entryId: string): Promise<void> {
  if (!email.saveContact) return;
  const [entry] = await db.select().from(partnerWaitlistEntries).where(eq(partnerWaitlistEntries.id, entryId));
  if (!entry) return;
  const answers = Object.fromEntries(
    Object.entries(entry.answers).map(([key, value]) => [
      `partner_${key}`,
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
  await email
    .saveContact({
      email: entry.email,
      properties: {
        ...answers,
        partner_waitlist: "joined",
        partner_name: entry.name,
        partner_whatsapp: entry.whatsapp,
        partner_locale: entry.locale,
        partner_source: entry.source,
        partner_joined_at: entry.createdAt.toISOString(),
        partner_updated_at: entry.updatedAt.toISOString(),
      },
    })
    .catch(rethrowEmailError);
}
