import { type Hold, useAgentHolds, useStopHold } from "@agenteschat/client";
import { holdLine } from "@agenteschat/client/lib/holds";
import { Button, Icon, Menu, MenuHeading, MenuItem, MenuNote, MenuSeparator } from "@agenteschat/ui";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useSayFailed } from "./head";

/**
 * What the agent keeps running on its computer (`keep_running`, ADR 0176), for whoever may watch it: each hold's
 * line (what, which agent kept it, since when, until when) and, for who may use the computer and admins, its Stop in
 * the hold's ⋯, as rare actions are. Nothing while there is none, or for who may not see them.
 */
function useKept(agentId: string) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const q = useAgentHolds(org.id, agentId);
  const stop = useStopHold(org.id, agentId);
  const say = useSayFailed();
  // "since today 14:02" becomes "since yesterday" by itself.
  const now = useNow(60_000);
  const holds = q.data?.holds ?? [];
  const lineOf = (hold: Hold) =>
    holdLine(t, hold, {
      agent: dir.agentById.get(hold.agentId)?.name ?? "",
      locale: i18n.language,
      now: new Date(now),
    });
  // It leaves the list at once; each refusal says so, even with another stop still on its way.
  const stopOne = (hold: Hold) => void stop.mutateAsync(hold.id).catch(() => say(t("agentComputer.kept.stopFailed")));
  return { holds, canStop: q.data?.canStop === true, lineOf, stopOne };
}

/** One hold's ⋯: its Stop. */
function HoldMenu({ hold, onStop }: { hold: Hold; onStop: () => void }) {
  const { t } = useTranslation();
  const label = t("agentComputer.kept.actions", { what: hold.what });
  return (
    <Menu
      align="end"
      label={label}
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
    >
      <MenuItem icon="stop" danger onSelect={onStop}>
        {t("agentComputer.kept.stop")}
      </MenuItem>
    </Menu>
  );
}

/** A row of the agent's fact sheet, under its computer's: one line per hold. */
export function KeptRunningRow({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const kept = useKept(agentId);
  if (kept.holds.length === 0) return null;
  return (
    <section className="agp-frow agp-cell--ro cmp-kept" aria-label={t("agentComputer.kept.title")}>
      <span className="agp-cell__key">
        <Icon name="play" size={16} />
      </span>
      <small className="agp-frow__label">{t("agentComputer.kept.title")}</small>
      <ul className="agp-frow__value cmp-kept__list">
        {kept.holds.map((hold) => {
          const line = kept.lineOf(hold);
          return (
            <li key={hold.id} className="cmp-kept__item">
              <span className="cmp-kept__t">
                <b>{line.what}</b>
                <span>{line.meta}</span>
              </span>
              {kept.canStop && <HoldMenu hold={hold} onStop={() => kept.stopOne(hold)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** In the computer dialog's head: how many, and each hold's line with its Stop in the menu it opens. */
export function KeptRunningButton({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const kept = useKept(agentId);
  if (kept.holds.length === 0) return null;
  const label = t("agentComputer.kept.count", { count: kept.holds.length });
  return (
    // Radix names the menu after its trigger ("Mantido rodando · 2").
    <Menu
      align="end"
      trigger={
        <Button size="sm" variant="ghost" icon="play" className="cmp-kept__button">
          {label}
        </Button>
      }
    >
      <MenuHeading>{t("agentComputer.kept.title")}</MenuHeading>
      {kept.holds.map((hold, i) => {
        const line = kept.lineOf(hold);
        return (
          <Fragment key={hold.id}>
            {i > 0 && <MenuSeparator />}
            <MenuNote>
              <span className="cmp-kept__t">
                <b>{line.what}</b>
                <span>{line.meta}</span>
              </span>
            </MenuNote>
            {kept.canStop && (
              <MenuItem icon="stop" danger onSelect={() => kept.stopOne(hold)}>
                {t("agentComputer.kept.stopOf", { what: hold.what })}
              </MenuItem>
            )}
          </Fragment>
        );
      })}
    </Menu>
  );
}
