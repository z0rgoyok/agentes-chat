import { type Message, useApi } from "@agenteschat/client";
import { type ConsultNoticeFold, pairItemOf } from "@agenteschat/client/lib/consult-group";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import { errorText } from "@agenteschat/client/lib/errors";
import { consultationOfNotice, noticeOf, stoppedNoticeOf } from "@agenteschat/client/lib/notices";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { EventPill, EventPillAction, EventPillText, ProviderLogo, useToast } from "@/ui";
import { useOrgId, useWhen } from "../shared/hooks";
import { ConsultQuote } from "./ConsultGroup";
import { keepOpen, keptOpen } from "./kept-sizes";
import { eventLineOf } from "./logic";
import { plateInset, useQuietInset, useRowLook } from "./look";
import { MessageText } from "./MessageText";
import { useRowDirectory } from "./row-data";
import { StoppedLine } from "./StoppedLine";

/**
 * An automatic line of the conversation, not a voice (the web's `NoticeLine`): what reached an agent's
 * conversation ("Rotina «Sentry» entregou um relatório" while the agent hasn't told it yet, "Infra
 * respondeu", "Nota de Dev", "Chegou o resultado que Ada esperava"), as one pill (`EventPill`) with its time; the
 * text opens under it on "Show". The agent's own reply, if it has one, follows as a normal message.
 * An answer the reply that asked shows (`ConsultGroup`, `fold`): nothing when that reply is close, the two agents'
 * pair row when it is farther up (a tap opens their conversation).
 * A task a person stopped has its own pill (`StoppedLine`), drawn in the stopped reply's when that reply is here.
 * Drawn again only when what it shows changes (the conversation redraws its rows when a receipt or a thread changes),
 * and opened, it comes back open when its row comes back into view (`keptOpen`).
 */
export const EventLine = memo(function EventLine({
  message,
  fold,
  gap,
}: {
  message: Message;
  fold?: ConsultNoticeFold;
  gap: number;
}) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const when = useWhen();
  const keep = `event:${message.id}`;
  const [open, setOpen] = useState(() => keptOpen(keep));
  const inset = useQuietInset();
  const look = useRowLook();
  // A person stopped one of the agent's tasks (ADR 0128): its own line, with the reason, or a way to give one.
  const stopped = stoppedNoticeOf(message.meta);
  if (stopped) return <StoppedLine message={message} notice={stopped} gap={gap} />;
  if (fold?.fold === "hide") return null;
  // Farther up than the reply that asked: the same quote of their talk where the answer arrived, on its own (no reply
  // here to sit in), opening their conversation.
  if (fold?.fold === "line")
    return (
      <View style={[plateInset(look, inset), { marginTop: gap }]}>
        <ConsultQuote
          askerId={fold.consultation.agentId}
          channelId={message.channelId}
          items={[fold.consultation]}
          alone
        />
      </View>
    );
  // An answer from another agent that carries the consultation, its reply not here: the same quote a reply has, on
  // its own (who asked whom), never the text written for the agent; a tap opens what they said.
  const consulted = consultationOfNotice(message.meta);
  const line = eventLineOf(message, {
    author: dir.nameOf(message.author) || t("channel.unknownAgent"),
    agentByHandle: (handle) => agentsByAnyHandle([...dir.agentById.values()]).get(handle.toLowerCase())?.name ?? null,
  });
  if (consulted)
    return (
      <View style={[plateInset(look, inset), { marginTop: gap }]}>
        <ConsultQuote
          askerId={consulted.askerId}
          channelId={message.channelId}
          items={[pairItemOf(consulted.consultation)]}
          alone
        />
      </View>
    );
  if (!line) return null;
  const kind = noticeOf(message.meta)?.kind;
  return (
    <View style={[styles.line, { paddingLeft: inset, marginTop: gap }]}>
      <EventPill
        mark={kind === "github_event" || kind === "github_check" ? <ProviderLogo id="github" size="xs" /> : line.icon}
        time={when.time(message.createdAt)}
        actions={[
          line.answer ? <AnswerGitHub key="answer" messageId={message.id} /> : null,
          line.detail ? (
            <EventPillAction
              key="show"
              label={open ? t("chat.notice.hide") : t("chat.notice.show")}
              expanded={open}
              onPress={() => {
                keepOpen(keep, !open);
                setOpen(!open);
              }}
            />
          ) : null,
        ]}
        below={
          open && line.detail ? (
            <EventPillText>
              <MessageText
                body={
                  "content" in line.detail ? line.detail.content : t(line.detail.words.key, line.detail.words.values)
                }
              />
            </EventPillText>
          ) : null
        }
      >
        {t(line.key, line.values)}
      </EventPill>
    </View>
  );
});

/**
 * "Pedir resposta" on what someone the agent doesn't answer wrote on GitHub: the agent answers them there, with this
 * person behind it. The pill changes in place once the server has it; a refusal says why.
 */
function AnswerGitHub({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <EventPillAction
      label={t("chat.notice.github.ask")}
      loading={busy}
      onPress={() => {
        setBusy(true);
        void api.chat
          .answerGitHub(orgId, messageId)
          .catch((error: unknown) => toast({ title: errorText(t, error), icon: "x" }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

const styles = StyleSheet.create({
  // Aligned with the messages' words, like `IssueTakenLine`; left aligned, never centered. The list sets its top.
  line: { paddingRight: 16 },
});
