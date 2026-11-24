import type { Agent, AgentSetup, CommandApproval } from "@agenteschat/client";
import { keys, useAgents, useAiChoice, useApi, useModels, useSetupPreview } from "@agenteschat/client";
import {
  autonomyName,
  changes,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "@agenteschat/client/lib/agent-setup";
import { type AiChoice, aiChoiceSetup } from "@agenteschat/client/lib/ai-choice";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName } from "@agenteschat/client/lib/format";
import { isAuto } from "@agenteschat/client/lib/providers";
import { Button, Checkbox, Dialog, DialogFooter, DialogSearchList, Locked, Switch } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AiChoiceFields, rowName, rowOfChoice } from "./AiChoice";

/**
 * "Usar em outros agentes" (ADR 0094), the one way to give several agents one AI: from an agent's "Mais opções" (its
 * own setup), from a coding plan's key ("Usar em todos os agentes") or a reply's stand-in model. The AI on top is the
 * one picker, starting on `initial`; under it every agent with what the setup would do to it (the server's preview),
 * those that can take it first, "Todos" over them. `exclude`: the agent it comes from, whose own is already saved.
 */
export function UseOnAgentsDialog({
  initial,
  extra,
  exclude,
  autonomy,
  allPicked = false,
  onClose,
}: {
  initial: AiChoice;
  /** What else the agent it comes from carries (its speed, its context window). */
  extra?: Pick<AgentSetup, "speed" | "contextTokens">;
  exclude?: string;
  /** The agent it comes from's Autonomia: "Levar a autonomia" over the list, on by default. */
  autonomy?: CommandApproval | undefined;
  /** Every agent that can take it starts picked. */
  allPicked?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const models = useModels();
  const dir = useDirectory(org.id);
  const others = (agents.data ?? []).filter((a) => a.id !== exclude);
  const ids = others.map((a) => a.id);
  const state = useAiChoice(org.id, { kind: "agents", agentIds: ids });
  const [choice, setChoice] = useState<AiChoice>(initial);
  const [withAutonomy, setWithAutonomy] = useState(true);
  const setup: AgentSetup = {
    ...aiChoiceSetup(choice),
    ...extra,
    ...(withAutonomy && autonomy ? { autonomy } : {}),
  };
  // The agent it comes from first, as its own setup is what the others take: a sign-in made for it is its own then.
  const preview = useSetupPreview(org.id, setup, exclude ? [exclude, ...ids] : ids);
  const results = sortedResults((preview.data ?? []).filter((r) => r.agentId !== exclude));
  const can = takers(results);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const chosenSet = picked ?? new Set(allPicked ? can : []);
  const chosen = can.filter((id) => chosenSet.has(id));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const query = q.trim().toLowerCase();
  const byId = new Map(others.map((a) => [a.id, a]));
  const shown = results.filter((r) => !query || byId.get(r.agentId)?.name.toLowerCase().includes(query));
  const row = rowOfChoice(state.rows, choice);
  const aiName = row ? rowName(t, row) : "";
  const nowOf = (a: Agent) =>
    a.brain && a.brain.kind !== "model"
      ? brainLine(t, a.brain, "").text
      : isAuto(a.model)
        ? t("brain.auto.label")
        : (models.data?.models.find((m) => m.id === a.model)?.label ?? a.model);
  const ownerOf = (a: Agent) => {
    const name = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
    return name ? firstName(name) : undefined;
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosenSet);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const use = async () => {
    setBusy(true);
    try {
      const done = await api.agents.applySetup(org.id, { setup, agentIds: chosen });
      const outcome = setupOutcome(done, chosen.length);
      if (outcome.done > 0) toast.show(t("agentPage.work.brain.copy.done", { count: outcome.done, setup: aiName }));
      if (outcome.autonomyOnly > 0)
        toast.show(t("agentPage.work.brain.copy.autonomyOnly", { count: outcome.autonomyOnly }));
      if (outcome.missed > 0) toast.show(t("agentPage.work.brain.copy.missed", { count: outcome.missed }), "error");
      for (const key of [
        keys.agents(org.id),
        keys.agentPages(org.id),
        keys.aiStatus(org.id),
        keys.aiAccounts(org.id),
        [...keys.missions(org.id), "eligible"],
      ])
        void qc.invalidateQueries({ queryKey: key });
      onClose();
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t("agentPage.work.brain.copy.title")}
      description={t("aiHub.bulk.sub")}
      closeLabel={t("common.close")}
      className="agp-copydialog"
    >
      <Locked when={busy}>
        <div className="ac-dialog__tools">
          <AiChoiceFields
            state={state}
            value={choice}
            onChange={(next) => {
              setChoice(next);
              setPicked(null);
            }}
          />
        </div>
        {autonomy && (
          <div className="ac-dialog__tools">
            <label htmlFor="setup-autonomy" className="agp-copydialog__all">
              <span className="scope-row__text">
                <b>{t("agentPage.work.brain.copy.withAutonomy")}</b>
                <span className="small muted">
                  {t("agentPage.work.brain.copy.withAutonomyLine", { value: autonomyName(t, autonomy) })}
                </span>
              </span>
              <Switch id="setup-autonomy" checked={withAutonomy} disabled={busy} onCheckedChange={setWithAutonomy} />
            </label>
          </div>
        )}
        {preview.data && (
          <div className="ac-dialog__tools">
            <label htmlFor="setup-all" className="agp-copydialog__all" data-off={can.length === 0 || undefined}>
              <Checkbox
                id="setup-all"
                checked={can.length > 0 && chosen.length === can.length}
                disabled={can.length === 0}
                onCheckedChange={(on) => setPicked(new Set(on ? can : []))}
              />
              <span className="scope-row__text">
                <b>{t("agentPage.work.brain.copy.all")}</b>
                <span className="small muted">
                  {can.length === 0
                    ? t("agentPage.work.brain.copy.none")
                    : t("agentPage.work.brain.copy.allLine", { count: can.length })}
                </span>
              </span>
            </label>
          </div>
        )}
        {preview.isPending ? (
          <div className="ac-dialog__body">
            <LoadingLine width={220} />
          </div>
        ) : preview.isError ? (
          <p className="ac-dialog__empty">{t("agentPage.work.failed")}</p>
        ) : (
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            search={others.length > 8}
            searchLabel={t("agentPage.work.brain.copy.search")}
            searchPlaceholder={t("agentPage.work.brain.copy.search")}
            listLabel={t("agentPage.work.brain.copy.title")}
            isEmpty={shown.length === 0}
            emptyText={t("agentPage.work.brain.copy.noMatch", { q })}
          >
            {shown.map((r) => {
              const a = byId.get(r.agentId);
              if (!a) return null;
              const id = `setup-${a.id}`;
              const off = !changes(r);
              return (
                <label key={a.id} htmlFor={id} className="scope-row" data-off={off || undefined}>
                  <Checkbox
                    id={id}
                    checked={!off && chosenSet.has(a.id)}
                    disabled={off}
                    onCheckedChange={(on) => toggle(a.id, on)}
                  />
                  <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                  <span className="scope-row__text">
                    <span>{a.name}</span>
                    <span className="small muted">{setupResultLine(t, r, { now: nowOf(a), owner: ownerOf(a) })}</span>
                  </span>
                </label>
              );
            })}
          </DialogSearchList>
        )}
      </Locked>
      <DialogFooter bar>
        <Button disabled={busy} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={chosen.length === 0 || busy} loading={busy} onClick={() => void use()}>
          {chosen.length === 0
            ? t("agentPage.work.brain.copy.pick")
            : t("agentPage.work.brain.copy.use", { count: chosen.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
