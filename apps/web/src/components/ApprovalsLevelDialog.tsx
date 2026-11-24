import {
  type Agent,
  type Approval,
  type ApprovalsLevel,
  useAgents,
  useChangeWhenAsks,
  useSettings,
  useSetWorkspaceApprovalsLevel,
  useUndoWhenAsks,
} from "@agenteschat/client";
import {
  APPROVALS_LEVELS,
  approvalsLevelOf,
  changesWhenAsks,
  ownApprovalsCount,
} from "@agenteschat/client/lib/approvals-level";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Checkbox, cx, Dialog, DialogBody, InfoHint, OptionList } from "@agenteschat/ui";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * The three approvals levels in a dialog (ADR 0173): an agent's page, Settings' workspace row and an approval's
 * "Mudar quando perguntar" all choose here. A choice saves at once; `children` go under the choices. With no `value`
 * none is chosen, so every one of them saves.
 */
export function ApprovalsLevelDialog({
  open,
  onOpenChange,
  description,
  value,
  saving,
  onChoose,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  value: ApprovalsLevel | null;
  saving: boolean;
  onChoose: (level: ApprovalsLevel) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const title = t("approvalsLevel.title");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        <OptionList<ApprovalsLevel | "">
          aria-label={title}
          value={value ?? ""}
          disabled={saving}
          onValueChange={(level) => level && onChoose(level)}
          options={APPROVALS_LEVELS.map((level) => ({
            value: level,
            title: t(`approvalsLevel.${level}.title`),
            description: t(`approvalsLevel.${level}.text`),
          }))}
        />
        {children}
      </DialogBody>
    </Dialog>
  );
}

/**
 * "Mudar quando perguntar" under a waiting approval, for who decides it and may set its agent's level: the agent's
 * three choices open in place. Choosing approves nothing. Who may set the workspace's level also gets "Para todos os
 * agentes do workspace", which sets it and clears every agent's own choice. A toast says the new choice, with Desfazer.
 */
export function WhenAsksLink({
  approval,
  agent,
  className,
}: {
  approval: Approval;
  agent: Agent | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const change = useChangeWhenAsks(org.id);
  const undo = useUndoWhenAsks(org.id);
  const [open, setOpen] = useState(false);
  const [everyAgent, setEveryAgent] = useState(false);
  const boxId = useId();
  if (!agent || !changesWhenAsks(agent, approval)) return null;
  const choose = (level: ApprovalsLevel) => {
    const all = everyAgent;
    change.mutate(
      { agentId: agent.id, level, everyAgent: all },
      {
        onSuccess: (before) => {
          setOpen(false);
          const words = t(`approvalsLevel.${level}.title`);
          toast.show(
            all
              ? t("approvalsLevel.nowEveryAgent", { level: words })
              : t("approvalsLevel.now", { name: agent.name, level: words }),
            "info",
            { label: t("approvalsLevel.undo"), run: () => undo.mutate({ before, everyAgent: all }) },
          );
        },
      },
    );
  };
  const saving = change.isPending || undo.isPending;
  return (
    <>
      <Button
        variant="link"
        className={cx("when-asks", className)}
        disabled={saving}
        onClick={() => {
          setEveryAgent(false);
          setOpen(true);
        }}
      >
        {t("approvalsLevel.change")}
      </Button>
      <ApprovalsLevelDialog
        open={open}
        onOpenChange={setOpen}
        description={t("approvalsLevel.lead", { name: agent.name })}
        // For every agent, the agent's own level is no answer: each choice, its level too, sets the workspace's.
        value={
          (change.isPending ? change.variables?.level : undefined) ?? (everyAgent ? null : approvalsLevelOf(agent))
        }
        saving={saving}
        onChoose={choose}
      >
        {/* The workspace's level reaches private agents too: owners and administrators only (ADR 0085 addendum of
            2026-11-17, the server's `setWorkspaceApprovalsLevel`). */}
        {can(org, "administrator") && (
          <label htmlFor={boxId} className="scope-row">
            <Checkbox id={boxId} checked={everyAgent} onCheckedChange={setEveryAgent} disabled={saving} />
            <span className="scope-row__text">{t("approvalsLevel.everyAgent")}</span>
          </label>
        )}
      </ApprovalsLevelDialog>
    </>
  );
}

/**
 * Settings → Aprovações (ADR 0173 addendum 2026-11-15), for who may set every agent's level, private ones included
 * (owners and administrators, ADR 0085 addendum of 2026-11-17): the workspace's level, which every agent without its
 * own choice follows. The dialog says how many agents keep their own.
 */
export function WorkspaceApprovalsRow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const agents = useAgents(org.id).data ?? [];
  const set = useSetWorkspaceApprovalsLevel(org.id);
  const [open, setOpen] = useState(false);
  if (!can(org, "administrator")) return null;
  const title = t("approvalsLevel.title");
  const level = (set.isPending ? set.variables?.level : undefined) ?? settings.data?.approvalsLevel ?? "risky";
  const own = ownApprovalsCount(agents);
  return (
    <div className="settings-row ac-actrow">
      <div className="settings-row__text ac-actrow__text">
        <span className="ac-hintline">
          <span className="settings-row__label">{title}</span>
          <InfoHint name={t("common.about", { label: title })}>{t("approvalsLevel.workspaceHelp")}</InfoHint>
        </span>
      </div>
      <div className="settings-row__control">
        <span className="settings-row__value">{t(`approvalsLevel.${level}.title`)}</span>
        <Button size="sm" type="button" disabled={!settings.data} onClick={() => setOpen(true)}>
          {t("approvalsLevel.edit")}
        </Button>
      </div>
      <ApprovalsLevelDialog
        open={open}
        onOpenChange={setOpen}
        description={t("approvalsLevel.workspaceLead")}
        value={level}
        saving={set.isPending}
        onChoose={(next) => {
          // The workspace and its agents show the level at once; a refusal puts it back.
          set.mutate({ level: next });
          setOpen(false);
        }}
      >
        {own > 0 && <p className="small muted">{t("approvalsLevel.ownAgents", { count: own })}</p>}
      </ApprovalsLevelDialog>
    </div>
  );
}
