import { type LiveConsult, type RunConsultation, typingIn } from "@agenteschat/client";
import { consultDetails, lineStep } from "@agenteschat/client/lib/activity";
import { handoffAsk } from "@agenteschat/client/lib/agent-work";
import { type ComponentProps, createContext, memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePresenceOf } from "../../status/hooks";
import { AskBar } from "../asks";
import { WorkingLine } from "../LiveRows";
import { type LiveTyping, useLiveTyping } from "../live";
import { ReturnLine, useReturnsHere } from "../Returns";

/**
 * The questions and hand-offs out from here, for the line above the composer and the header's pill, with what the
 * workspace's presence says of the other agent: its step, what it waits on, or what waits on me (its work for me, when
 * that work is the hand-off's run, says so before the list does). Read where they are drawn: the presence list changes
 * with any agent in the workspace, and the whole conversation was drawn again with each change.
 */
export function useLineConsults(consults: LiveConsult[], consultData: RunConsultation[] | undefined) {
  const { t } = useTranslation();
  const presence = usePresenceOf();
  return useMemo(
    () =>
      consults.map((x) => ({
        ...x,
        ...consultDetails(
          x,
          consultData ?? [],
          (id, run) => handoffAsk(presence.agent(id)?.work, run),
          (id) => lineStep(t, presence.agent(id)?.status?.status),
        ),
      })),
    [consults, consultData, presence, t],
  );
}

/** The requests' line above the composer (`AskBar`), with the work going on here as the working line tells it. */
export const LineAskBar = memo(function LineAskBar({
  consults,
  consultData,
  ...bar
}: Omit<ComponentProps<typeof AskBar>, "consults"> & {
  consults: LiveConsult[];
  consultData: RunConsultation[] | undefined;
}) {
  return <AskBar {...bar} consults={useLineConsults(consults, consultData)} />;
});

/**
 * Who works and who types here (`WorkingLine`): the conversation's last line, or above the composer while there is no
 * conversation yet. On its own: someone typing and the workspace's presence redraw this line, never the conversation.
 */
export const LiveWorkingLine = memo(function LiveWorkingLine({
  consults,
  consultData,
  typing,
  meId,
  threadId,
  ...line
}: Omit<ComponentProps<typeof WorkingLine>, "consults" | "typing"> & {
  consults: LiveConsult[];
  consultData: RunConsultation[] | undefined;
  typing: LiveTyping;
  meId: string | null;
  threadId: string | null;
}) {
  const lineConsults = useLineConsults(consults, consultData);
  // Who is typing here, in this conversation or this thread (never me), as on the web; who stopped leaves on time.
  const typingNow = useLiveTyping(typing);
  const typers = useMemo(
    () => typingIn(typingNow, typing.channelId, Date.now(), meId ?? undefined, threadId),
    [typingNow, typing.channelId, meId, threadId],
  );
  return <WorkingLine {...line} consults={lineConsults} typing={typers} />;
});

export type WorkLine = ComponentProps<typeof LiveWorkingLine>;

/** The working line the conversation ends with, as the screen has it now: null while it has none to show. */
export const WorkLineContext = createContext<WorkLine | null>(null);

/** The list's footer: it redraws with the work going on (through `WorkLineContext`), the list never does. */
function WorkFooter() {
  const line = useContext(WorkLineContext);
  return line ? <LiveWorkingLine {...line} /> : null;
}

/** One element for the screen's whole life: a new footer each time would redraw the list with every step of work. */
export const WORK_FOOTER = <WorkFooter />;

/** The returns agents set here, at rest in the working line's place (`ReturnLine`), read where they are drawn. */
export function HereReturns({
  channelId,
  threadId,
  onOpen,
  style,
}: {
  channelId: string;
  threadId: string | null;
  onOpen: () => void;
  style?: ComponentProps<typeof ReturnLine>["style"];
}) {
  const returns = useReturnsHere(channelId, threadId);
  return returns.length > 0 ? <ReturnLine returns={returns} onOpen={onOpen} style={style} /> : null;
}
