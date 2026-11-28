import { type Agent, keys, useApi, useRoutines } from "@agenteschat/client";
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
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedList, GroupedRow, useToast } from "@/ui";
import { useMyZone } from "../routines/hooks";
import { ruleSentence } from "../routines/rule";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";

/**
 * The routine an app brings, at the end of connecting it (ADR 0242), as the web's: on unless switched off, who does
 * it and when picked in its own rows. Null `routine`: the app brings none, or it was made already.
 */
export interface RoutineOffer {
  routine: ConnectRoutine | null;
  /** The app brings one, but the routines or the agents are on their way: its rows wait, and so does Done. */
  loading: boolean;
  agents: Agent[];
  agent: Agent | null;
  on: boolean;
  rule: number;
  setOn: (on: boolean) => void;
  setAgent: (id: string) => void;
  setRule: (index: number) => void;
}

export function useRoutineOffer(app: string | null | undefined): RoutineOffer {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const routines = useRoutines(orgId);
  const found = connectRoutineOf(app);
  const loading = Boolean(found) && (routines.isPending || dir.loading);
  // Shown while it loads; then only once the list says it isn't made. The list failing to come leaves it out.
  const routine = found && (loading || (routines.data && !connectRoutineMade(t, found, routines.data))) ? found : null;
  // Every agent uses a catalog app once it is connected: the offer keeps those I make routines for.
  const mine = useMemo(() => connectRoutineAgents(dir.agents), [dir.agents]);
  const [on, setOn] = useState(true);
  const [picked, setAgent] = useState<string | null>(null);
  const [rule, setRule] = useState(0);
  const agent = mine.find((a) => a.id === picked) ?? (routine ? suggestedAgent(mine) : null);
  return { routine, loading, agents: mine, agent, on, rule, setOn, setAgent, setRule };
}

/** Makes the routine and starts its first run at once, then says so with Undo; it outlives the sheet. */
export function useStartRoutine() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const timezone = useMyZone();
  return (offer: RoutineOffer) => {
    const { routine, agent } = offer;
    if (!routine || !agent || !offer.on || offer.loading) return;
    const rules = connectRoutineRules(routine);
    const rule = rules[offer.rule] ?? rules[0];
    if (!rule) return;
    const input = connectRoutineInput(t, routine, { agentId: agent.id, rule, timezone, today: todayYmd() });
    void (async () => {
      try {
        const made = await api.routines.create(orgId, input);
        await api.routines.runNow(orgId, made.id).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
        toast({
          title: t("connectFlow.routine.created", { name: made.name }),
          subtitle: t("connectFlow.routine.createdDetail", { agent: agent.name }),
          agentId: agent.id,
          action: {
            label: t("connectFlow.routine.undo"),
            onPress: () =>
              void api.routines.remove(orgId, made.id).then(() => {
                void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
                toast({ title: t("connectFlow.routine.undone") });
              }),
          },
        });
      } catch {
        toast({ title: t("connectFlow.routine.notCreated"), icon: "x" });
      }
    })();
  };
}

/**
 * The routine's group under what connecting said: its row with the switch (the whole row toggles), then who does it
 * and when, each a choice in the app's own sheet.
 */
export function RoutineOfferGroup({ offer }: { offer: RoutineOffer }) {
  const { t, i18n } = useTranslation();
  const timezone = useMyZone();
  const { routine, agent } = offer;
  if (!routine) return null;
  const name = connectRoutineName(t, routine);
  if (offer.loading)
    // What it is at once, its switch and rows waiting until who may run it is known.
    return (
      <GroupedList>
        <GroupedRow icon="clock" label={name} sub={t("connectFlow.routine.preparing")} media toggle disabled />
        <GroupedRow label={t("connectFlow.routine.who")} menu disabled />
        <GroupedRow label={t("connectFlow.routine.when")} menu disabled />
      </GroupedList>
    );
  if (!agent) return null;
  const today = todayYmd();
  const rules = connectRoutineRules(routine).map((r) =>
    capitalize(ruleSentence(t, i18n.language, connectRule(r, timezone, today), new Date(), false), i18n.language),
  );
  const pickAgent = () =>
    void pickOne({
      title: t("connectFlow.routine.who"),
      value: agent.id,
      options: offer.agents.map((a) => ({
        key: a.id,
        label: a.name,
        sub: a.role || undefined,
        leading: { kind: "agent", agentId: a.id },
      })),
    }).then((id) => id && offer.setAgent(id));
  const pickRule = () =>
    void pickOne({
      title: t("connectFlow.routine.when"),
      value: String(offer.rule),
      options: rules.map((label, i) => ({ key: String(i), label })),
    }).then((key) => key !== null && offer.setRule(Number(key)));
  return (
    <GroupedList>
      <GroupedRow
        icon="clock"
        label={name}
        sub={t(`connectFlow.routine.${routine.template}`, { name: agent.name })}
        subLines={4}
        media
        toggle={offer.on}
        onPress={() => offer.setOn(!offer.on)}
      />
      {offer.on ? (
        <>
          <GroupedRow
            label={t("connectFlow.routine.who")}
            value={agent.name}
            valueLeading={<AgentFace agentId={agent.id} size={22} />}
            menu
            onPress={pickAgent}
          />
          <GroupedRow label={t("connectFlow.routine.when")} value={rules[offer.rule]} menu onPress={pickRule} />
        </>
      ) : null}
    </GroupedList>
  );
}
