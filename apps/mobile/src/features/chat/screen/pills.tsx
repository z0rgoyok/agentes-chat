import type { DirectMessage, LiveConsult, LiveRun, RosterMember, RunConsultation } from "@agenteschat/client";
import { activityVerb } from "@agenteschat/client/lib/activity";
import { capitalize } from "@agenteschat/client/lib/format";
import { type ComponentProps, memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName } from "@/ui";
import { AgentFace, Face } from "../../shared/Face";
import { useColors, useDirectory } from "../../shared/hooks";
import { useDmStatusLine } from "../../status/hooks";
import { HeaderPill } from "../HeaderPill";
import { workingEntries } from "../logic";
import { useValueOf, type ValueStore } from "./hooks";
import { useLineConsults } from "./work-line";

/** "Revisor, Dev" for a screen reader, or just "Revisor" while there is no role or status (never "Revisor, ."). */
export const who = (name: string, status: string) => (status ? `${name}, ${status}` : name);

/** What every header pill of a conversation is handed: its presses keep their identity (`useLatest`). */
interface PillHands {
  onPress: () => void;
  /** Our counted views' width first in the bar's buttons (`pillRoom`). */
  leadRoom: number;
  /** The conversation switcher ("Switch conversation"). */
  onHold: () => void;
  holdHint: string;
}

/**
 * The pills in the header (`HeaderPill`), each on its own: the header shows them outside the screen, and the
 * conversation redrawing (an agent's step, someone typing) handed the header a new element each time. Each redraws
 * when what it shows changes.
 */
export const ThreadPill = memo(function ThreadPill({
  title,
  subtitle,
  label,
  icon = "reply",
  ...hands
}: PillHands & {
  title: string;
  subtitle: string | undefined;
  label: string;
  extraActions: number;
  /** Its mark: a thread's reply, a code session's code (ADR 0215), whose pill opens its code. */
  icon?: IconName;
}) {
  const c = useColors();
  const lead = useMemo(() => <Icon name={icon} size={18} color={c.muted} />, [c.muted, icon]);
  return <HeaderPill lead={lead} title={title} subtitle={subtitle} label={label} {...hands} />;
});

/**
 * A DM's pill: who it is with and how they are (ADR 0084), an agent's presence and what it does (its step, from its
 * runs here and the questions it asks), a person's line. The face moves only while the screen shows:
 * the header is drawn outside the screen's pause (`FocusLive`), and it moved under every screen pushed over it.
 */
export const DmPill = memo(function DmPill({
  name,
  withType,
  withId,
  agentId,
  says,
  roleLine,
  runs,
  consults,
  consultData,
  color,
  far,
  quietBelow,
  extraActions,
  inView,
  ...hands
}: PillHands & {
  name: string;
  withType: DirectMessage["with"]["type"];
  withId: string;
  /** An agent's DM: the agent. */
  agentId: string | null;
  /** Its own line (not a thread of the DM, whose pill shows while the thread loads). */
  says: boolean;
  /** An agent's role, or the right hand's line: what shows while it says nothing more. */
  roleLine: string | undefined;
  runs: LiveRun[];
  consults: LiveConsult[];
  consultData: RunConsultation[] | undefined;
  color: ComponentProps<typeof HeaderPill>["color"];
  /** More than a screen above the end (`far`) with nothing new below (`quietBelow`): only the face stays. */
  far: ValueStore<boolean>;
  quietBelow: boolean;
  extraActions: number;
  inView: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const lineConsults = useLineConsults(consults, consultData);
  // An agent's DM while it works: the pill's quiet line says what it does (its current step).
  const doing = useMemo(() => {
    if (!agentId || !says) return null;
    const entry = workingEntries(runs, lineConsults, (id) => dir.agentById.get(id)?.name ?? "").find(
      (e) => e.type === "agent" && e.id === agentId,
    );
    if (!entry) return null;
    return capitalize(activityVerb(t, entry.activity), i18n.language);
  }, [agentId, says, runs, lineConsults, dir.agentById, t, i18n.language]);
  const line = useDmStatusLine(says ? { type: withType, id: withId } : null, doing, agentId ? roleLine : undefined);
  const isFar = useValueOf(far);
  const busy = Boolean(doing);
  const lead = useMemo(
    () =>
      agentId ? (
        <AgentFace
          agentId={agentId}
          size={32}
          framed={false}
          mode={busy ? "run" : "idle"}
          presence
          ring={c.glassSolid}
          live={inView}
        />
      ) : (
        <Face who={{ type: withType, id: withId }} size={32} live={false} presence ring={c.glassSolid} />
      ),
    [agentId, busy, c.glassSolid, inView, withType, withId],
  );
  return (
    <HeaderPill
      lead={lead}
      title={name}
      subtitle={line ?? doing ?? roleLine}
      color={color}
      working={busy}
      collapsed={isFar && quietBelow}
      extraActions={extraActions}
      inView={inView}
      label={
        agentId
          ? t("mobile.chat.headerAgent", { who: who(name, line ?? doing ?? roleLine ?? "") })
          : t("mobile.chat.headerChannel", { who: who(name, line ?? "") })
      }
      {...hands}
    />
  );
});

/** A channel's pill: its name, how many are in it and the first faces; a tap opens who is in it. */
export const ChannelPill = memo(function ChannelPill({
  title,
  subtitle,
  label,
  color,
  roster,
  extraActions,
  inView,
  ...hands
}: PillHands & {
  title: string;
  subtitle: string | undefined;
  label: string;
  color: ComponentProps<typeof HeaderPill>["color"];
  roster: RosterMember[] | undefined;
  extraActions: number;
  /** Its screen shows: the sky in it moves only then. */
  inView: boolean;
}) {
  const c = useColors();
  const lead = useMemo(() => <Icon name="hash" size={18} color={c.muted} />, [c.muted]);
  const trailing = useMemo(
    () =>
      roster && roster.length > 0 ? (
        <View style={styles.faces}>
          {roster.slice(0, 3).map((r, i) => (
            // Every face the same size and shape box, ringed in the pill's glass: an agent in its tile
            // (its body alone stood lower than a person's circle), a person in a circle.
            <View
              key={`${r.type}:${r.id}`}
              style={[
                styles.pillFace,
                i > 0 && styles.pillOverlap,
                { borderColor: c.glassSolid },
                r.type !== "agent" && styles.round,
              ]}
            >
              <Face who={r} size={20} live={false} />
            </View>
          ))}
        </View>
      ) : undefined,
    [roster, c.glassSolid],
  );
  return (
    <HeaderPill
      lead={lead}
      title={title}
      subtitle={subtitle}
      color={color}
      trailing={trailing}
      extraActions={extraActions}
      inView={inView}
      label={label}
      {...hands}
    />
  );
});

const styles = StyleSheet.create({
  pillFace: { borderWidth: 2, borderRadius: 8 },
  pillOverlap: { marginLeft: -6 },
  faces: { flexDirection: "row" },
  round: { borderRadius: 12 },
});
