import type { OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { keys, useUpdateRole } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import type { RolePermission } from "@agenteschat/client/lib/permissions";
import {
  areaRows,
  COMPUTER_KEYS,
  COMPUTERS_ROW,
  everyoneOf,
  grants,
  isEveryone,
  levelOn,
  type PermissionAreaId,
  peopleWith,
  roleLock,
  roleName,
  rowState,
  sortRoles,
  whoStart,
  withRow,
} from "@agenteschat/client/lib/roles";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  ChipButton,
  Dialog,
  DialogFooter,
  fold,
  Icon,
  type IconName,
  InfoHint,
  SavedNote,
  SearchField,
  Select,
  Switch,
  Tip,
  Toolbar,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { WhoChip } from "./parts";
import { WhoCanDialog, type WhoCanState } from "./WhoDialogs";

const AREA_ICONS: Record<string, IconName> = {
  chat: "message",
  agents: "agent",
  tools: "plug",
  knowledge: "book",
  org: "settings",
};

/** The computers' five steps (`COMPUTER_STEPS`): none, then the person's own agents, then any agent. */
const STEPS = ["off", "ownBrowser", "ownComputer", "anyBrowser", "anyComputer"] as const;

/** Keeps "Salvo" up a moment after a save. */
function useSaved() {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  return [saved, setSaved] as const;
}

/**
 * A cargo's Permissões (W3), and Todos' (W10): one flat list in the five groups, each explanation behind its ⓘ,
 * Administrador last. A row everyone has carries the Todos chip; turning it off asks "Quem pode…" instead of a
 * locked switch (ADR 0085 addendum of 2026-11-13). Saves go one at a time, each with the cargo's whole key list.
 */
export function RolePermissions({ role, data, people }: { role: OrgRole; data: OrgRoles; people: Person[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const update = useUpdateRole(org.id, true);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useSaved();
  // Rows being saved, at the level they go to: shown there at once, disabled until it lands.
  const [pending, setPending] = useState<Map<string, number>>(new Map());
  const [who, setWho] = useState<WhoCanState | null>(null);
  const [askAdmin, setAskAdmin] = useState(false);
  const queue = useRef(Promise.resolve());
  const everyone = everyoneOf(data.roles);
  const base = isEveryone(role);
  const lock = roleLock(org, role) !== null;
  const admin = !base && role.permissions.includes("administrator");
  const name = roleName(t, role);
  // A manager who isn't an owner gives and takes only the keys they hold (`role.grant_forbidden`).
  const mine = org.role === "owner" ? null : grants(org.permissions ?? []);
  const holds = (row: string, level = 1) =>
    mine === null || (row === COMPUTERS_ROW ? level === 0 || mine.has(COMPUTER_KEYS[level - 1] ?? "") : mine.has(row));

  const save = (row: string, level: number) => {
    setPending((p) => new Map(p).set(row, level));
    queue.current = queue.current.then(async () => {
      const now = qc.getQueryData<OrgRoles>(keys.roles(org.id))?.roles.find((r) => r.id === role.id) ?? role;
      try {
        await update.mutateAsync({ roleId: role.id, patch: { permissions: withRow(now.permissions, row, level) } });
        setSaved(true);
      } catch (e) {
        if (errorCode(e) === "role.above_you") {
          toast.show(t("rolesPage.nowAbove"), "error");
          void qc.invalidateQueries({ queryKey: keys.roles(org.id) });
        } else toast.show(errorText(t, e), "error", { label: t("common.retry"), run: () => save(row, level) });
      } finally {
        setPending((p) => {
          const n = new Map(p);
          n.delete(row);
          return n;
        });
      }
    });
  };

  /** Opens "Quem pode" on a row: from this cargo's switch turned off, its chip, or Todos'. */
  const ask = (row: string, how: "off" | "chip", step?: number) => {
    const s = rowState(role, everyone, row);
    const holdersOf = (keep: number) => whoStart(data.roles, row, keep, "holders");
    if (base) {
      // Todos: lowering its step, or turning a row off, keeps it for the cargos that hold it. The chip of a key Todos
      // lacks asks about the key itself: level 1, never 0.
      const keep = Math.max(s.own, 1);
      const low = step ?? 0;
      setWho({ row, keep, low, everyone: false, ticked: holdersOf(keep) });
      return;
    }
    const keep = s.everyone;
    if (how === "chip") {
      setWho({ row, keep, low: 0, everyone: true, ticked: whoStart(data.roles, row, keep, "all") });
      return;
    }
    const low = step ?? 0;
    setWho({
      row,
      keep,
      low,
      everyone: false,
      ticked: whoStart(data.roles, row, keep, { but: role.id }),
      from: { id: role.id, level: low },
    });
  };

  const q = fold(query.trim());
  const rowTitle = (row: string) =>
    row === COMPUTERS_ROW ? t("rolesPage.computer.title") : t(`permissions.${row as RolePermission}.title`);
  const rowHint = (row: string) =>
    row === COMPUTERS_ROW ? t("rolesPage.computer.hint") : t(`permissions.${row as RolePermission}.desc`);
  const matches = (row: string, group: string) => !q || fold(`${rowTitle(row)} ${rowHint(row)} ${group}`).includes(q);

  /** The cargos holding a row on their own, for Todos' chip ("Só Admin e Financeiro"). */
  const holders = (row: string) =>
    sortRoles(
      data.roles.filter(
        (r) => !isEveryone(r) && (r.permissions.includes("administrator") || levelOn(r.permissions, row) > 0),
      ),
    );

  const keyRow = (row: string) => {
    const s = rowState(role, everyone, row);
    const level = pending.get(row) ?? (base ? s.own : s.level);
    const busy = pending.has(row);
    const held = holds(row);
    const id = `role-${role.id}-${row}`;
    const chip =
      !base && s.fromEveryone ? (
        <EveryoneChip onClick={lock || !held ? undefined : () => ask(row, "chip")} />
      ) : base && s.own === 0 && holders(row).length > 0 ? (
        <WhoChip roles={holders(row)} onClick={lock || !held ? undefined : () => ask(row, "off")} />
      ) : null;
    return (
      <PermRow
        key={row}
        id={id}
        title={rowTitle(row)}
        hint={rowHint(row)}
        status={!held && !lock ? t("rolesPage.notHeld") : undefined}
        chip={chip}
        control={
          <Switch
            id={id}
            checked={level > 0}
            disabled={lock || busy || !held}
            onCheckedChange={(on) => {
              if (on) save(row, 1);
              else if (base || s.everyone > 0) ask(row, "off");
              else save(row, 0);
            }}
          />
        }
      />
    );
  };

  const computersRow = () => {
    const s = rowState(role, everyone, COMPUTERS_ROW);
    const level = pending.get(COMPUTERS_ROW) ?? (base ? s.own : s.level);
    const id = `role-${role.id}-computers`;
    const options = STEPS.map((_, i) => ({
      value: String(i),
      label:
        i === 0
          ? t("rolesPage.computer.steps.off")
          : t(i % 2 === 1 ? "rolesPage.computer.short.browser" : "rolesPage.computer.short.computer"),
      group: i === 0 ? undefined : i <= 2 ? t("rolesPage.computer.groupOwn") : t("rolesPage.computer.groupAny"),
      disabled: !holds(COMPUTERS_ROW, i),
    }));
    return (
      <PermRow
        key={COMPUTERS_ROW}
        id={id}
        title={rowTitle(COMPUTERS_ROW)}
        hint={rowHint(COMPUTERS_ROW)}
        chip={
          !base && s.fromEveryone ? (
            <EveryoneChip
              onClick={lock || !holds(COMPUTERS_ROW, s.everyone) ? undefined : () => ask(COMPUTERS_ROW, "chip")}
            />
          ) : null
        }
        control={
          <Select
            id={id}
            size="sm"
            align="end"
            className="roles-steps"
            value={String(level)}
            disabled={lock || pending.has(COMPUTERS_ROW)}
            aria-label={rowTitle(COMPUTERS_ROW)}
            options={options}
            renderValue={(o) => (
              <span className="ac-select__text">
                {t(`rolesPage.computer.steps.${STEPS[Number(o.value)] ?? "off"}`)}
              </span>
            )}
            onValueChange={(v) => {
              const step = Number(v);
              const floor = base ? s.own : s.everyone;
              if (step < floor) ask(COMPUTERS_ROW, "off", step);
              else save(COMPUTERS_ROW, step);
            }}
          />
        }
      />
    );
  };

  const groups = data.areas.map((area) => {
    const label = t(`permissions.areas.${area.id as PermissionAreaId}`);
    const rows = areaRows(area).filter((row) => matches(row, label));
    return { area, label, rows };
  });
  const adminLabel = t("permissions.administrator.title");
  const adminShown =
    !base && (!q || fold(`${adminLabel} ${t("rolesPage.adminHint")} ${t("settings.advanced")}`).includes(q));
  const none = groups.every((g) => g.rows.length === 0) && !adminShown;
  const holdersCount = peopleWith(role, people).length;

  const adminCard = !base && (
    <Card aria-label={t("settings.advanced")} className="roles-perms">
      <CardHeader icon="shield" title={t("settings.advanced")} />
      <div className="settings-rows">
        <PermRow
          id={`role-${role.id}-admin`}
          title={adminLabel}
          hint={t("rolesPage.adminHint")}
          control={
            <Switch
              id={`role-${role.id}-admin`}
              checked={pending.get("administrator") !== undefined ? pending.get("administrator") === 1 : admin}
              disabled={lock || pending.has("administrator") || (mine !== null && !mine.has("administrator"))}
              onCheckedChange={(on) => (on ? setAskAdmin(true) : save("administrator", 0))}
            />
          }
        />
      </div>
    </Card>
  );

  return (
    <div className="roles-tab">
      {admin ? (
        <>
          <p className="roles-adminnote ac-iconline">
            <Icon name="shield" size={16} />
            <span>{t("rolesPage.adminOn", { name })}</span>
          </p>
          {adminCard}
        </>
      ) : (
        <>
          <Toolbar
            size="sm"
            search={
              <SearchField
                size="sm"
                value={query}
                placeholder={t("rolesPage.searchPermission")}
                aria-label={t("rolesPage.searchPermission")}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery("")}
                clearLabel={t("filters.clearSearch")}
              />
            }
            actions={<SavedNote shown={saved} label={t("common.saved")} />}
          />
          {none ? (
            <p className="roles-empty ac-actline">
              <span>{t("rolesPage.noPermissionMatch", { q: query.trim() })}</span>
              <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
                {t("filters.clearSearch")}
              </Button>
            </p>
          ) : (
            groups.map(
              (g) =>
                g.rows.length > 0 && (
                  <Card key={g.area.id} aria-label={g.label} className="roles-perms">
                    <CardHeader icon={AREA_ICONS[g.area.id] ?? "settings"} title={g.label} />
                    <div className="settings-rows">
                      {g.rows.map((row) => (row === COMPUTERS_ROW ? computersRow() : keyRow(row)))}
                    </div>
                  </Card>
                ),
            )
          )}
          {adminShown && adminCard}
        </>
      )}
      <p className="roles-agentnote ac-iconline">
        <Icon name="agent" size={16} />
        <span>{t("rolesPage.agentsNote")}</span>
      </p>
      <WhoCanDialog state={who} onClose={() => setWho(null)} data={data} people={people} />
      <Dialog
        open={askAdmin}
        onOpenChange={setAskAdmin}
        title={t("rolesPage.adminAsk.title", { name })}
        description={t("rolesPage.adminAsk.text", { name, count: holdersCount })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setAskAdmin(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setAskAdmin(false);
              save("administrator", 1);
            }}
          >
            {t("rolesPage.adminAsk.confirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/**
 * The Todos chip on a cargo's row: everyone has it. A button that opens "Quem pode…" (its tip says so), or plain words
 * where nothing changes.
 */
function EveryoneChip({ onClick }: { onClick?: () => void }) {
  const { t } = useTranslation();
  if (!onClick)
    return (
      <Chip icon="audienceEveryone" className="roles-who">
        {t("rolesPage.everyoneName")}
      </Chip>
    );
  return (
    <Tip tip={t("rolesPage.everyoneTip")} look="ac-msg__note-tip ac-glass" button>
      <ChipButton icon="audienceEveryone" className="roles-who" onClick={onClick}>
        {t("rolesPage.everyoneName")}
      </ChipButton>
    </Tip>
  );
}

/**
 * One permission's row: its title and ⓘ, what everyone or some cargos have as a chip, its switch or its steps. A press
 * on the words toggles a switch's row; the chip, the ⓘ and the control stay their own.
 */
function PermRow({
  id,
  title,
  hint,
  status,
  chip,
  control,
}: {
  id: string;
  title: string;
  hint: string;
  status?: string;
  chip?: ReactNode;
  control: ReactNode;
}) {
  const { t } = useTranslation();
  const toggle = (control as { type?: unknown } | null)?.type === Switch;
  return (
    <div
      className={
        toggle ? "settings-row ac-actrow settings-row--toggle roles-perm" : "settings-row ac-actrow roles-perm"
      }
    >
      <span className="settings-row__text ac-actrow__text">
        <span className="ac-hintline">
          {toggle ? (
            <label htmlFor={id} className="settings-row__label settings-row__hit">
              {title}
            </label>
          ) : (
            <label htmlFor={id} className="settings-row__label">
              {title}
            </label>
          )}
          <InfoHint name={t("common.about", { label: title })}>{hint}</InfoHint>
        </span>
        {status && <span className="settings-row__status">{status}</span>}
      </span>
      <span className="settings-row__end roles-perm__end">
        {chip}
        {control}
      </span>
    </div>
  );
}
