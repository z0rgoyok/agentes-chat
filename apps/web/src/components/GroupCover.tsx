import type { Agent, Member } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import type { TFunction } from "i18next";
import { useRef } from "react";
import { GroupFace } from "@/components/GroupFace";
import { AgentCover } from "@/components/Sky";
import "./group-conversation.css";

/** Who a group conversation holds, as its header and cover say it: "Você, Ana, Teo e Rita" (me, people, agents). */
export function groupWho(t: TFunction, meId: string, people: readonly Member[], agents: readonly Agent[]): string {
  const others = people.filter((p) => p.userId !== meId).map((p) => p.name);
  return joinNames([t("channel.groupYou"), ...others, ...agents.map((a) => a.name)], t);
}

/**
 * A personal workspace's group conversation opens with a cover (ADR 0159, amendment of 2026-11-26), as an agent's page
 * does: the sky in the agents' blue, the group's face on its foot, its name and who is in it. `hint`: what to do
 * first, while the conversation is empty.
 */
export function GroupCover({
  name,
  agentIds,
  who,
  hint,
}: {
  name: string;
  agentIds: readonly string[];
  who: string;
  hint?: string;
}) {
  const face = useRef<HTMLSpanElement>(null);
  return (
    <section className="group-cover" aria-label={name}>
      <div className="agp-cover group-cover__band">
        <AgentCover color="sky" busy={false} at={0.12} clear={() => [face.current]} />
      </div>
      <div className="group-cover__row">
        <span className="group-cover__face" ref={face}>
          <GroupFace agentIds={agentIds} size={88} />
        </span>
        <div className="group-cover__ident">
          <h2 className="group-cover__title">{name}</h2>
          <p className="group-cover__who">{who}</p>
        </div>
      </div>
      {hint && <p className="group-cover__hint">{hint}</p>}
    </section>
  );
}
