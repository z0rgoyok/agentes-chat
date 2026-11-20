import type { Routine, RoutineRun } from "@agenteschat/client";
import { capitalize, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  isRunAtWork,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runPixels,
} from "@agenteschat/client/lib/routine-view";
import { formatDuration } from "@agenteschat/client/lib/work";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, GroupedList, GroupedRow, Sheet } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { chatHref, routineHref } from "../links/logic";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useRunWords, useSay } from "./hooks";
import { RunStrip } from "./RunPixels";

/**
 * A routine's last runs as bars, as the web's row: a tap on one opens its details in a sheet (how it went, when, how
 * long), with the way to the message it left and, from the list (`toRoutine`), to the routine and its runs.
 */
export function RoutineRunBars({
  routine: r,
  running,
  toRoutine = false,
}: {
  routine: Routine;
  running: boolean;
  toRoutine?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const say = useSay();
  const words = useRunWords();
  // The picked run stays while its sheet leaves; only then is the sheet gone (none mounted in each row meanwhile).
  const [picked, setPicked] = useState<RoutineRun | null>(null);
  const [open, setOpen] = useState(false);
  // The finished runs as `runPixels` keeps them: the same order, so a bar's index is its run's.
  const finished = r.recentRuns.filter((x) => runPixelStatus(x.status));
  const atWork = r.recentRuns.find((x) => isRunAtWork(x.status)) ?? null;
  const link = picked ? runMessageLink(picked) : null;
  const took = picked?.finishedAt ? formatDuration(t, Date.parse(picked.finishedAt) - Date.parse(picked.at)) : null;
  const head = picked
    ? [capitalize(whenAt(t, i18n.language, picked.at), i18n.language), took].filter(Boolean).join(" · ")
    : "";
  const go = (href: Parameters<typeof router.push>[0]) => {
    setOpen(false);
    router.push(href);
  };
  const pick = (run: RoutineRun | null) => {
    if (!run) return;
    setPicked(run);
    setOpen(true);
  };
  return (
    <>
      <RunStrip
        runs={runPixels(r.recentRuns)}
        color={agentLook(dir.agentById.get(r.agentId)).color}
        running={running}
        label={words.label(r)}
        onPick={(i) => pick(i < 0 ? atWork : (finished[i] ?? null))}
      />
      {picked ? (
        <Sheet open={open} onClose={() => setOpen(false)} onGone={() => setPicked(null)}>
          <GroupedList>
            <GroupedRow
              label={say(runOutcome(picked, (id) => dir.memberById.get(id)?.name ?? null))}
              labelLines={0}
              sub={head}
            />
            {link ? (
              <GroupedRow
                icon="message"
                label={t("routines.openInChat")}
                chevron
                onPress={() => go(chatHref(link.channelId, link.threadId))}
              />
            ) : null}
            {toRoutine ? (
              <GroupedRow icon="clock" label={t("routines.runs")} chevron onPress={() => go(routineHref(r.id))} />
            ) : null}
          </GroupedList>
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * The routine's agent can't read what its trigger needs (none of the mailboxes, the picked one, a connection), as the
 * web's: the cause, and its profile, where who connected it gives the agent access.
 */
export function AgentAccessNote({
  agentId,
  words,
  values,
}: {
  agentId: string;
  words: string;
  values?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const name = useDirectory().agentById.get(agentId)?.name ?? "";
  return (
    <View style={accessStyles.note}>
      <Note icon="lock">{t(words, { ...agentGrammar(name), ...values })}</Note>
      <Button
        variant="secondary"
        size="sm"
        label={t("mail.routine.giveAccess")}
        onPress={() => router.push(`/agent/${agentId}` as never)}
      />
    </View>
  );
}

const accessStyles = StyleSheet.create({
  note: { gap: 8, paddingHorizontal: 16, paddingTop: 12, alignItems: "flex-start" },
});
