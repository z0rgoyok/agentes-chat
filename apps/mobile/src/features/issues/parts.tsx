import type { Issue, IssueColumn, IssueProjectRef } from "@agenteschat/client";
import { dueLabel, dueTone, joinNames } from "@agenteschat/client/lib/format";
import { githubLinkLabel } from "@agenteschat/client/lib/github-link";
import {
  type CardState,
  cardState,
  cardStateText,
  cardWaits,
  isOpen,
  taskAgentId,
} from "@agenteschat/client/lib/issues";
import { stepPhrase } from "@agenteschat/client/lib/work";
import { bodyTones } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { memo, type ReactNode, useCallback } from "react";
import { Trans, useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  Chip,
  CodeWords,
  Icon,
  IconButton,
  type IconName,
  PixelOrbit,
  PressScale,
  Sky,
  Text,
  type TextProps,
  TOOL_H,
  TOUCH,
  textLineOf,
  useFontScale,
  useReducedMotion,
} from "@/ui";
import { SocialMark } from "@/ui/auth/SocialMarks";
import { mediaRowAxis } from "@/ui/media-row";
import { router } from "@/ui/navigation";
import { useRowDirectory } from "../chat/row-data";
import { Face } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { MentionCount, Tile, useSurface } from "../shared/parts";
import { criteriaProgress, type IssueState, issueState, latestPr } from "./logic";

/** An agent's step in the person's words ("Mexeu nos arquivos do PC · trips.service.ts"), as the web says it. */
export function useStepText() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (step: Parameters<typeof stepPhrase>[1] | null | undefined) => (step ? stepPhrase(t, step, i18n.language) : ""),
    [t, i18n.language],
  );
}

/** A column's name as people read it: its own, or the stage's when it has none ("A fazer"). */
export function useColumnLabel() {
  const { t } = useTranslation();
  return useCallback((c: Pick<IssueColumn, "name" | "stage">) => c.name ?? t(`issues.status.${c.stage}`), [t]);
}

/**
 * A board column inside a stage (only where the board is customized): its name, whole, and count. In A fazer, for who
 * may create tasks, "+" at its end opens Nova tarefa in that column (the web's column head); a long name's first line
 * sits on the button's middle.
 */
export function ColumnHeader({ label, count, onNew }: { label: string; count: number; onNew?: () => void }) {
  const { t } = useTranslation();
  const line = textLineOf("small", useFontScale()).height;
  const onButton = onNew ? { paddingTop: Math.max(0, (TOOL_H - line) / 2) } : null;
  return (
    <View style={[styles.column, onNew && styles.columnActs]} accessibilityRole="header">
      <Text variant="small" tone="muted" style={[styles.columnName, onButton]}>
        {label}
      </Text>
      <Text variant="small" tone="faint" style={onButton}>
        {count}
      </Text>
      {onNew ? (
        <View style={styles.columnEnd}>
          <IconButton small icon="plus" label={t("issues.newIn", { column: label })} onPress={onNew} />
        </View>
      ) : null}
    </View>
  );
}

/** A task's title, whole, with its `code` as the inline code pill and its **bold** (the web card's); no links. */
export function TaskTitle({ title, ...text }: { title: string } & Omit<TextProps, "children">) {
  return (
    <Text {...text}>
      <CodeWords text={title} />
    </Text>
  );
}

const STATE_ICON: Record<Exclude<IssueState, "running">, IconName> = {
  waiting: "wait",
  stalled: "pause",
  review: "code",
  progress: "clock",
  todo: "circle",
  done: "checkc",
  canceled: "x",
};

/** The issue's state as a chip: "Trabalhando" with the agent's orbit, "Em revisão · PR #212", "Esperando você"… */
export function StateChip({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const state = issueState(issue);
  const pr = latestPr(issue);
  const label =
    state === "review" && pr
      ? t("mobile.issues.state.reviewPr", { number: pr.number })
      : t(`mobile.issues.state.${state}`);
  if (state === "running") {
    const agent = dir.agentById.get(taskAgentId(issue) ?? "");
    return <Chip label={label} leading={<PixelOrbit color={agentLook(agent).color} size={10} />} />;
  }
  return <Chip label={label} icon={STATE_ICON[state]} />;
}

/** Faces shown of a task several have, before "+N". */
const FACES_MAX = 3;

/**
 * Who has it: the agent's living body (moving while it works) or the person's face; nobody: an empty tile. Several:
 * their faces overlapping, three at most and then "+N", read out as their names; only the agent whose run it is moves.
 */
export function AssigneeFace({
  issue,
  size,
  live,
  ring,
}: {
  issue: Pick<Issue, "assignees" | "work">;
  size: number;
  live: boolean;
  /** The surface the faces stand on, which rings each of several (default a card's). */
  ring?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useRowDirectory();
  const [first, ...rest] = issue.assignees;
  if (!first) return <Tile icon="circle" size={size} />;
  const state = issue.work?.state;
  const agentId = taskAgentId(issue);
  const working = (who: Issue["assignees"][number]) => who.type === "agent" && who.id === agentId;
  const face = (who: Issue["assignees"][number], side: number) => (
    <Face
      who={who}
      size={who.type === "agent" ? side : side - 4}
      mode={working(who) && state === "running" ? "run" : working(who) && state === "stalled" ? "rest" : "idle"}
      live={live}
    />
  );
  if (rest.length === 0) return face(first, size);
  const more = issue.assignees.length - FACES_MAX;
  return (
    <View
      style={styles.faces}
      accessible
      accessibilityLabel={joinNames(
        issue.assignees.map((a) => dir.nameOf(a)),
        t,
      )}
    >
      {issue.assignees.slice(0, FACES_MAX).map((who, k) => (
        <View
          key={`${who.type}:${who.id}`}
          style={[styles.facesTile, { backgroundColor: ring ?? c.raised }, k > 0 && styles.facesOverlap]}
        >
          {face(who, size - 4)}
        </View>
      ))}
      {more > 0 ? (
        <Text variant="small" tone="muted" style={styles.facesMore}>
          +{more}
        </Text>
      ) : null}
    </View>
  );
}

/** The task's GitHub link as a chip: `repo#12`, with GitHub's mark. */
export function GithubChip({ url }: { url: string }) {
  const c = useColors();
  return <Chip label={githubLinkLabel(url)} leading={<SocialMark provider="github" color={c.muted} size={12} />} />;
}

/** A state's mark: the agent's orbit while it works; what calls on a person, or stopped, in the attention color. */
const CARD_STATE_ICON: Record<Exclude<CardState["kind"], "running">, IconName> = {
  approval: "shield",
  question: "help",
  stalled: "pause",
  blocked: "wait",
};

/** The one state of a task in words, as the web's card says it: "Pergunta algo", "Parado há 2 dias". */
export function useCardState(i: Issue) {
  const { t } = useTranslation();
  const state = cardState(i, Boolean(i.conversation?.working));
  return { state, words: state ? cardStateText(t, state) : null };
}

/** A state's mark and words, beside who has it on a card, after the name in a row. */
export function StateWords({ issue, state, words }: { issue: Issue; state: CardState; words: string }) {
  const c = useColors();
  const dir = useRowDirectory();
  const agent = dir.agentById.get(taskAgentId(issue) ?? "");
  return (
    <View style={[styles.inline, styles.state]}>
      {state.kind === "running" ? (
        <PixelOrbit color={agentLook(agent).color} size={10} />
      ) : (
        <Icon
          name={state.kind === "blocked" && state.blocked.reason === "failed" ? "info" : CARD_STATE_ICON[state.kind]}
          size={14}
          color={c.warn}
        />
      )}
      <Text variant="small" style={[styles.bold, styles.shrink, { color: state.kind === "running" ? c.agent : c.ink }]}>
        {words}
      </Text>
    </View>
  );
}

/**
 * A card's one row of facts, wrapping between facts: the number, the project, the label, the priority, the date in words (in the
 * attention color today, tomorrow and once late), the criteria, GitHub, the conversation's count with my mentions.
 */
function CardFacts({
  issue: i,
  mentions,
  unread,
  project,
}: {
  issue: Issue;
  mentions: number;
  unread: boolean;
  project: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useRowDirectory();
  const [label, ...labels] = i.labels;
  const due = i.dueDate && isOpen(i) ? { text: dueLabel(t, i18n.language, i.dueDate), tone: dueTone(i.dueDate) } : null;
  const crit = criteriaProgress(i);
  const pr = latestPr(i);
  const talk = i.conversation?.count ?? 0;
  const handedBy = i.backgroundWork?.handedBy ? dir.anyAgent(i.backgroundWork.handedBy.agentId)?.name : null;
  // A mark on the first line's middle, for a fact whose words wrap (a repository's name wider than the card).
  const mark = mediaRowAxis(12, textLineOf("caption", useFontScale())).face;
  return (
    <View style={styles.facts}>
      <Text variant="caption" tone="muted">
        #{i.number}
      </Text>
      {project && i.project ? <ProjectName project={i.project} /> : null}
      {label ? <Chip label={label} /> : null}
      {labels.length > 0 ? (
        <Text variant="caption" tone="muted" accessibilityLabel={labels.join(", ")}>
          +{labels.length}
        </Text>
      ) : null}
      {handedBy ? (
        <Text variant="caption" tone="muted">
          <Trans i18nKey="issues.handedBy" values={{ name: handedBy }} components={[<Text key="face" />]} />
        </Text>
      ) : null}
      {i.priority !== "normal" ? (
        <View style={styles.inline}>
          <Icon name="flag" size={12} color={i.priority === "high" ? c.warn : c.faint} />
          <Text variant="caption" tone="muted">
            {t(`issues.priority.${i.priority}`)}
          </Text>
        </View>
      ) : null}
      {due ? (
        <View style={styles.inline}>
          <Icon name="clock" size={12} color={due.tone ? c.warn : c.faint} />
          <Text variant="caption" style={due.tone ? [styles.bold, { color: c.warn }] : { color: c.muted }}>
            {t("mobile.issues.until", { date: due.text })}
          </Text>
        </View>
      ) : null}
      {crit ? (
        <View style={styles.inline}>
          <Icon name="checkc" size={12} color={crit.done === crit.total ? c.ok : c.faint} />
          <Text variant="caption" tone="muted">
            {crit.done}/{crit.total}
          </Text>
        </View>
      ) : null}
      {pr ? (
        <View style={styles.inline}>
          <SocialMark provider="github" color={c.faint} size={12} />
          <Text variant="caption" tone="muted">
            {t("issues.pr", { number: pr.number })}
          </Text>
        </View>
      ) : null}
      {i.githubUrl ? (
        <View style={[styles.inline, styles.wraps]}>
          <View style={{ marginTop: mark }}>
            <SocialMark provider="github" color={c.faint} size={12} />
          </View>
          <Text variant="caption" tone="muted" style={styles.shrink}>
            {githubLinkLabel(i.githubUrl)}
          </Text>
        </View>
      ) : null}
      {talk > 0 || mentions > 0 ? (
        <View style={styles.inline}>
          <Icon name="chat" size={12} color={c.faint} />
          {talk > 0 ? (
            <Text variant="caption" tone={unread ? "ink" : "muted"} style={unread ? styles.heavy : undefined}>
              {talk}
            </Text>
          ) : null}
          <MentionCount count={mentions} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One task on the board, in the web card's three parts: the title in the cards' type (the subhead, semibold, three
 * lines at most: the task's screen says it whole); one row of facts; who has it (the face 24, moving while its agent
 * works) and its one state. An agent waiting on a person puts its sky at the card's top, faded in. A long name wraps
 * beside the face, on the face's line first; a state that doesn't fit goes under, whole. It gives under the finger as
 * the Drive's cards do (`PressScale`); opening the task is its feedback.
 */
export const BoardCard = memo(function BoardCard({
  issue: i,
  live,
  project = true,
  mentions,
  unread,
}: {
  issue: Issue;
  live: boolean;
  /** Its project among the facts. A project's own board leaves it out. */
  project?: boolean;
  /** Mentions of me not read in its conversation (ADR 0145), red as on the web's card; the board reads them for all. */
  mentions: number;
  /** Its conversation's replies I haven't read. */
  unread: number;
}) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const surface = useSurface();
  const reduced = useReducedMotion();
  const axis = mediaRowAxis(24, textLineOf("small", useFontScale()));
  const { state, words } = useCardState(i);
  const agent = dir.agentById.get(taskAgentId(i) ?? "");
  const [who, ...others] = i.assignees;
  return (
    <PressScale
      haptic={false}
      fill={false}
      onPress={() => router.push(`/issues/${i.number}`)}
      accessibilityRole="button"
      accessibilityLabel={[
        t("issues.open", { number: i.number, title: i.title }),
        words,
        mentions > 0 ? t("shell.unreadMentions", { count: mentions }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      style={[styles.card, surface]}
      contentStyle={styles.cardIn}
    >
      {cardWaits(state) ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(200)} style={styles.sky}>
          <Sky
            color={agentLook(agent).color}
            surface="raised"
            depth={0.55}
            fade={0.15}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      <TaskTitle title={i.title} variant="subhead" numberOfLines={CARD_TITLE_LINES} style={styles.title} />
      <CardFacts issue={i} mentions={mentions} unread={unread > 0} project={project} />
      {i.status === "done" && i.backgroundWork?.result ? (
        <Text variant="caption" tone="ink2">
          {i.backgroundWork.result.text}
        </Text>
      ) : null}
      {who || state ? (
        <View style={styles.who}>
          {who && others.length > 0 ? (
            // Several have it: their faces say who, as the web's card does.
            <AssigneeFace issue={i} size={24} live={live} />
          ) : who ? (
            <View style={styles.person}>
              <View style={[styles.face, { marginTop: axis.face }]}>
                <AssigneeFace issue={i} size={24} live={live} />
              </View>
              <Text variant="small" tone="ink2" style={[styles.bold, styles.name, { paddingTop: axis.words }]}>
                {dir.nameOf(who)}
              </Text>
            </View>
          ) : null}
          {state && words ? <StateWords issue={i} state={state} words={words} /> : null}
        </View>
      ) : null}
    </PressScale>
  );
});

/** A card's title at most: a long task reads on its screen. */
const CARD_TITLE_LINES = 3;

/** A project's color as one flat tone, as the web's dot: the middle of the five its dither is drawn in. */
const projectTone = (color: string) => bodyTones(color)[2];

/** A project's dot in its color. No color: a hollow ring ("Sem projeto", "Todos os projetos"). */
export function ProjectDot({ color }: { color?: string | null | undefined }) {
  const c = useColors();
  return (
    <View style={styles.dotBox}>
      <View
        style={[
          styles.dot,
          color ? { backgroundColor: projectTone(color) } : { borderWidth: 1.5, borderColor: c.faint },
        ]}
      />
    </View>
  );
}

/**
 * A task's project on its card (among the facts, `caption`) and its row (in the row's second line, `small`): the dot
 * and the name, which wraps whole inside the line.
 */
export function ProjectName({
  project,
  variant = "caption",
}: {
  project: IssueProjectRef;
  variant?: "caption" | "small";
}) {
  const mark = mediaRowAxis(12, textLineOf(variant, useFontScale())).face;
  return (
    <View style={[styles.inline, styles.wraps]}>
      <View style={{ marginTop: mark }}>
        <ProjectDot color={project.color} />
      </View>
      <Text variant={variant} tone="muted" style={styles.shrink}>
        {project.name}
      </Text>
    </View>
  );
}

/** The strip's value line at the default text size: one line makes the 32 control. */
const PROP_LINE = textLineOf("subhead", 1).height;

/**
 * A field on a strip: 32 high in the field look, its icon or face and its value; a press opens its picker, the field
 * giving under the finger as the app's controls do (`PressScale`). A value wider than the screen wraps inside it, never
 * cut, its icon or face on the first line.
 */
export function PropChip({
  label,
  value,
  icon,
  leading,
  onPress,
}: {
  label: string;
  value: string;
  icon?: IconName;
  leading?: ReactNode;
  onPress: () => void;
}) {
  const c = useColors();
  const line = textLineOf("subhead", useFontScale()).height;
  return (
    <PressScale
      fill={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      hitSlop={{ top: (TOUCH - TOOL_H) / 2, bottom: (TOUCH - TOOL_H) / 2 }}
      style={styles.propBox}
      contentStyle={[styles.prop, { backgroundColor: c.sunken, borderColor: c.line2 }]}
    >
      <View style={{ height: line, justifyContent: "center" }}>
        {leading ?? (icon ? <Icon name={icon} size={16} color={c.muted} /> : null)}
      </View>
      <Text variant="subhead" style={styles.propText}>
        {value}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  // An icon's 12 box with the 8 dot in its middle, so the dot sits where a fact's mark does.
  dotBox: { width: 12, height: 12, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  prop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    minHeight: TOOL_H,
    maxWidth: "100%",
    paddingLeft: 10,
    paddingRight: 12,
    paddingVertical: (TOOL_H - PROP_LINE) / 2,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  propText: { fontWeight: "600", flexShrink: 1 },
  // The field's width at most the line it sits on: a long value wraps inside it.
  propBox: { maxWidth: "100%" },
  card: { borderRadius: 20, overflow: "hidden" },
  cardIn: { paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  inline: { flexDirection: "row", alignItems: "center", gap: 4 },
  // A long state (a stopped run's reason) wraps inside the card instead of running past its edge.
  state: { flexShrink: 1, maxWidth: "100%" },
  // A fact wider than the card (a long repository's link) wraps its words inside it, its mark on the first line.
  wraps: { maxWidth: "100%", alignItems: "flex-start" },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  heavy: { fontWeight: "700" },
  title: { fontWeight: "600" },
  // The approval card's sky at the top, fading into the card (the web's 64px).
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 64 },
  // A narrow card wraps between the facts, never inside one.
  facts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 2 },
  // The face with the name, then the state; a state that doesn't fit goes to the next line whole.
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 },
  faces: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  // Each face ringed in the card's surface, the next one over its edge.
  facesTile: { padding: 1.5, borderRadius: 8 },
  facesOverlap: { marginLeft: -6 },
  facesMore: { marginLeft: 6 },
  // Never the face alone on a line: the name wraps beside it.
  person: { flexDirection: "row", alignItems: "flex-start", gap: 8, flexShrink: 1 },
  // A person's photo is 20 (an agent's body 24): either sits in the 24 box, on the name's first line.
  face: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  name: { flexShrink: 1 },
  column: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    paddingBottom: 2,
    paddingHorizontal: 4,
  },
  columnName: { fontWeight: "600", flexShrink: 1 },
  // With "+": the row as tall as the button, the words on its first line's middle.
  columnActs: { alignItems: "flex-start", paddingTop: 2 },
  columnEnd: { marginLeft: "auto" },
});
