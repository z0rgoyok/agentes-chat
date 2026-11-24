import { isPinnedSelection, type Message, messageLiveRef, resolvedOf, useResolveComment } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { Button, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** A comment with a pin on a picture, a video or a PDF (ADR 0208): it can be resolved. */
export const isResolvable = (message: Message) =>
  !message.local && isPinnedSelection(messageLiveRef(message)?.selection);

/** "Resolve" / "Reopen" on a comment's hover bar: its pin leaves the file (or comes back); the message stays. */
export function ResolveButton({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const resolve = useResolveComment(org.id);
  if (!isResolvable(message)) return null;
  const resolved = resolvedOf(message.meta) !== null;
  const label = resolved ? t("files.comments.reopen") : t("files.comments.resolve");
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon="check"
      aria-label={label}
      aria-pressed={resolved}
      title={label}
      onClick={() =>
        resolve.mutate({
          channelId: message.channelId,
          messageId: message.id,
          resolved: !resolved,
          by: { type: "person", id: me.user.id },
        })
      }
    />
  );
}

/** Under a resolved comment: "Resolved by Iris · 14:05", quietly. */
export function ResolvedLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const resolved = resolvedOf(message.meta);
  if (!resolved || !isResolvable(message)) return null;
  const name =
    resolved.by.type === "agent"
      ? (dir.anyAgent(resolved.by.id)?.name ?? t("channel.unknownAgent"))
      : (dir.memberById.get(resolved.by.id)?.name ?? t("channel.unknownPerson"));
  return (
    <p className="lf-resolved ac-iconline">
      <Icon name="check" size={14} />
      <span>{t("files.comments.resolvedBy", { name, time: formatTime(i18n.language, resolved.at) })}</span>
    </p>
  );
}
