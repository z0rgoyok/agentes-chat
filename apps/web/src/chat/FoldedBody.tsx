import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useOverflows } from "@/hooks/useOverflows";
import { useReveal } from "@/hooks/useReveal";

/**
 * A long text an agent wrote, on a page rather than in a conversation: its Markdown as a message's, folded until
 * "Ver mais" opens it in place, for good.
 */
export function FoldedBody({ body }: { body: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Only what this width really cuts: the same text may fit whole on a wide page and not on a phone.
  const cut = useOverflows(box, !open);
  const reveal = useReveal(box, open);
  return (
    <div className="folded-body">
      <div
        ref={box}
        className="folded-body__text"
        data-folded={open ? undefined : ""}
        data-cut={cut && !open ? "" : undefined}
      >
        <MessageBody body={body} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
      </div>
      {cut && !open && (
        <button
          type="button"
          className="ac-link folded-body__more"
          onClick={() => {
            reveal();
            setOpen(true);
          }}
        >
          {t("channel.long.more")}
        </button>
      )}
    </div>
  );
}
