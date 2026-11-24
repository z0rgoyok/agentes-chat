import type { BrowserProfile, Machine } from "@agenteschat/client";
import { profileUser, useBrowserProfileMutations, useBrowserProfiles } from "@agenteschat/client";
import { profileRefusalLine, profileToolOff, profileUnavailable } from "@agenteschat/client/lib/machines";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import {
  AvatarStack,
  Button,
  Card,
  CardHeader,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  SettingNote,
} from "@agenteschat/ui";
import { type ReactNode, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useSaid, useToast } from "@/lib/toast";
import { AgentAvatar, AgentWho } from "../AgentAvatar";
import { AgentSwitches } from "../AgentSwitches";
import { DialogHeadContext, type DialogHeadSlots, type KeptPicture } from "../computer/head";
import { ToolOneClickButton } from "../devices/ToolOneClick";
import { ErrorState, LoadingList } from "../Loading";
import { useOrg } from "../org-context";
import { BrowserCard } from "./BrowserCard";
import "../computer/computer.css";
import "./browser.css";

const errorCode = (err: unknown) => (err as { code?: string } | null)?.code;

/** "Novo perfil": a name, who may use it, one short note; creating opens the login at once. */
function NewProfileDialog({
  machineId,
  onClose,
  onCreated,
}: {
  machineId: string;
  onClose: () => void;
  onCreated: (p: BrowserProfile) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actions = useBrowserProfileMutations(org.id);
  const [name, setName] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim();
  const create = () => {
    if (!clean) return;
    actions.create.mutate(
      { machineId, name: clean, agentIds },
      {
        onSuccess: onCreated,
        onError: (err) =>
          setError(
            errorCode(err) === "browser_profile.name_taken"
              ? t("browser.profiles.nameTaken")
              : errorCode(err) === "browser_profile.machine"
                ? t("browser.profiles.outdated")
                : t("browser.profiles.failed"),
          ),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("browser.profiles.new")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Locked when={actions.create.isPending}>
          <DialogBody>
            <Field label={t("browser.profiles.name")} error={error ?? undefined}>
              <Input
                value={name}
                maxLength={60}
                placeholder={t("browser.profiles.namePlaceholder")}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            <div className="ac-field">
              <span className="ac-field__label">{t("browser.profiles.who")}</span>
              <AgentSwitches value={agentIds} onChange={setAgentIds} />
            </div>
            <SettingNote icon="alert">{t("browser.profiles.note")}</SettingNote>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!clean || actions.create.isPending}
            loading={actions.create.isPending}
          >
            {t("browser.profiles.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RenameProfileDialog({ profile, onClose }: { profile: BrowserProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actions = useBrowserProfileMutations(org.id);
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("browser.profiles.renameTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          actions.update.mutate(
            { profileId: profile.id, name: clean },
            {
              onSuccess: onClose,
              onError: (err) =>
                setError(
                  errorCode(err) === "browser_profile.name_taken"
                    ? t("browser.profiles.nameTaken")
                    : t("browser.profiles.failed"),
                ),
            },
          );
        }}
      >
        <Locked when={actions.update.isPending}>
          <DialogBody>
            <Field label={t("browser.profiles.name")} error={error ?? undefined}>
              <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!clean} loading={actions.update.isPending}>
            {t("browser.profiles.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function AgentsDialog({ profile, onClose }: { profile: BrowserProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useBrowserProfileMutations(org.id);
  const [agentIds, setAgentIds] = useState(profile.agentIds);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("browser.profiles.agentsTitle", { name: profile.name })}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogBody>
        <AgentSwitches value={agentIds} onChange={setAgentIds} />
        <SettingNote icon="alert">{t("browser.profiles.note")}</SettingNote>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            // Shows at once and the dialog closes; a refusal puts the agents back and says so.
            void actions.update
              .mutateAsync({ profileId: profile.id, agentIds })
              .catch(() => toast.show(t("browser.profiles.failed"), "error"));
            onClose();
          }}
        >
          {t("browser.profiles.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DeleteDialog({ profile, onClose }: { profile: BrowserProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useBrowserProfileMutations(org.id);
  const count = profile.agentIds.length;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("browser.profiles.deleteTitle", { name: profile.name })}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <p>
          {t("common.joinSentences", {
            a: count > 0 ? t("browser.profiles.deleteText", { count }) : t("browser.profiles.deleteTextNone"),
            b: t("common.cantUndo"),
          })}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          onClick={() => {
            // Out of the list at once and the dialog closes; a refusal puts it back and says so.
            void actions.remove.mutateAsync(profile.id).then(
              () => toast.show(t("browser.profiles.deleted", { name: profile.name })),
              () => toast.show(t("browser.profiles.failed"), "error"),
            );
            onClose();
          }}
        >
          {t("browser.profiles.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * A profile's live view, in control ("Fazer login") or watching ("Assistir"), in the computer dialog's frame: the page
 * fills it and the card's head is the dialog's head, so the profile's name shows once, in the title.
 */
function ProfileView({
  profile,
  machine,
  onClose,
}: {
  profile: BrowserProfile;
  machine: Machine;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [sub, setSub] = useState<HTMLElement | null>(null);
  const [acts, setActs] = useState<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  const picture = useRef<KeptPicture | null>(null);
  const { said, say } = useSaid();
  const head: DialogHeadSlots = {
    sub,
    actions: acts,
    full,
    setFull,
    watching: "",
    say: (text) => say(text, true),
    picture,
  };
  // Opened from "Assistir" while an agent has it, else from "Fazer login".
  const watching = profile.holder?.type === "agent";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        watching
          ? t("browser.profiles.watch", { name: profile.name })
          : t("browser.profiles.loginTitle", { name: profile.name })
      }
      subtitle={
        <>
          {said && (
            <span key={said.at} className="cmp-said ac-iconline" role="alert">
              <Icon name="alert" size={14} />
              <span>{said.text}</span>
            </span>
          )}
          <span ref={setSub} className="cmp-sub" hidden={said !== null} />
        </>
      }
      actions={<span ref={setActs} className="cmp-acts ac-acts" />}
      closeLabel={t("common.close")}
      width={1280}
      className={cx("cmp-dialog", full && "is-full")}
    >
      <DialogHeadContext.Provider value={head}>
        <div className="cmp-body">
          <BrowserCard
            agentId={`profile:${profile.id}`}
            name={profile.name}
            onFold={onClose}
            surface
            profile={{
              id: profile.id,
              name: profile.name,
              agentIds: profile.agentIds,
              canDrive: canDo(org, "manage_connectors") && canDo(org, "control_browsers"),
              machine,
            }}
          />
          <div className="cmp-steps-row" />
        </div>
      </DialogHeadContext.Provider>
    </Dialog>
  );
}

/** Why "Fazer login" didn't open, under the profile's name, with the one way out (ADR 0036 §8). */
type Refusal = { kind: "refused"; err: unknown } | { kind: "turningOn" };

function RefusalLine({
  refusal,
  machine,
  pending,
  onRetry,
}: {
  refusal: Refusal;
  machine: Machine;
  pending: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  let text: string;
  let action: ReactNode = null;
  if (refusal.kind === "turningOn") text = t("browser.profiles.turningOn", { machine: machine.name });
  else {
    text = profileRefusalLine(t, refusal.err);
    const off = profileToolOff(refusal.err);
    if (off)
      action = (
        <ToolOneClickButton
          machineId={off.machineId}
          machineName={off.machineName}
          oneClick={off.oneClick}
          tool={off.tool}
          label={off.oneClick?.kind === "allow" ? t("browser.profiles.loginOn") : undefined}
          onAllowed={onRetry}
        />
      );
    else if (profileUnavailable(refusal.err))
      action = (
        <Button size="sm" icon="refresh" loading={pending} onClick={onRetry}>
          {t("common.retry")}
        </Button>
      );
  }
  return (
    <div className={cx("pf-line small", refusal.kind === "refused" && "is-refused")} role="status">
      <span className="pf-line__text ac-iconline">
        {refusal.kind === "turningOn" ? <Icon name="check" size={14} /> : <Icon name="alert" size={14} />}
        <span>{text}</span>
      </span>
      {action}
    </div>
  );
}

type Open = { kind: "new" } | { kind: "rename" | "agents" | "delete" | "view"; profile: BrowserProfile } | null;

/**
 * "Perfis do navegador" on a computer's page (ADR 0110): named, shared logins that the chosen agents use, one at a
 * time. Each row says whether it is free or who uses it, who may use it, "Fazer login" and a menu. Creating,
 * choosing agents and deleting are for "apps e computadores"; everyone else sees the list. Single-mode computers
 * only (`profilesApply`): the caller leaves it out elsewhere.
 */
export function BrowserProfilesCard({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const look = useRightHandLook();
  const toast = useToast();
  const profiles = useBrowserProfiles(org.id);
  const actions = useBrowserProfileMutations(org.id);
  const [open, setOpen] = useState<Open>(null);
  const manage = canDo(org, "manage_connectors");
  const drive = manage && canDo(org, "control_browsers");
  const mine = (profiles.data ?? []).filter((p) => p.machineId === m.id);
  const outdated = m.browserProfiles === false;
  const [refusals, setRefusals] = useState<Record<string, Refusal>>({});
  const setRefusal = (id: string, r: Refusal | null) =>
    setRefusals(({ [id]: _, ...rest }) => (r ? { ...rest, [id]: r } : rest));
  const login = (p: BrowserProfile) =>
    actions.takeover.mutate(p.id, {
      onSuccess: (now) => {
        setRefusal(p.id, null);
        setOpen({ kind: "view", profile: now });
      },
      onError: (err) => {
        // A refusal with a cause stays on its row with its way out; anything else is a toast, as before.
        if (profileToolOff(err) || profileUnavailable(err)) setRefusal(p.id, { kind: "refused", err });
        else {
          setRefusal(p.id, null);
          toast.show(profileRefusalLine(t, err), "error");
        }
      },
    });
  return (
    <Card>
      <CardHeader
        icon="globe"
        title={t("browser.profiles.title")}
        subtitle={t("browser.profiles.sub")}
        action={
          manage &&
          !outdated &&
          !(profiles.isSuccess && mine.length === 0) && (
            <Button size="sm" icon="plus" onClick={() => setOpen({ kind: "new" })}>
              {t("browser.profiles.new")}
            </Button>
          )
        }
      />
      {outdated ? (
        <SettingNote icon="alert">{t("browser.profiles.outdated")}</SettingNote>
      ) : profiles.isPending ? (
        <LoadingList count={2} avatar={false} />
      ) : profiles.isError && !profiles.data ? (
        <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : mine.length === 0 ? (
        <EmptyState
          size="panel"
          agent={look}
          title={t("browser.profiles.emptyTitle")}
          actions={
            manage && (
              <Button variant="primary" icon="plus" onClick={() => setOpen({ kind: "new" })}>
                {t("browser.profiles.new")}
              </Button>
            )
          }
        >
          {t(manage ? "browser.profiles.empty" : "browser.profiles.emptyViewer")}
        </EmptyState>
      ) : (
        <div className="machine-page__agents pf-list">
          {mine.map((p) => {
            const user = profileUser(p);
            const userName = user?.agentId
              ? (dir.agentById.get(user.agentId)?.name ?? "")
              : user?.userId
                ? (dir.memberById.get(user.userId)?.name ?? "")
                : "";
            const live = Boolean(user?.agentId);
            return (
              <div key={p.id} className="machine-page__agent-row">
                <div className="machine-page__agent">
                  <span className="list-col">
                    <span className="machine-page__agent-name">{p.name}</span>
                    {user ? (
                      <span className="small row">
                        {user.agentId ? (
                          <Trans
                            i18nKey="browser.profiles.inUse"
                            components={{ who: <AgentWho agentId={user.agentId} name={userName} /> }}
                          />
                        ) : (
                          t("browser.profiles.inUsePerson", { name: userName })
                        )}
                      </span>
                    ) : (
                      <span className="small muted">{t("browser.profiles.free")}</span>
                    )}
                  </span>
                </div>
                <span className="pf-stack">
                  {p.agentIds.length > 0 && (
                    <AvatarStack>
                      {p.agentIds.slice(0, 5).map((id) => (
                        <AgentAvatar key={id} agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="xs" />
                      ))}
                    </AvatarStack>
                  )}
                </span>
                <span className="pf-count small muted">
                  {t("browser.profiles.agents", { count: p.agentIds.length })}
                </span>
                <span className="pf-acts">
                  {drive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="key"
                      loading={actions.takeover.isPending}
                      onClick={() => login(p)}
                    >
                      {t("browser.profiles.login")}
                    </Button>
                  )}
                  {(manage || (live && drive)) && (
                    <Menu
                      align="end"
                      trigger={
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="more"
                          aria-label={t("browser.profiles.more", { name: p.name })}
                        />
                      }
                    >
                      {live && drive && (
                        <MenuItem icon="eye" onSelect={() => setOpen({ kind: "view", profile: p })}>
                          {t("browser.profiles.watch", { name: userName })}
                        </MenuItem>
                      )}
                      {manage && (
                        <>
                          <MenuItem icon="edit" onSelect={() => setOpen({ kind: "rename", profile: p })}>
                            {t("browser.profiles.rename")}
                          </MenuItem>
                          <MenuItem icon="members" onSelect={() => setOpen({ kind: "agents", profile: p })}>
                            {t("browser.profiles.changeAgents")}
                          </MenuItem>
                          <MenuItem icon="trash" danger onSelect={() => setOpen({ kind: "delete", profile: p })}>
                            {t("browser.profiles.delete")}
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  )}
                </span>
                {refusals[p.id] && (
                  <RefusalLine
                    refusal={refusals[p.id] as Refusal}
                    machine={m}
                    pending={actions.takeover.isPending}
                    onRetry={() => {
                      if (
                        refusals[p.id]?.kind === "refused" &&
                        profileToolOff((refusals[p.id] as { err: unknown }).err)
                      )
                        setRefusal(p.id, { kind: "turningOn" });
                      login(p);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {mine.length > 0 && <SettingNote icon="lock">{t("browser.profiles.sameUser")}</SettingNote>}
      {open?.kind === "new" && (
        <NewProfileDialog
          machineId={m.id}
          onClose={() => setOpen(null)}
          onCreated={(p) => {
            setOpen(null);
            if (drive) login(p);
          }}
        />
      )}
      {open?.kind === "rename" && <RenameProfileDialog profile={open.profile} onClose={() => setOpen(null)} />}
      {open?.kind === "agents" && <AgentsDialog profile={open.profile} onClose={() => setOpen(null)} />}
      {open?.kind === "delete" && <DeleteDialog profile={open.profile} onClose={() => setOpen(null)} />}
      {open?.kind === "view" && <ProfileView profile={open.profile} machine={m} onClose={() => setOpen(null)} />}
    </Card>
  );
}
