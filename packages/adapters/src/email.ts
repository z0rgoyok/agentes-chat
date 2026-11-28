import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";

/**
 * Transactional email. Core sends only through an outbox job (`email.send`),
 * never inline in a request. Cloud: MillionSend (Resend-compatible API).
 * Self-hosted: that API, or any SMTP server. Without either: a dev sender
 * that logs instead of sending.
 */
export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Same key → the provider sends once (also deduped by the outbox). */
  idempotencyKey: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  /** Pictures attached to the message. */
  inline?: InlinePart[];
}

/** A picture attached to a message, shown where its HTML says `cid:{cid}`. */
export interface InlinePart {
  cid: string;
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** A marketing contact (e.g. a confirmed waiting list address), keyed by email. */
export interface EmailContact {
  email: string;
  /**
   * Custom properties, merged into what the provider already has; null removes one. With a null the contact is
   * updated first; one the provider doesn't have yet is created with the other properties, or not at all with none.
   */
  properties: Record<string, string | number | null>;
}

export interface EmailSender {
  readonly id: string;
  /** Whether real delivery is configured (enables password reset and email verification). */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<{ id: string }>;
  /** Creates or updates a contact in the provider's list; absent = the provider keeps no contacts. */
  saveContact?(contact: EmailContact): Promise<void>;
  /**
   * Lets the provider mail this one address again after it stopped because of an earlier bounce; true when it lifted
   * such a stop. A complaint or an unsubscribe stays. Absent = the provider keeps no such list.
   */
  removeSuppression?(address: string): Promise<boolean>;
}

/**
 * Why a send can never reach its recipient as things stand: `suppressed`, the provider stopped mailing the address (an
 * earlier hard bounce or complaint); `rejected`, the provider or the receiving server refused the address itself.
 */
export type Undelivered = "suppressed" | "rejected";

/** A send failure; `retryable` drives the outbox retry. `recipient`: the refusal is about the recipient. */
export class EmailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly recipient?: Undelivered,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/**
 * MillionSend over its REST API (`POST {baseURL}/emails`, bearer key), the
 * documented Resend-compatible fields. 429 (quota) and 5xx retry; 4xx don't.
 * A 409 (idempotency conflict: this key was already used) counts as sent.
 */
export function createMillionSendSender(options: {
  apiKey: string;
  from: string;
  replyTo?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): EmailSender {
  const http = options.fetch ?? fetch;
  const base = (options.baseURL ?? "https://api.millionsend.com").replace(/\/$/, "");
  return {
    id: "millionsend",
    delivers: true,
    async send(message) {
      let res: Response;
      try {
        res = await http(`${base}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": message.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: options.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo || options.replyTo ? { reply_to: message.replyTo ?? options.replyTo } : {}),
            ...(message.tags?.length ? { tags: message.tags } : {}),
            ...(message.inline?.length
              ? {
                  attachments: message.inline.map((a) => ({
                    filename: a.filename,
                    content: Buffer.from(a.content).toString("base64"),
                    content_type: a.contentType,
                    content_id: a.cid,
                  })),
                }
              : {}),
          }),
        });
      } catch (error) {
        throw new EmailError(`could not reach MillionSend: ${String(error)}`, true);
      }
      if (res.status === 409) return { id: `duplicate:${message.idempotencyKey}` };
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok || !body.id) {
        throw new EmailError(
          `MillionSend refused the email (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? ""}`.trim(),
          res.status === 429 || res.status >= 500,
          res.status,
          body.name === "all_recipients_suppressed"
            ? "suppressed"
            : // Its 422 `validation_error` for an address no mail can reach says so in these words.
              res.status === 422 && body.message?.includes("can never receive mail")
              ? "rejected"
              : undefined,
        );
      }
      return { id: body.id };
    },
    /**
     * `GET`, then `DELETE /suppressions/{email}`, only for an `origin: "bounce"`: a complaint, an unsubscribe or a
     * suppression made by hand is the recipient's or the operator's choice, which a resend never overrides. A 404 is
     * an address it wasn't holding back.
     */
    async removeSuppression(address) {
      const call = async (method: "GET" | "DELETE") => {
        let res: Response;
        try {
          res = await http(`${base}/suppressions/${encodeURIComponent(address)}`, {
            method,
            headers: { authorization: `Bearer ${options.apiKey}` },
          });
        } catch (error) {
          throw new EmailError(`could not reach MillionSend: ${String(error)}`, true);
        }
        if (res.status === 404) return null;
        const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string; origin?: string };
        if (!res.ok) {
          throw new EmailError(
            `MillionSend refused the suppression ${method === "GET" ? "lookup" : "removal"} (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? ""}`.trim(),
            res.status === 429 || res.status >= 500,
            res.status,
          );
        }
        return body;
      };
      if ((await call("GET"))?.origin !== "bounce") return false;
      return (await call("DELETE")) !== null;
    },
    /**
     * `POST /contacts`; an existing contact (409) gets its properties merged with `PATCH /contacts/{email}`. A null
     * goes only by `PATCH`, where it removes the key; a contact it doesn't find (404) is created with the rest.
     */
    async saveContact(contact) {
      const call = async (method: string, path: string, body: unknown) => {
        try {
          return await http(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          throw new EmailError(`could not reach MillionSend: ${String(error)}`, true);
        }
      };
      const patch = () =>
        call("PATCH", `/contacts/${encodeURIComponent(contact.email)}`, { properties: contact.properties });
      const removes = Object.values(contact.properties).includes(null);
      let res = removes
        ? await patch()
        : await call("POST", "/contacts", { email: contact.email, properties: contact.properties });
      if (res.status === 409) res = await patch();
      if (removes && res.status === 404) {
        const kept = Object.fromEntries(Object.entries(contact.properties).filter(([, value]) => value !== null));
        if (Object.keys(kept).length === 0) return;
        res = await call("POST", "/contacts", { email: contact.email, properties: kept });
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
        throw new EmailError(
          `MillionSend refused the contact (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? ""}`.trim(),
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
    },
  };
}

/**
 * Any SMTP server, from an `smtp://` (STARTTLS) or `smtps://` (implicit TLS)
 * URL with the credentials. A 5xx answer (recipient refused, bad login) won't
 * change on retry; anything else (4xx, connection, timeout) retries.
 */
export function createSmtpEmailSender(options: {
  url: string;
  from: string;
  replyTo?: string;
  /** Tests: replaces the SMTP connection (nodemailer's `jsonTransport`, or a stub). */
  transport?: Pick<Mail, "sendMail">;
}): EmailSender {
  const transport: Pick<Mail, "sendMail"> =
    options.transport ??
    // Timeouts well under the outbox lease (10 min): a hung server must not get the job claimed and sent twice.
    nodemailer.createTransport({
      url: options.url,
      // Without it, smtp:// goes on in plaintext when the server doesn't offer STARTTLS, an offer an
      // on-path attacker can strip. A `?requireTLS=false` in the URL overrides it (nodemailer's precedence).
      requireTLS: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    });
  return {
    id: "smtp",
    delivers: true,
    async send(message) {
      try {
        const info = await transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          replyTo: message.replyTo ?? options.replyTo,
          ...(message.inline?.length
            ? {
                attachments: message.inline.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content),
                  contentType: a.contentType,
                  cid: a.cid,
                })),
              }
            : {}),
        });
        return { id: String(info.messageId) };
      } catch (error) {
        const e = error as { responseCode?: number; message?: string; command?: string };
        throw new EmailError(
          `SMTP send failed: ${e.message ?? String(error)}`,
          (e.responseCode ?? 0) < 500,
          e.responseCode,
          (e.responseCode ?? 0) >= 500 && e.command === "RCPT TO" ? "rejected" : undefined,
        );
      }
    },
  };
}

/** Dev fallback: no email configured, so the email is logged (subject, recipients, text) and not sent. */
export function createLogEmailSender(log: (line: string, data: Record<string, unknown>) => void): EmailSender {
  return {
    id: "log",
    delivers: false,
    async send(message) {
      log("email (not sent: neither MILLIONSEND_API_KEY nor SMTP_URL is set)", {
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { id: `logged:${message.idempotencyKey}` };
    },
  };
}

/**
 * Test sender: records every message, never sends. `refused`: addresses it refuses as MillionSend would (a suppressed
 * one until `removeSuppression`, which `unsuppressed` records).
 */
export function createFakeEmailSender(options: { delivers?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  const contacts: EmailContact[] = [];
  const refused = new Map<string, Undelivered>();
  const unsuppressed: string[] = [];
  const sender: EmailSender & {
    sent: EmailMessage[];
    contacts: EmailContact[];
    refused: Map<string, Undelivered>;
    unsuppressed: string[];
  } = {
    id: "fake",
    delivers: options.delivers ?? true,
    sent,
    contacts,
    refused,
    unsuppressed,
    async send(message) {
      const why = message.to.map((a) => refused.get(a.toLowerCase())).find(Boolean);
      if (why) throw new EmailError(`fake refused the email (422 ${why})`, false, 422, why);
      sent.push(message);
      return { id: `fake-${sent.length}` };
    },
    async saveContact(contact) {
      contacts.push(contact);
    },
    async removeSuppression(address) {
      unsuppressed.push(address);
      if (refused.get(address.toLowerCase()) !== "suppressed") return false;
      refused.delete(address.toLowerCase());
      return true;
    },
  };
  return sender;
}
