import {
  type CodeSuggestion,
  type Message,
  useKeepCodeSuggestionHere,
  useOpenCodeSuggestion,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { type RequestAnswer, RequestCard, RequestTile } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import "./code-suggestion.css";

/**
 * A code session an agent suggested under its reply (ADR 0215 §11): the request card of the chat, kind `code`. The
 * project and whose computer it runs on, "Ver o pedido" opening the person's words it starts with, and the decision:
 * "Abrir sessão" (the session opens with those words, and the page goes to it) or "Fazer aqui". Only the person who
 * asked decides; anyone else reads who it waits for. Decided, the footer says how it ended, with the way to the
 * session it opened.
 */
export function CodeSuggestionCard({ message, suggestion }: { message: Message; suggestion: CodeSuggestion }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const open = useOpenCodeSuggestion(org.id);
  const here = useKeepCodeSuggestionHere(org.id);
  const [error, setError] = useState<string | null>(null);
  const agent = dir.anyAgent(suggestion.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const goTo = (sessionId: string) =>
    void navigate({ to: "/org/$orgId/code/$sessionId", params: { orgId: org.id, sessionId } });
  const decision = { channelId: message.channelId, messageId: message.id, suggestion, userId: me.user.id };
  const failed = (err: unknown) => setError(errorText(t, err, i18n.language));
  const ended = suggestion.status === "opened" || suggestion.status === "here";
  // Being opened by me (here, or in another window of mine): its buttons wait for it.
  const opening = suggestion.status === "opening" && suggestion.by === me.user.id;
  const mine = (suggestion.status === "pending" || opening) && suggestion.askerId === me.user.id;
  const who = suggestion.by === me.user.id ? null : dir.memberById.get(suggestion.by ?? "")?.name;
  const someone = who ?? t("channel.unknownPerson");
  const answer: RequestAnswer | undefined = ended
    ? {
        done: true,
        text:
          suggestion.status === "opened"
            ? suggestion.by === me.user.id
              ? t("codeSessions.suggestion.opened")
              : t("codeSessions.suggestion.openedBy", { name: someone })
            : suggestion.by === me.user.id
              ? t("codeSessions.suggestion.keptHere")
              : t("codeSessions.suggestion.keptHereBy", { name: someone }),
        ...(suggestion.at ? { time: whenAt(t, i18n.language, suggestion.at) } : {}),
        ...(suggestion.status === "opened" && suggestion.sessionId
          ? {
              action: (
                <Button variant="ghost" size="sm" onClick={() => goTo(suggestion.sessionId as string)}>
                  {t("codeSessions.suggestion.see")}
                </Button>
              ),
            }
          : {}),
      }
    : undefined;
  const busy = open.isPending || here.isPending || opening;
  return (
    <RequestCard
      id={suggestion.id}
      kind="code"
      agent={agent}
      label={t("codeSessions.suggestion.label")}
      mine={mine}
      waitingFor={t("ask.waitingFor", {
        name: dir.memberById.get(suggestion.askerId)?.name ?? t("channel.unknownPerson"),
      })}
      what={suggestion.title}
      object={{
        logo: (
          <RequestTile>
            <Icon name="code" size={16} />
          </RequestTile>
        ),
        title: suggestion.title,
        detail: t("codeSessions.suggestion.detail", { repo: suggestion.repo, ...agentGrammar(name) }),
        more: t("codeSessions.suggestion.more"),
      }}
      details={<p className="code-suggest__request">{suggestion.request}</p>}
      body={
        error ? (
          <p className="rq__error" role="alert">
            {error}
          </p>
        ) : undefined
      }
      answer={answer}
      actions={
        mine && (
          <>
            <Button
              variant="primary"
              size="sm"
              icon="code"
              loading={open.isPending || opening}
              disabled={busy}
              onClick={() => {
                setError(null);
                open.mutate(decision, { onSuccess: (session) => goTo(session.id), onError: failed });
              }}
            >
              {t("codeSessions.suggestion.open")}
            </Button>
            <Button
              size="sm"
              loading={here.isPending}
              disabled={busy}
              onClick={() => {
                setError(null);
                here.mutate(decision, { onError: failed });
              }}
            >
              {t("codeSessions.suggestion.here")}
            </Button>
          </>
        )
      }
    />
  );
}
