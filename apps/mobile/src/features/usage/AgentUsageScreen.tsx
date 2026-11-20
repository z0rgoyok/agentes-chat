import type { AgentPlanUsage } from "@agenteschat/client";
import { useAgentPlanUsage, useApi } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import {
  formatMonth,
  formatPercent,
  formatShortDate,
  formatTokensShort,
  formatUsd,
  joinNames,
} from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  brandOf,
  noWindowsText,
  partedUsage,
  usageSourceName,
  usageSourcePart,
} from "@agenteschat/client/lib/plan-usage";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, Icon, InfoHint, ProviderLogo, SkeletonList, Text } from "@/ui";
import { openAgentAi } from "../ai/AgentAiScreen";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Loaded, PushedHeader } from "../shared/parts";
import { AccountHead, PlanMeter, PlanModels, Swatch, UsageCard, UsageDays } from "./parts";

/*
 * An agent's Uso, as the web's tab (ADR 0063): one sentence with the month by account, the month day by day colored
 * by account, the account it thinks with now with its windows (its part in full ink) and the month by account.
 * Money only where the server sent it (`view_usage`).
 */

export function AgentUsageScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const c = useColors();
  const dir = useDirectory();
  const meId = useMeId();
  const insets = useSafeAreaInsets();
  const usage = useAgentPlanUsage(orgId, agentId);
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  // Its owner and who manages it (the server's `canManage`) change what it thinks with, as on its page (the right
  // hand's is each person's own, on its settings). Here too: this is where they see it at its limit.
  const changes = agent && !isRightHand(agent) && (Boolean(meId && agent.ownerUserId === meId) || managesAgent(agent));
  const switchAi = changes ? (
    <View style={styles.switch}>
      <Button
        variant="secondary"
        size="sm"
        label={t("usageQueue.switchAi", agentGrammar(name))}
        onPress={() => openAgentAi(agentId)}
      />
    </View>
  ) : null;
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  // A pull asks the plans for their usage again and reads the agent's month again.
  const pull = usePullRefresh(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
    return usage.refetch();
  });
  const data = usage.data;
  // Plan accounts in inks, in the order they come (now first); the API in the agent's own color.
  const planTones = [c.ink, c.faint, c.lineStrong];
  const apiTone = gradientOf(agentLook(agent).color)[1];
  const tones = new Map<string, string>();
  let plans = 0;
  for (const s of data?.sources ?? []) {
    tones.set(s.key, s.type === "api" ? apiTone : (planTones[plans++ % planTones.length] ?? apiTone));
  }
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("usageViews.agent.title", agentGrammar(name))} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {/* The numbers fade in over the spinner; numbers already here when the screen opens just show. */}
        <LayoutAnimationConfig skipEntering>
          {usage.isLoading ? <SkeletonList rows={3} /> : null}
          {!usage.isLoading && !data ? <LoadFailed onRetry={() => void usage.refetch()} /> : null}
          {data ? (
            <Loaded>
              <View style={styles.stack}>
                <Month data={data} name={name} tones={tones} />
                {data.current ? <Now data={data} agentId={agentId} name={name} action={switchAi} /> : switchAi}
                {data.sources.length > 0 ? (
                  <BySource
                    data={data}
                    name={name}
                    onApi={!agent?.brain || agent.brain.kind === "model"}
                    apiTone={apiTone}
                  />
                ) : null}
              </View>
            </Loaded>
          ) : null}
        </LayoutAnimationConfig>
      </ScrollView>
    </View>
  );
}

function Month({ data, name, tones }: { data: AgentPlanUsage; name: string; tones: Map<string, string> }) {
  const { t, i18n } = useTranslation();
  const g = agentGrammar(name);
  const month = formatMonth(i18n.language, new Date(`${data.month}-15T12:00:00`));
  const total = (d: { tokens: Record<string, number> }) => Object.values(d.tokens).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...data.days.map(total));
  const daysInMonth = new Date(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 0).getDate();
  const columns = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${data.month}-${String(i + 1).padStart(2, "0")}`;
    const day = data.days.find((d) => d.date === date);
    if (!day) return { key: date, parts: [], ahead: true };
    return {
      key: date,
      parts: Object.entries(day.tokens).map(([key, n]) => ({
        key,
        value: (n / max) * 100,
        color: tones.get(key) ?? "#888888",
      })),
    };
  });
  const used = data.sources.filter((s) => s.tokens > 0);
  return (
    // The bar says whose usage it is: the card says what it draws, the month day by day.
    <UsageCard icon="chart" title={t("usageViews.agent.daysLabel", { month })}>
      {data.tokens === 0 ? (
        <Text variant="small" tone="muted">
          {t("usageViews.agent.empty", { ...g, month })}
        </Text>
      ) : (
        <>
          <Text variant="body" tone="ink" style={styles.sentence}>
            {t("usageViews.agent.sentence", {
              ...g,
              month,
              tokens: formatTokensShort(t, i18n.language, data.tokens),
              parts: joinNames(
                used.map((s) => usageSourcePart(t, i18n.language, s)),
                t,
              ),
            })}
          </Text>
          {typeof data.equivalentUsd === "number" && data.equivalentUsd > 0 ? (
            <InfoHint
              name={t("common.about", { label: t("usageViews.apiPrice") })}
              text={t("usageViews.apiPriceHint")}
              variant="small"
            >
              <Text variant="small" tone="muted">
                {t("usageViews.agent.equivalent", { amount: formatUsd(i18n.language, data.equivalentUsd) })}
              </Text>
            </InfoHint>
          ) : null}
          <UsageDays
            days={columns}
            label={t("usageViews.agent.daysLabel", { month })}
            marks={[1, 8, 15, 22, daysInMonth]}
          />
          <View style={styles.legend}>
            {used.map((s) => (
              <View key={s.key} style={styles.legendItem}>
                <Swatch color={tones.get(s.key) ?? "#888888"} />
                <Text variant="small" tone="muted">
                  {usageSourceName(t, s)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </UsageCard>
  );
}

function Now({
  data,
  agentId,
  name,
  action,
}: {
  data: AgentPlanUsage;
  agentId: string;
  name: string;
  /** "Trocar a IA do Nick", under the account it thinks with now, for who may. */
  action: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const g = agentGrammar(name);
  const current = data.current;
  if (!current) return null;
  // Who else thinks with it now; one that used it earlier this month only counts in the windows' parts.
  const others = current.agents
    .filter((a) => a.now && a.agentId !== agentId)
    .map((a) => dir.agentById.get(a.agentId)?.name ?? a.name);
  return (
    <UsageCard
      icon="clock"
      title={t("usageViews.agent.now")}
      footer={t("usageViews.agent.estimateShort")}
      footerHint={{
        name: t("common.about", { label: t("usageViews.agent.now") }),
        text: t("usageViews.agent.estimate", { ...g, brand: brandOf(current) }),
      }}
    >
      <AccountHead
        account={current}
        extra={others.length ? t("usageViews.agent.sharedWith", { names: joinNames(others, t) }) : null}
      />
      {current.usage ? (
        <PlanMeter
          usage={partedUsage(
            current.usage,
            (parts) => {
              const mine = parts.find((p) => p.agentId === agentId);
              return mine
                ? t("usageViews.agent.part", { ...g, percent: formatPercent(i18n.language, mine.percent) })
                : undefined;
            },
            agentId,
          )}
        />
      ) : (
        <Text variant="small" tone="muted">
          {noWindowsText(t, current)}
        </Text>
      )}
      <PlanModels usage={current.usage} provider={current.provider} />
      {action}
    </UsageCard>
  );
}

/** The month by account (at phone width the web drops the bars: the name, then the tokens and what they're worth). */
function BySource({
  data,
  name,
  onApi,
  apiTone,
}: {
  data: AgentPlanUsage;
  name: string;
  onApi: boolean;
  apiTone: string;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const g = agentGrammar(name);
  return (
    <UsageCard icon="drive" title={t("usageViews.agent.byAccount")}>
      <View>
        {data.sources.map((s, i) => {
          const when =
            s.type === "plan" && !s.now && s.lastDay
              ? t("usageViews.agent.until", { date: formatShortDate(i18n.language, `${s.lastDay}T12:00:00`) })
              : s.now
                ? t("usageViews.agent.nowTag")
                : null;
          const money =
            s.type === "api"
              ? s.costUsd !== undefined
                ? t("usageViews.paid", { amount: formatUsd(i18n.language, s.costUsd) })
                : s.budgetPercent !== undefined
                  ? t("usageViews.budgetShare", { percent: formatPercent(i18n.language, s.budgetPercent) })
                  : null
              : typeof s.equivalentUsd === "number"
                ? t("usageViews.equivalent", { amount: formatUsd(i18n.language, s.equivalentUsd) })
                : t("usageViews.agent.ofMonth", { percent: formatPercent(i18n.language, s.share) });
          return (
            <View
              key={s.key}
              style={[styles.source, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <View>
                {s.account ? (
                  <AccountHead account={s.account} extra={when} />
                ) : (
                  <View style={styles.acct}>
                    {s.type === "api" ? (
                      <View style={[styles.key, { borderColor: c.line }]}>
                        <Icon name="lock" size={16} color={apiTone} />
                      </View>
                    ) : (
                      <ProviderLogo id={s.kind ?? "claude_code"} size="sm" off />
                    )}
                    <View style={styles.grow}>
                      <Text variant="callout" tone="ink" style={styles.bold}>
                        {usageSourceName(t, s)}
                      </Text>
                      <Text variant="small" tone="muted" numberOfLines={2}>
                        {s.type === "api"
                          ? t(onApi ? "usageViews.agent.apiMain" : "usageViews.agent.apiFallback", g)
                          : s.removed
                            ? t("usageViews.agent.removedSub")
                            : t("usageViews.agent.oldSub")}
                      </Text>
                    </View>
                  </View>
                )}
              </View>
              <View style={styles.n}>
                <Text variant="callout" tone="ink" style={[styles.bold, styles.tabular]}>
                  {formatTokensShort(t, i18n.language, s.tokens)}
                </Text>
                {money && s.type !== "api" && typeof s.equivalentUsd === "number" ? (
                  <InfoHint
                    name={t("common.about", { label: t("usageViews.apiPrice") })}
                    text={t("usageViews.apiPriceHint")}
                    variant="small"
                  >
                    <Text variant="small" tone="muted" style={styles.tabular}>
                      {money}
                    </Text>
                  </InfoHint>
                ) : money ? (
                  <Text variant="small" tone="muted" style={styles.tabular}>
                    {money}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </UsageCard>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  // The page's own gap, for the cards that fade in together.
  stack: { gap: 14 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  tabular: { fontVariant: ["tabular-nums"] },
  // The month in one sentence, read before the chart: the body's size, a step heavier.
  sentence: { fontWeight: "500" },
  legend: { flexDirection: "row", flexWrap: "wrap", rowGap: 4, columnGap: 14 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  // The figures under the account, as wide as the row: beside it, a narrow column squeezed them and the name.
  source: { gap: 6, paddingVertical: 12 },
  acct: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  key: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  n: { alignItems: "flex-start" },
  switch: { flexDirection: "row" },
});
