import { cx, Icon } from "@agenteschat/ui";
import type { CSSProperties } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./group-conversation.css";

/** The most faces a group's face shows: four, or three and how many else. */
const FACES = 4;

/**
 * A personal workspace's group conversation as one face (ADR 0159, amendment of 2026-11-26): its agents' own tiles in
 * the box of one face, two on a diagonal, three as two over one, four as two by two, more as three and "+N". With no
 * agent, an empty tile with the people mark. `size` is the box's side; the sidebar's comes from its tokens instead.
 */
export function GroupFace({
  agentIds,
  count = agentIds.length,
  size,
  className,
}: {
  /** Its agents, in the order they joined (the channel list's `agentIds`, or its members). */
  agentIds: readonly string[];
  /** How many agents it has in all, when `agentIds` holds only the first ones. */
  count?: number;
  size?: number;
  className?: string;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const total = Math.max(count, agentIds.length);
  const shown = agentIds.slice(0, total > FACES ? FACES - 1 : FACES);
  const more = total - shown.length;
  const style = size ? ({ "--group-face": `${size}px` } as CSSProperties) : undefined;
  if (shown.length === 0) {
    return (
      <span className={cx("group-face group-face--empty", className)} style={style} aria-hidden="true">
        <Icon name="members" />
      </span>
    );
  }
  return (
    <span className={cx("group-face", className)} data-count={Math.min(total, FACES)} style={style} aria-hidden="true">
      {shown.map((id) => (
        <span key={id} className="group-face__cell">
          <AgentAvatar agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="sm" />
        </span>
      ))}
      {more > 0 && <span className="group-face__more">+{more}</span>}
    </span>
  );
}
