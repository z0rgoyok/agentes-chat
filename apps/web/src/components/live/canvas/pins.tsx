import { type Artifact, keys, type Message, messageLiveRef, useThreadMessages } from "@agenteschat/client";
import type { Point } from "@agenteschat/live/canvas";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { type Camera, type Size, toScreen } from "./camera";

/**
 * Comments pinned on the canvas (ADR 0199): each is a message of the file's own conversation whose `liveRef` names a
 * point of this canvas. The plane draws them where they point (in world units, so a pin follows the view as it pans
 * and zooms), as the face of who wrote it and its number, oldest first; a press opens the conversation at it.
 */

export interface CanvasPin {
  message: Message;
  point: Point;
  /** 1 for the oldest. */
  n: number;
}

/** The messages that pin a point on this file, numbered oldest first. */
export function pinsOf(messages: readonly Message[], artifactId: string): CanvasPin[] {
  const out: CanvasPin[] = [];
  for (const m of messages) {
    const ref = messageLiveRef(m);
    const point = ref?.artifactId === artifactId ? ref.selection?.point : undefined;
    if (point) out.push({ message: m, point, n: out.length + 1 });
  }
  return out;
}

/** Pins further than this off the plane's edges aren't drawn (screen pixels). */
const OFF_SCREEN = 48;

export const CommentPins = memo(function CommentPins({
  artifact,
  cam,
  stage,
  onOpen,
}: {
  artifact: Pick<Artifact, "id" | "conversation">;
  cam: Camera;
  stage: Size;
  onOpen(messageId: string): void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const qc = useQueryClient();
  const talk = artifact.conversation ?? null;
  const messages = useThreadMessages(org.id, talk?.channelId, talk?.rootId ?? "");
  // With the conversation closed nothing else reads it: a new message there (the file's count moves) reads it again.
  const counted = useRef(talk?.count);
  useEffect(() => {
    if (!talk || counted.current === talk.count) return;
    counted.current = talk.count;
    void qc.invalidateQueries({ queryKey: keys.thread(org.id, talk.channelId, talk.rootId), exact: true });
  }, [qc, org.id, talk]);
  const pins = useMemo(() => pinsOf(messages.data ?? [], artifact.id), [messages.data, artifact.id]);
  if (!pins.length) return null;
  return (
    <div className="cnv-pins">
      {pins.map((pin) => {
        const at = toScreen(cam, pin.point);
        if (at.x < -OFF_SCREEN || at.y < -OFF_SCREEN || at.x > stage.w + OFF_SCREEN || at.y > stage.h + OFF_SCREEN) {
          return null;
        }
        const author = pin.message.author;
        const agent = author.type === "agent" && author.id ? dir.anyAgent(author.id) : undefined;
        const name =
          author.type === "agent"
            ? (agent?.name ?? t("channel.unknownAgent"))
            : ((author.id && dir.memberById.get(author.id)?.name) ?? t("channel.unknownPerson"));
        const words = pin.message.body.replace(/\s+/g, " ").trim();
        const label = t("live.canvas.comment.pin", { n: pin.n, name });
        return (
          <button
            key={pin.message.id}
            type="button"
            className="cnv-pin"
            data-pin={pin.message.id}
            style={{ left: at.x, top: at.y }}
            aria-label={label}
            title={words ? `${name}: ${words.length > 120 ? `${words.slice(0, 119)}…` : words}` : name}
            onClick={() => onOpen(pin.message.id)}
          >
            {author.type === "agent" && author.id ? (
              <AgentAvatar agentId={author.id} name={name} size="xs" />
            ) : (
              <PersonAvatar id={author.id ?? ""} name={name} size="xs" />
            )}
            <span className="cnv-pin__n tabular">{pin.n}</span>
          </button>
        );
      })}
    </div>
  );
});
