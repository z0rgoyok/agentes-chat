import type { OrgRole, Person } from "@agenteschat/client";
import { useChangeRole, useSetMemberRoles } from "@agenteschat/client";
import { firstName } from "@agenteschat/client/lib/format";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { giveRole, isBelow, PEOPLE_SEARCH_FROM, peopleWith, roleName } from "@agenteschat/client/lib/roles";
import { matchesWords } from "@agenteschat/ui/search";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, GroupedFooter, GroupedList, GroupedRow, SearchField, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { givableRoles, givesRole, OWNER_ROLE } from "./logic";
import { ask, CargoMark, Gone, rolesHref, useFail, useMailLossAsk, useRolesData, useSetCargo, Waiting } from "./parts";

const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);

/**
 * Taking a person out of a cargo: at once, with Desfazer in the toast; on oneself it asks first, since only someone
 * above gives it back.
 */
function useTakeOut() {
  const { t } = useTranslation();
  const toast = useToast();
  const fail = useFail();
  const { viewer } = useRolesData();
  const cargo = useSetCargo();
  const take = (role: OrgRole, name: string, p: Person) =>
    void cargo.run(p, role.id, false).then((done) => {
      if (!done) return;
      successHaptic();
      toast({
        title: t("mobile.roles.people.removed", { person: p.name, name }),
        icon: "check",
        action: { label: t("members.undo"), onPress: () => void cargo.run(p, role.id, true).catch(fail) },
      });
    }, fail);
  return {
    busy: cargo.busy,
    run: async (role: OrgRole, p: Person) => {
      const name = roleName(t, role);
      if (p.userId !== viewer.userId) return take(role, name, p);
      const sure = await ask(
        { title: t("mobile.roles.people.selfTitle", { name }), text: t("mobile.roles.people.selfText", { name }) },
        t("common.cancel"),
        t("rolesPage.remove"),
        true,
      );
      if (sure) take(role, name, p);
    },
  };
}

/**
 * A cargo's people (P8): Adicionar pessoas, then each person with an × that takes them out ("Tirar Carla de Suporte"),
 * or "Acima do seu cargo" for someone the viewer may not change. A search past eight.
 */
export function RolePeopleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const { org, data, people, failed, error, retry, viewer } = useRolesData();
  const [query, setQuery] = useState("");
  const role = data?.roles.find((r) => r.id === roleId);
  const takeOut = useTakeOut();
  const title = t("rolesPage.peopleTitle");
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  if (!role) return <Gone title={title} />;
  const name = roleName(t, role);
  const holders = peopleWith(role, people).sort(byName);
  const shown = holders.filter((p) => matchesWords(`${p.name} ${p.email}`, query));
  const giving = givesRole(org, role);
  return (
    <SettingsPage title={title} subtitle={name} locked={takeOut.busy}>
      {holders.length > PEOPLE_SEARCH_FROM ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("rolesPage.searchPeople")}
            accessibilityLabel={t("rolesPage.searchPeople")}
          />
        </View>
      ) : null}
      <Gap />
      <GroupedList>
        {giving ? (
          <GroupedRow
            icon="plus"
            label={t("rolesPage.addPeople")}
            onPress={() => router.push(rolesHref.tab("add", role.id))}
          />
        ) : null}
        {shown.map((p) => {
          const below = isBelow(viewer, p, data.roles);
          return (
            <GroupedRow
              key={p.userId}
              leading={<Face who={{ type: "person", id: p.userId }} size={30} live={false} />}
              label={p.userId === viewer.userId ? `${p.name}${t("common.youSuffix")}` : p.name}
              sub={p.email}
              subLines={2}
              media
              {...(giving && below
                ? {
                    remove: {
                      label: t("rolesPage.removeOf", { person: p.name, name }),
                      onPress: () => void takeOut.run(role, p),
                    },
                  }
                : below
                  ? {}
                  : { belowText: t("rolesPage.aboveYou") })}
            />
          );
        })}
      </GroupedList>
      {holders.length === 0 ? <GroupedFooter>{t("rolesPage.nobody", { name })}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/**
 * Adicionar a {{name}} (`owner`: make owners): who may get it, checked, then the docked Adicionar; the mailbox question
 * first when agents would lose one. Owners are made one by one, stopping at a refusal, as on the web.
 */
export function AddToRoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, data, people: live, failed, error, retry, viewer } = useRolesData();
  const set = useSetMemberRoles(orgId);
  const change = useChangeRole(orgId);
  const askMail = useMailLossAsk();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Everyone as before Adicionar: the ones being added keep their rows while it adds and the screen goes back.
  const people = useHeldWhile(live, busy);
  const [query, setQuery] = useState("");
  const owner = roleId === OWNER_ROLE;
  const role = data?.roles.find((r) => r.id === roleId);
  const name = owner ? t("roles.owner") : role ? roleName(t, role) : "";
  const title = t("rolesPage.addTitle", { name });
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  if (!owner && !role) return <Gone title={title} />;
  const candidates = (
    owner
      ? people.filter((p) => p.role !== "owner")
      : people.filter((p) => !(p.roleIds ?? []).includes(roleId) && isBelow(viewer, p, data.roles))
  ).sort(byName);
  const add = async () => {
    setBusy(true);
    let stays = true;
    try {
      const ids = [...picked];
      let added = 0;
      let refused: unknown = null;
      if (owner) {
        for (const userId of ids) {
          try {
            await change.mutateAsync({ userId, role: "owner" });
            added++;
          } catch (e) {
            refused = e;
            break;
          }
        }
      } else {
        const seen = await askMail(roleId, ids, t("mobile.roles.mail.addAnyway"));
        if (seen === null) return;
        ({ added, failed: refused } = await giveRole(people, ids, roleId, (v) =>
          set.mutateAsync({ ...v, mailLossSeen: seen }),
        ));
      }
      if (added > 0) {
        successHaptic();
        toast({ title: t("rolesPage.added", { count: added, name }), icon: "check" });
      }
      if (refused) fail(refused);
      else {
        stays = false;
        goBack();
      }
    } catch (e) {
      fail(e);
    } finally {
      if (stays) setBusy(false);
    }
  };
  return (
    <SettingsPage
      title={title}
      locked={busy}
      bottom={
        <Button
          variant="primary"
          size="md"
          label={picked.size ? t("rolesPage.addCount", { count: picked.size }) : t("rolesPage.add")}
          disabled={picked.size === 0}
          loading={busy}
          onPress={() => void add()}
        />
      }
    >
      <GroupedFooter>{t("rolesPage.addSub")}</GroupedFooter>
      {candidates.length > PEOPLE_SEARCH_FROM ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("rolesPage.searchPeople")}
            accessibilityLabel={t("rolesPage.searchPeople")}
          />
        </View>
      ) : null}
      <Gap />
      <GroupedList>
        {candidates
          .filter((p) => matchesWords(`${p.name} ${p.email}`, query))
          .map((p) => (
            <GroupedRow
              key={p.userId}
              leading={<Face who={{ type: "person", id: p.userId }} size={30} live={false} />}
              label={p.name}
              sub={p.email}
              subLines={2}
              media
              checked={picked.has(p.userId)}
              onPress={() => {
                tapHaptic();
                setPicked((now) => {
                  const next = new Set(now);
                  if (!next.delete(p.userId)) next.add(p.userId);
                  return next;
                });
              }}
            />
          ))}
      </GroupedList>
      {candidates.length === 0 ? <GroupedFooter>{t("rolesPage.noOneLeft", { name })}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/**
 * Cargos de Carla (P11), from Membros: a switch per cargo the viewer may give, each saving on its own (the mailbox
 * question first when it would take one), every switch off while one saves. Todos is everyone's: said under them.
 */
export function PersonRolesScreen({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { data, people, failed, error, retry, viewer } = useRolesData();
  const cargo = useSetCargo();
  const person = people?.find((p) => p.userId === userId);
  const title = person ? t("members.rolesOf", { name: firstName(person.name) }) : t("rolesPage.rolesCta");
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  if (!person) return <Gone title={title} />;
  const roles = givableRoles(data.roles);
  const flip = async (role: OrgRole, on: boolean) => {
    if (!on && person.userId === viewer.userId) {
      const name = roleName(t, role);
      const sure = await ask(
        { title: t("mobile.roles.people.selfTitle", { name }), text: t("mobile.roles.people.selfText", { name }) },
        t("common.cancel"),
        t("rolesPage.remove"),
        true,
      );
      if (!sure) return;
    }
    try {
      if (await cargo.run(person, role.id, on)) successHaptic();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <SettingsPage title={title} locked={cargo.busy}>
      <Gap />
      <GroupedList>
        {roles.map((r) => {
          const on = (person.roleIds ?? []).includes(r.id);
          return (
            <GroupedRow
              key={r.id}
              leading={<CargoMark role={r} size={30} />}
              label={r.name}
              labelLines={0}
              media
              toggle={on}
              disabled={cargo.busy}
              onPress={() => void flip(r, !on)}
            />
          );
        })}
      </GroupedList>
      <GroupedFooter>{roles.length ? t("members.everyoneNote") : t("members.noRolesToGive")}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 10 },
});
