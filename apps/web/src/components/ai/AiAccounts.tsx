import type { AiAccounts as AiAccountsView, AiHubAccount } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, useMachines } from "@agenteschat/client";
import { CLI_OF_BRAIN } from "@agenteschat/client/lib/activity";
import {
  accountTitle,
  againLogin,
  endsOnClaude,
  groupPlans,
  identityUnknown,
  offersSignInAgain,
  type PlanAccount,
  signInNote,
  unusedCopies,
} from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { isPlanId, planOf, signInProviderOf } from "@agenteschat/client/lib/plans";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  Menu,
  MenuItem,
  SettingNote,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlanHold, usePlanHold } from "@/components/ai/plan-hold";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { AddAccount } from "./AddAccountFlow";
import { CliFetchLine } from "./CliFetchLine";
import { UseOnAgentsDialog } from "./UseOnAgents";

/*
 * What can be done with an AI account in "Contas de IA" (ADR 0059), as its detail's ⋯ menu: renaming it and
 * disconnecting it (whoever manages it), signing in again and dropping copies (its owner), giving a coding plan's key
 * to every agent. Its logins (one per agent) act as one.
 */

type Row = AiAccountsView["accounts"][number];
type Open = "rename" | "again" | "remove" | "all";

/** The ⋯ of an account's detail; nothing when the viewer can do nothing with it. */
export function AccountMenu({
  logins,
  canManage,
  label,
}: {
  logins: readonly AiHubAccount[];
  canManage: boolean;
  /** The menu's name ("Mais ações"). */
  label: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiAccounts(org.id);
  const machines = useMachines(org.id);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const account = groupPlans(logins)[0];
  const a = account?.logins.find((l) => l.shared === true) ?? account?.logins[0];
  if (!account || !a) return null;
  const names = (list: string[]) => joinNames(list, t);
  const refetch = () => {
    for (const key of [keys.aiAccounts(org.id), keys.planUsage(org.id), keys.agents(org.id)])
      void qc.invalidateQueries({ queryKey: key });
  };
  const computer = computerNameOf(t, org.name, a.computer, isPersonal(org));
  // Every login of the account goes; `copies`: only those that think for no agent, each a sign-in made again.
  const remove = async (gone: readonly Row[], done: string) => {
    setBusy(true);
    try {
      for (const l of gone) await api.machines.removeAccount(org.id, l.machineId, l.id);
      toast.show(done);
      setOpen(null);
    } catch (e) {
      toast.show(errorText(t, e), "error");
    } finally {
      refetch();
      setBusy(false);
    }
  };
  const copies = a.mine ? unusedCopies(account) : [];
  const plan = planOf(a.provider);
  const again = a.mine && (account.logins.some(offersSignInAgain) || Boolean(plan));
  const all = Boolean(plan) && a.status === "active" && a.rights.canUse;
  if (!canManage && !again && !all && copies.length === 0) return null;
  return (
    <>
      <Menu
        align="end"
        label={label}
        trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={label} disabled={busy} />}
      >
        {canManage && (
          <MenuItem icon="edit" onSelect={() => setOpen("rename")}>
            {t("aiAccounts.page.rename")}
          </MenuItem>
        )}
        {again && (
          <MenuItem icon="key" onSelect={() => setOpen("again")}>
            {plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain")}
          </MenuItem>
        )}
        {all && (
          <MenuItem icon="members" onSelect={() => setOpen("all")}>
            {t("aiAccounts.page.useAll")}
          </MenuItem>
        )}
        {copies.length > 0 && (
          <MenuItem
            icon="repeat"
            onSelect={() => void remove(copies, t("aiAccounts.page.copiesRemoved", { count: copies.length }))}
          >
            {t("aiAccounts.page.removeCopies")}
          </MenuItem>
        )}
        {canManage && (
          <MenuItem icon="trash" danger onSelect={() => setOpen("remove")}>
            {t("aiAccounts.page.disconnect")}
          </MenuItem>
        )}
      </Menu>
      {open === "all" && (
        <UseOnAgentsDialog
          initial={{ brain: a.kind, account: a.id, machineId: a.machineId, model: null }}
          allPicked
          onClose={() => setOpen(null)}
        />
      )}
      {open === "rename" && (
        <RenameDialog
          account={a}
          onClose={() => setOpen(null)}
          onSaved={(name) => {
            toast.show(t("aiAccounts.page.renamed", { label: name }));
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open === "again" && (
        <AgainDialog
          account={account}
          local={ai.data?.computers.find((c) => c.machineId === a.machineId)?.mine}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            refetch();
          }}
        />
      )}
      {open === "remove" && (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && setOpen(null)}
          title={t("aiAccounts.page.disconnectTitle", { label: accountTitle(t, a) })}
          description={[
            account.usedBy.length > 0
              ? t("aiAccounts.page.disconnectAgents", {
                  count: account.usedBy.length,
                  agents: names(account.usedBy),
                  computer,
                })
              : t("aiAccounts.page.disconnectNone", { computer }),
            ...(account.logins.some((l) =>
              endsOnClaude(
                l,
                machines.data?.find((m) => m.id === l.machineId),
              ),
            )
              ? [t("aiAccounts.page.revokeOnClaude")]
              : []),
          ].join(" ")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() =>
                void remove(account.logins, t("aiAccounts.page.disconnected", { label: accountTitle(t, a) }))
              }
            >
              {t("aiAccounts.page.disconnect")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}

/**
 * What an account's detail says before its limits: what its sign-in needs (signed out, or not checked), how many of its
 * logins are copies nobody thinks with, and what stands for it when there is no email (a key's end).
 */
export function AccountNotes({ logins }: { logins: readonly AiHubAccount[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id);
  const account = groupPlans(logins)[0];
  const a = account?.logins.find((l) => l.shared === true) ?? account?.logins[0];
  if (!account || !a) return null;
  const note = signInNote(t, account, Boolean(planOf(a.provider)));
  const copies = a.mine ? unusedCopies(account) : [];
  // Its CLI being fetched on its computer (ADR 0228 §6), or why that failed.
  const computer = machines.data?.find((m) => m.id === a.machineId);
  const fetching = computer?.cliFetch?.[CLI_OF_BRAIN[a.kind] ?? ""];
  const fetchShown = Boolean(computer && fetching && fetching.state !== "ready");
  const identity = a.email
    ? a.email
    : a.keyHint
      ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
      : a.mine &&
          identityUnknown(
            a,
            machines.data?.find((m) => m.id === a.machineId),
          )
        ? t("aiAccounts.page.identityUnknown")
        : null;
  if (!note && copies.length === 0 && !identity && !fetchShown) return null;
  return (
    <div className="aa-notes">
      {identity && <span className="small muted">{identity}</span>}
      {computer && fetchShown && <CliFetchLine machine={computer} cli={CLI_OF_BRAIN[a.kind]} />}
      {note && <SettingNote icon={note.state === "out" ? "alert" : "info"}>{note.text}</SettingNote>}
      {copies.length > 0 && (
        <SettingNote icon="repeat">{t("aiAccounts.page.copies", { count: copies.length })}</SettingNote>
      )}
    </div>
  );
}

/**
 * Signing in again: a coding plan's new key goes to every login of the account, a sign-in to its first login out
 * (else one unchecked, else its first). Closes once each login took it.
 */
function AgainDialog({
  account,
  local,
  onClose,
  onDone,
}: {
  account: PlanAccount<Row>;
  local: boolean | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const hold = usePlanHold();
  const added = useRef(new Set<string>());
  const a = againLogin(account);
  if (!a) return null;
  const key = isPlanId(a.provider);
  const fanOut = key ? account.logins.map((l) => ({ id: l.id, again: l.id })) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={accountTitle(t, a)}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogBody>
        {hold ? (
          <PlanHold hold={hold} />
        ) : (
          <AddAccount
            machineId={a.machineId}
            kind={a.kind}
            computer={a.computer}
            again={a.id}
            email={a.email}
            local={local}
            {...(signInProviderOf(a.provider) ? { provider: signInProviderOf(a.provider) } : {})}
            {...(fanOut ? { fanOut } : {})}
            onBack={onClose}
            onAdded={(_, login) => {
              added.current.add(login ?? a.id);
              if (added.current.size >= (fanOut?.length ?? 1)) onDone();
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Row;
  onClose: () => void;
  onSaved: (label: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  // The automatic name ("Claude 2") is no name of theirs: the field starts empty, showing the email.
  const given = account.named === true ? account.label : "";
  const [label, setLabel] = useState(given);
  const [busy, setBusy] = useState(false);
  const name = label.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("aiAccounts.page.renameTitle", { label: accountTitle(t, account) })}
      closeLabel={t("common.close")}
      width={420}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name || busy) return;
          setBusy(true);
          api.machines.renameAccount(org.id, account.machineId, account.id, name).then(
            () => onSaved(name),
            () => {
              toast.show(t("agentPage.work.failed"), "error");
              setBusy(false);
            },
          );
        }}
      >
        <Locked when={busy}>
          <DialogBody>
            <Field
              label={t("aiAccounts.page.nameLabel")}
              id="ai-rename"
              hint={{
                name: t("common.about", { label: t("aiAccounts.page.nameLabel") }),
                text: t("aiAccounts.done.name"),
              }}
            >
              <Input
                value={label}
                maxLength={40}
                placeholder={account.email ?? t("aiAccounts.rename.placeholder")}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name || name === given}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
