import { LONG_MESSAGE } from "@agenteschat/client/lib/message-length";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOverflows } from "@/hooks/useOverflows";
import { useReveal } from "@/hooks/useReveal";

/**
 * A message's words in a conversation: one taller than `LONG_MESSAGE.over` (the `.msg-clip` rules) shows its start,
 * faded, with "Ver mais", and so does a long message from one agent to another, folded to its `lead` (ADR 0034).
 * "Ver mais" opens the words in place, for good (no "Ver menos"): they grow down from the fold and the list stops
 * following its end, so the reader stays on them. `children` draws the words (`lead` while folded to it) with the class
 * it is given on their own root: no box goes around them, since the bubble's rules read the words as the direct child
 * of the message's text.
 */
export function ClippedBody({
  lead,
  children,
}: {
  lead?: string | undefined;
  children: (className: string, lead?: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  const foot = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = foot.current?.previousElementSibling;
    words.current = el instanceof HTMLElement ? el : null;
  }, []);
  const [open, setOpen] = useState(false);
  const cut = useOverflows(words, !open, LONG_MESSAGE.over);
  const reveal = useReveal(words, open);
  const folded = !open && (cut || lead !== undefined);
  return (
    <>
      {children(cut && !open ? "msg-clip msg-clip--cut" : "msg-clip", open ? undefined : lead)}
      {/* Always there, to find the words by; empty under a message that shows whole, so its text reads as its words alone. */}
      <div ref={foot} className="msg-clip__foot" hidden={!folded}>
        {folded && (
          <button
            type="button"
            className="ac-link msg-clip__more"
            onClick={() => {
              reveal();
              actions?.letGo?.();
              setOpen(true);
            }}
          >
            {t("channel.long.more")}
          </button>
        )}
      </div>
    </>
  );
}
