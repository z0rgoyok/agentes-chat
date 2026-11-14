import { type Message, useAiAccounts, useStopReason } from "@agenteschat/client";
import { seesDetails } from "@agenteschat/client/lib/audience";
import { mayPickModel } from "@agenteschat/client/lib/brain-picker";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { StoppedNotice } from "@agenteschat/client/lib/notices";
import { can } from "@agenteschat/client/lib/permissions";
import { modelStandInKey } from "@agenteschat/client/lib/plan-usage";
import { planOf } from "@agenteschat/client/lib/plans";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, EventPill, EventPillAction, PixelStop, useToast } from "@/ui";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openKeyForAll } from "../ai/KeyForAllScreen";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { ReasonField } from "../task-manager/parts";
import { useQuietInset } from "./look";
import { useStoppedRun } from "./stopped-runs";

/**
 * A stopped task as one pill (ADR 0128): "You stopped Ada" (with the reason once said), the stop's time, and its
 * actions: Continue (`cont`, where the task can pick up again) and, for who stopped it while it has no reason, "Add a
 * reason", which opens a short field under the pill; the agent reads it on its next turn. `fallback`: its words when
 * no person stopped it (the step limit, stuck) or nobody is known. Under the stopped reply when it is in the
 * conversation, else in the notice's place (`StoppedLine`).
 */
export function StopPill({
  agent,
  notice,
  at,
  byUserId,
  fallback,
  cont,
}: {
  /** The agent's name, as the sentence says it ("You stopped Ada"). */
  agent: string;
  /** The `run_stopped` notice the agent got: who, their name, the reason. */
  notice?: StoppedNotice | null;
  /** When the stop came (the notice's time). */
  at?: string | null;
  /** Without a notice: the person in the reply's meta. */
  byUserId?: string | null;
  fallback: string;
  cont?: ReactNode;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const meId = useMeId();
  const orgId = useOrgId();
  const toast = useToast();
  const say = useStopReason(orgId);
  const [writing, setWriting] = useState(false);
  const [why, setWhy] = useState("");
  // Sent from here: shown at once, before the notice itself comes back with it.
  const [sent, setSent] = useState<string | null>(null);
  const by = notice?.byUserId || byUserId || null;
  const mine = Boolean(meId) && by === meId;
  const reason = notice?.reason ?? sent;
  const stopper = notice?.byName || (by ? dir.nameOf({ type: "person", id: by }) : "");
  const { context } = agentGrammar(agent);
  const sentence = mine
    ? t("taskManager.stopped.line", { agent, context })
    : stopper
      ? t("taskManager.stopped.lineBy", { name: stopper, agent, context })
      : fallback;
  const sayWhy = Boolean(notice) && mine && !reason && !writing;
  const send = () => {
    const text = why.trim();
    if (!text || !notice) return;
    say.mutate(
      { runId: notice.runId, reason: text },
      {
        onSuccess: () => {
          setSent(text);
          setWriting(false);
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };
  return (
    <EventPill
      mark={<PixelStop size={12} color={c.faint} moving={false} />}
      time={at ? when.time(at) : undefined}
      actions={[
        cont,
        sayWhy ? (
          <EventPillAction key="why" label={t("taskManager.stopped.sayWhy")} onPress={() => setWriting(true)} />
        ) : null,
      ]}
      below={
        notice && writing && !reason ? (
          <View style={styles.form}>
            <View style={styles.grow}>
              <ReasonField
                value={why}
                onChange={setWhy}
                placeholder={t("taskManager.stopped.whyPlaceholder")}
                autoFocus
              />
            </View>
            <Button
              variant="secondary"
              size="sm"
              label={t("taskManager.stopped.send")}
              loading={say.isPending}
              disabled={!why.trim()}
              onPress={send}
            />
          </View>
        ) : null
      }
    >
      {sentence}
      {reason ? ` · ${t("taskManager.stopped.reason", { reason })}` : null}
    </EventPill>
  );
}

/**
 * The `run_stopped` notice a person's stop leaves in the agent's conversation: nothing while the stopped reply is
 * here (its own pill says it, `stoppedRunsOf`), else its pill alone, as when a queued task is stopped before it wrote.
 */
export function StoppedLine({ message, notice, gap }: { message: Message; notice: StoppedNotice; gap: number }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const inset = useQuietInset();
  const inReply = useStoppedRun(notice.runId);
  if (inReply) return null;
  const agent = dir.nameOf(message.author) || t("channel.unknownAgent");
  return (
    <View style={[styles.line, { paddingLeft: inset, marginTop: gap }]}>
      <StopPill agent={agent} notice={notice} at={message.createdAt} fallback={t("mobile.chat.stopped.plain")} />
    </View>
  );
}

/** Under a reply that came at standard speed because Fast was refused (`meta.speedFallback`), with the way to the agent. */
export function SpeedFallbackLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const agent = dir.agentById.get(message.author.id ?? "");
  return (
    <EventPill
      mark="info"
      actions={
        agent && seesDetails(agent) ? (
          <EventPillAction label={t("chat.speedFallback.action")} onPress={() => openAgentAi(agent.id)} />
        ) : null
      }
    >
      {t("chat.speedFallback.text")}
    </EventPill>
  );
}

/**
 * Under a reply "Automático" gave with another model because the plan refused the one it maps to
 * (`meta.modelStandIn`). Whoever may change the agent gets "Usar o <modelo> em todos" (the key's screen, on that
 * model) when the key is theirs to share, and "Escolher modelo" (the agent's AI page).
 */
export function ModelStandInLine({ message, text }: { message: Message; text: string }) {
  const { t } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const agent = dir.agentById.get(message.author.id ?? "");
  const may = mayPickModel(agent, meId, can(org, "manage_agents"));
  const key = may ? modelStandInKey(message.meta) : null;
  const ai = useAiAccounts(orgId, Boolean(key));
  const account = key
    ? ai.data?.accounts.find((a) => a.id === key.account && a.machineId === key.machineId && a.status === "active")
    : undefined;
  return (
    <EventPill
      mark="info"
      actions={
        agent && may ? (
          <>
            {key && account && planOf(account.provider) ? (
              <EventPillAction
                label={t("chat.modelStandIn.useAll", { model: key.to })}
                onPress={() => openKeyForAll(key.machineId, key.account, key.model)}
              />
            ) : null}
            <EventPillAction label={t("chat.modelStandIn.pick")} onPress={() => openAgentAi(agent.id)} />
          </>
        ) : null
      }
    >
      {text}
    </EventPill>
  );
}

const styles = StyleSheet.create({
  // Aligned with the messages' words, as the other automatic events (`EventLine`). The list sets its top.
  line: { paddingRight: 16 },
  grow: { flex: 1, minWidth: 0 },
  // Under the pill, the field and Send on one row.
  form: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", marginTop: 4 },
});
