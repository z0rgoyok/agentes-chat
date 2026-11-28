import type { ThreadInfo } from "@agenteschat/client";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { AvatarStack, Button, cx, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { MetaLine } from "@/components/MetaLine";
import { NavToggle } from "@/components/NavDrawer";

/**
 * The conversation's header in the panel: who is in it, "Conversa da tarefa", "Bruno, Walter e Theo · 5 mensagens
 * · agora", and close. No title to rename and no thread states: the task is its title and its state. A live file's
 * conversation is the same (ADR 0199) with its own `title` ("Conversa do quadro") and close words.
 */
export function TaskConversationHeader({
  thread,
  onClose,
  title,
  closeLabel,
}: {
  thread: ThreadInfo;
  onClose?: () => void;
  title?: string;
  closeLabel?: string;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const people = thread.participants.flatMap((p) => (p.id && p.type !== "app" ? [{ type: p.type, id: p.id }] : []));
  const names = joinNames(
    people.slice(0, 4).map((p) => actors.name(p)),
    t,
  );
  return (
    <header className={cx("channel__header thread-head", onClose && "thread-head--panel")}>
      {!onClose && <NavToggle />}
      <span className="thread-head__who" aria-hidden="true">
        {people.length > 0 ? (
          <AvatarStack>{people.slice(0, 3).map((p) => actors.avatar(p, "sm"))}</AvatarStack>
        ) : (
          <Icon name="message" size={18} />
        )}
      </span>
      <div className="thread-head__text">
        <h1 className="channel__title thread-title">
          <span className="thread-title__text">{title ?? t("issues.conversation.title")}</span>
        </h1>
        <MetaLine
          where={names}
          parts={[
            thread.replyCount > 0 && t("issues.conversation.messages", { count: thread.replyCount }),
            <time key="at" dateTime={thread.lastActivityAt}>
              {relativeTime(t, i18n.language, thread.lastActivityAt)}
            </time>,
          ]}
        />
      </div>
      {onClose && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={closeLabel ?? t("issues.conversation.close")}
          title={closeLabel ?? t("issues.conversation.close")}
          onClick={onClose}
        />
      )}
    </header>
  );
}
