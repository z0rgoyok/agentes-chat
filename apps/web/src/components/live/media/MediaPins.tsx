import { cx } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { type MediaPin, pinAt, pinFlips } from "./marks";
import "./pins.css";

/** Who wrote a comment, by name, as the pins and the peek say it. */
export function usePinAuthor() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (pin: MediaPin) => {
    const author = pin.message.author;
    if (author.type === "agent") return (author.id && dir.anyAgent(author.id)?.name) || t("channel.unknownAgent");
    return (author.id && dir.memberById.get(author.id)?.name) || t("channel.unknownPerson");
  };
}

/** A comment's face: the agent's or the person's, small. */
export function PinFace({ pin, name }: { pin: MediaPin; name: string }) {
  const author = pin.message.author;
  return author.type === "agent" && author.id ? (
    <AgentAvatar agentId={author.id} name={name} size="xs" />
  ) : (
    <PersonAvatar id={author.id ?? ""} name={name} size="xs" />
  );
}

/**
 * The comments pinned on a picture, a video's frame or a PDF's page (ADR 0208), over its box (fractions of it): each
 * one the face of who wrote it and its number, as the canvas draws its pins; an area's outline shows for the comment
 * open now. A resolved one is gone unless `showResolved`, then faded with the others made on an older version. A press
 * opens the conversation at it; `peek` shows its words on hover (the viewer, which has no conversation beside it).
 */
export function MediaPins({
  pins,
  focusId,
  showResolved,
  peek,
  onOpen,
}: {
  pins: readonly MediaPin[];
  focusId?: string | null;
  showResolved: boolean;
  peek?: boolean;
  onOpen: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = usePinAuthor();
  const [hover, setHover] = useState<string | null>(null);
  const shown = pins.filter((p) => p.selection.mark && (showResolved || !p.resolved || p.message.id === focusId));
  if (!shown.length) return null;
  const focus = shown.find((p) => p.message.id === focusId);
  const area = focus?.selection.mark?.w !== undefined ? focus.selection.mark : null;
  const peeked = peek ? shown.find((p) => p.message.id === hover) : undefined;
  return (
    <div className="mf-pins">
      {area && (
        <span
          className="mf-area"
          style={{
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${(area.w ?? 0) * 100}%`,
            height: `${(area.h ?? 0) * 100}%`,
          }}
          aria-hidden="true"
        />
      )}
      {shown.map((pin) => {
        const mark = pin.selection.mark;
        if (!mark) return null;
        const at = pinAt(mark);
        const name = nameOf(pin);
        const words = pin.message.body.replace(/\s+/g, " ").trim();
        return (
          <button
            key={pin.message.id}
            type="button"
            className={cx(
              "mf-pin",
              pin.message.id === focusId && "mf-pin--on",
              (pin.old || pin.resolved) && "mf-pin--faded",
            )}
            data-pin={pin.message.id}
            data-flip={pinFlips(at.x) || undefined}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
            aria-label={t("live.canvas.comment.pin", { n: pin.n, name })}
            title={
              peek
                ? undefined
                : pin.old && pin.selection.version
                  ? t("files.comments.fromVersion", { version: pin.selection.version })
                  : words
                    ? `${name}: ${words.length > 120 ? `${words.slice(0, 119)}…` : words}`
                    : name
            }
            onPointerDown={(e) => e.stopPropagation()}
            onPointerEnter={() => setHover(pin.message.id)}
            onPointerLeave={() => setHover((h) => (h === pin.message.id ? null : h))}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(pin.message.id);
            }}
          >
            <PinFace pin={pin} name={name} />
            <span className="mf-pin__n tabular">{pin.n}</span>
          </button>
        );
      })}
      {peeked?.selection.mark && <PinPeek pin={peeked} name={nameOf(peeked)} />}
    </div>
  );
}

/**
 * A pin's words on hover, in the viewer with its comments closed: who, when, what, and that a click opens them there.
 * On the picture's right half it opens to the pin's left.
 */
function PinPeek({ pin, name }: { pin: MediaPin; name: string }) {
  const { t, i18n } = useTranslation();
  const mark = pin.selection.mark;
  if (!mark) return null;
  const at = pinAt(mark);
  const when = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(pin.message.createdAt),
  );
  const words = pin.message.body.replace(/\s+/g, " ").trim();
  return (
    <div
      className="mf-peek ac-glass"
      data-flip={at.x > 0.5 || undefined}
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      role="tooltip"
    >
      <div className="mf-peek__head">
        <PinFace pin={pin} name={name} />
        <b>{name}</b>
        <time dateTime={pin.message.createdAt}>{when}</time>
      </div>
      {words && <p className="mf-peek__words">{words.length > 220 ? `${words.slice(0, 219)}…` : words}</p>}
      <span className="mf-peek__go">{t("files.comments.peekOpen")}</span>
    </div>
  );
}
