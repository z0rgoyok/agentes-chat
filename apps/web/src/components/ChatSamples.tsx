import type { ChatStyle, ChatTextSize } from "@agenteschat/client/lib/chat-look";
import { type AgentColor, Avatar, cx, Message, MessageLookContext, MessageText } from "@agenteschat/ui";
import { type ReactNode, useContext } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";

/**
 * A few real rows of a conversation, drawn by its own code and scaled down: the pictures of Settings › Conversations
 * (ChatLookSettings.tsx) and the background picker's preview (WallpaperDialog.tsx).
 */

/** The agent of the samples, the pixel face a DM has. */
export const SAMPLE_AGENT = { color: "green" as AgentColor, name: "Ada" };

export interface SampleLine {
  who: "me" | "agent";
  text: string;
  time: string;
  /** Its place in its author's run. */
  run?: "solo" | "start" | "mid" | "end";
}

/** A few real rows, drawn by the conversation's own code. */
export function SampleRows({
  lines,
  children,
}: {
  lines: SampleLine[];
  children?: (line: SampleLine, row: ReactNode) => ReactNode;
}) {
  const { me } = useOrg();
  // A DM's two speakers need no name in the bubble: the conversation's own rows wrap it to hide it, so do these.
  const names = useContext(MessageLookContext)?.names !== false;
  return lines.map((line) => {
    const agent = line.who === "agent";
    const run = line.run ?? "solo";
    const row = (
      <Message
        key={line.text}
        agent={agent}
        own={!agent}
        run={run}
        grouped={run === "mid" || run === "end"}
        avatar={
          agent ? (
            <AgentAvatar name={SAMPLE_AGENT.name} appearance={{ color: SAMPLE_AGENT.color }} />
          ) : (
            <Avatar kind="person" name={me.user.name} imageUrl={me.user.image ?? undefined} />
          )
        }
        author={
          agent && !names ? (
            <span className="ac-visually-hidden">{SAMPLE_AGENT.name}</span>
          ) : agent ? (
            SAMPLE_AGENT.name
          ) : (
            me.user.name
          )
        }
        time={line.time}
      >
        <MessageText>
          <div className="md md--message">
            <p>{line.text}</p>
          </div>
        </MessageText>
      </Message>
    );
    return children ? children(line, row) : row;
  });
}

/** The rows' box: a conversation's list in the look `look`, scaled down, out of the page's focus and reading. */
export function SampleMini({
  className,
  look,
  size,
  faces = true,
  wallpaper,
  children,
}: {
  className?: string;
  look: ChatStyle;
  /** Its own Text size: the looks' small pictures stay at the default, the size's preview shows the choice. */
  size: ChatTextSize;
  faces?: boolean;
  /** Over a background (its kind): the bubbles lift off it as in the conversation. */
  wallpaper?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("chat-look__mini", className)} data-text-size={size} aria-hidden="true" inert>
      <span
        className="channel__messages"
        data-look={look}
        data-faces={faces ? undefined : "false"}
        data-wallpaper={wallpaper}
      >
        {children}
      </span>
    </span>
  );
}
