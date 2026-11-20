import type { MachineAccount, PlanUsage } from "@agenteschat/client";
import {
  accountTitle,
  type ExistingAi,
  haveAbout,
  haveGroup,
  lockedByOwner,
  lockedText,
  pickable,
  unnamedAccount,
} from "@agenteschat/client/lib/ai-accounts";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type PlanChoice, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { roomWord } from "@agenteschat/client/lib/plan-usage";
import { keyLine } from "@agenteschat/client/lib/providers";
import { Button, Icon, Input, ProviderLogo, planState, Radio, RadioGroup } from "@agenteschat/ui";
import { sortHave } from "@agenteschat/ui/plan-state";
import type { TFunction } from "i18next";
import { type CSSProperties, Fragment, type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRenameAccount } from "@/hooks/useRenameAccount";
import { planWord } from "@/lib/plan-usage";
import "./arrival.css";

/** A row's id in the list: an account's or a key's. */
export const haveId = (r: ExistingAi) => (r.kind === "key" ? `key:${r.key.id}` : `account:${r.choice.login.id}`);

/**
 * One row of what the person already has, as the list draws it: an account, a key, or (the agent's "Quem pensa") any
 * other way it thinks. The list orders and groups these; the row puts the radio, the mark, the name and how full the
 * plan is on one line, then a line about it and its state in words.
 */
export interface HaveItem {
  id: string;
  title: string;
  /** In its owner's group: who else thinks with it, its email or its key's end. */
  about?: string;
  /** In a list of mixed owners: whose it is ("Sua", "De Walter", "Chave do workspace"). */
  whose: string;
  /** Its group, by owner: `mine`, `keys`, or another owner's key. */
  group: { key: string; label: string };
  /** Its AI (Claude, ChatGPT…, or the API keys): its group in a list by AI (`HaveList.byAi`). */
  ai?: { key: string; label: string };
  mark: ReactNode;
  /** Its plan's limits; null where nothing says (a key). */
  usage: PlanUsage | null;
  /** Its state in words over the plan's own (`planWord`): someone else's says when it is fine too. */
  word?: string | null;
  /** It can't be picked. */
  off?: boolean;
  /** Picking it asks for a sign-in: after those used in one click. */
  signIn?: boolean;
  /** A workspace key: after the plans. */
  isKey?: boolean;
  /** The viewer's own account with no name of theirs and no email ("Unnamed account"): its title reads quieter. */
  unnamed?: boolean;
  /**
   * The viewer's own account: the pencil after its title changes its name in the row itself. `value`: the name its
   * owner gave it, empty while it has the automatic one.
   */
  rename?: { value: string; placeholder: string; save: (name: string) => Promise<unknown> };
}

/** How much of its plan an item has used, and whether it is near or at its limit; null where nothing says. */
const roomOf = (usage: PlanUsage | null) => (usage ? planState(usage) : null);
const limited = (i: Pick<HaveItem, "usage">) => roomOf(i.usage)?.state === "limited";

type Rankable = Pick<HaveItem, "usage" | "off" | "signIn" | "isKey">;

export { sortHave };

/** A row the person can't pick: someone else's they may not use, or a plan that can't run on that computer now. */
const offOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean) =>
  r.kind === "account" && (r.act === "locked" || dims(planOfAccount(r.choice.login)));

const rankOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean): Rankable => ({
  usage: r.kind === "account" ? r.choice.login.usage : null,
  off: offOf(r, dims),
  signIn: r.kind === "account" && r.act !== "use" && r.act !== "move",
  isKey: r.kind === "key",
});

/** The row a list opens on: the usable one with most room, never one at its limit while another has room. */
export function bestHave(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean): string | undefined {
  const first = sortHave(rows.map((r) => ({ r, ...rankOf(r, dims) }))).find((x) => !x.off);
  return first ? haveId(first.r) : undefined;
}

/** Up to this many rows the list shows them all, in groups; past it, this many with most room and a way to the rest. */
export const HAVE_SHOWN = 3;

/** Saves an account's new name (`useRenameAccount`). */
export type RenameAccount = (machineId: string, accountId: string, name: string) => Promise<unknown>;

/**
 * The pencil of the viewer's own account on `machineId` (`HaveItem.rename`): the name they gave it to start from, else
 * an empty field showing its email, or an example where it has none.
 */
export const renameOf = (
  t: TFunction,
  a: Pick<MachineAccount, "id" | "label" | "named" | "email" | "mine">,
  machineId: string | undefined,
  rename: RenameAccount | undefined,
): HaveItem["rename"] =>
  a.mine && machineId && rename
    ? {
        value: a.named === true ? a.label : "",
        placeholder: a.email ?? t("aiAccounts.rename.placeholder"),
        save: (name) => rename(machineId, a.id, name),
      }
    : undefined;

/** What the person already has (`ExistingAi`), as the list's rows. */
function itemOf(
  t: TFunction,
  locale: string,
  r: ExistingAi,
  agentName: string,
  dims: (choice: PlanChoice) => boolean,
  rename?: RenameAccount,
): HaveItem {
  const group = haveGroup(t, r);
  if (r.kind === "key") {
    return {
      id: haveId(r),
      title: r.key.label,
      about: keyLine(t, r.key),
      whose: group.label,
      group,
      mark: <Icon name="key" size={20} className="arrival-have__mark" />,
      usage: null,
      word: t("agentPage.work.brain.modelText", agentGrammar(agentName)),
      isKey: true,
    };
  }
  const a = r.choice.login;
  return {
    id: haveId(r),
    title: accountTitle(t, a),
    unnamed: unnamedAccount(a),
    rename: renameOf(t, a, "machineId" in a && typeof a.machineId === "string" ? a.machineId : undefined, rename),
    about: haveAbout(t, r, agentName),
    whose: a.mine ? t("connectAi.chat.yours") : group.label,
    group,
    mark: <ProviderLogo id={a.provider ?? a.kind} size="xs" />,
    ...(a.mine ? {} : { word: roomWord(t, locale, roomOf(a.usage)) }),
    ...rankOf(r, dims),
  };
}

/**
 * One row. In a list (`RadioGroup`) it is a radio, its border alone marking the one picked (no dot); `still`: the one
 * in use, shown alone, nothing to pick. `whose`: it says whose it is instead of the line about it (a list of mixed
 * owners). `onPick`: picking it acts at once, so it is a button (a radio would act on every arrow key).
 */
export function HaveRow({
  item,
  checked,
  whose = false,
  disabled = false,
  still = false,
  word,
  onPick,
}: {
  item: HaveItem;
  checked: boolean;
  whose?: boolean;
  disabled?: boolean;
  still?: boolean;
  /** Its state in words, over the plan's own ("Quase no limite"). */
  word?: string | null;
  onPick?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dom = useId();
  const [renaming, setRenaming] = useState(false);
  const off = disabled || item.off === true;
  const state = roomOf(item.usage);
  // Among mixed owners an account's own line still tells it apart (an email, whose it is); a key says whose.
  const about = whose && (item.isKey || !item.about) ? item.whose : item.about;
  const shownWord =
    word !== undefined
      ? word
      : item.word !== undefined
        ? item.word
        : item.usage
          ? planWord(t, i18n.language, item.usage)
          : null;
  const used = state ? Math.min(100, Math.round(state.used)) : 0;
  if (renaming && item.rename) return <RenameRow item={item} onDone={() => setRenaming(false)} />;
  const body = (
    <>
      {item.mark}
      <span className="arrival-have__text">
        <span className="arrival-have__head">
          <span className="arrival-have__title" data-unnamed={item.unnamed ? "" : undefined}>
            {item.title}
          </span>
          {item.rename && !disabled && (
            <button
              type="button"
              className="arrival-have__edit"
              aria-label={t("aiAccounts.rename.action", { label: item.title })}
              title={t("aiAccounts.rename.action", { label: item.title })}
              onClick={(e) => {
                // In the row's label: the click opens the name, never picks the row.
                e.preventDefault();
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
          )}
        </span>
        {about && <span className="arrival-have__line">{about}</span>}
        {shownWord && (
          <span className="arrival-have__line" data-plan={state?.state}>
            {shownWord}
          </span>
        )}
      </span>
      {state && (
        // Only the bar is hidden: how full the plan is stays read with the row, since the rows are sorted and picked
        // by room (ADR 0032, addendum).
        <span className="arrival-have__room" data-plan={state.state}>
          <span className="arrival-have__meter" aria-hidden="true">
            <i style={{ "--used": `${used}%` } as CSSProperties} />
          </span>
          <span className="arrival-have__pct">
            {new Intl.NumberFormat(i18n.language, { style: "percent" }).format(used / 100)}
          </span>
        </span>
      )}
    </>
  );
  if (still) {
    return (
      <div className="arrival-have__row" data-state="checked" data-still="">
        {body}
      </div>
    );
  }
  if (onPick) {
    return (
      <button
        type="button"
        className="arrival-have__row"
        data-state={checked ? "checked" : "unchecked"}
        data-disabled={off ? "" : undefined}
        aria-pressed={checked}
        disabled={off}
        onClick={onPick}
      >
        {body}
      </button>
    );
  }
  return (
    <label
      htmlFor={`${dom}-row`}
      className="arrival-have__row"
      data-state={checked ? "checked" : "unchecked"}
      data-disabled={off ? "" : undefined}
    >
      <Radio value={item.id} id={`${dom}-row`} disabled={off} />
      {body}
    </label>
  );
}

/** The row while its account's name is changed (`HaveItem.rename`): the field and Save where the name stood. */
function RenameRow({ item, onDone }: { item: HaveItem; onDone: () => void }) {
  const { t } = useTranslation();
  const rename = item.rename;
  const [name, setName] = useState(rename?.value ?? "");
  const [busy, setBusy] = useState(false);
  if (!rename) return null;
  const clean = name.trim();
  const save = async () => {
    if (!clean || clean === rename.value) return onDone();
    setBusy(true);
    try {
      await rename.save(clean);
      onDone();
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="arrival-have__row" data-state="unchecked" data-renaming="">
      {item.mark}
      <span className="arrival-have__text">
        <form
          className="arrival-have__rename"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            value={name}
            autoFocus
            maxLength={40}
            placeholder={rename.placeholder}
            aria-label={t("aiAccounts.rename.label")}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!clean}>
            {t("common.save")}
          </Button>
        </form>
        {item.about && <span className="arrival-have__line">{item.about}</span>}
      </span>
    </div>
  );
}

/**
 * A plan that can't be picked now, with why and its way out (`why`). Only its mark and name are dimmed: the reason
 * and its link stay readable.
 */
export function HaveOffRow({ item, why }: { item: Pick<HaveItem, "title" | "mark">; why: ReactNode }) {
  return (
    <div className="arrival-have__row" data-disabled="" data-why="">
      {item.mark}
      <span className="arrival-have__text">
        <span className="arrival-have__title">{item.title}</span>
        <span className="arrival-have__why">{why}</span>
      </span>
    </div>
  );
}

/**
 * Rows to pick one from (`HaveItem`): few are grouped (the person's, the workspace's keys, each other owner's); many
 * show the three with most room, each saying whose it is, and `all` lists every one under a search, by owner, those at
 * their limit last. `byAi`: those groups go by AI instead of by owner. `pinned`: a group over the rest whatever their
 * number (the one in use), never in `all`. `onPick`: a row acts once picked, so the rows are buttons, not radios.
 */
export function HaveList({
  items,
  value,
  onChange,
  all = false,
  onAll,
  disabled = false,
  pinned,
  label,
  byAi = false,
  notes = [],
  onPick,
}: {
  items: readonly HaveItem[];
  value: string | undefined;
  onChange: (id: string) => void;
  all?: boolean;
  onAll?: () => void;
  disabled?: boolean;
  pinned?: { label: string; items: readonly HaveItem[] };
  label: string;
  /** Its groups by AI (Claude, ChatGPT…, the API keys last) instead of by owner, a row with nothing more to say saying whose it is. */
  byAi?: boolean;
  /** A quiet line under a group (`HaveItem.group.key`), after its rows; under the list where that group has none shown. */
  notes?: readonly { key: string; text: string }[];
  onPick?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const list = sortHave(items);
  const many = items.length > HAVE_SHOWN;
  const row = (i: HaveItem, whose: boolean) => (
    <HaveRow
      key={i.id}
      item={i}
      checked={i.id === value}
      whose={whose}
      disabled={disabled}
      onPick={onPick && (() => onPick(i.id))}
    />
  );

  /** By owner: the person's, the workspace's keys, each other owner's; in `all`, those at their limit last. */
  const groups = () => {
    const out: { key: string; label: string; rows: HaveItem[] }[] = [];
    const into = (key: string, label: string, i: HaveItem) => {
      const group = out.find((g) => g.key === key);
      if (group) group.rows.push(i);
      else out.push({ key, label, rows: [i] });
    };
    const open = all ? list.filter((i) => !limited(i)) : list;
    if (byAi) {
      for (const i of open) if (i.ai && !i.isKey) into(i.ai.key, i.ai.label, i);
      for (const i of open) if (!i.ai || i.isKey) into(i.ai?.key ?? i.group.key, i.ai?.label ?? i.group.label, i);
      if (all) for (const i of list.filter(limited)) into("limit", t("connectAi.chat.atLimit"), i);
      return out;
    }
    for (const i of open) if (i.group.key === "mine") into(i.group.key, i.group.label, i);
    for (const i of open) if (i.group.key === "keys") into(i.group.key, i.group.label, i);
    for (const i of open) if (i.group.key !== "mine" && i.group.key !== "keys") into(i.group.key, i.group.label, i);
    if (all) for (const i of list.filter(limited)) into("limit", t("connectAi.chat.atLimit"), i);
    return out;
  };
  const note = (n: { key: string; text: string }) => (
    <p key={`note:${n.key}`} className="arrival-have__note">
      {n.text}
    </p>
  );
  const shownGroups = groups();
  const grouped = (
    <>
      {shownGroups.map((g) => (
        <Fragment key={g.key}>
          <p className="arrival-opts__label">{g.label}</p>
          {g.rows.map((i) => row(i, g.key === "limit" || (byAi && !i.about)))}
          {notes.filter((n) => n.key === g.key).map(note)}
        </Fragment>
      ))}
      {notes.filter((n) => !shownGroups.some((g) => g.key === n.key)).map(note)}
    </>
  );
  const top = pinned && pinned.items.length > 0 && !all && (
    <>
      <p className="arrival-opts__label">{pinned.label}</p>
      {pinned.items.map((i) => row(i, false))}
    </>
  );

  const found = query.trim()
    ? list.filter((i) => `${i.title} ${i.whose}`.toLowerCase().includes(query.trim().toLowerCase()))
    : null;
  const body = all ? (
    <>
      <label className="arrival-have__search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={query}
          placeholder={t("connectAi.chat.search")}
          aria-label={t("connectAi.chat.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="arrival-have__scroll">
        {found ? (
          found.length > 0 ? (
            found.map((i) => row(i, true))
          ) : (
            <p className="arrival-have__none">{t("connectAi.chat.none")}</p>
          )
        ) : (
          grouped
        )}
      </div>
    </>
  ) : many ? (
    <>
      {top}
      <p className="arrival-opts__label">{t("connectAi.chat.best")}</p>
      {list.slice(0, HAVE_SHOWN).map((i) => row(i, true))}
      {/* The one picked in the full list stays in sight when it isn't among the three. */}
      {list
        .slice(HAVE_SHOWN)
        .filter((i) => i.id === value)
        .map((i) => row(i, true))}
      <button type="button" className="arrival-have__link" onClick={onAll}>
        <Icon name="layers" size={16} />
        <span>{t("connectAi.chat.seeAll", { count: items.length })}</span>
        <Icon name="chevronRight" size={16} />
      </button>
      {notes.map(note)}
    </>
  ) : (
    <>
      {top}
      {grouped}
    </>
  );
  return onPick ? (
    <fieldset className="arrival-have" aria-label={label}>
      {body}
    </fieldset>
  ) : (
    <RadioGroup className="arrival-have" aria-label={label} value={value ?? ""} onValueChange={onChange}>
      {body}
    </RadioGroup>
  );
}

/**
 * What the person already has for the agent, to pick one (ADR 0160, addendum). A row puts the radio, the mark, the name
 * and how full the plan is on one line, then the line that tells it apart (`haveAbout`) and its state in words. Few
 * accounts are grouped (the person's, the workspace's keys, each other owner's); many show the three with most room,
 * and `all` lists every one under a search, by owner, those at their limit last. Someone else's that the person can't
 * pick leave the list: one line under that person's group says how many (`lockedByOwner`).
 */
export function ConnectHave({
  rows,
  agentName,
  value,
  onChange,
  dims,
  all = false,
  onAll,
  disabled = false,
  acts = false,
}: {
  rows: readonly ExistingAi[];
  agentName: string;
  value: string | undefined;
  onChange: (id: string) => void;
  /** A plan that can't sign in on that computer now: its rows are off. */
  dims: (choice: PlanChoice) => boolean;
  /** Every account, with the search. */
  all?: boolean;
  /** Past `HAVE_SHOWN` rows: opens the list of all of them. */
  onAll?: () => void;
  disabled?: boolean;
  /** A pick acts at once (no confirm at the foot): the rows are buttons (`HaveList`). */
  acts?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const rename = useRenameAccount();
  const items = pickable(rows).map((r) => itemOf(t, i18n.language, r, agentName, dims, rename));
  return (
    <HaveList
      items={items}
      notes={lockedByOwner(rows).map((o) => ({ key: o.key, text: lockedText(t, o) }))}
      value={value}
      onChange={onChange}
      all={all}
      onAll={onAll}
      disabled={disabled}
      onPick={acts ? onChange : undefined}
      label={t("connectAi.have.title")}
    />
  );
}
