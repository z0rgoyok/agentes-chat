import type { ApprovalEmail } from "@agenteschat/client";
import { Icon } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useReveal } from "@/hooks/useReveal";
import "./email-letter.css";

/**
 * The email an approval writes, as it will be: De (the mailbox and its provider), Para, Assunto, the
 * text (folded to a few lines until "Ver mais" opens it in place, unless `full`) and the message it answers. Never
 * the raw values.
 */
export function EmailLetter({ email, full }: { email: ApprovalEmail; full?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const words = useRef<HTMLDivElement>(null);
  const reveal = useReveal(words, open);
  const long = email.body.length > 220 || email.body.split("\n").length > 4;
  const folded = !full && !open && long;
  const people: [string, string[]][] = [
    [t("approval.email.to"), email.to],
    [t("approval.email.cc"), email.cc],
    [t("approval.email.bcc"), email.bcc],
  ];
  return (
    <div className="email-letter">
      <dl className="email-letter__head">
        <div className="email-letter__row">
          <dt>{t("approval.email.from")}</dt>
          <dd>
            <b>{email.from || email.mailbox}</b>
            {email.provider && <span className="email-letter__muted"> · {email.provider}</span>}
          </dd>
        </div>
        {people.map(([label, list]) =>
          list.length > 0 ? (
            <div key={label} className="email-letter__row">
              <dt>{label}</dt>
              <dd>
                <b>{list.join(", ")}</b>
              </dd>
            </div>
          ) : null,
        )}
        <div className="email-letter__row">
          <dt>{t("approval.email.subject")}</dt>
          <dd className="email-letter__subject">{email.subject || t("approval.email.noSubject")}</dd>
        </div>
      </dl>
      {email.body && (
        <div ref={words} className="email-letter__body" data-folded={folded ? "" : undefined}>
          {email.body}
        </div>
      )}
      {folded && (
        <button
          type="button"
          className="ac-link email-letter__more"
          onClick={() => {
            reveal();
            setOpen(true);
          }}
        >
          {t("channel.long.more")}
        </button>
      )}
      {email.original && (
        <p className="email-letter__original ac-iconline">
          <Icon name="reply" size={14} />
          <span>
            <Trans
              i18nKey={
                email.verb === "forward"
                  ? email.original.from
                    ? "approval.email.forwardsFrom"
                    : "approval.email.forwards"
                  : email.original.from
                    ? "approval.email.answersFrom"
                    : "approval.email.answers"
              }
              values={{ subject: email.original.subject, from: email.original.from ?? "" }}
              components={{ b: <b /> }}
            />
          </span>
        </p>
      )}
    </div>
  );
}
