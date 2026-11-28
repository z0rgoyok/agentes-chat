import {
  type Memory,
  useForgetRightHandLearned,
  useMemoryAction,
  useOrgMemories,
  useSetTeamWeekPrefs,
  useSettings,
  useTeamWeekPrefs,
  useUpdateSettings,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { memoryAudienceGroups, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { canMakeTeamMemory } from "@agenteschat/client/lib/team-memory";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  EmptyState,
  Filters,
  GroupedList,
  GroupedRow,
  LIST_AVATAR,
  ListRow,
  SCREEN_X,
  SearchField,
  SectionHeader,
  SkeletonList,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { MemoryFix } from "../agents/AgentProfileScreen";
import { canEditMemories } from "../agents/logic";
import { useMemoryOriginText } from "../agents/useMemoryOriginText";
import { StarCard, StarStrip } from "../constellation/Constellation";
import { aroundStar, memoryMap } from "../constellation/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { confirmAction, Gap } from "../settings/parts";
import { Face } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { agentFilters, inAgent, justLearned, mostUsed, searchMemories } from "./logic";

const openMemory = (id: string) => router.push(`/memory/${id}`);

/**
 * Memória, pushed from Você: what the agents learned as a sky (each agent with its memories; pages live in the wiki's
 * own map), the search, a filter per agent, what they learned last and what they use most.
 */
export function MemoryScreen({ agent: initialAgent }: { agent?: string } = {}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const memories = useOrgMemories(orgId);
  const pull = usePullRefresh(memories.refetch);
  const openDm = useOpenDm();
  // Whoever answers this person: the right hand first (the server's `canTalk` holds the talk permission).
  const listener = [rightHandOf(dir.agents), ...dir.agents].find((a) => a && canTalk(a));
  const lodi = rightHandOf(dir.agents);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState(initialAgent || "all");
  const [picked, setPicked] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const shown = useMemo(() => inAgent(memories.data ?? [], agent), [memories.data, agent]);
  const map = useMemo(() => memoryMap(shown, dir.agents), [shown, dir.agents]);
  const selected = map.stars.find((s) => s.id === picked) ?? map.stars.find((s) => s.kind === "memory") ?? null;
  // The sky and the search's results cross-fade as a search starts and ends, and fade in when they load.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const when = (iso: string) => relativeTime(t, i18n.language, iso);
  // The list's own rows, as the wiki's beside it: the agent's face in the 52 column, what it learned (two lines at
  // most), whose memory it is and when.
  const row = (m: Memory, i: number) => (
    <ListRow
      key={m.id}
      divider={i > 0}
      leading={<Face who={{ type: "agent", id: m.agentId }} size={LIST_AVATAR - 2} live={false} />}
      title={m.summary ?? memoryLine(t, m)}
      titleLines={2}
      sub={`${dir.nameOf({ type: "agent", id: m.agentId })} · ${when(m.updatedAt)}`}
      subLines={1}
      chevron
      onPress={() => openMemory(m.id)}
    />
  );
  // Worked out again only when the memories or the words change, not at each render (each letter, before it settles).
  const found = useMemo(() => (search ? searchMemories(shown, search) : []), [shown, search]);
  const recent = useMemo(() => justLearned(shown), [shown]);
  const used = useMemo(() => mostUsed(shown), [shown]);
  const subtitle = !selected
    ? ""
    : selected.kind === "agent"
      ? t("mobile.memory.agentLine", { count: shown.filter((m) => m.agentId === selected.id).length })
      : t("mobile.memory.line", {
          name: dir.nameOf({ type: "agent", id: selected.agentId ?? null }),
          count: selected.weight,
        });
  return (
    <PushedLargeTitle
      title={t("mobile.memory.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {t("mobile.memory.subtitle")}
      </Text>
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.memory.search")}
          accessibilityLabel={t("mobile.memory.search")}
          returnKeyType="search"
        />
      </View>
      {/* Loading: the rows' own shape; failed: what happened and the way to ask again. */}
      {memories.isLoading ? <SkeletonList rows={4} /> : null}
      {memories.isError && !memories.data ? <LoadFailed onRetry={() => void memories.refetch()} /> : null}
      {memories.isSuccess && (memories.data ?? []).length === 0 ? (
        <FirstUse
          place="memory"
          size="panel"
          mood="thinking"
          acts={Boolean(listener)}
          label={listener ? t("team.sectors.ask", { name: listener.name }) : undefined}
          icon="chat"
          onPress={
            listener
              ? () => void openDm({ agentId: listener.id }, { compose: true, text: t("mobile.empty.memory.ask") })
              : undefined
          }
        />
      ) : null}
      {lodi && agent === lodi.id ? <RightHandLearning agentId={lodi.id} /> : null}
      {(memories.data ?? []).length > 0 ? (
        <Filters
          items={agentFilters(memories.data ?? [], dir.agents, t("mobile.memory.all"))}
          value={agent}
          onChange={(k) => {
            setAgent(k);
            setPicked(null);
          }}
        />
      ) : null}
      {search ? (
        <Animated.View key="found" {...fade}>
          {found.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.memory.noMatch")}
              action={
                <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              }
            />
          ) : (
            found.map(row)
          )}
        </Animated.View>
      ) : selected ? (
        <Animated.View key="sky" {...fade}>
          <StarCard
            label={t("mobile.memory.sky")}
            count={shown.length}
            map={map}
            selected={selected.id}
            onSelect={setPicked}
            title={selected.title}
            subtitle={subtitle}
            onOpen={() => (selected.kind === "agent" ? router.push(`/agent/${selected.id}`) : openMemory(selected.id))}
          />
          {lodi && agent === lodi.id ? (
            // The right hand's, as its Memory tab groups them: what is the viewer's alone, then each channel's.
            memoryAudienceGroups(justLearned(shown, shown.length)).map((group) => (
              <View key={group.key}>
                <SectionHeader
                  title={
                    group.key === "you"
                      ? t("agentPage.memory.learning.onlyYou")
                      : group.channel
                        ? t("agentPage.memory.learning.everyoneIn", { channel: group.channel })
                        : t("agentPage.memory.learning.everyone")
                  }
                />
                {group.items.map(row)}
              </View>
            ))
          ) : (
            <>
              <SectionHeader title={t("mobile.memory.recent")} />
              {recent.map(row)}
              <SectionHeader title={t("mobile.memory.mostUsed")} />
              {used.map(row)}
            </>
          )}
        </Animated.View>
      ) : (memories.data ?? []).length > 0 ? (
        <EmptyState
          size="inline"
          title={t("mobile.empty.memory.noneForAgent")}
          action={
            <Button variant="secondary" size="sm" label={t("mobile.memory.all")} onPress={() => setAgent("all")} />
          }
        />
      ) : null}
    </PushedLargeTitle>
  );
}

/**
 * The right hand's learning, above its memories (the web's Memory tab card): the person's own switch, Forget all (only
 * their own), and for who configures the workspace, the workspace's switch.
 */
function RightHandLearning({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const toast = useToast();
  const prefs = useTeamWeekPrefs(orgId).data;
  const setPrefs = useSetTeamWeekPrefs(orgId);
  const settings = useSettings(orgId).data;
  const setSettings = useUpdateSettings(orgId);
  const forget = useForgetRightHandLearned(orgId, agentId);
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  const workspaceOn = settings?.rightHandLearns !== false;
  const fromYou = t("agentPage.memory.learning.fromYou");
  const workspace = t("agentPage.memory.learning.workspace");
  const forgetAll = t("agentPage.memory.learning.forgetAll");
  return (
    <>
      <Gap />
      <GroupedList>
        <GroupedRow
          label={fromYou}
          labelLines={2}
          hint={{ name: t("common.about", { label: fromYou }), text: t("agentPage.memory.learning.fromYouHint") }}
          {...(!workspaceOn ? { sub: t("agentPage.memory.learning.workspaceOff") } : {})}
          toggle={workspaceOn && !prefs?.learnOff}
          disabled={!prefs || !workspaceOn}
          onPress={() => setPrefs.mutate({ learnOff: !prefs?.learnOff }, { onError: failed })}
        />
        <GroupedRow
          label={forgetAll}
          danger
          hint={{ name: t("common.about", { label: forgetAll }), text: t("agentPage.memory.learning.forgetAllHint") }}
          disabled={forget.isPending}
          onPress={() =>
            confirmAction({
              title: t("agentPage.memory.learning.forgetTitle"),
              text: t("agentPage.memory.learning.forgetText"),
              action: forgetAll,
              cancel: t("common.cancel"),
              onConfirm: () =>
                forget.mutate(undefined, {
                  onSuccess: () => toast({ title: t("agentPage.memory.learning.forgotten"), icon: "check" }),
                  onError: failed,
                }),
            })
          }
        />
        {can(org, "configure") && settings ? (
          <GroupedRow
            label={workspace}
            labelLines={2}
            hint={{ name: t("common.about", { label: workspace }), text: t("agentPage.memory.learning.workspaceHint") }}
            toggle={workspaceOn}
            disabled={setSettings.isPending}
            onPress={() => setSettings.mutate({ rightHandLearns: !workspaceOn }, { onError: failed })}
          />
        ) : null}
      </GroupedList>
    </>
  );
}

/** One memory, with its small sky. */
export function MemoryDetailScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <MemoryDetail id={id} />
    </SheetHostProvider>
  );
}

function MemoryDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const { org } = useOrg();
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const originText = useMemoryOriginText();
  const memories = useOrgMemories(orgId);
  const m = memories.data?.find((x) => x.id === id);
  const agentId = m?.agentId ?? "";
  const action = useMemoryAction(orgId, agentId);
  const reduced = useReducedMotion();
  const agent = dir.anyAgent(agentId);
  const name = dir.nameOf({ type: "agent", id: agentId });
  const editable = canEditMemories(agent, { id: meId, org });
  const [details, setDetails] = useState(false);
  const around = useMemo(
    () => aroundStar(memoryMap(memories.data ?? [], dir.agents), agentId),
    [memories.data, dir.agents, agentId],
  );
  if (!m) {
    // Still loading: the rows' shape; a list that didn't load is not a memory that's gone.
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader solid={false} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          {memories.isLoading ? (
            <SkeletonList rows={3} />
          ) : memories.isError && !memories.data ? (
            <LoadFailed onRetry={() => void memories.refetch()} />
          ) : (
            <EmptyState size="page" icon="brain" title={t("mobile.memory.gone")} />
          )}
        </ScrollView>
      </View>
    );
  }
  const forget = () =>
    Alert.alert(t("mobile.memory.forgetTitle"), t("mobile.memory.forgetText", { name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.intentAgents.fix.forget"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "archive", id: m.id, archived: true },
            {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
                goBack();
              },
              onError: failed,
            },
          ),
      },
    ]);
  // Tornar do time (ADR 0167): who reviews memory makes it every agent's, its copies archived.
  const teams = can(org, "review_memory") && canMakeTeamMemory(m);
  const makeTeam = () =>
    action.mutate(
      { type: "team", id: m.id },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("teamMemory.made"), agentId });
          goBack();
        },
        onError: failed,
      },
    );
  const fix = () =>
    sheet.open(
      <MemoryFix
        memory={m}
        agentId={agentId}
        agentName={name}
        g={genderOf(name)}
        source={originText(m)}
        onSee={undefined}
        onDone={sheet.close}
      />,
    );
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <StarStrip map={around} selected={m.id} />
        <View style={styles.body}>
          <View style={styles.who}>
            <Face who={{ type: "agent", id: agentId }} size={20} />
            <Text variant="subhead" tone="faint" style={styles.shrink}>
              {t("mobile.memory.of", { name })}
            </Text>
          </View>
          <Text variant="title2" accessibilityRole="header">
            {m.summary ?? memoryLine(t, m)}
          </Text>
          {m.summary ? (
            <Pressable
              onPress={() => setDetails((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: details }}
              hitSlop={12}
              style={({ pressed }) => [styles.details, pressed && styles.pressed]}
            >
              <Text variant="subhead" tone="ink2" style={styles.bold}>
                {t("mobile.memory.details")}
              </Text>
              {details ? (
                <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
                  <Text variant="subhead" tone="muted" selectable>
                    {memoryLine(t, m)}
                  </Text>
                </Animated.View>
              ) : null}
            </Pressable>
          ) : null}
          <View style={styles.chips}>
            {/* Only the state that says something: nobody is asked to confirm what an agent saved (ADR 0219). */}
            {m.verified ? <Chip icon="check" label={t("mobile.memory.confirmed")} /> : null}
            <Chip icon="clock" label={t("mobile.memory.uses", { count: m.uses })} />
          </View>
          <Text variant="subhead" tone="muted">
            {originText(m)}
          </Text>
          {m.supersedes ? (
            <View style={[styles.before, { backgroundColor: c.sunken }]}>
              <Text variant="subhead" tone="muted">
                {t("mobile.memory.before", { text: m.supersedes })}
              </Text>
            </View>
          ) : null}
        </View>
        {editable || teams ? (
          <View style={styles.actions}>
            {teams ? (
              <Button
                variant="secondary"
                wide
                icon="members"
                label={t("teamMemory.make")}
                disabled={action.isPending}
                onPress={makeTeam}
              />
            ) : null}
            {editable ? (
              <>
                <Button variant="secondary" wide icon="pen" label={t("mobile.memory.fix")} onPress={fix} />
                <Button
                  variant="ghost"
                  wide
                  label={t("mobile.intentAgents.fix.forget")}
                  disabled={action.isPending}
                  onPress={forget}
                />
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  fill: { flex: 1 },
  lead: { paddingHorizontal: SCREEN_X, marginTop: -4 },
  // 10 between the field and the agents' chips under it, as Drive and Routines: with 4 they touched the field.
  search: { paddingHorizontal: SCREEN_X, paddingTop: 12, paddingBottom: 10 },
  body: { paddingHorizontal: SCREEN_X, paddingTop: 14, gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  before: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  actions: { paddingHorizontal: SCREEN_X, paddingTop: 20, gap: 8 },
  details: { gap: 6 },
  pressed: { opacity: 0.6 },
  bold: { fontWeight: "600" },
});
