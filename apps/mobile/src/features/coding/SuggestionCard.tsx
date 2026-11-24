import {
  type CodeSuggestion,
  type Message,
  useApi,
  useKeepCodeSuggestionHere,
  useOpenCodeSuggestion,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { Button, Icon, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { type AskAnswer, AskButtons, AskCard, AskFoot, type AskWell } from "../chat/asks";
import { useRowDirectory, useRowMeId } from "../chat/row-data";
import { useColors, useOrgId } from "../shared/hooks";
import { sessionChatHref } from "./logic";

/**
 * A code session an agent suggested under its reply (ADR 0215 §11), the web's card on the phone: the request card of
 * the chat, kind `code`. The project and whose computer it runs on, "Ver o pedido" opening the person's words it starts
 * with, and the decision: "Abrir sessão" (the session's conversation opens) or "Fazer aqui". Only the person who asked
 * decides; anyone else reads who it waits for. Decided, it says how it ended, with the way to the session it opened.
 */
export function CodeSuggestionCard({ message, suggestion }: { message: Message; suggestion: CodeSuggestion }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const c = useColors();
  const toast = useToast();
  const open = useOpenCodeSuggestion(orgId);
  const here = useKeepCodeSuggestionHere(orgId);
  const name = dir.anyAgent(suggestion.agentId)?.name ?? t("channel.unknownAgent");
  const failed = (err: unknown) => toast({ title: errorText(t, err, i18n.language), icon: "x" });
  // Its conversation (the session as the phone shows it): read for its thread, then pushed.
  const goTo = (sessionId: string) =>
    void api.code
      .get(orgId, sessionId)
      .then((s) => router.push(sessionChatHref(s)))
      .catch(failed);
  const well: AskWell = {
    tile: <Icon name="code" size={20} color={c.ink2} />,
    title: suggestion.title,
    detail: t("codeSessions.suggestion.detail", { repo: suggestion.repo, ...agentGrammar(name) }),
    more: {
      label: t("codeSessions.suggestion.more"),
      content: (
        <Text variant="body" tone="ink2" selectable>
          {suggestion.request}
        </Text>
      ),
    },
  };
  const byMe = suggestion.by === meId;
  const someone = dir.memberById.get(suggestion.by ?? "")?.name ?? t("channel.unknownPerson");

  if (suggestion.status === "opened" || suggestion.status === "here") {
    const opened = suggestion.status === "opened";
    const answer: AskAnswer = {
      done: true,
      words: opened
        ? byMe
          ? t("codeSessions.suggestion.opened")
          : t("codeSessions.suggestion.openedBy", { name: someone })
        : byMe
          ? t("codeSessions.suggestion.keptHere")
          : t("codeSessions.suggestion.keptHereBy", { name: someone }),
      time: suggestion.at ? whenAt(t, i18n.language, suggestion.at) : undefined,
      actions:
        opened && suggestion.sessionId ? (
          <Button
            variant="ghost"
            size="card"
            label={t("codeSessions.suggestion.see")}
            onPress={() => goTo(suggestion.sessionId as string)}
          />
        ) : undefined,
    };
    return (
      <AskCard
        id={suggestion.id}
        kind="code"
        agentId={suggestion.agentId}
        waitsFor={null}
        lead=""
        well={well}
        answer={answer}
      />
    );
  }

  // Being opened by me (here, or on another device of mine): its buttons wait for it.
  const opening = suggestion.status === "opening" && byMe;
  const mine = meId !== null && suggestion.askerId === meId && (suggestion.status === "pending" || opening);
  if (!mine || meId === null) {
    const asker = dir.memberById.get(suggestion.askerId)?.name ?? t("channel.unknownPerson");
    return (
      <AskCard
        id={suggestion.id}
        kind="code"
        agentId={suggestion.agentId}
        waitsFor={t("ask.waitingFor", { name: asker })}
        lead=""
        well={well}
      />
    );
  }
  const decision = { channelId: message.channelId, messageId: message.id, suggestion, userId: meId };
  const busy = open.isPending || here.isPending || opening;
  return (
    <AskCard
      id={suggestion.id}
      kind="code"
      agentId={suggestion.agentId}
      waitsFor="you"
      lead=""
      well={well}
      foot={
        <AskFoot>
          <AskButtons
            primary={
              <Button
                variant="primary"
                size="card"
                wide
                label={t("codeSessions.suggestion.open")}
                loading={open.isPending || opening}
                disabled={busy}
                onPress={() =>
                  open.mutate(decision, {
                    onSuccess: (session) => router.push(sessionChatHref(session)),
                    onError: failed,
                  })
                }
              />
            }
            secondary={
              <Button
                variant="secondary"
                size="card"
                wide
                label={t("codeSessions.suggestion.here")}
                loading={here.isPending}
                disabled={busy}
                onPress={() => here.mutate(decision, { onError: failed })}
              />
            }
          />
        </AskFoot>
      }
    />
  );
}
