import {
  type BrowserTrailStep,
  browserTrailHosts,
  browserTrailHref,
  browserTrailKind,
  browserTrailLines,
  browserTrailPages,
  browserTrailSpanMs,
  HELD_STALE_MS,
  isHeldTakeover,
  type ScreenKind,
  trailProfile,
  useAgentBrowserHandoff,
} from "@agenteschat/client";
import { screenT } from "@agenteschat/client/lib/browser-card";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stopperName, stopperOf } from "@agenteschat/client/lib/notices";
import { siteName } from "@agenteschat/client/lib/sites";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, View } from "react-native";
import { Chip, Icon, IconButton, insetCorners, RowPressable, Text, useToast } from "@/ui";
import { keepOpen, keptOpen } from "../chat/kept-sizes";
import { useCardTop, useMessageCardCorners } from "../chat/look";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { stepText } from "./logic";
import { BAND, EndBand, SiteIcon } from "./parts";
import { TrailMark, TrailStrip } from "./TrailPixels";

/** The strip's columns in the band, the latest: its line also holds how long it took. */
const STRIP = 16;

/** A step in the person's words, from the saved trail. */
const said = (t: TFunction, s: BrowserTrailStep, screen: ScreenKind) => stepText(t, s, screen);

/**
 * Where the agent browsed, on its message after the run, as on the web (`BrowserTrailCard`): the frame it worked in,
 * closed into its top, a light band of the agent's color (`EndBand`) saying where, its steps as pixel columns in the
 * agent's tones (never a picture of the page, ADR 0040 §7) and how long. Opening it lists the steps by page (site and
 * time once), repeats folded into one line, each line with its own column, each site openable in the person's own
 * browser; the band's strip is not drawn again there. On the desktop (`screen`, ADR 0062) the same band tells the apps
 * it opened instead of the sites.
 */
export function TrailCard({
  agentId,
  runId,
  steps,
  stopped,
  recent = false,
  screen = "browser",
}: {
  agentId: string;
  /** Its run: while a take over still holds the browser, the live card stands in the conversation instead. */
  runId: string | null;
  /** `meta.browser.steps` (`browserTrailOf`), or the desktop's (`desktopTrailOf`). */
  steps: BrowserTrailStep[];
  /** The run was stopped (`meta.canceled`): who pressed Stop, or the agent that did at their word, when known. */
  stopped?: { byUserId: string | null; byAgentId?: string | null } | null;
  /** A recent message: ask the server about a take over (otherwise only what the realtime events said). */
  recent?: boolean;
  screen?: ScreenKind;
}) {
  const cardCorners = useMessageCardCorners();
  const { t, i18n } = useTranslation();
  const tt = screenT(t, screen);
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const cardTop = useCardTop();
  const when = useWhen();
  const toast = useToast();
  // Opened, it comes back open when its row comes back into view (`keptOpen`), at the size the list kept for it.
  const keep = `trail:${screen}:${runId ?? agentId}:${steps.at(-1)?.at ?? ""}`;
  const [open, setOpen] = useState(() => keptOpen(keep));
  const asks = recent && runId !== null && screen === "browser";
  const handoff = useAgentBrowserHandoff(orgId, agentId, asks, HELD_STALE_MS);
  const agent = dir.agentById.get(agentId);
  const color = agentLook(agent).color;
  const last = steps.at(-1);
  if (!last || (asks && isHeldTakeover(handoff.data, runId))) return null;

  const time = when.time(last.at);
  const by = stopped ? stopperOf(stopped, meId) : null;
  const person = stopperName(by, {
    agent: (id) => dir.nameOf({ type: "agent", id }),
    person: (id) => dir.memberById.get(id)?.name,
  });
  // Done needs no line (the message has its time); stopped says who and when.
  const ended = !stopped
    ? null
    : by?.kind === "you"
      ? tt("after.stoppedByYou", { time })
      : person
        ? tt("after.stoppedBy", { person, time })
        : tt("after.stoppedAt", { time });
  const hosts = browserTrailHosts(steps);
  // A shared profile (ADR 0110): its name then, before the site; the agent's own browser has none.
  const profile = screen === "browser" ? trailProfile(steps) : null;
  // The site alone, short ("web.acme.example" → "acme.example"): the band already says it browsed.
  const site = screen === "browser" && hosts[0] ? siteName(hosts[0]) : hosts[0];
  const title = !site
    ? tt("after.titleNoSite")
    : hosts.length > 1
      ? tt("after.titleMore", { site, count: hosts.length - 1 })
      : site;
  const count = t("chat.work.steps", { count: steps.length });
  const duration = formatDuration(t, browserTrailSpanMs(steps));
  const summary = tt("after.summaryNoSite", { steps: count, duration });
  const label = [tt("inCard.group", agentGrammar(agent?.name ?? "")), title, summary, ended].filter(Boolean).join(". ");
  const toggle = () => {
    tapHaptic();
    keepOpen(keep, !open);
    setOpen(!open);
  };

  return (
    <View style={cardTop}>
      <EndBand color={color} style={[styles.card, cardCorners]}>
        <RowPressable
          onPress={toggle}
          litColor={c.plateSoft}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={label}
          accessibilityHint={open ? tt("after.hideSteps") : tt("after.showSteps")}
          style={styles.row}
        >
          {profile ? <Chip label={profile} /> : null}
          {hosts[0] ? (
            <SiteIcon host={hosts[0]} letterOnly={screen !== "browser"} />
          ) : (
            <View style={styles.tile}>
              <Icon name={screen === "desktop" ? "laptop" : "globe"} size={14} color={c.muted} />
            </View>
          )}
          {/* One line as the web's (the site, then its steps and how long at the end) where it fits; on a narrow
              phone the steps go under the site instead of cutting it. */}
          <View style={styles.head}>
            <Text variant="footnote" tone="ink2" numberOfLines={1} style={[styles.title, styles.semibold]}>
              {title}
            </Text>
            <View style={styles.sum}>
              <TrailStrip kinds={steps.slice(-STRIP).map(browserTrailKind)} color={color} />
              <Text variant="caption" tone="muted" numberOfLines={1} style={[styles.shrink, styles.num]}>
                {summary}
              </Text>
            </View>
          </View>
          <View style={open ? styles.flip : undefined}>
            <Icon name="chev" size={13} color={c.faint} />
          </View>
        </RowPressable>
        {ended ? (
          <View style={styles.ended}>
            <Icon name="stop" size={12} color={c.faint} />
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
              {ended}
            </Text>
          </View>
        ) : null}
        {open ? (
          <View
            style={[styles.log, { backgroundColor: c.raised }, cardCorners && insetCorners(cardCorners, BAND.inset)]}
          >
            {browserTrailPages(steps).map((p, i) => {
              const href = p.link ? browserTrailHref(p.site) : null;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed list from the message
                <View key={i} style={styles.page}>
                  <View style={styles.site}>
                    <Icon name={screen === "desktop" ? "laptop" : "globe"} size={SITE_ICON} color={c.muted} />
                    <Text variant="footnote" tone="ink2" numberOfLines={1} style={[styles.grow, styles.semibold]}>
                      {p.host ?? tt("after.noSite")}
                      {p.path ? (
                        <Text variant="footnote" tone="faint" style={styles.medium}>
                          {p.path}
                        </Text>
                      ) : null}
                    </Text>
                    {p.steps[0] ? (
                      <Text variant="caption" tone="faint">
                        {when.time(p.steps[0].at)}
                      </Text>
                    ) : null}
                    {href ? (
                      <IconButton
                        icon="out"
                        small
                        label={tt("after.openSite", { site: p.site })}
                        // The person's own browser: when the phone won't open it, a toast says so.
                        onPress={() =>
                          void Linking.openURL(href).catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))
                        }
                      />
                    ) : null}
                  </View>
                  {browserTrailLines(p.steps).map((line, j) => {
                    const [a, b] = line.steps;
                    if (!a) return null;
                    const text = b
                      ? tt("after.pair", { a: said(t, a, screen), b: lowerFirst(said(t, b, screen), i18n.language) })
                      : a.failed
                        ? tt("after.failed", { step: said(t, a, screen) })
                        : said(t, a, screen);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed list from the message
                      <View key={j} style={styles.line}>
                        <View style={styles.mark}>
                          <TrailMark kind={browserTrailKind(a)} color={color} />
                        </View>
                        <Text
                          variant="footnote"
                          tone={a.failed ? "danger" : "muted"}
                          numberOfLines={1}
                          style={styles.grow}
                        >
                          {text}
                        </Text>
                        {line.times > 1 ? (
                          <View style={[styles.times, { backgroundColor: c.plate }]}>
                            <Text variant="caption" tone="ink2" style={styles.timesText}>
                              {tt("after.times", { count: line.times })}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </View>
        ) : null}
      </EndBand>
    </View>
  );
}

/** A page's site mark in the list, beside its footnote name. */
const SITE_ICON = 13;
/** The band's row: 12 in, then the 18-point tile and 9 of gap, where the stopped line's words start too. */
const ROW_IN = 12;
const TILE = 18;
const ROW_GAP = 9;

const styles = StyleSheet.create({
  // The band is the card: the conversation's card gap above it (`useCardTop`), none of its own.
  card: { alignSelf: "stretch" },
  // A finger's 44, the tools block's head beside it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    minHeight: 44,
    paddingLeft: ROW_IN,
    paddingRight: 10,
    paddingVertical: 6,
  },
  head: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: ROW_GAP,
    rowGap: 2,
  },
  // No site yet: the screen's mark in the site tile's room, so the title starts where it always does.
  tile: { width: TILE, alignItems: "center" },
  title: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  sum: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"] },
  flip: { transform: [{ rotate: "180deg" }] },
  // "Stopped at…" under the row, starting where the title does.
  ended: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: ROW_IN + TILE + ROW_GAP,
    paddingRight: 12,
    paddingBottom: 8,
  },
  // The steps inside the band, 5 in from its edges, on the card's own surface with its corners (and its cut).
  log: {
    marginHorizontal: BAND.inset,
    marginBottom: BAND.inset,
    paddingTop: 6,
    paddingHorizontal: 14 - BAND.inset,
    paddingBottom: 10,
    borderTopLeftRadius: BAND.radius - BAND.inset,
    borderTopRightRadius: BAND.radius - BAND.inset,
    borderBottomRightRadius: BAND.radius - BAND.inset,
    borderBottomLeftRadius: Math.max(1, BAND.cut - BAND.inset),
  },
  page: { paddingTop: 4 },
  site: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 },
  // A line's mark starts where its page's name does: past the site's mark and the gap.
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: SITE_ICON + 8 },
  mark: { width: 18, alignItems: "center" },
  times: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  timesText: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
