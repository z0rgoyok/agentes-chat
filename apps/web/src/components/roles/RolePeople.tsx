import type { OrgRole, OrgRoles, Person, RoleMailLoss } from "@agenteschat/client";
import { useApi, useSetMemberRoles } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { can } from "@agenteschat/client/lib/permissions";
import { isBelow, PEOPLE_SEARCH_FROM, peopleWith, roleLock, roleName } from "@agenteschat/client/lib/roles";
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  fold,
  Icon,
  List,
  Locked,
  SearchField,
  Toolbar,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { PersonRow } from "./parts";

/**
 * Gives a cargo to people, asking first when that takes a mailbox from an agent (`…/members/preview`): `ask` gets the
 * mailboxes that would go (none: yes at once), and each save carries what was agreed, so one given meanwhile is
 * refused and asked about again.
 */
export function useGiveRole() {
  const { org } = useOrg();
  const api = useApi();
  const set = useSetMemberRoles(org.id);
  return async (
    role: OrgRole,
    people: readonly Person[],
    userIds: readonly string[],
    ask: (lost: RoleMailLoss[]) => Promise<boolean>,
  ) => {
    const lost = await api.roles.mailLoss(org.id, role.id, [...userIds]);
    // Not given after all: nothing changed, and the question goes back to the pick.
    if (!(await ask(lost))) return null;
    const seen = lost.map((m) => m.accountId);
    let added = 0;
    let failed: unknown = null;
    for (const userId of userIds) {
      const p = people.find((x) => x.userId === userId);
      if (!p) continue;
      try {
        await set.mutateAsync({ userId, roleIds: [...(p.roleIds ?? []), role.id], mailLossSeen: seen });
        added++;
      } catch (e) {
        failed ??= e;
      }
    }
    return { added, failed };
  };
}

/** The mailboxes a change takes from agents, a row each: the address, whose it is and which agent reads it. */
export function MailLoss({ lost }: { lost: readonly RoleMailLoss[] }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="roles-line roles-line--live">{t("rolesPage.mail.lead")}</p>
      <List className="roles-mail">
        {lost.map((m) => (
          <div key={`${m.agentId}-${m.accountId}`} className="ac-list__row roles-mail__row">
            <Icon name="mail" size={18} />
            <span className="roles-mail__text">
              <b>{m.address}</b>
              <span>{t("rolesPage.mail.of", { owner: m.ownerName ?? m.address, agent: m.agentName })}</span>
            </span>
          </div>
        ))}
      </List>
      <p className="roles-line ac-iconline">
        <Icon name="info" size={16} />
        <span>{t("rolesPage.mail.again")}</span>
      </p>
    </>
  );
}

/** The mailbox question's title: one agent and one owner by name, else in general. */
export const mailTitle = (t: TFunction, lost: readonly RoleMailLoss[]) => {
  const agents = new Set(lost.map((m) => m.agentId));
  const owners = new Set(lost.map((m) => m.ownerName ?? m.address));
  const [first] = lost;
  return agents.size === 1 && owners.size === 1 && first
    ? t("rolesPage.mail.title", { agent: first.agentName, owner: first.ownerName ?? first.address })
    : t("rolesPage.mail.titleMany");
};

/**
 * A cargo's Pessoas (W9): who holds it, each with Tirar (Desfazer in its toast; on oneself, a question first), and
 * Adicionar pessoas. Someone above the viewer only shows. An agent found by the search says agents have no cargo.
 */
export function RolePeople({
  role,
  data,
  people,
  onAgents,
}: {
  role: OrgRole;
  data: OrgRoles;
  people: Person[];
  onAgents: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const set = useSetMemberRoles(org.id);
  const give = useGiveRole();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [self, setSelf] = useState(false);
  const holders = peopleWith(role, people);
  const name = roleName(t, role);
  const lock = roleLock(org, role) !== null;
  const gives = !lock && role.givable && can(org, "manage_members");
  const viewer = { role: org.role, rank: org.rank, userId: me.user.id };
  const below = (p: Person) => isBelow(viewer, p, data.roles);
  const q = fold(query.trim());
  const shown = holders.filter((p) => !q || fold(`${p.name} ${p.email}`).includes(q));
  const agent = q ? dir.agents.find((a) => fold(a.name).includes(q)) : undefined;
  const take = (p: Person) =>
    set.mutate(
      { userId: p.userId, roleIds: (p.roleIds ?? []).filter((id) => id !== role.id) },
      {
        onSuccess: () =>
          toast.show(t("rolesPage.holders.removed", { person: p.name, name }), "success", {
            label: t("rolesPage.holders.undo"),
            run: () => set.mutate({ userId: p.userId, roleIds: [...(p.roleIds ?? [])] }),
          }),
      },
    );
  return (
    <div className="roles-tab">
      <Toolbar
        size="sm"
        search={
          holders.length > PEOPLE_SEARCH_FROM ? (
            <SearchField
              size="sm"
              value={query}
              placeholder={t("rolesPage.searchPeople")}
              aria-label={t("rolesPage.searchPeople")}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel={t("filters.clearSearch")}
            />
          ) : undefined
        }
        actions={
          gives && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {t("rolesPage.addPeople")}
            </Button>
          )
        }
      />
      {agent && (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.holders.agent", { name: agent.name })}</span>
          <Button size="sm" variant="ghost" onClick={onAgents}>
            {t("rolesPage.holders.seeAgents")}
          </Button>
        </p>
      )}
      {holders.length === 0 ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.nobody", { name })}</span>
          {gives && (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
              {t("rolesPage.addPeople")}
            </Button>
          )}
        </p>
      ) : shown.length === 0 && !agent ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.holders.noMatch", { q: query.trim() })}</span>
          <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
            {t("filters.clearSearch")}
          </Button>
        </p>
      ) : (
        shown.length > 0 && (
          <List className="roles-people">
            {shown.map((p) => {
              const mine = p.userId === me.user.id;
              const above = !below(p);
              return (
                <PersonRow key={p.userId} person={p} you={mine} className="ac-list__row">
                  {above ? (
                    <Chip icon="lock">{t("rolesPage.aboveYou")}</Chip>
                  ) : (
                    gives && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={set.isPending && set.variables?.userId === p.userId}
                        aria-label={t("rolesPage.removeOf", { person: p.name, name })}
                        onClick={() => (mine ? setSelf(true) : take(p))}
                      >
                        {t("rolesPage.remove")}
                      </Button>
                    )
                  )}
                </PersonRow>
              );
            })}
          </List>
        )
      )}
      <AddPeopleDialog
        open={adding}
        onOpenChange={setAdding}
        title={t("rolesPage.addTitle", { name })}
        description={t("rolesPage.addSub")}
        candidates={people.filter((p) => !(p.roleIds ?? []).includes(role.id) && below(p))}
        emptyText={t("rolesPage.noOneLeft", { name })}
        onAdd={async (ids, ask) => {
          const given = await give(role, people, ids, ask);
          if (!given) return false;
          if (given.added > 0) toast.show(t("rolesPage.added", { count: given.added, name }));
          if (given.failed) toast.show(errorText(t, given.failed), "error");
          return true;
        }}
      />
      <Dialog
        open={self}
        onOpenChange={setSelf}
        title={t("rolesPage.holders.selfTitle", { name })}
        description={t("rolesPage.holders.selfText", { name })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setSelf(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              setSelf(false);
              const p = people.find((x) => x.userId === me.user.id);
              if (p) take(p);
            }}
          >
            {t("rolesPage.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/**
 * "Adicionar a Suporte": a checklist of who may get it (a search past 8), "Adicionar 2". When that takes a mailbox from
 * an agent, the same dialog turns into that question, as tall, before anything changes (`ask`).
 */
export function AddPeopleDialog({
  open,
  onOpenChange,
  title,
  description,
  candidates,
  emptyText,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  candidates: Person[];
  emptyText: string;
  /** Whether it is done (a "Voltar" from the mailbox question goes back to the pick instead). */
  onAdd: (userIds: string[], ask: (lost: RoleMailLoss[]) => Promise<boolean>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState<{ lost: RoleMailLoss[]; answer: (yes: boolean) => void } | null>(null);
  // Who could get it before Adicionar, also while it closes: the ones being added keep their rows.
  const listed = useHeldWhile(candidates, busy || !open);
  const q = fold(query.trim());
  const shown = listed.filter((p) => !q || fold(`${p.name} ${p.email}`).includes(q));
  const close = (next: boolean) => {
    if (busy && !mail) return;
    if (!next) {
      mail?.answer(false);
      setMail(null);
      setPicked(new Set());
      setQuery("");
    }
    onOpenChange(next);
  };
  const ask = (lost: RoleMailLoss[]) =>
    lost.length === 0 ? Promise.resolve(true) : new Promise<boolean>((answer) => setMail({ lost, answer }));
  const answer = (yes: boolean) => {
    mail?.answer(yes);
    setMail(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={mail ? mailTitle(t, mail.lost) : title}
      description={mail ? undefined : description}
      closeLabel={t("common.close")}
      width={440}
    >
      <Locked when={busy && !mail}>
        <DialogBody className="roles-add">
          {mail ? (
            <MailLoss lost={mail.lost} />
          ) : (
            <>
              {listed.length > PEOPLE_SEARCH_FROM && (
                <SearchField
                  size="sm"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onClear={() => setQuery("")}
                  clearLabel={t("filters.clearSearch")}
                  placeholder={t("rolesPage.searchPeople")}
                  aria-label={t("rolesPage.searchPeople")}
                />
              )}
              {shown.length === 0 ? (
                <p className="roles-empty">
                  {listed.length === 0 ? emptyText : t("rolesPage.holders.noMatch", { q: query.trim() })}
                </p>
              ) : (
                <div className="roles-pick">
                  {shown.map((p) => {
                    const id = `add-${p.userId}`;
                    return (
                      <label key={p.userId} htmlFor={id} className="scope-row roles-pick__row">
                        <Checkbox
                          id={id}
                          checked={picked.has(p.userId)}
                          onCheckedChange={(on) =>
                            setPicked((s) => {
                              const next = new Set(s);
                              if (on) next.add(p.userId);
                              else next.delete(p.userId);
                              return next;
                            })
                          }
                        />
                        <Avatar size="sm" name={p.name} imageUrl={p.avatarUrl ?? p.image} />
                        <span className="roles-person__who">
                          <b>{p.name}</b>
                          <span>{p.email}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        {mail ? (
          <>
            <Button onClick={() => answer(false)}>{t("common.back")}</Button>
            <Button variant="primary" onClick={() => answer(true)}>
              {t("rolesPage.mail.addAnyway")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => close(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={picked.size === 0}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (await onAdd([...picked], ask)) close(false);
                } catch (e) {
                  toast.show(errorText(t, e), "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {picked.size ? t("rolesPage.addCount", { count: picked.size }) : t("rolesPage.add")}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
