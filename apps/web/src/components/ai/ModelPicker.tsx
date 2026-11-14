import type { Agent, AgentBrain, Message } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useAiAccounts,
  useApi,
  useCredentials,
  useModels,
  usePlatformKey,
  useUpdateAgent,
} from "@agenteschat/client";
import { type EffortLevel, effortLevelsOf, effortOf, effortTextOf } from "@agenteschat/client/lib/brain-advanced";
import {
  mayPickModel,
  modelPickerModels,
  modelPickerSave,
  modelPickerTiles,
  modelPickerUndo,
  type PickerBefore,
  type PickerModel,
} from "@agenteschat/client/lib/brain-picker";
import { can } from "@agenteschat/client/lib/permissions";
import { modelStandInKey, planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planOf } from "@agenteschat/client/lib/plans";
import { modelChoices } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  BrainIcon,
  Button,
  cx,
  EffortPixels,
  EventPill,
  EventPillAction,
  Icon,
  Input,
  Popover,
  ProviderLogo,
  planLine,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { TeamScene } from "@/components/arrival/TeamScene";
import { useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { fullLook, lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { UseKeyForAll } from "./UseKeyForAll";
import "./model-picker.css";

/** Past this many models the list gets a search field. */
const SEARCH_FROM = 8;

/**
 * The agent's AI and model, changed in place (a DM's header, its profile card, its side panel): a button saying what
 * it thinks with, opening the picker under the agent's sky. Whoever can't change it (not an admin, not its owner)
 * reads the same words, with nothing to press.
 */
export function ModelPickerButton({
  agent,
  size = "sm",
  className,
}: {
  agent: Agent;
  size?: "sm" | "row";
  className?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const thinks = useAgentThinks(agent);
  if (!thinks?.text) return null;
  const mark = thinks.mark ? <ProviderLogo id={thinks.mark} size="xs" /> : <BrainIcon kind={thinks.kind} size={14} />;
  // The team's right hand thinks with each person's own AI ("Sua IA"), set where that is: never picked here.
  if (!mayPickModel(agent, me.user.id, can(org, "manage_agents")))
    return (
      <span
        className={cx("mp-label", className)}
        data-size={size}
        title={isRightHand(agent) ? undefined : t("brain.picker.readOnly")}
      >
        {mark}
        <span className="mp-label__text">{thinks.text}</span>
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
          <Icon name="chevronDown" size={14} className="mp-trigger__chevron" />
        </button>
      )}
    />
  );
}

/** The picker, opened from `trigger` (the header's button, a reply's "Escolher modelo"). */
function ModelPickerPopover({ agent, trigger }: { agent: Agent; trigger: (open: boolean) => ReactElement }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      label={t("brain.picker.open", { agent: agent.name })}
      className="mp"
      trigger={trigger(open)}
    >
      {open && <ModelPickerPanel agent={agent} onClose={() => setOpen(false)} />}
    </Popover>
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
  const may = mayPickModel(agent, me.user.id, can(org, "manage_agents"));
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
      {all && account && key && <UseKeyForAll account={account} model={key.model} onClose={() => setAll(false)} />}
    </>
  );
}

function ModelPickerPanel({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const brain = useAgentBrain(useOrg().org.id, agent.id);
  if (!brain.data) return <div className="mp__loading" aria-busy="true" />;
  return <PickerBody agent={agent} view={brain.data} onClose={onClose} />;
}

function PickerBody({ agent, view, onClose }: { agent: Agent; view: AgentBrain; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const connect = useConnectAi();
  const openPanel = useOpenAgentPanel();
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const all = models.data?.models ?? [];
  const choices = modelChoices(all, credentials.data ?? view.keys ?? [], platform.data ?? false);
  const tiles = modelPickerTiles(t, view, agent.ownerUserId, choices, agent.model, all);
  const [tileKey, setTileKey] = useState(() => (tiles.find((x) => x.current) ?? tiles[0])?.key);
  const tile = tiles.find((x) => x.key === tileKey) ?? tiles[0];
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const account = tile?.accounts.find((a) => a.id === accountId) ?? tile?.accounts[0];
  const rows = tile ? modelPickerModels(t, i18n.language, view, tile, account, choices, agent.model) : [];
  const [q, setQ] = useState("");
  const shown = q.trim() ? rows.filter((r) => r.label.toLowerCase().includes(q.trim().toLowerCase())) : rows;
  const [busy, setBusy] = useState(false);
  const checked = rows.find((r) => r.checked);
  const effortOn = tile?.current && checked && !checked.auto;
  const effort = effortOf(view.brain, view.effort);

  const refresh = () => {
    for (const key of [keys.agentBrain(org.id, agent.id), keys.agents(org.id), keys.aiStatus(org.id)])
      void qc.invalidateQueries({ queryKey: key });
  };
  const apply = async (brainInput: Parameters<typeof api.agents.setBrain>[2] | null, model?: string) => {
    if (brainInput) await api.agents.setBrain(org.id, agent.id, brainInput);
    if (model !== undefined) await update.mutateAsync({ model });
  };
  const putBack = async (undo: ReturnType<typeof modelPickerUndo>) => {
    try {
      await apply(undo.brain, undo.model);
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      refresh();
    }
  };
  const pick = async (row: PickerModel) => {
    if (!tile || busy || row.checked) return;
    const before: PickerBefore = {
      brain: view.brain,
      account: view.account,
      model: view.model,
      effort: view.effort,
      apiModel: agent.model,
    };
    const saving = modelPickerSave(view, tile, account, row.value);
    setBusy(true);
    try {
      await apply(saving.brain, saving.model);
      onClose();
      toast.show(t("brain.picker.saved", { agent: agent.name, model: row.label }), "success", {
        label: t("brain.picker.undo"),
        run: () => void putBack(modelPickerUndo(before, saving)),
      });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const setEffort = async (e: EffortLevel) => {
    if (!tile || e === effort) return;
    try {
      await api.agents.setBrain(org.id, agent.id, { brain: tile.kind, effort: e });
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      refresh();
    }
  };
  const usage = account?.usage ?? null;
  const meter = usage ? planLine(usage, planMeterText(t, i18n.language)) : null;

  return (
    <div className="mp__body" aria-busy={busy || undefined}>
      <TeamScene className="mp__sky" agents={[{ id: agent.id, name: agent.name }]} lead={agent.id}>
        {tile && (
          <>
            <span className="team-scene__trail" data-state="done">
              {[0, 1, 2, 3, 4].map((n) => (
                <i key={n} style={{ "--n": n } as CSSProperties} />
              ))}
            </span>
            <span key={tile.key} className="team-scene__mark">
              <ProviderLogo id={tile.mark} size="tile" />
            </span>
          </>
        )}
      </TeamScene>
      <div className="mp__tiles">
        {tiles.map((x) => (
          <button
            key={x.key}
            type="button"
            className="mp__tile"
            aria-pressed={x.key === tile?.key}
            aria-label={x.name}
            title={x.name}
            onClick={() => {
              setTileKey(x.key);
              setAccountId(undefined);
              setQ("");
            }}
          >
            <ProviderLogo id={x.mark} size="sm" />
          </button>
        ))}
        {connect && (
          <button
            type="button"
            className="mp__tile mp__tile--add"
            aria-label={t("brain.picker.connect")}
            title={t("brain.picker.connect")}
            onClick={() => {
              onClose();
              connect.open({ agentId: agent.id, chat: true });
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      {tile && (
        <div className="mp__head">
          <div className="mp__who">
            <b>{tile.name}</b>
            {tile.accounts.length > 1 ? (
              <select
                className="mp__account"
                aria-label={t("brain.picker.account")}
                value={account?.id ?? ""}
                onChange={(e) => setAccountId(e.target.value || null)}
              >
                {tile.accounts.map((a) => (
                  <option key={a.id ?? "own"} value={a.id ?? ""}>
                    {a.label}
                  </option>
                ))}
              </select>
            ) : (
              account && <span className="mp__plan">{account.label}</span>
            )}
          </div>
          {meter?.line && (
            <span className="mp__usage" data-state={meter.state} title={meter.title}>
              {[meter.line, meter.alert].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      )}
      {rows.length > SEARCH_FROM && (
        <Input
          className="mp__search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("brain.picker.search")}
          aria-label={t("brain.picker.search")}
        />
      )}
      <div className="mp__models" role="listbox" aria-label={tile?.name ?? ""}>
        {shown.map((r) => (
          <button
            key={r.value}
            type="button"
            role="option"
            aria-selected={r.checked}
            className="ac-menu__item mp__model"
            data-refused={r.refused || undefined}
            disabled={busy}
            onClick={() => void pick(r)}
          >
            <span className="ac-menu__label">
              <span className="mp__model-name">{r.label}</span>
              {(r.auto || r.refused || r.textOnly) && (
                <span className="ac-menu__desc">
                  {r.refused ? t("brain.picker.refused") : r.auto ? r.sub : t("brain.picker.textOnly")}
                </span>
              )}
            </span>
            {r.auto && <span className="mp__model-tag">{t("brain.picker.default")}</span>}
            <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5.5 10.5 3 3 6-7" />
            </svg>
          </button>
        ))}
      </div>
      {effortOn && tile && (
        <div className="mp__effort">
          <EffortPixels
            label={t("agentPage.work.brain.effort")}
            value={effort}
            onValueChange={(e) => void setEffort(e)}
            color={fullLook(lookOf(agent)).color}
            steps={effortLevelsOf(tile.kind).map((e) => ({ value: e, label: t(`agentPage.work.brain.efforts.${e}`) }))}
            hint={(e) => t(`agentPage.work.brain.effortText.${effortTextOf(tile.kind, e)}`)}
            unset={t("agentPage.work.brain.efforts.none")}
          />
        </div>
      )}
      <div className="mp__foot">
        <small>{t("brain.picker.applies")}</small>
        {openPanel && (
          <Button
            size="sm"
            variant="ghost"
            icon="settings"
            onClick={() => {
              onClose();
              openPanel(agent.id, "settings", "brain:more");
            }}
          >
            {t("brain.picker.more")}
          </Button>
        )}
      </div>
    </div>
  );
}
