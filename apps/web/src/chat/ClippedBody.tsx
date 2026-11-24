import { LONG_MESSAGE, shownWhole } from "@agenteschat/client/lib/message-length";
import { Icon } from "@agenteschat/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useOverflows } from "@/hooks/useOverflows";
import { useReveal } from "@/hooks/useReveal";

/**
 * A message's words in a conversation: one taller than `LONG_MESSAGE.over` (the `.msg-clip` rules) shows its start,
 * faded, with "Ver mais", and so does a long message from one agent to another, folded to its `lead` (ADR 0034).
 * "Ver mais" opens the words in place, for good (no "Ver menos"): they grow down from the fold and the list stops
 * following its end, so the reader stays on them. `children` draws the words (`lead` while folded to it) with the class
 * it is given on their own root: no box goes around them, since the bubble's rules read the words as the direct child
 * of the message's text. One `addressed` to the reader (their answer, `answerIds`, or a mention of them) shows whole
 * however long, and so does one shown whole before in this session (`shownWhole`).
 */
export function ClippedBody({
  id,
  addressed = false,
  lead,
  children,
}: {
  id: string;
  addressed?: boolean;
  lead?: string | undefined;
  children: (className: string, lead?: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  const fullMessages = useOrg().org.chatPrefs?.fullMessages === true;
  const foot = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = foot.current?.previousElementSibling;
    words.current = el instanceof HTMLElement ? el : null;
  }, []);
  // An agent's message to another folded to its lead is not the reader's answer: only "Ver mais" opens it.
  if (addressed && lead === undefined) shownWhole.add(id);
  const [open, setOpen] = useState(() => shownWhole.has(id));
  const expanded = open || fullMessages || (lead === undefined && shownWhole.has(id));
  const cut = useOverflows(words, !expanded, LONG_MESSAGE.over, LONG_MESSAGE.shows) && !expanded;
  const reveal = useReveal(words, open);
  const folded = !expanded && (cut || lead !== undefined);
  return (
    <>
      {children(cut ? "msg-clip msg-clip--cut" : "msg-clip", expanded ? undefined : lead)}
      {/* Always there, to find the words by; empty under a message that shows whole, so its text reads as its words alone. */}
      <div ref={foot} className="msg-clip__foot" hidden={!folded}>
        {folded && (
          <button
            type="button"
            className="ac-link msg-clip__more"
            onClick={() => {
              reveal();
              actions?.letGo?.();
              shownWhole.add(id);
              setOpen(true);
            }}
          >
            {t("channel.long.more")}
            <Icon name="chevronDown" size={16} inline />
          </button>
        )}
      </div>
    </>
  );
}
