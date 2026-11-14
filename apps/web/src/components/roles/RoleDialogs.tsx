import type { OrgRole, OrgRoles, Person } from "@agenteschat/client";
import {
  channelMembersQuery,
  useApi,
  useChannels,
  useCreateRole,
  useDeleteRole,
  useUpdateRole,
} from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import {
  deleteLeavers,
  holdsAll,
  isEveryone,
  peopleWith,
  ROLE_TEMPLATES,
  ROLES_MAX,
  roleName,
  sortRoles,
} from "@agenteschat/client/lib/roles";
import {
  type AgentColor,
  Alert,
  agentGradient,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  Field,
  Icon,
  type IconName,
  Input,
  Locked,
  RoleMark,
  Select,
  SettingRow,
  Switch,
} from "@agenteschat/ui";
import { useQueries } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { Names, useRoleNav } from "./parts";

/** A cargo's name at most (`ROLE_NAME_MAX` on the server). */
const NAME_MAX = 40;

/**
 * Duplicar: a copy below the viewer with the source's keys, channels and agents (`copyFrom`), opened at once. Only a
 * cargo below them whose keys they all hold.
 */
export function useDuplicate() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const nav = useRoleNav();
  const create = useCreateRole(org.id, true);
  return {
    allowed: (role: OrgRole) => !isEveryone(role) && role.editable && holdsAll(org, role.permissions),
    run: (role: OrgRole) => {
      const name = t("rolesPage.copyName", { name: role.name }).slice(0, NAME_MAX);
      create.mutate(
        { name, copyFrom: role.id },
        {
          onSuccess: (r) => {
            toast.show(t("rolesPage.created", { name }));
            nav.open(r.id);
          },
          onError: (e) => toast.show(errorText(t, e), "error"),
        },
      );
    },
  };
}

/**
 * "Nome, cor e ícone" (behind ✎): a live preview (the mark, a name in the color as the chat paints it), the name, the
 * color, the icon and "Mostrar separado"; Todos keeps its name and icon, only its color changes.
 */
export function LookDialog({
  open,
  onOpenChange,
  role,
  data,
  people,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: OrgRole;
  data: OrgRoles;
  people: Person[];
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const update = useUpdateRole(org.id, true);
  const base = isEveryone(role);
  const [draft, setDraft] = useState({ name: role.name, color: role.color, icon: role.icon, hoist: role.hoist });
  const [tried, setTried] = useState(false);
  // Each opening starts from the cargo as it is now; while open, a change by someone else never overwrites the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per opening
  useEffect(() => {
    if (open) setDraft({ name: role.name, color: role.color, icon: role.icon, hoist: role.hoist });
  }, [open]);
  const name = draft.name.trim();
  const nameError = !base && tried && !name ? t("errors.role.nameRequired") : null;
  const tooLong = !base && name.length > NAME_MAX ? t("errors.role.nameLong", { max: NAME_MAX }) : null;
  const patch = {
    ...(!base && name !== role.name ? { name } : {}),
    ...(draft.color !== role.color ? { color: draft.color } : {}),
    ...(!base && draft.icon !== role.icon ? { icon: draft.icon } : {}),
    ...(!base && draft.hoist !== role.hoist ? { hoist: draft.hoist } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  const close = (next: boolean) => {
    if (update.isPending) return;
    if (!next) {
      setTried(false);
      update.reset();
    }
    onOpenChange(next);
  };
  const save = () => {
    setTried(true);
    if ((!base && !name) || tooLong) return;
    if (!changed) return close(false);
    update.mutate({ roleId: role.id, patch }, { onSuccess: () => onOpenChange(false) });
  };
  const [top, deep] = agentGradient(draft.color as AgentColor);
  // Whose name the preview paints: someone who holds it, else the viewer.
  const sample = (isEveryone(role) ? undefined : peopleWith(role, people)[0]?.name) ?? me.user.name;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("rolesPage.lookTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <Locked when={update.isPending}>
        <DialogBody>
          {/* The mark is a word of the name's line, on its capitals' middle; a long name wraps under it. */}
          <p className="roles-preview">
            <span className="roles-preview__mark">
              <RoleMark color={draft.color} icon={base ? role.icon : draft.icon} size={32} />
            </span>
            <b className="roles-preview__name" style={{ "--msg-name": deep, "--msg-name-dark": top } as CSSProperties}>
              {sample}
            </b>{" "}
            <span className="roles-preview__where">{t("rolesPage.previewWhere")}</span>
          </p>
          {base ? (
            <p className="roles-look__status">{t("rolesPage.locked.everyone")}</p>
          ) : (
            <Field
              label={t("rolesPage.name")}
              hint={{ name: t("common.about", { label: t("rolesPage.name") }), text: t("rolesPage.nameDesc") }}
              error={nameError ?? tooLong}
            >
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    save();
                  }
                }}
              />
            </Field>
          )}
          <Field
            label={t("rolesPage.color")}
            hint={{ name: t("common.about", { label: t("rolesPage.color") }), text: t("rolesPage.colorDesc") }}
            group
          >
            <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
              {data.colors.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === c}
                  aria-label={t("rolesPage.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c as AgentColor, 8)}")` }}
                  onClick={() => setDraft((d) => ({ ...d, color: c }))}
                />
              ))}
            </div>
          </Field>
          {!base && (
            <Field label={t("rolesPage.icon")} group>
              <div className="roles-icons" role="radiogroup" aria-label={t("rolesPage.icon")}>
                {data.icons.map((n) => (
                  // biome-ignore lint/a11y/useSemanticElements: an icon button in a radio group
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={draft.icon === n}
                    aria-label={n}
                    className="roles-iconpick"
                    onClick={() => setDraft((d) => ({ ...d, icon: n }))}
                  >
                    <Icon name={n as IconName} size={18} />
                  </button>
                ))}
              </div>
            </Field>
          )}
          {!base && (
            <SettingRow
              title={t("rolesPage.hoist")}
              hint={{ name: t("common.about", { label: t("rolesPage.hoist") }), text: t("rolesPage.hoistDesc") }}
              htmlFor="role-hoist"
            >
              <Switch
                id="role-hoist"
                checked={draft.hoist}
                onCheckedChange={(hoist) => setDraft((d) => ({ ...d, hoist }))}
              />
            </SettingRow>
          )}
          {update.isError && <Alert>{errorText(t, update.error)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={() => close(false)} disabled={update.isPending}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={update.isPending} onClick={save}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Criar cargo: a name and where it starts from, one select whose options are all one height (the ready-made ones,
 * then "Igual a" each cargo the viewer may copy, with its channels and agents). It opens on Permissões.
 */
export function NewRoleDialog({
  open,
  onOpenChange,
  roles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: OrgRole[];
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const create = useCreateRole(org.id, true);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("blank");
  const copies = sortRoles(roles.filter((r) => !isEveryone(r) && holdsAll(org, r.permissions)));
  const typed = name.trim();
  const close = (next: boolean) => {
    if (create.isPending) return;
    if (!next) {
      setName("");
      setFrom("blank");
      create.reset();
    }
    onOpenChange(next);
  };
  const submit = () => {
    if (!typed || typed.length > NAME_MAX) return;
    const copy = from.startsWith("copy:") ? copies.find((r) => `copy:${r.id}` === from) : undefined;
    const tpl = ROLE_TEMPLATES.find((x) => x.id === from);
    // A cargo below the viewer is copied whole, its channels and agents too (`copyFrom`); one above, its keys only.
    const input = copy
      ? copy.editable
        ? { name: typed, copyFrom: copy.id }
        : { name: typed, icon: copy.icon, color: copy.color, permissions: copy.permissions }
      : { name: typed, icon: tpl?.icon, color: tpl?.color, permissions: [...(tpl?.keys ?? [])] };
    create.mutate(input, {
      onSuccess: (r) => {
        toast.show(t("rolesPage.created", { name: typed }));
        setName("");
        setFrom("blank");
        onCreated(r.id);
      },
    });
  };
  const options = [
    ...ROLE_TEMPLATES.map((x) => ({
      value: x.id as string,
      label: t(`rolesPage.templates.${x.id}`),
      leading:
        x.id === "blank" ? (
          <RoleMark color="graphite" icon="audienceEveryone" size={18} />
        ) : (
          <RoleMark color={x.color} icon={x.icon} size={18} />
        ),
    })),
    ...copies.map((r) => ({
      value: `copy:${r.id}`,
      label: r.name,
      group: t("rolesPage.sameAs"),
      leading: <RoleMark color={r.color} icon={r.icon} size={18} />,
    })),
  ];
  const failure =
    create.isError &&
    (errorCode(create.error) === "role.too_many"
      ? t("rolesPage.full", { max: ROLES_MAX })
      : errorText(t, create.error));
  return (
    <Dialog open={open} onOpenChange={close} title={t("rolesPage.newTitle")} closeLabel={t("common.close")} width={440}>
      <Locked when={create.isPending}>
        <DialogBody>
          <Field
            label={t("rolesPage.name")}
            error={typed.length > NAME_MAX ? t("errors.role.nameLong", { max: NAME_MAX }) : undefined}
          >
            <Input
              value={name}
              autoFocus
              placeholder={t("rolesPage.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          <Field label={t("rolesPage.startFrom")}>
            <Select value={from} onValueChange={setFrom} options={options} />
          </Field>
          {failure && <Alert>{failure}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button onClick={() => close(false)} disabled={create.isPending}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={!typed} loading={create.isPending} onClick={submit}>
          {t("rolesPage.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Apagar Suporte?": who holds it keeps their other cargos, and who leaves the channels they saw only through it
 * (the channels the viewer sees, read while it is open). Then the list.
 */
export function DeleteRoleDialog({
  open,
  onOpenChange,
  role,
  people,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: OrgRole;
  people: Person[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const nav = useRoleNav();
  const remove = useDeleteRole(org.id, true);
  const name = roleName(t, role);
  const channels = (useChannels(org.id).data ?? []).filter(
    (c) => c.visibility === "private" && (c.audienceRoleIds ?? []).includes(role.id),
  );
  const members = useQueries({
    queries: channels.map((c) => ({ ...channelMembersQuery(api, org.id, c.id), enabled: open })),
  });
  const membersOf = (channelId: string) => {
    const i = channels.findIndex((c) => c.id === channelId);
    return (members[i]?.data ?? []).filter((m) => m.type === "person").map((m) => m.id);
  };
  // Until its channels' members are in, the line holds its place and Apagar waits: who leaves is said before it goes.
  const reading = open && members.some((m) => m.isPending);
  const leaving = open ? deleteLeavers(role, channels, membersOf, people) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
      title={t("rolesPage.deleteTitle", { name })}
      description={t("common.joinSentences", { a: t("rolesPage.deleteText"), b: t("common.cantUndo") })}
      closeLabel={t("common.close")}
      width={440}
    >
      {(reading || leaving.length > 0) && (
        <DialogBody>
          <p className="roles-line ac-iconline" aria-live="polite">
            <Icon name="members" size={16} />
            {reading ? (
              <span className="muted">{t("rolesPage.deleteReading")}</span>
            ) : (
              <span>
                {t("rolesPage.deleteLeave", { name })} <Names names={leaving.map((p) => p.name)} bold />.
              </span>
            )}
          </p>
        </DialogBody>
      )}
      {remove.isError && (
        <DialogBody>
          <Alert>{errorText(t, remove.error)}</Alert>
        </DialogBody>
      )}
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} disabled={remove.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={reading}
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(role.id, {
              onSuccess: () => {
                toast.show(t("rolesPage.deleted", { name }));
                onOpenChange(false);
                nav.list();
              },
            })
          }
        >
          {t("rolesPage.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
