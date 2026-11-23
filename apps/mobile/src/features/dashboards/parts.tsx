import {
  type Dashboard,
  type DashboardSummary,
  editorsSummary,
  editorsText,
  useDecideDashboardProposal,
  type WidgetFormat,
  type WidgetSchedule,
  withEditRoles,
} from "@agenteschat/client";
import { WIDGET_SCHEDULES, WIDGET_SIZES, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { Canvas } from "@shopify/react-native-skia";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import {
  Button,
  Disclosure,
  EmptyState,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  MEDIA_ROW,
  MediaRow,
  RoleMark,
  RowPressable,
  Segmented,
  SkeletonList,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { Gap } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader, successHaptic, useSurface } from "../shared/parts";
import { DitherShape } from "./Dither";
import { closeEditRoles, openEditRoles } from "./edit-roles";
import { useAgentLook, useCustomRoles } from "./hooks";
import {
  type AudienceDraft,
  editorsChoices,
  roleNamesOf,
  roundRectPath,
  thumbRects,
  widgetTones,
  withAudience,
  withEditors,
  withRoles,
} from "./logic";
import { usePickMenu } from "./menu";
import { closeOptionPick, openOptionPick } from "./option-pick";

/** Pieces the dashboards' screens share (ADR 0135). */

/**
 * A pushed screen whose subject isn't here (a board, a widget, a routine): its bar over the grouped gray, then the
 * rows' shape while it loads, why it couldn't load with Retry, or that it is gone (deleted, or not the viewer's to
 * see). Never a bare spinner, never a dead end.
 */
export function MissingScreen({
  title,
  state,
  onRetry,
  gone,
}: {
  title: string;
  state: "loading" | "failed" | "gone";
  onRetry: () => void;
  /** What "gone" means here ("Este painel não existe, ou você não o vê."). */
  gone: string;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.missing}>
        {state === "loading" ? (
          <SkeletonList rows={3} />
        ) : state === "failed" ? (
          <LoadFailed onRetry={onRetry} />
        ) : (
          <EmptyState size="panel" icon="search" title={t("mobile.notFound.title")} subtitle={gone} />
        )}
      </ScrollView>
    </View>
  );
}

const THUMB_W = 56;
const THUMB_H = 44;

/** A board's thumbnail: its first widgets as small dithered tiles in their agents' tones. */
export function BoardThumb({ thumbs }: { thumbs: DashboardSummary["thumbs"] }) {
  const { colors: c, scheme } = useTheme();
  const dir = useDirectory();
  const rects = thumbRects(thumbs, THUMB_W, THUMB_H);
  return (
    <View style={[styles.thumb, { backgroundColor: c.sunken }]}>
      {rects.length > 0 ? (
        <Canvas style={StyleSheet.absoluteFill}>
          {rects.map((r, i) => {
            const tones = widgetTones(agentLook(dir.anyAgent(r.agentId)).color, scheme === "dark");
            return (
              <DitherShape
                // biome-ignore lint/suspicious/noArrayIndexKey: the tiles of one thumbnail, in order
                key={i}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                shape={roundRectPath(0.5, 0.5, r.w - 1, r.h - 1, 3)}
                fill={tones.fill}
                stroke={tones.stroke}
                strokeWidth={1}
                cell={1}
              />
            );
          })}
        </Canvas>
      ) : null}
    </View>
  );
}

/**
 * "Created by Theo · 4 widgets", "Created by you · 1 widget"; with `count` false only who made it (a board's bar,
 * where its meta line already counts the widgets).
 */
export function useBoardByline() {
  const { t } = useTranslation();
  return (board: Pick<DashboardSummary, "owner" | "mine" | "widgetCount">, count = true) => {
    const by = board.owner
      ? board.owner.kind === "person" && board.mine
        ? t("dashboards.meta.byYou")
        : t("dashboards.meta.by", { name: board.owner.name })
      : null;
    const widgets = count ? t("dashboards.meta.widgets", { count: board.widgetCount }) : null;
    return [by, widgets].filter(Boolean).join(" · ");
  };
}

/**
 * A board in the Dashboards list: its thumbnail, its name (a lock when not the whole workspace's), who made it, and the
 * chevron, on a grouped row's measures (`GROUPED_ROW`). Its own row because the thumbnail is wider than a row's
 * leading column; it lights a beat after the finger lands, as the grouped rows do.
 */
export function BoardRow({
  board,
  title,
  sub,
  onPress,
  locked,
}: {
  board: Pick<DashboardSummary, "thumbs">;
  title: string;
  sub: string;
  onPress: () => void;
  locked: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <RowPressable
      hold
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, sub].join(", ")}
      style={styles.boardRow}
    >
      <BoardThumb thumbs={board.thumbs} />
      <View style={styles.grow}>
        <View style={styles.titleLine}>
          <Text variant="body" numberOfLines={1} style={[styles.semibold, styles.shrink]}>
            {title}
          </Text>
          {locked ? <Icon name="lock" size={17} color={c.faint} /> : null}
        </View>
        <Text variant="footnote" tone="faint" numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Disclosure />
    </RowPressable>
  );
}

/** Who sees a board, as its meta line says it: the whole workspace, its roles (each with its mark), or only you. */
export function AudienceLine({ board, after }: { board: Pick<Dashboard, "audience" | "roleIds">; after?: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const roles = useCustomRoles();
  const picked = roles.filter((r) => board.roleIds.includes(r.id));
  return (
    <View style={styles.audience}>
      <Icon name={board.audience === "workspace" ? "globe" : "lock"} size={13} color={c.muted} />
      {board.audience === "roles" ? (
        picked.map((r) => (
          <View key={r.id} style={styles.role}>
            <RoleMark color={r.color} icon={r.icon} size={14} />
            <Text variant="footnote" tone="muted" style={styles.semibold}>
              {r.name}
            </Text>
          </View>
        ))
      ) : (
        <Text variant="footnote" tone="muted" style={styles.semibold}>
          {board.audience === "workspace" ? t("dashboards.audience.workspace") : t("dashboards.audience.private")}
        </Text>
      )}
      {after ? (
        <Text variant="footnote" tone="faint">
          {`· ${after}`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * An agent asks to show this board to more people (ADR 0135 §11): only the person it asked decides, here or in
 * Activity. Publish shows it to the workspace (or the roles it named); Keep only for me leaves it private.
 */
export function ProposalBanner({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const surface = useSurface("e2");
  const roles = useCustomRoles();
  const decide = useDecideDashboardProposal(orgId);
  const p = board.proposal;
  const look = useAgentLook(p?.agentId);
  if (!p?.canDecide) return null;
  const names = roleNamesOf(p.roleIds, roles).join(", ");
  const toRoles = p.audience === "roles" && names.length > 0;
  const publish = toRoles
    ? t("dashboards.proposal.publishRoles", { roles: names })
    : t("dashboards.proposal.publishWorkspace");
  const send = (decision: "publish" | "keep") =>
    decide.mutate(
      { dashboardId: board.id, decision },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title:
              decision === "publish"
                ? t("dashboards.proposal.published", { title: board.title })
                : t("dashboards.proposal.kept", { title: board.title }),
          });
        },
        onError: failed,
      },
    );
  return (
    <View style={[styles.proposal, surface]}>
      {/* The agent's face and what it asks on one line; who would see it and why under them, whole. */}
      <MediaRow
        size="row"
        face={<AgentFace agentId={p.agentId} size={MEDIA_ROW.row.face} live={false} />}
        name={t("dashboards.proposal.title", { name: look.name })}
      >
        <Text variant="footnote" tone="muted">
          {toRoles ? t("dashboards.proposal.roles", { roles: names }) : t("dashboards.proposal.workspace")}
        </Text>
        {p.why ? (
          <Text variant="footnote" tone="faint">
            {p.why}
          </Text>
        ) : null}
      </MediaRow>
      <View style={styles.proposalActions}>
        <Button
          size="sm"
          variant="secondary"
          label={t("dashboards.proposal.keep")}
          disabled={decide.isPending}
          onPress={() => send("keep")}
        />
        <Button
          size="sm"
          variant="primary"
          label={publish}
          loading={decide.isPending}
          onPress={() => send("publish")}
        />
      </View>
    </View>
  );
}

/** Line glyphs of the formats that have no icon of their own: a number, a goal's track, a line over time. */
const KIND_PATHS: Partial<Record<WidgetFormat, { d: string; w?: number }[]>> = {
  kpi: [{ d: "M6.5 8.5 9 6.5v11" }, { d: "M13 8.5a2.6 2.6 0 0 1 5.2 0c0 2.6-5.2 4.6-5.2 9h5.4" }],
  goal: [{ d: "M6 12h7", w: 3.2 }],
  line: [{ d: "M4 16.5 9 11l4 3.2L20 7" }, { d: "M4 20h16" }],
};
const KIND_ICONS: Partial<Record<WidgetFormat, IconName>> = {
  auto: "sparkle",
  bars: "chart",
  list: "list",
  text: "text",
};

/** A format's small glyph (the format chips): the line icons' style. */
export function KindGlyph({ kind, size = 16, color }: { kind: WidgetFormat; size?: number; color: string }) {
  const icon = KIND_ICONS[kind];
  if (icon) return <Icon name={icon} size={size} color={color} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {kind === "goal" ? (
        <Rect x={3.5} y={8.5} width={17} height={7} rx={2.5} stroke={color} strokeWidth={1.7} />
      ) : null}
      {(KIND_PATHS[kind] ?? []).map((p) => (
        <Path key={p.d} d={p.d} stroke={color} strokeWidth={p.w ?? 1.7} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

/** How often it updates: the five schedules, the shortest words, in a row that scrolls on a small phone. */
export function ScheduleChoice({
  value,
  onChange,
  without,
}: {
  value: WidgetSchedule;
  onChange: (schedule: WidgetSchedule) => void;
  /** A schedule left out ("only pin" stands for `manual` when pinning). */
  without?: WidgetSchedule;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.segments}
    >
      <Segmented
        items={WIDGET_SCHEDULES.filter((s) => s !== without).map((s) => ({
          key: s,
          label: t(`widgets.schedulesShort.${s}`),
        }))}
        value={value}
        onChange={(k) => onChange(k as WidgetSchedule)}
      />
    </ScrollView>
  );
}

/** A widget's size: S (half a row on the phone), M (the row), L (the row, drawn big), with what each means under it. */
export function SizeChoice({ value, onChange }: { value: WidgetSize; onChange: (size: WidgetSize) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Segmented
        items={WIDGET_SIZES.map((s) => ({ key: s, label: t(`widgets.sizes.${s}`) }))}
        value={value}
        onChange={(k) => onChange(k as WidgetSize)}
      />
      <GroupedFooter>{t(`mobile.dashboards.sizeHint.${value}`)}</GroupedFooter>
    </>
  );
}

/**
 * Who sees and who edits a board (Share and New dashboard): the whole workspace, some roles, or only you. With roles,
 * a row under the choice names the ones picked and pushes the app's picker to check them (picking "Cargos" with none
 * yet opens it at once). Then, unless it's only yours, who edits it: a row saying who that opens the app's picker
 * (whoever sees it, only you and admins, or "Some roles…", a pushed screen to check them). Under it, what showing a
 * board exposes.
 */
export function AudienceFields({
  draft,
  onChange,
  members,
}: {
  draft: AudienceDraft;
  onChange: (draft: AudienceDraft) => void;
  /** People in the workspace now (the workspace option's hint). */
  members: number;
}) {
  const { t } = useTranslation();
  const roles = useCustomRoles();
  const pickMenu = usePickMenu();
  // The roles' screens write back here while they are open; leaving the form ends them.
  useEffect(
    () => () => {
      closeEditRoles();
      closeOptionPick();
    },
    [],
  );
  /** The roles that see it, checked on the app's picker, pushed. `base`: the draft as it is when it opens. */
  const openSeers = (base: AudienceDraft) => {
    openOptionPick({
      many: true,
      title: t("dashboards.audience.roles"),
      values: base.roleIds,
      options: roles.map((r) => ({
        key: r.id,
        label: r.name,
        leading: <RoleMark color={r.color} icon={r.icon} size={22} />,
      })),
      apply: (ids) => onChange(withRoles(base, ids)),
    });
    router.push("/option-pick");
  };
  const pick = (audience: AudienceDraft["audience"]) => {
    const next = withAudience(draft, audience);
    onChange(next);
    if (audience === "roles" && next.roleIds.length === 0 && roles.length > 0) openSeers(next);
  };
  const openRoles = () => {
    openEditRoles({
      audience: draft.audience,
      roleIds: draft.roleIds,
      editRoleIds: draft.editPolicy === "roles" ? draft.editRoleIds : [],
      apply: (ids) => onChange(withEditRoles(draft, ids)),
    });
    router.push("/board-edit-roles");
  };
  const openEditors = () =>
    pickMenu(
      t("dashboards.edit.label"),
      editorsChoices(roles.length).map((key) => ({
        key,
        label: key === "roles" ? t("dashboards.edit.someRoles") : t(`dashboards.edit.${key}`),
      })),
      draft.editPolicy,
      (key) => (key === "roles" ? openRoles() : onChange(withEditors(draft, key))),
    );
  const seers = roleNamesOf(draft.roleIds, roles);
  return (
    <>
      <GroupedHeader>{t("dashboards.audience.label")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="globe"
          label={t("dashboards.audience.workspace")}
          sub={t("dashboards.audience.workspaceHint", { count: members })}
          subLines={2}
          checked={draft.audience === "workspace"}
          onPress={() => pick("workspace")}
        />
        <GroupedRow
          icon="members"
          label={t("dashboards.audience.roles")}
          checked={draft.audience === "roles"}
          onPress={() => pick("roles")}
        />
        <GroupedRow
          icon="lock"
          label={t("dashboards.audience.private")}
          checked={draft.audience === "private"}
          onPress={() => pick("private")}
        />
      </GroupedList>
      {draft.audience === "roles" ? (
        roles.length === 0 ? (
          <GroupedFooter>{t("dashboards.audience.noRoles")}</GroupedFooter>
        ) : (
          <>
            <Gap />
            <GroupedList>
              <GroupedRow
                icon="members"
                label={seers.length > 0 ? seers.join(", ") : t("dashboards.edit.someRoles")}
                labelLines={2}
                {...(seers.length === 0
                  ? { sub: t("dashboards.errors.rolesRequired"), subTone: "amber" as const }
                  : {})}
                chevron
                onPress={() => openSeers(draft)}
              />
            </GroupedList>
          </>
        )
      ) : null}
      {draft.audience === "private" ? null : (
        <>
          <GroupedHeader>{t("dashboards.edit.label")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon={draft.editPolicy === "viewers" ? "eye" : draft.editPolicy === "owner" ? "lock" : "members"}
              label={editorsText(t, editorsSummary(draft, roles))}
              menu
              onPress={openEditors}
            />
          </GroupedList>
        </>
      )}
      {/* A footer like the others, from the section's edge: an icon before it set it in from them. */}
      <GroupedFooter
        hint={{ name: t("common.about", { label: t("dashboards.audience.label") }), text: t("widgets.exposure") }}
      >
        {t("widgets.exposureShort")}
      </GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  missing: { paddingHorizontal: 16, paddingTop: 8 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  thumb: { width: THUMB_W, height: THUMB_H, borderRadius: 10, overflow: "hidden" },
  boardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  audience: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  role: { flexDirection: "row", alignItems: "center", gap: 4 },
  proposal: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    padding: 12,
    gap: 10,
  },
  // From the card's edge, as the face and the words above them (the web's row drops them under at its start too).
  proposalActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  segments: { paddingHorizontal: 16 },
});
