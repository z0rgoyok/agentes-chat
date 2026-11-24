import type { Agent, Message } from "@agenteschat/client";
import { useAiAccounts } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { mayPickModel } from "@agenteschat/client/lib/brain-picker";

import { modelStandInKey } from "@agenteschat/client/lib/plan-usage";
import { planOf } from "@agenteschat/client/lib/plans";

import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { BrainIcon, cx, EventPill, EventPillAction, Icon, ProviderLogo } from "@agenteschat/ui";

import { cloneElement, type ReactElement, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenAgentPanel } from "@/components/agent-panel-context";

import { useOrg } from "@/components/org-context";
import { useAgentThinks } from "@/hooks/useAgentThinks";

import { AiChoiceDialog } from "./AiChoiceDialog";
import { UseOnAgentsDialog } from "./UseOnAgents";
import "./model-picker.css";

/**
 * The agent's AI and model, changed in place (a DM's header, its profile card, its side panel): a button saying what
 * it thinks with, opening the picker under the agent's sky. Whoever can't change it (not an admin, not its owner)
 * reads the same words, with nothing to press. `status`: a code session's status line under its composer (ADR 0215),
 * quiet words with `after` (its plan's limits) in them, a plate only under the pointer.
 */
export function ModelPickerButton({
  agent,
  size = "sm",
  className,
  after,
}: {
  agent: Agent;
  size?: "sm" | "row" | "status";
  className?: string;
  /** In it after the model, on a `status` line. */
  after?: ReactNode;
}) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const thinks = useAgentThinks(agent);
  if (!thinks?.text) return null;
  const mark = thinks.mark ? <ProviderLogo id={thinks.mark} size="xs" /> : <BrainIcon kind={thinks.kind} size={14} />;
  // The team's right hand thinks with each person's own AI ("Sua IA"), set where that is: never picked here.
  if (!mayPickModel(agent, me.user.id, managesAgent(agent)))
    return (
      <span
        className={cx("mp-label", className)}
        data-size={size}
        title={isRightHand(agent) ? undefined : t("brain.picker.readOnly")}
      >
        {mark}
        <span className="mp-label__text">{thinks.text}</span>
        {size === "status" && after}
      </span>
    );
  return (
    <ModelPickerPopover
      agent={agent}
      trigger={(open) => (
        <button
          type="button"
          className={cx("mp-trigger", className)}
          data-size={size}
          aria-label={t("brain.picker.open", { agent: agent.name })}
          aria-expanded={open}
        >
          {mark}
          <span className="mp-label__text">{thinks.text}</span>
          {size === "status" && after}
          <Icon name="chevronDown" size={14} className="mp-trigger__chevron" />
        </button>
      )}
    />
  );
}

/**
 * The picker, opened from `trigger` (the header's button, a reply's "Escolher modelo"): the one "Quem pensa" dialog, the
 * agent's sky at its top, "Mais opções" leading to its page's settings.
 */
function ModelPickerPopover({ agent, trigger }: { agent: Agent; trigger: (open: boolean) => ReactElement }) {
  const { t } = useTranslation();
  const openPanel = useOpenAgentPanel();
  const [open, setOpen] = useState(false);
  return (
    <>
      {cloneElement(trigger(open) as ReactElement<{ onClick?: () => void; "aria-haspopup"?: string }>, {
        onClick: () => setOpen(true),
        "aria-haspopup": "dialog",
      })}
      <AiChoiceDialog
        open={open}
        onClose={() => setOpen(false)}
        agent={agent}
        target={{ kind: "agent", agentId: agent.id }}
        title={t("brain.picker.open", { agent: agent.name })}
        note={t("brain.picker.applies")}
        links={
          openPanel
            ? [
                {
                  label: t("brain.picker.more"),
                  onOpen: () => {
                    setOpen(false);
                    openPanel(agent.id, "settings", "brain:more");
                  },
                },
              ]
            : []
        }
      />
    </>
  );
}

/**
 * Under a reply "Automático" gave with another model because the plan refused the one it maps to
 * (`meta.modelStandIn`). Whoever may change the agent gets "Usar o <modelo> em todos" (the key's dialog, on that
 * model) when the key is theirs to share, and "Escolher modelo" (the picker).
 */
export function ModelStandInLine({
  text,
  agent,
  meta,
}: {
  text: string;
  agent?: Agent | undefined;
  meta: Message["meta"];
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const may = mayPickModel(agent, me.user.id, managesAgent(agent));
  const key = may ? modelStandInKey(meta) : null;
  const ai = useAiAccounts(org.id, Boolean(key));
  const account = key
    ? ai.data?.accounts.find((a) => a.id === key.account && a.machineId === key.machineId && a.status === "active")
    : undefined;
  const [all, setAll] = useState(false);
  return (
    <>
      <EventPill
        className="cn-pill cn-pill--part"
        mark={<Icon name="info" size={14} />}
        actions={
          may &&
          agent && (
            <>
              {key && account && planOf(account.provider) && (
                <EventPillAction onClick={() => setAll(true)}>
                  {t("chat.modelStandIn.useAll", { model: key.to })}
                </EventPillAction>
              )}
              <ModelPickerPopover
                agent={agent}
                trigger={(open) => (
                  <EventPillAction aria-expanded={open}>{t("chat.modelStandIn.pick")}</EventPillAction>
                )}
              />
            </>
          )
        }
      >
        {text}
      </EventPill>
      {all && account && key && (
        <UseOnAgentsDialog
          initial={{ brain: account.kind, account: account.id, machineId: account.machineId, model: key.model }}
          allPicked
          onClose={() => setAll(false)}
        />
      )}
    </>
  );
}
