import type { OrgRole, Person } from "@agenteschat/client";
import { useChannels } from "@agenteschat/client";
import { joinNames, namesText } from "@agenteschat/client/lib/format";
import type { RoleTab } from "@agenteschat/client/lib/roles";
import { Avatar, Chip, ChipButton, RoleMark, Tip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** Where a list of names is cut, its other names under a tip on "mais N". */
const MARK = "\u0000";

/**
 * Names as a sentence says them, the first `max` and "e mais N" with the rest under a tip ("Carla, Diego e mais 3").
 */
export function Names({ names, max = 2, bold = false }: { names: readonly string[]; max?: number; bold?: boolean }) {
  const { t } = useTranslation();
  const shown = names.slice(0, max);
  const rest = names.slice(max);
  const word = (n: ReactNode, key: string) => (bold ? <b key={key}>{n}</b> : <span key={key}>{n}</span>);
  if (rest.length === 0) {
    const parts = joinNames(
      shown.map((_, i) => `${MARK}${i}${MARK}`),
      t,
    ).split(MARK);
    return <>{parts.map((p, i) => (i % 2 === 1 ? word(shown[Number(p)], `n${p}`) : p))}</>;
  }
  const parts = joinNames([...shown.map((_, i) => `${MARK}${i}${MARK}`), `${MARK}more${MARK}`], t).split(MARK);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        if (p !== "more") return word(shown[Number(p)], `n${p}`);
        return (
          <Tip key="more" tip={joinNames(rest, t)} look="ac-msg__note-tip ac-glass">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tip with the other names opens on the keys' focus too */}
            <b className="roles-names__more" tabIndex={0}>
              {t("notifications.namesMore", { count: rest.length })}
            </b>
          </Tip>
        );
      })}
    </>
  );
}

/**
 * Who has something, as a row's chip: "Todos", or "Só Suporte e Ana" with their marks and faces (up to 3, then "+N").
 * `onClick`: a chip that opens who may change it; `label`: its name for screen readers.
 */
export function WhoChip({
  everyone,
  roles = [],
  people = [],
  label,
  onClick,
  disabled,
  icon,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "onClick"> & {
  everyone?: boolean;
  roles?: readonly OrgRole[];
  people?: readonly { userId: string; name: string; image?: string | null }[];
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** In place of the marks: a lock for "Privado". */
  icon?: "lock";
}) {
  const { t } = useTranslation();
  const names = [...roles.map((r) => r.name), ...people.map((p) => p.name)];
  const text = everyone
    ? t("rolesPage.everyoneName")
    : icon === "lock"
      ? t("channel.visibilityPrivate")
      : t("rolesPage.only", { names: namesText(t, names, 2) });
  // Straight in the chip, no wrapper: a leading mark keeps the chip's round end.
  const lead = everyone ? undefined : icon ? undefined : (
    <>
      {roles.slice(0, 3).map((r) => (
        <RoleMark key={r.id} color={r.color} icon={r.icon} size={18} />
      ))}
      {people.slice(0, Math.max(0, 3 - roles.length)).map((p) => (
        <Avatar key={p.userId} size="xs" name={p.name} imageUrl={p.image ?? null} />
      ))}
    </>
  );
  const iconName = everyone ? "audienceEveryone" : icon;
  if (onClick)
    return (
      <ChipButton
        {...rest}
        className="roles-who"
        icon={iconName}
        lead={lead}
        aria-label={label ?? (everyone ? undefined : t("rolesPage.only", { names: joinNames(names, t) }))}
        onClick={onClick}
        disabled={disabled}
      >
        {text}
      </ChipButton>
    );
  return (
    <Chip
      {...rest}
      className="roles-who"
      icon={iconName}
      lead={lead}
      title={names.length > 2 ? joinNames(names, t) : undefined}
    >
      {text}
    </Chip>
  );
}

/**
 * A person in a cargo's list: the face, the name and the address on the name's line (under it, at the row's full width,
 * at phone width), what ends the row at its end. `className` is the list's own row (`ac-list__row`, `settings-row`).
 */
export function PersonRow({
  person,
  you,
  className,
  children,
}: {
  person: Person;
  you: boolean;
  className: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`${className} ac-mediarow ac-mediarow--row roles-person`}>
      <span className="ac-mediarow__face">
        <Avatar size="sm" name={person.name} imageUrl={person.avatarUrl ?? person.image} />
      </span>
      <span className="ac-mediarow__head">
        <b>
          {person.name}
          {you ? t("common.youSuffix") : ""}
        </b>
        <span className="ac-mediarow__meta">{person.email}</span>
      </span>
      {children && <span className="ac-mediarow__end">{children}</span>}
    </div>
  );
}

/** Opens a cargo's page (its id, `everyone` or `owner`) on a tab, or the list. */
export function useRoleNav() {
  const { org } = useOrg();
  const navigate = useNavigate();
  return {
    open: (roleId: string, tab?: RoleTab) =>
      void navigate({
        to: "/org/$orgId/settings/roles/$roleId",
        params: { orgId: org.id, roleId },
        search: tab && tab !== "permissions" ? { tab } : {},
      }),
    list: () => void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "roles" } }),
  };
}

/** A role's address on its page: `everyone` for Todos. */
export const roleRef = (r: Pick<OrgRole, "id" | "kind">) => (r.kind === "everyone" ? "everyone" : r.id);

/** Channels' and agents' names by id, for the tips that name what a cargo reaches. */
export type Names = ReturnType<typeof useNames>;
export function useNames() {
  const { org } = useOrg();
  const channels = useChannels(org.id).data ?? [];
  const dir = useDirectory(org.id);
  const byId = new Map(channels.map((c) => [c.id, c.name]));
  return {
    channel: (id: string) => byId.get(id),
    agent: (id: string) => dir.agentById.get(id)?.name,
  };
}
