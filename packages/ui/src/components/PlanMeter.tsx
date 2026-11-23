import type { ReactNode } from "react";
import { cx } from "../cx";
import {
  modelQuota,
  PLAN_ALMOST,
  type PlanMeterText,
  type PlanMeterUsage,
  planAgeShown,
  planLevel,
  planLine,
  planState,
  planWindows,
  renewals,
  windowAmount,
} from "../plan-state";
import { Meter } from "./Surfaces";

export {
  limitOffers,
  modelQuota,
  type OfferAccount,
  PLAN_ALMOST,
  PLAN_CRITICAL,
  PLAN_TONE,
  type PlanLevel,
  type PlanMeterText,
  type PlanMeterUsage,
  type PlanMeterWindow,
  type PlanState,
  planAgeShown,
  planAttention,
  planLevel,
  planLine,
  planState,
  planWindows,
  windowAmount,
} from "../plan-state";

const passed = (iso: string | undefined, now: number) => iso !== undefined && Date.parse(iso) <= now;

/**
 * A plan's usage like the provider shows it: a bar per window, tightest first,
 * with its percentage and when it resets; "almost" from 80%, "at the limit
 * until…" at 100%, and how old the numbers are. The bars are ink until a window
 * nears its limit (`data-level`, `planLevel`): amber from 80%, red from 90% and at
 * the limit, the words and the percentage always beside the color. `compact`
 * (lists, an agent's facts, Contas de IA): one line with the tightest windows
 * ("semana 40% · 5h 12%", after `label`), one bar for the fullest, every window
 * on hover, and only near the limit when it renews, then how old the numbers are
 * from 10 minutes ("atualizado há 51 min"; out of date past 6 hours); a window whose own reading is that old shows
 * only its age, no number or bar ("semana atualizado há 7 h", `windowStale`); nothing
 * while no window is known, unless the plan already refused a request ("No limite"). `children` (an
 * account's agents) go between the bars and when they renew: each window's
 * renewal then moves under them, on one line, before how old the numbers are. How old they are shows only once that
 * matters (`planAgeShown`): fresh numbers need no date.
 */
export function PlanMeter({
  usage,
  text,
  compact = false,
  label,
  now = Date.now(),
  className,
  children,
}: {
  usage: PlanMeterUsage;
  text: PlanMeterText;
  compact?: boolean;
  /** Compact: what the line starts with (the account's name). */
  label?: string;
  now?: number;
  className?: string;
  children?: ReactNode;
}) {
  if (compact) {
    const shown = planLine(usage, text, now);
    if (!shown) return null;
    const line = [label, shown.line, shown.age].filter(Boolean).join(" · ");
    return (
      <div
        className={cx("ac-planmeter", "ac-planmeter--compact", className)}
        data-state={shown.state}
        data-stale={shown.stale || undefined}
        data-level={planLevel(shown.top?.used ?? 0, shown.state === "limited")}
        title={shown.title}
      >
        {line && <span className="ac-planmeter__line">{line}</span>}
        {shown.top && <Meter value={shown.top.used} max={100} label={text.window(shown.top)} marks={[PLAN_ALMOST]} />}
        {shown.alert && <span className="ac-planmeter__state">{shown.alert}</span>}
      </div>
    );
  }
  const rows = planWindows(usage, now);
  const { state, until, used } = planState(usage, now);
  const sections = text.group && rows.some((w) => modelQuota(w)) ? bySection(rows) : null;
  const headline = state === "limited" ? text.limited(until) : state === "almost" ? text.almost : null;
  const renews = children ? renewals(rows, text, now) : null;
  return (
    <div className={cx("ac-planmeter", className)} data-state={state} data-level={planLevel(used, state === "limited")}>
      {headline && <p className="ac-planmeter__state">{headline}</p>}
      {rows.length > 0 && (
        <ul className="ac-planmeter__windows">
          {(sections ?? rows.map((w) => ({ w, group: null, first: false }))).map(({ w, group, first }, i) => {
            const quota = modelQuota(w);
            const name =
              sections && quota ? text.window({ kind: quota.kind, usedPercent: w.usedPercent }) : text.window(w);
            // A window that reset is empty again: its parts were the old window's. One read too long ago may have.
            const fresh = !passed(w.resetsAt, now) && !w.stale;
            const heading = first && text.group ? text.group(group) : null;
            return (
              <li
                key={`${w.kind}:${w.label ?? i}`}
                className="ac-planmeter__window"
                data-level={w.stale ? "ok" : planLevel(w.used)}
                data-stale={w.stale || undefined}
              >
                {heading && <span className="ac-planmeter__group">{heading}</span>}
                <span className="ac-planmeter__name">{name}</span>
                <span className="ac-planmeter__pct">{windowAmount(usage, w, text)}</span>
                {!w.stale && (
                  <Meter
                    value={w.used}
                    max={100}
                    label={group ? `${text.group?.(group) ?? group} · ${name}` : name}
                    marks={[PLAN_ALMOST]}
                    {...(w.part !== undefined && fresh ? { part: w.part } : {})}
                    {...(w.segments && fresh ? { segments: w.segments } : {})}
                  />
                )}
                {w.note && fresh && <small className="ac-planmeter__note">{w.note}</small>}
                {w.resetsAt && fresh && !children && (
                  <small className="ac-planmeter__reset">{text.resets(w.resetsAt)}</small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {children}
      {children && renews && <small className="ac-planmeter__reset">{renews}</small>}
      {planAgeShown(usage, now) && <small className="ac-planmeter__at">{text.updated(usage.at)}</small>}
    </div>
  );
}

/**
 * The full meter's rows by whom they bind (`modelQuota`): the account's own first, then each model group's in the
 * order its tightest quota comes, each row's order within kept; `first` starts a section (its heading).
 */
function bySection<W extends { kind: string; label?: string }>(rows: readonly W[]) {
  const groups: (string | null)[] = [];
  for (const w of rows) {
    const group = modelQuota(w)?.group ?? null;
    if (!groups.includes(group)) groups.push(group);
  }
  // The account's own (no group) lead whatever their usage.
  groups.sort((a, b) => Number(a !== null) - Number(b !== null));
  return groups.flatMap((group) =>
    rows.filter((w) => (modelQuota(w)?.group ?? null) === group).map((w, i) => ({ w, group, first: i === 0 })),
  );
}
