import type { Artifact } from "@agenteschat/client";
import { useArtifact, useFileUnread } from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { badgeCount } from "@agenteschat/client/lib/unread";
import { Button, CountBadge, CountChip } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useMaybeArtifactViewer } from "@/components/artifacts/viewer-context";
import { useOrg } from "@/components/org-context";
import { ThreadLineBody } from "@/components/threads/ThreadLines";

/*
 * A picture's, a video's or a PDF's comments outside the viewer's body (ADR 0208): "Comments N" in its header, and
 * the line under a posted file in the chat. Both lead to the viewer with the comments open.
 */

/**
 * "Comments 2" in the viewer's header: opens or closes the file's comments beside it. A mention of me there adds its
 * red number.
 */
export function ViewerCommentsButton({
  artifact,
  open,
  onToggle,
}: {
  artifact: Artifact;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { mentions } = useFileUnread(org.id, artifact.id);
  const count = artifact.conversation?.count ?? 0;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="comment"
      className="viewer-comments"
      aria-pressed={open}
      title={t("files.comments.title")}
      onClick={onToggle}
    >
      {/* Like the viewer's other actions: the words go on a narrow screen, the icon and the count stay. */}
      <span className="artifact-action__label">{t("files.comments.title")}</span>
      {count > 0 && <CountChip size="sm">{count}</CountChip>}
      {mentions > 0 && (
        <CountBadge
          className="task-talk__mentions"
          role="img"
          aria-label={t("shell.unreadMentions", { count: mentions })}
        >
          {badgeCount(mentions)}
        </CountBadge>
      )}
    </Button>
  );
}

/**
 * Under a picture, a video or a PDF posted in a conversation, once it has comments: who commented, "3 comments on
 * the image" and when, the look of a thread's line; a press opens it in the viewer with its comments open.
 */
export function ChatCommentsLine({ artifactId, version }: { artifactId: string; version?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useMaybeArtifactViewer();
  // The card's own query (the same version): read once for both.
  const artifact = useArtifact(org.id, artifactId, version).data;
  const media = mediaKindOfArtifact(artifact);
  const talk = artifact?.conversation;
  if (!media || !talk || talk.count === 0) return null;
  return (
    <button
      type="button"
      className="thread-line mf-chatline"
      onClick={() => viewer?.open(artifactId, version, undefined, {})}
    >
      <ThreadLineBody
        people={talk.participants}
        label={t(`files.comments.line.${media}` as "files.comments.line.image", { count: talk.count })}
        at={talk.lastAt}
      />
    </button>
  );
}
