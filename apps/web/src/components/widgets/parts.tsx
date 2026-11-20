import type { Widget, WidgetKind, WidgetWait } from "@agenteschat/client";
import {
  useDesktopStatus,
  useWidgetLacksAi,
  widgetFailureText,
  widgetNeedsAi,
  widgetWaitFix,
  widgetWaiting,
  widgetWaitText,
} from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { relativeTime } from "@agenteschat/client/lib/format";
import { maySetAgentAi, noAiLockedLine, planKeyIntent } from "@agenteschat/client/lib/no-ai";
import { type AgentColor, Icon, PixelSpinner } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { useOpenComputer } from "@/components/computer/open";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/** The widget's agent as a board shows it: its name and its color (sky when it is gone). */
export function useWidgetAgent(agentId: string) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  return { agent, name: agent?.name ?? t("channel.unknownAgent"), color: colorOf(agent) };
}

/** The face of the agent who looks after a widget, at the start of its card's title (`WidgetCard`'s `face`). */
export function WidgetFace({ agentId, name }: { agentId: string; name: string }) {
  return <AgentAvatar agentId={agentId} name={name} size="xs" />;
}

/** What a widget is called until its agent names it: its kind ("Number", "Bars"…), or "New widget" (ADR 0135). */
export function neutralWidgetTitle(t: TFunction, kind: WidgetKind | null): string {
  return kind ? t(`widgets.kinds.${kind}`) : t("widgets.untitled");
}

/**
 * A widget's title as boards and its panel show it. The agent names it on its first build; until then (or when an
 * older widget still holds the start of what was asked) the neutral name, never the raw ask (ADR 0135).
 */
export function widgetTitle(t: TFunction, w: Pick<Widget, "title" | "prompt" | "spec" | "kind" | "format">): string {
  const title = w.title.trim();
  const ask = w.prompt.trim();
  if (title && (w.spec || !ask || !ask.startsWith(title))) return w.title;
  return neutralWidgetTitle(t, w.kind ?? (w.format === "auto" ? null : w.format));
}

/** Why a widget stopped updating, in the reader's words (`widgetFailureText`). */
export const failureText = widgetFailureText;

/** The words over a widget with no data yet: its agent building it, or waiting for an AI to build it with. */
export const widgetBodyText = (t: TFunction, widget: Pick<Widget, "status" | "failure">, name: string) =>
  widgetNeedsAi(widget) ? t("widgets.needsAi.body", { name }) : t("widgets.status.building", { name });

/**
 * What a widget waiting for an AI offers the viewer (the board, its panel, its notice, New widget's test): Connect to
 * whoever may set its agent's AI (for the right hand the workspace's, which a build falls back to when the AI of
 * whoever made the widget can't think; on a plan that can't take it, `reason` a plan line, a key: `planKeyIntent`),
 * else who can. Nothing on a billing hold (an AI comes after the plan, which the hold's own banner says).
 */
export function useWidgetAiWay(
  agentId: string | null | undefined,
  reason?: string | null,
): { connect: () => void } | { locked: string } | null {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  if (!agent || !connect || held) return null;
  if (maySetAgentAi(agent, me.user.id, org))
    return { connect: () => connect.open({ agentId: agent.id, ...planKeyIntent(agent, reason) }) };
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : null;
  return { locked: noAiLockedLine(t, agent.name, owner) };
}

/** After the reason of a widget waiting for an AI: Connect, or who can connect it (`useWidgetAiWay`). */
function NeedsAiWay({ agentId, reason }: { agentId: string; reason: string | null }) {
  const { t } = useTranslation();
  const way = useWidgetAiWay(agentId, reason);
  if (!way) return null;
  if (!("connect" in way)) return way.locked;
  return (
    <button
      type="button"
      className="wg__resolve"
      onClick={(e) => {
        e.stopPropagation();
        way.connect();
      }}
    >
      {t("noAi.action")}
    </button>
  );
}

/**
 * A widget's footer on a board (ADR 0135): who looks after it, when it last updated and how often; while it is built
 * or updated, the agent at it, or what its run waits for, with Continue now on a pause near the limit (greyed for
 * anyone but Continuar agora's people) or what ends the wait sooner (`WaitFix`); failed, why, with Resolve (an update
 * asked now); waiting for an AI, why, with Connect or who can connect it (it builds by itself once one is there,
 * `useBuildOnceAi`); stopped for the lack of one, Connect while there is none, then Resolve (`useWidgetLacksAi`).
 */
export function WidgetFoot({
  widget,
  name,
  color,
  now,
  onResolve,
  resolving = false,
}: {
  widget: Widget;
  name: string;
  color: AgentColor;
  now: number;
  /** Resolve, or Continue now on a pause: an update asked now (only for whoever may). */
  onResolve?: () => void;
  /** An update asked now is on its way. */
  resolving?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const needsAi = useWidgetLacksAi(org.id, widget);
  const schedule = t(`widgets.schedulesInline.${widget.schedule}`);
  const waiting = resolving ? null : widgetWaiting(widget, now);
  if (waiting)
    return (
      <span className="wg__wait ac-iconline" role="status">
        <Icon name="pause" size={14} />
        <span>
          {widgetWaitText(t, i18n.language, waiting, name, new Date(now))}{" "}
          {waiting.code !== "usage_pause" ? (
            <WaitFix agentId={widget.agentId} wait={waiting} />
          ) : onResolve ? (
            <button
              type="button"
              className="wg__resolve"
              disabled={!waiting.canContinue}
              title={t(
                !waiting.canContinue
                  ? "usageCard.forbidden"
                  : waiting.source === "budget"
                    ? "usageCard.hintBudget"
                    : "usageCard.hint",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onResolve();
              }}
            >
              {t("usageCard.continue")}
            </button>
          ) : null}
        </span>
      </span>
    );
  if (widget.status === "building")
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">
          {name} <span className="wg__dot">·</span> {schedule}
        </span>
      </>
    );
  if (widget.status === "updating" || resolving)
    return (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when">{t("widgets.status.updating", { name })}</span>
      </>
    );
  if (widget.status === "failed") {
    return (
      <span className="wg__warn ac-iconline" role="status">
        <Icon name={needsAi ? "plug" : "alert"} size={14} />
        <span>
          {failureText(t, widget.failure, name)}{" "}
          {needsAi ? (
            <NeedsAiWay agentId={widget.agentId} reason={widget.failure?.detail ?? null} />
          ) : (
            onResolve && (
              <button
                type="button"
                className="wg__resolve"
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve();
                }}
              >
                {t("widgets.failure.resolve")}
              </button>
            )
          )}
        </span>
      </span>
    );
  }
  // The agent's face leads the card's title (`WidgetCard`'s `face`): the footer only says who and when.
  return (
    <span className="wg__when">
      <b>{name}</b>
      {widget.refreshedAt && (
        <>
          {" "}
          <span className="wg__dot">·</span> {relativeTime(t, i18n.language, widget.refreshedAt, new Date(now))}
        </>
      )}{" "}
      <span className="wg__dot">·</span> {schedule}
    </span>
  );
}

/**
 * What ends a widget's wait sooner, beside its words, for who may do it (`widgetWaitFix`): the agent's budget or model
 * on its page, or its computer opened in place for whoever may watch it.
 */
function WaitFix({ agentId, wait }: { agentId: string; wait: WidgetWait }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const openComputer = useOpenComputer();
  const agent = dir.anyAgent(agentId);
  const owner = agent?.ownerUserId === me.user.id;
  const fix = widgetWaitFix(wait, { admin: managesAgent(agent), owner });
  const watches = useDesktopStatus(org.id, agentId, { enabled: fix === "openComputer" }).isSuccess;
  const stop = (e: MouseEvent) => e.stopPropagation();
  if (fix === "openComputer")
    return watches ? (
      <button
        type="button"
        className="wg__resolve"
        onClick={(e) => {
          stop(e);
          openComputer(agentId);
        }}
      >
        {t("queue.openComputer")}
      </button>
    ) : null;
  if (!fix) return null;
  return (
    <Link
      to="/org/$orgId/agents/$agentId"
      params={{ orgId: org.id, agentId }}
      search={{ tab: "settings", sec: fix === "raiseBudget" ? "budget" : "brain" }}
      className="wg__resolve"
      onClick={stop}
    >
      {t(`usageCard.${fix}`)}
    </Link>
  );
}

/**
 * A board's head controls as one pill (ADR 0135): "Organize" (pressed while organizing, then "Done") and "+ Widget"
 * side by side, a hairline between them. Home's mural and a board's page use it.
 */
export function BoardActionsPill({
  label,
  arranging,
  onArrange,
  onAdd,
}: {
  /** The group's name ("My Home", the board's title). */
  label: string;
  arranging: boolean;
  /** Absent: no Organize (an empty board has nothing to move). */
  onArrange?: () => void;
  /** Absent: no "+" (Home showing a board the person only sees). */
  onAdd?: () => void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: two buttons that read as one control, not a fieldset
    <span className="wb-pill" role="group" aria-label={label}>
      {onArrange && (
        <button type="button" aria-pressed={arranging} onClick={onArrange}>
          <Icon name={arranging ? "check" : "grid"} size={16} />
          {arranging ? t("widgets.organize.done") : t("widgets.organize.start")}
        </button>
      )}
      {onAdd && (
        <button type="button" aria-label={t("widgets.add.label")} title={t("widgets.add.label")} onClick={onAdd}>
          <Icon name="plus" size={16} />
          {t("widgets.add.short")}
        </button>
      )}
    </span>
  );
}
