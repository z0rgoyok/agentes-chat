import type { Agent, AgentAudience, Channel, OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { channelMembersQuery, keys, useApi, useSetRowHolders, useWidenAudience } from "@agenteschat/client";
import { audienceAdmits, audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { RolePermission } from "@agenteschat/client/lib/permissions";
import {
  COMPUTERS_ROW,
  channelLeavers,
  holdersAfter,
  isEveryone,
  levelOn,
  ROLES_SEARCH_FROM,
  rowChanges,
  rowHolders,
  sortRoles,
  writableRoles,
} from "@agenteschat/client/lib/roles";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  fold,
  Icon,
  type IconName,
  Locked,
  OptionList,
  RoleMark,
  SearchField,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudiencePeoplePicker, audienceValid } from "@/components/AgentAudience";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { Names } from "./parts";

const isAdmin = (r: OrgRole) => !isEveryone(r) && r.permissions.includes("administrator");

/**
 * What a dialog opened with, kept while it closes (its exit plays over the same words), and which opening it is: each
 * opening starts its own state over.
 */
function useOpening<T>(value: T | null) {
  const [last, setLast] = useState<{ value: T; n: number } | null>(null);
  if (value !== null && value !== last?.value) setLast({ value, n: (last?.n ?? 0) + 1 });
  return value !== null && value !== last?.value ? { value, n: (last?.n ?? 0) + 1 } : last;
}

/**
 * The cargos to tick in a "Quem…" dialog: a mark, the name and how many hold it. An Administrador cargo is ticked and
 * can't change (it may everything), one above the viewer shows as it is. A search past 8, the list scrolling at 320.
 */
function RoleTicks({
  roles,
  ticked,
  onToggle,
  fixed,
  idPrefix,
}: {
  roles: readonly OrgRole[];
  ticked: ReadonlySet<string>;
  onToggle: (roleId: string, on: boolean) => void;
  /** Why a cargo can't be ticked or unticked here, and how it shows; none: it can. */
  fixed: (role: OrgRole) => { on: boolean; note: string } | null;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = fold(query.trim());
  const shown = roles.filter((r) => !q || fold(r.name).includes(q));
  return (
    <div className="roles-ticks">
      {roles.length > ROLES_SEARCH_FROM && (
        <SearchField
          size="sm"
          value={query}
          placeholder={t("rolesPage.search")}
          aria-label={t("rolesPage.search")}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("filters.clearSearch")}
        />
      )}
      <div className="roles-ticks__list">
        {shown.map((r) => {
          const id = `${idPrefix}-${r.id}`;
          const f = fixed(r);
          return (
            <label key={r.id} htmlFor={id} className="scope-row roles-tick" data-off={f ? "" : undefined}>
              <Checkbox
                id={id}
                checked={f ? f.on : ticked.has(r.id)}
                disabled={f !== null}
                onCheckedChange={(on) => onToggle(r.id, on)}
              />
              <RoleMark color={r.color} icon={r.icon} size={26} />
              <span className="scope-row__text">
                <span>{r.name}</span>
                <span className="small muted">{t("rolesPage.people", { count: r.people })}</span>
              </span>
              {f?.note && <span className="roles-tick__note">{f.note}</span>}
            </label>
          );
        })}
        {shown.length === 0 && <p className="small muted">{t("rolesPage.noMatch", { q: query.trim() })}</p>}
      </div>
    </div>
  );
}

/** A dialog's lines under its choice: what always holds ("Donos sempre podem.") and the live one, its room kept. */
function Lines({ quiet = [], live }: { quiet?: { icon: IconName; text: ReactNode }[]; live: ReactNode }) {
  return (
    <div className="roles-lines">
      {quiet.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of lines
        <p key={i} className="roles-line ac-iconline">
          <Icon name={q.icon} size={16} />
          <span>{q.text}</span>
        </p>
      ))}
      <p className="roles-line roles-line--live ac-iconline" aria-live="polite">
        <Icon name="members" size={16} />
        <span>{live}</span>
      </p>
    </div>
  );
}

/** A live line naming people: "Deixam de poder: Carla, Diego e mais 3.", the viewer first, as "você". */
function PeopleLine({ prefix, people }: { prefix: string; people: readonly Person[] }) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const names = [...people]
    .sort((a, b) => Number(b.userId === me.user.id) - Number(a.userId === me.user.id))
    .map((p) => (p.userId === me.user.id ? t("common.you") : p.name));
  return (
    <>
      {prefix} <Names names={names} bold />.
    </>
  );
}

/** What a "Quem pode" dialog is about: the row, the levels it moves between, where it started, who starts ticked. */
export interface WhoCanState {
  row: string;
  /** The level the ticked cargos keep (1, or the computers' step Todos had). */
  keep: number;
  /** `everyone`'s level once only some cargos keep it (0, or a lower step). */
  low: number;
  everyone: boolean;
  ticked: Set<string>;
  /** The cargo the change started on, at exactly this level. */
  from?: { id: string; level: number };
}

/** The computers' steps past none (`COMPUTER_STEPS`) as the sentences say them. */
const STEP_WITH = ["ownBrowser", "ownComputer", "anyBrowser", "anyComputer"] as const;
const stepWith = (step: number) => STEP_WITH[step - 1] ?? "ownBrowser";

/**
 * "Quem pode criar canais" (W4): Todos, or only some cargos, ticked in a checklist; who loses it said live; Salvar
 * changes Todos and the cargos in one call (`PUT …/permissions/{row}`). The computers' ladder says who keeps a step
 * when Todos goes below it.
 */
export function WhoCanDialog({
  state,
  onClose,
  data,
  people,
}: {
  state: WhoCanState | null;
  onClose: () => void;
  data: OrgRoles;
  people: Person[];
}) {
  const last = useOpening(state);
  if (!last) return null;
  return <WhoCan key={last.n} state={last.value} open={state !== null} onClose={onClose} data={data} people={people} />;
}

function WhoCan({
  state: s,
  open,
  onClose,
  data,
  people,
}: {
  state: WhoCanState;
  open: boolean;
  onClose: () => void;
  data: OrgRoles;
  people: Person[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useSetRowHolders(org.id, true);
  const [c, setChoice] = useState({ everyone: s.everyone, ticked: new Set(s.ticked) });
  const roles = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const computers = s.row === COMPUTERS_ROW;
  const holders = rowHolders(data.roles, s.row, c, { keep: s.keep, low: s.low, from: s.from });
  const changes = rowChanges(data.roles, s.row, holders);
  const after = holdersAfter(people, data.roles, s.row, holders);
  const writable = new Set(writableRoles(data.roles).map((r) => r.id));
  const others = roles.filter((r) => r.id !== s.from?.id);
  const title = computers
    ? t("rolesPage.who.computersTitle", { what: t(`rolesPage.computer.with.${stepWith(s.keep)}`) })
    : t("rolesPage.who.title", { short: t(`permissions.${s.row as RolePermission}.short`) });
  const live =
    after.losing.length > 0 ? (
      <PeopleLine prefix={t("rolesPage.who.losing")} people={after.losing} />
    ) : after.gaining.length > 0 && c.everyone ? (
      t("rolesPage.who.everyoneGains")
    ) : after.gaining.length > 0 ? (
      <PeopleLine prefix={t("rolesPage.who.gaining")} people={after.gaining} />
    ) : (
      t("rolesPage.who.nobody")
    );
  // The computers' ladder also says where Todos goes.
  const step =
    computers && !c.everyone
      ? s.low > 0
        ? t("rolesPage.who.computersLow", { what: t(`rolesPage.computer.with.${stepWith(s.low)}`) })
        : t("rolesPage.who.computersNone")
      : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !save.isPending && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={480}
    >
      <Locked when={save.isPending}>
        <DialogBody>
          <OptionList
            attached
            aria-label={title}
            value={c.everyone ? "everyone" : "some"}
            onValueChange={(v) => setChoice({ ...c, everyone: v === "everyone" })}
            options={[
              { value: "everyone", title: t("rolesPage.everyoneName"), description: t("rolesPage.who.everyoneDesc") },
              {
                value: "some",
                title: t("rolesPage.who.some"),
                children:
                  others.length === 0 ? (
                    <p className="small muted">{t("rolesPage.who.noRoles")}</p>
                  ) : (
                    <RoleTicks
                      roles={roles}
                      ticked={c.ticked}
                      idPrefix="who-can"
                      onToggle={(id, on) => {
                        const ticked = new Set(c.ticked);
                        if (on) ticked.add(id);
                        else ticked.delete(id);
                        setChoice({ ...c, ticked });
                      }}
                      fixed={(r) =>
                        isAdmin(r)
                          ? { on: true, note: t("permissions.administrator.title") }
                          : !writable.has(r.id)
                            ? { on: levelOn(r.permissions, s.row) >= s.keep, note: t("rolesPage.aboveYou") }
                            : null
                      }
                    />
                  ),
              },
            ]}
          />
          <Lines
            quiet={[
              ...(step ? [{ icon: "audienceEveryone" as const, text: step }] : []),
              { icon: "audienceOwner", text: t("rolesPage.who.owners") },
            ]}
            live={live}
          />
          {save.isError && <Alert>{errorText(t, save.error)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={onClose} disabled={save.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!changes}
          loading={save.isPending}
          onClick={() => save.mutate({ row: s.row, holders }, { onSuccess: onClose })}
        >
          {save.isError ? t("common.retry") : t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Who sees a channel, as a "Quem vê" dialog sets it. */
type SeesMode = "everyone" | "some" | "private";

/**
 * "Quem vê #clientes" (W6): Todos, only some cargos (a checklist), or only who is added, the three words a channel's
 * own details use; who leaves or stops seeing it said live. Saves through the channel's own change.
 */
export function WhoSeesDialog({
  channel,
  start,
  onClose,
  data,
  people,
}: {
  channel: Channel | null;
  /** The cargos it starts with ticked, on "Só alguns cargos". */
  start: ReadonlySet<string>;
  onClose: () => void;
  data: OrgRoles;
  people: Person[];
}) {
  const last = useOpening(channel);
  if (!last) return null;
  return (
    <WhoSees
      key={last.n}
      channel={last.value}
      start={start}
      open={channel !== null}
      onClose={onClose}
      data={data}
      people={people}
    />
  );
}

function WhoSees({
  channel: c,
  start,
  open,
  onClose,
  data,
  people,
}: {
  channel: Channel;
  start: ReadonlySet<string>;
  open: boolean;
  onClose: () => void;
  data: OrgRoles;
  people: Person[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const [mode, setMode] = useState<SeesMode>("some");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(start));
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (input: { visibility: "public" | "private"; audienceRoleIds: string[] }) =>
      api.chat.update(org.id, c.id, input),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.channels(org.id) }),
        qc.invalidateQueries({ queryKey: keys.roles(org.id) }),
      ]),
  });
  const members = useQuery(channelMembersQuery(api, org.id, c.id));
  const memberIds = (members.data ?? []).filter((m) => m.type === "person").map((m) => m.id);
  const roles = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  // Administrador sees every channel (ADR 0151). Any other cargo is the viewer's to tick: a channel's cargos have no
  // rank rule, as its own "Quem pode entrar" has none.
  const picked = roles.filter((r) => ticked.has(r.id) && !isAdmin(r)).map((r) => r.id);
  const next =
    mode === "everyone"
      ? { visibility: "public" as const, audienceRoleIds: [] }
      : { visibility: "private" as const, audienceRoleIds: mode === "some" ? picked : [] };
  const moved = channelLeavers(c, next, memberIds, people, data.roles);
  const live =
    mode === "everyone" ? (
      t("rolesPage.channels.openAllText")
    ) : moved.leave.length > 0 ? (
      <PeopleLine prefix={t("rolesPage.channels.leave")} people={moved.leave} />
    ) : moved.unsee.length > 0 ? (
      <PeopleLine prefix={t("rolesPage.sees.unsee")} people={moved.unsee} />
    ) : (
      t("rolesPage.who.nobody")
    );
  const title = t("rolesPage.sees.title", { channel: c.name });
  const changed =
    c.visibility !== next.visibility ||
    [...(c.audienceRoleIds ?? [])].sort().join() !== [...next.audienceRoleIds].sort().join();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={480}
    >
      <Locked when={save.isPending}>
        <DialogBody>
          <OptionList<SeesMode>
            attached
            aria-label={title}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "everyone", title: t("rolesPage.everyoneName"), description: t("newChannel.publicDesc") },
              {
                value: "some",
                title: t("rolesPage.who.some"),
                children: (
                  <RoleTicks
                    roles={roles}
                    ticked={ticked}
                    idPrefix="who-sees"
                    onToggle={(id, on) =>
                      setTicked((s) => {
                        const n = new Set(s);
                        if (on) n.add(id);
                        else n.delete(id);
                        return n;
                      })
                    }
                    fixed={(r) => (isAdmin(r) ? { on: true, note: t("permissions.administrator.title") } : null)}
                  />
                ),
              },
              { value: "private", title: t("rolesPage.sees.private"), description: t("rolesPage.sees.privateDesc") },
            ]}
          />
          <Lines live={live} />
          {save.isError && <Alert>{errorText(t, save.error)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={onClose} disabled={save.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!changed || (mode === "some" && picked.length === 0)}
          loading={save.isPending}
          onClick={() => save.mutate(next, { onSuccess: onClose })}
        >
          {save.isError ? t("common.retry") : t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Quem fala com a Ada" (W8): the agent page's "Quem pode falar" in a dialog: Todos, only some cargos and people, or
 * only the person responsible; who stops talking to it said live. Saves as the agent page does, asking first when it
 * opens someone's plan or takes a mailbox.
 */
export function WhoTalksDialog({
  agent,
  start,
  onClose,
  people,
}: {
  agent: Agent | null;
  /** Its audience as the dialog opens (the cargo ticked or unticked already). */
  start: AgentAudience;
  onClose: () => void;
  people: Person[];
}) {
  const last = useOpening(agent);
  if (!last) return null;
  return (
    <TalksDialog
      key={last.n}
      agent={last.value}
      open={agent !== null}
      start={start}
      onClose={onClose}
      people={people}
    />
  );
}

function TalksDialog({
  agent,
  open,
  start,
  onClose,
  people,
}: {
  agent: Agent;
  open: boolean;
  start: AgentAudience;
  onClose: () => void;
  people: Person[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const widen = useWidenAudience(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const [audience, setAudience] = useState<AgentAudience>(start);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const g = agentGrammar(agent.name);
  const owner = people.find((p) => p.userId === agent.ownerUserId);
  const before = audienceOf(agent);
  const as = (a: AgentAudience): Agent => ({ ...agent, audience: { ...a, consultable: before.consultable } });
  const losing = people.filter(
    (p) =>
      p.userId !== agent.ownerUserId &&
      audienceAdmits(agent, p.userId, p.roleIds ?? []) &&
      !audienceAdmits(as(audience), p.userId, p.roleIds ?? []),
  );
  const valid = audienceValid(audience, agent.ownerUserId);
  const same =
    audience.mode === before.mode &&
    (audience.mode !== "people" ||
      ([...audience.userIds].sort().join() === [...before.userIds].sort().join() &&
        [...(audience.roleIds ?? [])].sort().join() === [...before.roleIds].sort().join()));
  const title = t("rolesPage.talks.title", { name: agent.name });
  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const next = audiencePatch({ ...audience, consultable: before.consultable });
      if (await widen.saveAsync(next, asks.ask(next))) onClose();
    } catch (e) {
      // The failure's toast is the app's own (a failed write); the button reads "Tentar de novo".
      setFailed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => !next && !busy && onClose()}
        title={title}
        closeLabel={t("common.close")}
        width={480}
      >
        <Locked when={busy}>
          <DialogBody>
            <OptionList
              attached
              aria-label={title}
              value={audience.mode}
              onValueChange={(mode) => setAudience((a) => ({ ...a, mode }))}
              options={[
                { value: "everyone", title: t("rolesPage.everyoneName"), description: t("rolesPage.who.everyoneDesc") },
                {
                  value: "people",
                  title: t("rolesPage.talks.some"),
                  children: (
                    <AudiencePeoplePicker
                      value={{ userIds: audience.userIds, roleIds: audience.roleIds ?? [] }}
                      onChange={(v) => setAudience((a) => ({ ...a, ...v }))}
                      ownerUserId={agent.ownerUserId}
                      idPrefix={`talks-${agent.id}`}
                      everyRole
                    />
                  ),
                },
                {
                  value: "owner",
                  title: owner ? t("rolesPage.only", { names: owner.name }) : t("audience.mode.owner"),
                  description: t("rolesPage.talks.ownerDesc", g),
                  disabled: !agent.ownerUserId,
                },
              ]}
            />
            <Lines
              live={
                losing.length > 0 ? (
                  <PeopleLine prefix={t("rolesPage.talks.losing", { ...g, agent: agent.name })} people={losing} />
                ) : (
                  t("rolesPage.who.nobody")
                )
              }
            />
          </DialogBody>
        </Locked>
        <DialogFooter bar>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={same || !valid} loading={busy} onClick={() => void save()}>
            {failed !== null ? t("common.retry") : t("common.save")}
          </Button>
        </DialogFooter>
      </Dialog>
      {asks.dialog}
    </>
  );
}
