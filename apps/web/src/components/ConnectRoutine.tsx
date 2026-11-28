import type { Agent } from "@agenteschat/client";
import { keys, useRoutines } from "@agenteschat/client";
import {
  type ConnectRoutine,
  connectRoutineAgents,
  connectRoutineInput,
  connectRoutineMade,
  connectRoutineName,
  connectRoutineOf,
  connectRoutineRules,
  connectRule,
  suggestedAgent,
  todayYmd,
} from "@agenteschat/client/lib/connect-routines";
import { capitalize } from "@agenteschat/client/lib/format";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import { Icon, Select, Skeleton, SkeletonGroup, Switch } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { ruleSentence } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";

/**
 * The routine an app brings, at the end of connecting it (ADR 0242): on unless switched off, its agent and when it
 * runs picked on the spot. `agents` are the ones that may use the app (all of them for a catalog app; who got access
 * for a mailbox): the offer keeps those I make routines for. Null `routine`: this app brings none, or it was made.
 */
export interface RoutineOffer {
  routine: ConnectRoutine | null;
  /**
   * The app brings one, but whether it was made already or who may run it isn't known yet (the routines or the agents
   * are on their way): its line shows what it is with the rest loading, and Done waits.
   */
  loading: boolean;
  /** Who it may run as, the suggested one first among equals (`connectRoutineAgents`). */
  agents: Agent[];
  agent: Agent | null;
  on: boolean;
  /** Its rule among `connectRoutineRules`. */
  rule: number;
  setOn: (on: boolean) => void;
  setAgent: (id: string) => void;
  setRule: (index: number) => void;
}

export function useRoutineOffer(
  app: string | null | undefined,
  agents: readonly Agent[] | undefined,
  /** The agents are still on their way (`agents` is then empty). */
  agentsPending = false,
): RoutineOffer {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const found = connectRoutineOf(app);
  const loading = Boolean(found) && (routines.isPending || agentsPending);
  // Shown while it loads; then only once the list says it isn't made (a routine is never offered twice). The list
  // failing to come leaves it out.
  const routine = found && (loading || (routines.data && !connectRoutineMade(t, found, routines.data))) ? found : null;
  const mine = useMemo(() => connectRoutineAgents(agents ?? []), [agents]);
  const [on, setOn] = useState(true);
  const [picked, setAgent] = useState<string | null>(null);
  const [rule, setRule] = useState(0);
  const agent = mine.find((a) => a.id === picked) ?? (routine ? suggestedAgent(mine) : null);
  return { routine, loading, agents: mine, agent, on, rule, setOn, setAgent, setRule };
}

/** The switch while the line loads: it shows on, and does nothing yet. */
const waitsToLoad = () => {};

/** Whether Done (or Continue) makes it: loaded, on, with an agent. */
export const offerTaken = (o: RoutineOffer) => Boolean(o.routine && !o.loading && o.agent && o.on);

function useZone() {
  const { me } = useOrg();
  const actors = useActors();
  return actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "UTC";
}

/**
 * Makes the routine and starts its first run at once, then says so with Undo. It outlives the dialog that asked for
 * it (the dialog closes on Done): the toast and the list are the app's, not the dialog's.
 */
export function useStartRoutine() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const timezone = useZone();
  return (offer: RoutineOffer, mailbox?: string) => {
    const { routine, agent } = offer;
    if (!routine || !agent || !offer.on) return;
    const rule = connectRoutineRules(routine)[offer.rule] ?? connectRoutineRules(routine)[0];
    if (!rule) return;
    const input = connectRoutineInput(t, routine, {
      agentId: agent.id,
      rule,
      timezone,
      today: todayYmd(),
      ...(mailbox ? { mailbox } : {}),
    });
    void (async () => {
      try {
        const made = await api.routines.create(org.id, input);
        await api.routines.runNow(org.id, made.id).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: keys.routines(org.id) });
        toast.show(
          t("connectFlow.routine.created", { name: made.name }),
          "success",
          {
            label: t("connectFlow.routine.undo"),
            run: () =>
              void api.routines.remove(org.id, made.id).then(() => {
                void qc.invalidateQueries({ queryKey: keys.routines(org.id) });
                toast.show(t("connectFlow.routine.undone"));
              }),
          },
          t("connectFlow.routine.createdDetail", { agent: agent.name }),
        );
      } catch {
        toast.show(t("connectFlow.routine.notCreated"), "error");
      }
    })();
  };
}

/**
 * The routine's line, under what connecting said: what it does with the agent's name in it and its switch on the
 * title's line, then who does it and when (the selects of Routines). With nobody to run it (a mailbox nobody reads
 * yet), the switch is off and the line says what to do.
 */
export function RoutineOfferRow({ offer, waitsForAccess = false }: { offer: RoutineOffer; waitsForAccess?: boolean }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const timezone = useZone();
  const { routine, agent } = offer;
  if (!routine) return null;
  const name = connectRoutineName(t, routine);
  const icon = <Icon name={routine.apps === "mailbox" ? "mail" : "repeat"} size={18} />;
  if (offer.loading)
    // What it is at once, who and when as their shapes (the selects' size, no jump when they land); Done waits.
    return (
      <SkeletonGroup label={t("connectFlow.routine.preparing")} className="cflow-routine">
        <div className="cflow-routine__head">
          <span className="cflow-routine__icon">{icon}</span>
          <span className="cflow-routine__words">
            <b>{name}</b>
            <span className="cflow-routine__wait">
              <Skeleton width="72%" />
            </span>
          </span>
          <Switch checked disabled onCheckedChange={waitsToLoad} aria-label={t("connectFlow.routine.on", { name })} />
        </div>
        <div className="ac-props cflow-routine__props">
          <Skeleton shape="block" width={112} className="cflow-routine__select" />
          <Skeleton shape="block" width={248} className="cflow-routine__select" />
        </div>
      </SkeletonGroup>
    );
  if (!agent && !waitsForAccess) return null;
  const on = offer.on && Boolean(agent);
  const today = todayYmd();
  const when = connectRoutineRules(routine).map((r, i) => ({
    value: String(i),
    label: capitalize(
      ruleSentence(t, i18n.language, connectRule(r, timezone, today), new Date(), false),
      i18n.language,
    ),
  }));
  return (
    <section className="cflow-routine" data-off={on ? undefined : ""}>
      <label className="cflow-routine__head" htmlFor={id}>
        <span className="cflow-routine__icon">{icon}</span>
        <span className="cflow-routine__words">
          <b>{name}</b>
          <span className="small muted">
            {agent
              ? t(`connectFlow.routine.${routine.template}`, { name: agent.name })
              : t("connectFlow.routine.noAgent")}
          </span>
        </span>
        <Switch
          id={id}
          checked={on}
          disabled={!agent}
          onCheckedChange={offer.setOn}
          aria-label={t("connectFlow.routine.on", { name })}
        />
      </label>
      {on && agent && (
        <div className="ac-props cflow-routine__props">
          <Select
            size="sm"
            aria-label={t("connectFlow.routine.who")}
            value={agent.id}
            onValueChange={offer.setAgent}
            options={offer.agents.map((a) => ({
              value: a.id,
              label: a.name,
              description: a.role || undefined,
              leading: <AgentAvatar agentId={a.id} name={a.name} size="sm" />,
            }))}
          />
          <Select
            size="sm"
            aria-label={t("connectFlow.routine.when")}
            value={String(offer.rule)}
            onValueChange={(v) => offer.setRule(Number(v))}
            options={when}
          />
        </div>
      )}
    </section>
  );
}
