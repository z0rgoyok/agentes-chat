import type { Agent } from "@agenteschat/client";
import { useComputerSetup, useMachines, useWorkspaceLimits } from "@agenteschat/client";
import { type PaidReturn, paidComputerLine, paidLine, paidRoom } from "@agenteschat/client/lib/billing";
import { setupView, WORKSPACE_COMPUTER_KIND, workspaceComputerOn } from "@agenteschat/client/lib/computer";
import { firstName } from "@agenteschat/client/lib/format";
import { rightHandOf, sceneTeam } from "@agenteschat/client/lib/right-hand";
import {
  Button,
  Chip,
  ComputerPortrait,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Spinner,
  useDawn,
} from "@agenteschat/ui";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePlanOffer } from "@/lib/plan-offer";
import { type SceneAgent, TeamScene } from "./TeamScene";
import "./arrival.css";

/** How far into the dawn a computer that is on lights up, and the team gets up (then greets). */
const COMPUTER_ON = 0.3;
const TEAM_UP = 0.6;

/** The workspace's own computer as the moment says it, only as it is now; null: it has none of its own. */
export type PaidComputer = { on: boolean; line: string } | null;

/** The moment's one way on: what it does and its words. */
export type PaidNext = { label: string; run: () => void } | null;

/**
 * What the moment says, read before it shows so no line changes under the person: the plan by its name and period
 * (`title`), what it gives (`room`, null when the limits can't be read), and the workspace's computer as it is now.
 */
export function usePaidFacts(orgId: string, moment: PaidReturn | null, owner: boolean) {
  const { t, i18n } = useTranslation();
  const on = moment !== null;
  const named = usePlanOffer(i18n.language, { key: moment?.plan, enabled: Boolean(moment?.plan) });
  const limits = useWorkspaceLimits(orgId, on);
  const setup = useComputerSetup(orgId, on);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const machines = useMachines(orgId, on && view?.phase === "ready");
  const computerOn = workspaceComputerOn(view, machines.data);
  const computer: PaidComputer =
    computerOn === null ? null : { on: computerOn, line: paidComputerLine(t, computerOn, owner) };
  return {
    loading: named.loading || limits.isLoading || setup.isLoading || machines.isLoading,
    title: paidLine(t, named.offer?.name, moment?.period),
    room: paidRoom(t, i18n.language, limits.data),
    computer,
  };
}

/**
 * Right after a paid Checkout (ADR 0079): night turns to day over the team, the agents get up one after another and
 * greet the person who paid, and the workspace's computer stands beside them as it is: lit when it is on, dimmed while
 * it gets ready. Decorative, as every sky is: the words beside it say the same. With reduced motion it is day at once.
 */
export function PaidScene({
  agents,
  name,
  computer,
  className,
}: {
  agents: readonly (SceneAgent & Pick<Agent, "builtin">)[];
  /** The person who paid, greeted by their first name. */
  name: string | null | undefined;
  computer: PaidComputer;
  className?: string;
}) {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  // The first frame is the night the team slept in: the dawn starts from it.
  useEffect(() => setOn(true), []);
  const day = useDawn(on);
  const lead = rightHandOf(agents);
  const team = sceneTeam(agents, lead).slice(0, 3);
  const up = day >= TEAM_UP;
  const first = firstName(name ?? "");
  return (
    <TeamScene
      className={cx("paid-scene", className)}
      agents={team}
      lead={lead?.id}
      asleep={!up}
      day={day}
      expression="happy"
    >
      {computer && (
        <ComputerPortrait
          kind={WORKSPACE_COMPUTER_KIND}
          state={computer.on && day >= COMPUTER_ON ? "online" : "paused"}
        />
      )}
      <Chip className="sky-chip paid-scene__hello" data-on={up ? "" : undefined}>
        {first ? t("paidMoment.hello", { first }) : t("paidMoment.hi")}
      </Chip>
    </TeamScene>
  );
}

/** The computer in one line: on, or getting ready, with the orbit every wait leads with. */
export function PaidComputerLine({ computer }: { computer: NonNullable<PaidComputer> }) {
  return (
    <p className="paid-computer ac-iconline" role="status">
      {computer.on ? <Icon name="check" size={14} /> : <Spinner size={14} />}
      <span>{computer.line}</span>
    </p>
  );
}

/**
 * The moment in full, wherever the return from a paid Checkout lands (in a workspace opening after its onboarding,
 * before the beta notice): the team waking on a larger sky, the plan in force as its title, what it gives, the
 * computer as it is, and one way on (`next`; none: Continue). Every way out ends it (`onClose`); `onScreen` once it
 * is drawn.
 */
export function PaidDialog({
  moment,
  next,
  onClose,
  onScreen,
}: {
  moment: PaidReturn;
  next: PaidNext;
  onClose: () => void;
  onScreen: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const facts = usePaidFacts(org.id, moment, org.role === "owner");
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!facts.loading) onScreen();
  }, [facts.loading, onScreen]);
  if (facts.loading) return null;
  const label = next?.label ?? t("common.continue");
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={facts.title}
      closeLabel={t("common.close")}
      width={480}
      bare
      initialFocus={go}
      className="arrival arrival-paid"
    >
      <div className="arrival-hero">
        <PaidScene agents={dir.agents} name={me.user.name} computer={facts.computer} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      {/* The dialog's name is its hidden title; this is the same line, drawn. */}
      <div className="arrival-lede">
        <p className="arrival-lede__title" aria-hidden="true">
          {facts.title}
        </p>
        {facts.room && <p className="arrival-lede__text">{facts.room}</p>}
      </div>
      {facts.computer && (
        <DialogBody>
          <PaidComputerLine computer={facts.computer} />
        </DialogBody>
      )}
      <DialogFooter>
        <Button
          ref={go}
          variant="primary"
          kbd={["↵"]}
          className="paid-go"
          title={label}
          onClick={() => {
            next?.run();
            onClose();
          }}
        >
          {label}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The moment's lighter form, for a plan that turned on after the person left the page the return landed on: a card in
 * the window's corner that leaves the page as it is, with the team waking on its band, the plan in force, the computer
 * as it is (else what the plan gives) and the one way on (`next`), until it is closed or used. `onScreen` once it is
 * drawn.
 */
export function PaidCard({
  moment,
  next,
  onClose,
  onScreen,
}: {
  moment: PaidReturn;
  next: PaidNext;
  onClose: () => void;
  onScreen: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const facts = usePaidFacts(org.id, moment, org.role === "owner");
  const titleId = useId();
  useEffect(() => {
    if (!facts.loading) onScreen();
  }, [facts.loading, onScreen]);
  if (facts.loading) return null;
  // Over the page, outside the shell's own layers, and under every dialog (`--z-docked`), one already open included.
  return createPortal(
    // Polite: read out as it comes, never over what is being read.
    <section className="paid-card" aria-labelledby={titleId} aria-live="polite">
      <div className="paid-card__band">
        <PaidScene agents={dir.agents} name={me.user.name} computer={facts.computer} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="paid-card__body">
        <h2 id={titleId} className="paid-card__title">
          {facts.title}
        </h2>
        {facts.computer ? (
          <PaidComputerLine computer={facts.computer} />
        ) : (
          facts.room && <p className="paid-card__line">{facts.room}</p>
        )}
        {next && (
          <Button
            variant="primary"
            size="sm"
            className="paid-go paid-card__go"
            title={next.label}
            onClick={() => {
              next.run();
              onClose();
            }}
          >
            {next.label}
          </Button>
        )}
      </div>
    </section>,
    document.body,
  );
}
