import { elapsedClock } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  activityVerb,
  barAsking,
  barFaces,
  barWords,
  facesOf,
  listNames,
  markedPieces,
  markInk,
  peopleGroups,
} from "@agenteschat/client/lib/activity";
import { Avatar, Icon } from "@agenteschat/ui";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentWho } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * The working line's pieces: the
 * stacked live mini bodies of who is on it, the sentence with names in ink
 * ("Theo e mais 2 estão trabalhando · Marina está digitando…", "Dev está
 * perguntando ao Infra…", "Rui está gravando áudio…") and the clock of a
 * question that is out.
 */

/** A marked sentence as plain text (what the leaving phrase reads). */
const plainText = (text: string) =>
  markedPieces(text)
    .map((p) => p.text)
    .join("");

/** Splits a marked sentence into text, bold names and faced names. */
export function boldNames(text: string): ReactNode[] {
  return markedPieces(text).map((p, i) =>
    p.agentId ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <AgentWho key={i} agentId={p.agentId} name={p.text} />
    ) : p.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: same
      <b key={i}>{p.text}</b>
    ) : (
      p.text
    ),
  );
}

/** The sentence with names in bold (its text content equals `activityText`). */
export function WorkingWords({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  return <>{boldNames(activitySentence(t, entries, markInk))}</>;
}

/**
 * The card's phrase: one agent on its own is just its name (its row in the conversation says what it does), several
 * the sentence. Who is typing comes after it, in a piece of its own that keeps its width (`barWords`), and who records
 * a voice message last, after their mark and faces. While both are at it, each verb is a group with its own mark and
 * faces, and the second takes a line of its own when one is short of room.
 */
export function BarPhrase({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  const [agents, sep, typers, typing, voiceSep, recorders, recording] = barWords(t, entries, markInk);
  const people = (names: string, doing: string, after = "") => (
    <span className="ac-typing__people">
      <span className="ac-typing__typers">{boldNames(names)}</span>
      {doing}
      {after}
    </span>
  );
  return (
    <>
      {agents && (
        <span className="ac-typing__agents">
          <TurnText text={agents} />
          {sep && <span className="ac-typing__and">{sep}</span>}
        </span>
      )}
      {typing &&
        (recording ? (
          <span className="ac-typing__group">
            <TypingMark />
            <WorkingStack entries={entries} faces={facesOf(entries, "typing")} />
            {people(typers, typing, voiceSep)}
          </span>
        ) : (
          people(typers, typing)
        ))}
      {recording && (
        <span className="ac-typing__group">
          <RecordingMark />
          <WorkingStack entries={entries} faces={facesOf(entries, "recordingVoice")} />
          {people(recorders, recording)}
        </span>
      )}
    </>
  );
}

/** Three dots rising in turn while someone types (still with reduced motion). */
export function TypingMark() {
  return (
    <span className="ac-typing__dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** Three bars rising and falling, in the voice wave's look, where the dots are for typing (still with reduced motion). */
export function RecordingMark() {
  return (
    <span className="ac-typing__bars" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * One agent whose row is out of view: its name and its row's step ("Nina consultando o Email · …"). The step keeps
 * one width (cut with "…"), so its time and the controls after it never move under the pointer as it turns; the
 * whole step stays for screen readers and as the tip.
 */
export function BarStep({ name, step }: { name: string; step: string }) {
  return (
    <span className="ac-typing__agents">
      <b>{name}</b>{" "}
      <span className="ac-typing__step" title={step}>
        <TurnText text={step} />
      </span>
    </span>
  );
}

/**
 * Who is typing or recording beside that agent, after its time: "· Marina digitando · Rui gravando áudio…". The names
 * give way first, never what they do; the time and the stop stay the agent's.
 */
export function BarAlsoTyping({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  const groups = peopleGroups(entries);
  return groups.map((g, i) => (
    <span key={g.kind} className="ac-typing__also">
      <span className="ac-typing__typers">{boldNames(listNames(t, g.names, markInk))}</span>
      {` ${activityVerb(t, { kind: g.kind })}${i === groups.length - 1 ? "…" : ""}`}
    </span>
  ));
}

/**
 * A new phrase comes up from below while the old one leaves upward (just a swap with reduced motion).
 * The one leaving is drawn from an attribute, so the text on the page is only the phrase now.
 */
export function TurnText({ text }: { text: string }) {
  const [shown, setShown] = useState({ now: text, was: null as string | null, n: 0 });
  if (shown.now !== text) setShown({ now: text, was: shown.now, n: shown.n + 1 });
  return (
    <span className="ac-turn">
      {shown.was !== null && (
        <span
          key={`was-${shown.n}`}
          className="ac-turn__out"
          aria-hidden="true"
          data-text={plainText(shown.was)}
          onAnimationEnd={() => setShown((s) => (s.n === shown.n ? { ...s, was: null } : s))}
        />
      )}
      <span key={`now-${shown.n}`} className="ac-turn__in" data-first={shown.n === 0 || undefined}>
        {boldNames(shown.now)}
      </span>
    </span>
  );
}

/**
 * The stacked mini bodies, a few at most (`barFaces`, or the `faces` given): each on a plate so overlaps stay
 * readable. An agent on its own asking another, or handing it work, shows both, with an arrow (the one asked is
 * thinking). When the one asked waits on the person reading, the pulsing wait mark takes the arrow's place and it
 * looks up; when it waits on someone else, a quiet clock does and it rests. Nothing when there is no face to stack.
 */
export function WorkingStack({
  entries,
  faces = barFaces(entries),
}: {
  entries: ActivityEntry[];
  faces?: ActivityEntry[];
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const asking = barAsking(entries);
  if (faces.length === 0) return null;
  const tok = (key: string, node: ReactNode) => (
    <span key={key} className="ac-typing__tok">
      {node}
    </span>
  );
  return (
    <span className="ac-typing__avatars" aria-hidden="true">
      {faces.map((e) => {
        if (e.type === "person")
          return tok(`p:${e.id}`, <Avatar size="xs" name={e.name} imageUrl={dir.memberById.get(e.id)?.image} />);
        if (asking && e.consult === asking)
          return (
            <Fragment key={`c:${e.id}`}>
              {tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="idle" />)}
              <span className="ac-typing__to">
                {asking.yours ? (
                  <WaitMark />
                ) : asking.wait ? (
                  <Icon name="clock" size={14} />
                ) : (
                  <Icon name="arrowRight" size={14} />
                )}
              </span>
              {tok(
                `t:${asking.to}`,
                <AgentAvatar
                  agentId={asking.to}
                  size="xs"
                  name={asking.toName}
                  state={asking.yours ? "waiting" : asking.wait ? "idle" : "thinking"}
                />,
              )}
            </Fragment>
          );
        return tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="writing" />);
      })}
    </span>
  );
}

/**
 * "0:41" next to the question the line tells while its colleague is at it (tabular figures); null when it tells none
 * (`barAsking`), or tells work handed off or a wait (they carry their own time, `barConsultTime`).
 */
export function ConsultClock({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  const { t } = useTranslation();
  const asking = barAsking(entries);
  if (!asking || asking.kind === "note" || asking.wait || asking.yours) return null;
  const time = elapsedClock(now - asking.since);
  return (
    <span className="ac-typing__clock ac-num" role="timer" aria-label={t("chat.consult.clock", { time })}>
      {time}
    </span>
  );
}
