import {
  BROWSER_FPS,
  type BrowserHandoff,
  drivesOnDesktop,
  HANDOFF_OVER,
  handoffIsMine,
  handoffScreen,
  useBrowserHandoff,
  useBrowserHandoffActions,
  useDesktopStatus,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, PressScale, Text, useToast } from "@/ui";
import { AskButtons, AskCard, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { useMessageCardFrame } from "../chat/look";
import { openComputer } from "../computer/AgentComputerRow";
import { IconTile } from "../connectors/ConnectorIcon";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { ownsIn } from "../shared/owner";
import { PromptForm } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";
import { BrowserCard } from "./BrowserCard";
import { cardStateOf, NOTE_LIMIT } from "./logic";
import { useOpenHandoffId } from "./open";
import { FrameView, useLiveConnection } from "./parts";

/**
 * An agent's request for help in its browser, in the conversation, as on the web (`BrowserHandoffCard`). While nobody
 * has opened it, it is the request card: what the agent needs, "See the screen" showing its page as it is now, Open
 * (takes the control right here) and "Not now" (tells the agent, with an optional reason). Once someone is in control
 * the same card says who is helping, and the agent's browser in its frame stands under it: in the person's control
 * when it is theirs, behind Watch when it is someone else's. A request on the agent's desktop is the same card, Open
 * taking it into the computer's full view (the screen needs its room, ADR 0098), and one line that opens that view
 * once someone helps there. Once it ends, the request card says how it ended where its buttons were. The state comes
 * from the message (`meta.browserHandoff`) and is refreshed from the server. A push or the inbox opens this card.
 */
export function HandoffCard({ handoff: fromMessage }: { handoff: BrowserHandoff }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const c = useColors();
  const frame = useMessageCardFrame();
  const openId = useOpenHandoffId();
  const dir = useDirectory();
  const when = useWhen();
  const fresh = useBrowserHandoff(orgId, fromMessage.id);
  const h: BrowserHandoff = fresh.data ?? fromMessage;
  const state = cardStateOf(h, meId);
  const desktop = handoffScreen(h) === "desktop";
  // A browser request whose window is on the agent's screen, for someone who may drive the screen: helped there.
  const screenQ = useDesktopStatus(orgId, h.agentId, {
    enabled: !desktop && (state === "waiting" || state === "mine"),
  });
  const opensScreen = drivesOnDesktop(h, screenQ.data);
  // Someone else helps: their page shows here only once this person asks to watch (Watch), as on the web.
  const [watching, setWatching] = useState(false);

  // Over: the same request card, what was asked still its words, and how it ended and who did it where its buttons were.
  if (state === "done" || state === "failed" || state === "expired" || state === "cancelled" || state === "withdrawn") {
    const name = dir.agentById.get(h.agentId)?.name ?? t("channel.unknownAgent");
    const g = agentGrammar(name);
    const time = h.resolvedAt ? when.short(h.resolvedAt) : "";
    const helper = h.controllerUserId ? dir.memberById.get(h.controllerUserId)?.name : undefined;
    return (
      <AskCard
        id={h.id}
        kind={desktop ? "desktop" : "browser"}
        agentId={h.agentId}
        waitsFor={null}
        lead={h.instructions}
        well={{ tile: <IconTile name={desktop ? "laptop" : "globe"} size={20} bare />, title: name, detail: null }}
        answer={{
          done: state === "done" || state === "withdrawn",
          words:
            state === "done"
              ? h.controllerUserId === meId
                ? t(desktop ? "desktop.card.doneByYou" : "browser.card.doneByYou", { ...g, time, agent: name })
                : t(desktop ? "desktop.card.doneBy" : "browser.card.doneBy", {
                    ...g,
                    time,
                    agent: name,
                    name: helper ?? "",
                  })
              : state === "failed"
                ? t("browser.card.failed")
                : state === "cancelled"
                  ? t("browser.card.cancelled")
                  : state === "withdrawn"
                    ? t("browser.card.withdrawn", g)
                    : t("browser.card.expired", g),
          note: state === "failed" ? h.note : null,
        }}
      />
    );
  }
  if (opensScreen && (state === "mine" || state === "helping")) {
    const helper = h.controllerUserId ? dir.memberById.get(h.controllerUserId)?.name : undefined;
    // It opens the computer's screen: the press shows, with no haptic (plain navigation), and the chevron says where.
    return (
      <PressScale
        haptic={false}
        fill={false}
        onPress={() => openComputer(h.agentId, h.seat)}
        accessibilityRole="button"
        style={[styles.card, frame.style]}
        contentStyle={styles.done}
      >
        <LineIcon name="laptop" variant="small" size={15} color={c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {state === "mine"
            ? t("mobile.browser.live.inControl")
            : t("mobile.browser.live.helping", { name: helper ?? t("channel.unknownPerson") })}
        </Text>
        <LineIcon name="right" variant="small" size={15} color={c.faint} />
      </PressScale>
    );
  }
  if (state === "waiting") {
    return <HandoffAsk handoff={h} desktop={desktop} opensScreen={opensScreen} claim={openId === h.id} />;
  }
  const name = dir.agentById.get(h.agentId)?.name ?? t("channel.unknownAgent");
  const helper = h.controllerUserId ? dir.memberById.get(h.controllerUserId)?.name : undefined;
  const mine = state === "mine";
  return (
    <>
      <AskCard
        id={h.id}
        kind={desktop ? "desktop" : "browser"}
        agentId={h.agentId}
        waitsFor={
          mine
            ? t("browser.card.helpingYou")
            : t("browser.card.helping", { name: helper ?? t("channel.unknownPerson") })
        }
        lead={h.instructions}
        well={{ tile: <IconTile name={desktop ? "laptop" : "globe"} size={20} bare />, title: name, detail: null }}
        foot={
          mine || watching ? null : (
            <AskFoot>
              <AskButtons
                primary={
                  <Button
                    variant="secondary"
                    size="card"
                    wide
                    label={t("browser.card.watch")}
                    onPress={() => setWatching(true)}
                  />
                }
              />
            </AskFoot>
          )
        }
      />
      {mine || watching ? <BrowserCard agentId={h.agentId} handoff={h} claim={openId === h.id} /> : null}
    </>
  );
}

/** The request while it waits: the request card. */
function HandoffAsk({
  handoff: h,
  desktop,
  opensScreen,
  claim,
}: {
  handoff: BrowserHandoff;
  desktop: boolean;
  /** Helped on the agent's whole screen (`drivesOnDesktop`): Open goes to the computer's full view. */
  opensScreen: boolean;
  claim: boolean;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const asks = useAskStore();
  const actions = useBrowserHandoffActions(orgId);
  const agent = dir.agentById.get(h.agentId);
  const name = agent?.name ?? "";
  // Whose it is goes by ids (the same rule as the line above the composer); a name only says who, once it loads.
  // Someone else's: who it waits for in the header when known, no buttons here.
  // One who holds the role that answers for it helps as its owner (ADR 0085, addendum of 2026-11-21).
  const owner = ownsIn(dir.memberById, meId, agent) ? meId : agent?.ownerUserId;
  const mine = meId !== null && handoffIsMine(h, meId, owner, org);
  const asked = h.requestedForUserId ? dir.memberById.get(h.requestedForUserId)?.name : undefined;
  // It ended meanwhile: the card settles on its own (`useBrowserHandoffMutations`), with nothing to tell.
  const failed = (err: unknown) => {
    if ((err as { code?: string }).code !== HANDOFF_OVER) toast({ title: t("mobile.app.failed"), icon: "x" });
  };

  // `Button` gives the press's haptic: none more here, or a press taps twice.
  // One at a time: a second tap while it takes the control would push the screen twice.
  const taking = useRef(false);
  const take = async () => {
    if (taking.current) return;
    taking.current = true;
    try {
      await actions.takeControl(h.id);
      asks?.settle(h.id);
      if (opensScreen) openComputer(h.agentId, h.seat);
    } catch (err) {
      failed(err);
    } finally {
      taking.current = false;
    }
  };
  // A push or the inbox opened this request: it takes the control once (first one wins), when it is the person's.
  const claimed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request, when it opened the conversation
  useEffect(() => {
    if (!claim || !mine || claimed.current || h.status !== "pending") return;
    claimed.current = true;
    actions.takeControl(h.id).then(
      () => {
        if (opensScreen) openComputer(h.agentId, h.seat);
      },
      () => {},
    );
  }, [claim, opensScreen, mine, h.id, h.status]);

  const notNow = useNotNow(h, () => asks?.settle(h.id));

  return (
    <AskCard
      id={h.id}
      kind={desktop ? "desktop" : "browser"}
      agentId={h.agentId}
      waitsFor={mine ? "you" : asked ? t("ask.waitingFor", { name: asked }) : null}
      lead={h.instructions}
      well={{
        tile: <IconTile name={desktop ? "laptop" : "globe"} size={20} bare />,
        title: name,
        detail: null,
        more: desktop
          ? null
          : {
              label: t("ask.seeScreen"),
              content: <ScreenPeek agentId={h.agentId} name={name} color={agentLook(agent).color} />,
            },
      }}
      expiry={h.expiresAt ? <ExpiryLine createdAt={h.createdAt} expiresAt={h.expiresAt} /> : null}
      foot={
        <AskFoot>
          {mine ? (
            <AskButtons
              primary={
                <Button variant="primary" size="card" wide label={t("mobile.browser.card.open")} onPress={take} />
              }
              secondary={<Button variant="secondary" size="card" wide label={t("approval.notNow")} onPress={notNow} />}
            />
          ) : null}
        </AskFoot>
      }
    />
  );
}

/** The agent's page as it is now, with its pointer, to look at before taking it (watching only: taps do nothing). */
function ScreenPeek({ agentId, name, color }: { agentId: string; name: string; color: string | undefined }) {
  const c = useColors();
  // A small look before taking it: a frame a second is enough (ADR 0040 §7.1).
  const live = useLiveConnection(agentId, true, BROWSER_FPS.preview);
  return (
    <View style={[styles.peek, { backgroundColor: c.sunken }]}>
      {live.frame ? (
        <FrameView
          frame={live.frame}
          enabled={false}
          onInput={live.sendInput}
          edge={styles.peek.borderRadius}
          cursor={{
            agentId,
            name,
            color,
            pointer: (live.handoff?.controllerUserId ?? live.controllerUserId) ? null : live.pointer,
          }}
        />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  card: { borderRadius: 20 },
  // A line that wraps keeps its icon on the first.
  done: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  peek: { aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});

/**
 * "Agora não" on a request for help: the agent hears it couldn't be done now, with the reason if one is given. The
 * chat's card and the agent's computer ask it the same way.
 */
export function useNotNow(h: BrowserHandoff | null, onDone?: () => void) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const actions = useBrowserHandoffActions(orgId);
  const name = (h && dir.agentById.get(h.agentId)?.name) ?? "";
  const g = genderOf(name);
  // Pressed through a `Button`, which gives the press's haptic.
  return () => {
    if (!h) return;
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        limit={NOTE_LIMIT}
        onSubmit={async (text) => {
          sheet.close();
          try {
            await actions.failed(h.id, text.trim() || undefined);
            onDone?.();
          } catch (err) {
            // It ended meanwhile: the card settles on its own (`useBrowserHandoffMutations`), with nothing to tell.
            if ((err as { code?: string }).code !== HANDOFF_OVER) toast({ title: t("mobile.app.failed"), icon: "x" });
          }
        }}
      />,
    );
  };
}
