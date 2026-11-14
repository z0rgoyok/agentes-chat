import type { BrowserHandoff } from "@agenteschat/client";
import {
  drivesOnDesktop,
  HANDOFF_OVER,
  handoffFuse,
  handoffIsMine,
  handoffScreen,
  handoffTimeLeft,
  isWaitingHandoff,
  keys,
  useApi,
  useBrowserHandoffMutations,
  useDesktopStatus,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { useOpenComputer } from "../computer/open";
import { useOrg } from "../org-context";
import { type RequestAnswer, RequestCard, RequestFuse, RequestTile, useExpired } from "../RequestCard";
import { BrowserCard } from "./BrowserCard";
import { useBrowserCardRequest } from "./open";
import "./browser.css";

/** The newest view of a request: what the cache heard (an action, the realtime event), else the card's meta. */
export function useCurrentHandoff(orgId: string, handoff: BrowserHandoff) {
  const api = useApi();
  // Listens to the cache entry without fetching: the card's meta is where it starts.
  const query = useQuery({
    queryKey: keys.browserHandoff(orgId, handoff.id),
    queryFn: () => api.browser.handoff(orgId, handoff.id),
    enabled: false,
    placeholderData: handoff,
  });
  return query.data ?? handoff;
}

/**
 * An agent asks a person for help in its browser (`browser_ask_person`,
 * ADR 0040 §6) or on its desktop (`desktop_ask_person`, ADR 0058): the
 * request, the time left, "Abrir" to the live view; who is helping; and how
 * it ended. While it waits, the same request card as every other ask.
 */
export function BrowserHandoffCard({ handoff }: { handoff: BrowserHandoff }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const current = useCurrentHandoff(org.id, handoff);
  const actions = useBrowserHandoffMutations(org.id);
  const agent = dir.agentById.get(current.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  // It stops waiting the moment it expires, even before the server's event says so.
  const expired = useExpired(current.status === "pending" ? current.expiresAt : null);
  const waiting = !expired && isWaitingHandoff(current);
  const active = current.status === "active";
  // The time left moves on.
  useNow(waiting ? 15_000 : false);
  const mineInControl = active && current.controllerUserId === me.user.id;
  const helper = current.controllerUserId ? dir.memberById.get(current.controllerUserId)?.name : undefined;
  const settled = !waiting && !active;
  const status = current.status === "pending" ? "expired" : current.status;
  const left = handoffTimeLeft(t, current);
  const onDesktop = handoffScreen(current) === "desktop";
  // The window of a browser request on the agent's screen, for someone who may drive that screen: they help there.
  const desktop = useDesktopStatus(org.id, current.agentId, { enabled: !onDesktop && (waiting || active) });
  const opensDesktop = drivesOnDesktop(current, desktop.data);
  // The agent's browser opens right here, under the request; on its screen, in the computer dialog.
  const [here, setHere] = useState(false);
  const openComputer = useOpenComputer();
  const show = () => (opensDesktop ? openComputer(current.agentId, current.seat) : setHere(true));
  const take = () =>
    actions.takeControl.mutate(current.id, {
      onSuccess: show,
      onError: (err) => {
        // It ended meanwhile: the card says so itself (`useBrowserHandoffMutations` reads it again).
        if ((err as { code?: string }).code === HANDOFF_OVER) return;
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        );
      },
    });
  // A notification asked for this request: take it (or show it, when it's already mine).
  const asked = useBrowserCardRequest({ handoffId: current.id });
  const latest = useRef({ take, waiting, show });
  latest.current = { take, waiting, show };
  useEffect(() => {
    if (asked === null) return;
    if (latest.current.waiting) latest.current.take();
    else latest.current.show();
  }, [asked]);
  const showBrowser = !opensDesktop && ((here && (waiting || active)) || mineInControl);
  const time = current.resolvedAt ? formatTime(i18n.language, current.resolvedAt) : "";
  const screenIcon = onDesktop ? "computer" : "globe";
  const groupLabel = onDesktop ? t("desktop.card.group", g) : t("browser.card.group", g);
  // A request card like every other, waiting, with someone helping or over. "Ver a tela" shows the agent's browser
  // under it (its desktop, in the computer dialog); "Abrir aqui" takes control as before. Over, the same card says how
  // it ended and who did it where its button was.
  const asker = current.requestedForUserId;
  // Its buttons only for whom it waits on (the server checks again when they open it).
  const mine = waiting && handoffIsMine(current, me.user.id, agent?.ownerUserId, org);
  const askedName = asker ? dir.memberById.get(asker)?.name : undefined;
  const answer: RequestAnswer | undefined = settled
    ? {
        done: status === "done" || status === "withdrawn",
        text:
          status === "done"
            ? current.controllerUserId === me.user.id
              ? t(onDesktop ? "desktop.card.doneByYou" : "browser.card.doneByYou", { time, ...g, agent: name })
              : t(onDesktop ? "desktop.card.doneBy" : "browser.card.doneBy", {
                  ...g,
                  time,
                  agent: name,
                  name: helper ?? "",
                })
            : status === "failed"
              ? t("browser.card.failed")
              : status === "cancelled"
                ? t("browser.card.cancelled")
                : status === "withdrawn"
                  ? t("browser.card.withdrawn", g)
                  : t("browser.card.expired", g),
        note: status === "failed" && current.note ? <>“{inlineWords(current.note)}”</> : undefined,
      }
    : undefined;
  return (
    <>
      <RequestCard
        id={current.id}
        kind={onDesktop ? "desktop" : "browser"}
        agent={agent}
        runId={current.runId}
        label={groupLabel}
        mine={mine}
        waitingFor={
          active
            ? mineInControl
              ? t("browser.card.helpingYou")
              : t("browser.card.helping", { name: helper ?? "" })
            : askedName
              ? t("ask.waitingFor", { name: askedName })
              : undefined
        }
        answer={answer}
        lead={current.instructions}
        object={{
          logo: (
            <RequestTile>
              <Icon name={screenIcon} size={16} />
            </RequestTile>
          ),
          title: onDesktop ? t("desktop.card.where", g) : t("browser.card.where", g),
          detail: agent?.handle ? `@${agent.handle}` : undefined,
          ...(waiting ? { more: t("ask.seeScreen") } : {}),
        }}
        open={!opensDesktop && showBrowser}
        onOpenChange={
          waiting ? (open) => (opensDesktop ? openComputer(current.agentId, current.seat) : setHere(open)) : undefined
        }
        actions={
          mine ? (
            <Button
              variant="primary"
              size="sm"
              icon={screenIcon}
              loading={actions.takeControl.isPending}
              onClick={take}
              title={t("browser.inCard.openHereHint")}
            >
              {t("browser.inCard.openHere")}
            </Button>
          ) : active && !showBrowser ? (
            <Button size="sm" icon={screenIcon} onClick={show}>
              {opensDesktop && mineInControl ? t("agentComputer.open") : t("browser.card.watch")}
            </Button>
          ) : undefined
        }
        end={
          waiting && (
            <RequestFuse
              left={handoffFuse(current)}
              agent={agent}
              text={left !== null ? t("browser.card.left", { time: left }) : null}
            />
          )
        }
        what={current.instructions}
      />
      {showBrowser && (
        <BrowserCard agentId={current.agentId} name={name} handoff={current} onSettled={() => setHere(false)} />
      )}
    </>
  );
}
