import type { Agent } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Dialog, DialogBody, DialogFooter, Icon, type IconName } from "@agenteschat/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type HaveItem, HaveList, HaveOffRow, HaveRow } from "@/components/arrival/ConnectHave";
import { TeamScene } from "@/components/arrival/TeamScene";
import { BrainLine, PickList, type PickOption } from "@/pages/agent/brain/pieces";
import "@/pages/agent/brain/brain-dialog.css";

/** The model of the account in use: its name on the first screen, and the list its line opens. */
export interface RightHandModel {
  label: string;
  lead?: ReactNode;
  value: string;
  options: readonly PickOption[];
  /** The search's words, for a long list (the API's models). */
  search?: string;
  onPick: (value: string) => void;
}

/** A line under the model that leads somewhere else: connecting another AI, going back to the workspace's. */
export interface RightHandLink {
  icon: IconName;
  label: string;
  onClick: () => void;
}

/**
 * Who thinks for the right hand, drawn as any agent's "Quem pensa" (`BrainDialog`) and from its pieces: the agent and
 * the AI's mark under the sky, the account in use with its plan's room, the model on a line that opens its list, and
 * "Trocar de conta" where there are accounts to pick from (the workspace's AI), each account once, by owner. Its two
 * uses differ only in what they are given: the viewer's own AI, or the AI of people with no plan of their own
 * (ADR 0137 §11). A choice is saved when its screen's button is pressed.
 */
export function RightHandBrainDialog({
  agent,
  open,
  onClose,
  title,
  note,
  mark,
  current,
  empty,
  model,
  accounts,
  links = [],
  unusable = [],
  busy,
  locked = false,
}: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  /** The first screen's title, the dialog's name. */
  title: string;
  /** The footer's quiet line: who the choice is for. */
  note: string;
  /** The AI's mark beside the agent, under the sky. */
  mark?: ReactNode;
  /** The account in use; none when nothing thinks yet (`empty` says so). */
  current: HaveItem | null;
  empty?: string;
  model?: RightHandModel | null;
  /** The other accounts it may think with, the one in use left out; `empty`: what to do when there is none. */
  accounts?: {
    items: readonly HaveItem[];
    onPick: (id: string) => void;
    empty?: string;
    /** Under the list: connecting another AI, which opens every provider to pick from. */
    more?: RightHandLink;
  } | null;
  links?: readonly RightHandLink[];
  /** Plans it can't think with now, under the others, each with why (`rightHandUnusable`). */
  unusable?: readonly { id: string; item: Pick<HaveItem, "title" | "mark">; why: ReactNode }[];
  busy: boolean;
  /** Nothing changes for now (a billing hold): the lines that change it don't open. */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const g = agentGrammar(agent.name);
  const [screen, setScreen] = useState<"glance" | "switch" | "model">("glance");
  const [account, setAccount] = useState<string>();
  const [picked, setPicked] = useState<string>();
  // Each opening starts on the first screen, with nothing picked.
  useEffect(() => {
    if (!open) return;
    setScreen("glance");
    setAccount(undefined);
    setPicked(undefined);
  }, [open]);
  const glance = () => setScreen("glance");
  const shown =
    screen === "switch"
      ? t("agentPage.work.brain.v2.switchTitle", g)
      : screen === "model"
        ? t("agentPage.work.brain.v2.modelTitle", g)
        : title;
  const modelValue = picked ?? model?.value ?? "";
  const modelLabel = model?.options.find((o) => o.value === modelValue)?.label ?? "";
  const accountLabel = accounts?.items.find((i) => i.id === account)?.title ?? "";
  const stays = busy || locked;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={shown}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="arrival arrival-chat bd"
    >
      <div className="arrival-hero">
        <TeamScene agents={[{ id: agent.id, name: agent.name }]} lead={agent.id} asleep={!current}>
          {mark && <span className="team-scene__mark">{mark}</span>}
        </TeamScene>
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
      <div className="bd-glide">
        {/* biome-ignore lint/a11y/useSemanticElements: a screen of the dialog, not a group of form fields */}
        <div key={screen} className="bd-screen" role="group" aria-label={shown}>
          {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
          <div className="arrival-lede arrival-lede--row">
            {screen !== "glance" && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="chevronLeft"
                aria-label={t("common.back")}
                disabled={busy}
                onClick={glance}
              />
            )}
            <p className="arrival-lede__title" aria-hidden="true">
              {shown}
            </p>
          </div>
          <DialogBody>
            {screen === "glance" && (
              <>
                <div className="bd-use">
                  <p className="arrival-opts__label">{t("agentPage.work.brain.account")}</p>
                  {current ? <HaveRow item={current} checked still /> : <p className="muted">{empty}</p>}
                </div>
                {model && (
                  <div className="bd-lines">
                    <BrainLine
                      label={t("agentPage.work.brain.planModel")}
                      lead={model.lead}
                      value={model.label}
                      onOpen={stays ? undefined : () => setScreen("model")}
                    />
                  </div>
                )}
                {links.map((link) => (
                  <button
                    key={link.label}
                    type="button"
                    className="arrival-have__link arrival-have__link--other"
                    disabled={busy}
                    onClick={link.onClick}
                  >
                    <Icon name={link.icon} size={16} />
                    <span>{link.label}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                ))}
              </>
            )}
            {screen === "switch" && accounts && (
              <>
                <HaveList
                  items={accounts.items}
                  // The one in use is the one checked until another is picked, as on any agent's.
                  value={account ?? current?.id}
                  onChange={setAccount}
                  disabled={stays}
                  pinned={{ label: t("agentPage.work.brain.v2.inUse"), items: current ? [current] : [] }}
                  label={shown}
                />
                {accounts.items.length === 0 && accounts.empty && <p className="small muted">{accounts.empty}</p>}
                {unusable.length > 0 && (
                  <div className="bd-use">
                    <p className="arrival-opts__label">{t("rightHand.unusable.title", g)}</p>
                    {unusable.map((u) => (
                      <HaveOffRow key={u.id} item={u.item} why={u.why} />
                    ))}
                  </div>
                )}
                {accounts.more && (
                  <button
                    type="button"
                    className="arrival-have__link arrival-have__link--other"
                    disabled={busy}
                    onClick={accounts.more.onClick}
                  >
                    <Icon name={accounts.more.icon} size={16} />
                    <span>{accounts.more.label}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                )}
              </>
            )}
            {screen === "model" && model && (
              <PickList
                options={model.options}
                value={modelValue}
                onChange={setPicked}
                label={shown}
                {...(model.search ? { searchLabel: model.search } : {})}
              />
            )}
          </DialogBody>
        </div>
        {screen === "glance" && (
          <DialogFooter className={accounts ? "bd-foot bd-foot--two" : "bd-foot"} note={note}>
            {accounts && (
              <Button disabled={stays} onClick={() => setScreen("switch")}>
                {t("agentPage.work.brain.v2.switch")}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t("agentPage.work.brain.v2.finish")}
            </Button>
          </DialogFooter>
        )}
        {screen === "switch" && accounts && (
          <DialogFooter className="bd-foot" note={note}>
            <Button
              variant="primary"
              disabled={stays || !account || account === current?.id}
              loading={busy}
              onClick={() => {
                if (!account || account === current?.id) return;
                accounts.onPick(account);
                glance();
              }}
            >
              {account && account !== current?.id
                ? t("agentPage.work.brain.v2.switchTo", { label: accountLabel })
                : t("agentPage.work.brain.v2.switch")}
            </Button>
          </DialogFooter>
        )}
        {screen === "model" && model && (
          <DialogFooter className="bd-foot" note={note}>
            <Button
              variant="primary"
              disabled={stays || modelValue === model.value}
              loading={busy}
              onClick={() => {
                model.onPick(modelValue);
                glance();
              }}
            >
              {t("connectAi.use", { label: modelLabel })}
            </Button>
          </DialogFooter>
        )}
      </div>
    </Dialog>
  );
}
