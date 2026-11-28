import {
  BROWSER_FPS,
  type BrowserFrame,
  type BrowserHandoff,
  browserSiteUrl,
  browserSteps,
  type DesktopViewState,
  handoffFuse,
  isOpenHandoff,
  type LiveRun,
  profileLiveKey,
  rememberHeldPlace,
  useAgentBrowserHandoff,
  useAgentScreenControl,
  useBrowserHandoffActions,
  useBrowserProfileMutations,
  useBrowserScreen,
  useBrowserStuck,
  useMachines,
} from "@agenteschat/client";
import { browserCardLine, hostAndPath, titleKind } from "@agenteschat/client/lib/browser-card";
import { LEGACY_MOVE, maintenanceNamed, maintenanceOf } from "@agenteschat/client/lib/computer-maintenance";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { browserNoAnswerMessage, browserOffMessage, profileRefusalLine } from "@agenteschat/client/lib/machines";
import { useSeat } from "@agenteschat/client/lib/seat-context";
import { isBlankPage, siteName } from "@agenteschat/client/lib/sites";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useIsFocused } from "expo-router";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, ScrollView, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { INACTIVE_GRACE_MS, useAppActive } from "@/lib/useAppActive";
import { Sky } from "@/sky/Sky";
import {
  Button,
  Fuse,
  Glass,
  Icon,
  IconButton,
  InkOrbit,
  PixelOrbit,
  PressScale,
  RADIUS,
  Text,
  TOUCH,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { useRowDirectory, useRowMeId } from "../chat/row-data";
import { openComputer } from "../computer/AgentComputerRow";
import { ScreenWatch, type ScreenWatchHandle } from "../computer/ScreenWatch";
import { DEFAULT_DESKTOP } from "../computer/screen-view";
import { MachineToolButton } from "../devices/ToolOneClick";
import { ReportProblemButton } from "../report/ReportProblemButton";
import { withAgentFaces } from "../shared/Face";
import { useColors, useEdition, useNow, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { successHaptic, useSurface } from "../shared/parts";
import { framesWanted, pageGapKey, pageNoteOf, skyBehind, stepIcon, stepText, waitsForPage } from "./logic";
import {
  AddressBar,
  browserTyping,
  EndBand,
  FrameView,
  SITE_PAPER,
  SiteIcon,
  TypeBar,
  useLiveConnection,
} from "./parts";
import { useFinishHandoff } from "./useFinishHandoff";

/** The log's last lines under the page on the computer's full view (the design shows three). */
const LOG_LINES = 3;

/** The frame's words on the agent's color, the same in both themes (the web's `--frame-ink`), and its softer tones. */
const FRAME_INK = "#ffffff";
const FRAME_NOW = "rgba(255, 255, 255, 0.92)";
const FRAME_PATH = "rgba(255, 255, 255, 0.72)";
/** The frame while the person is in control: graphite (the web's `--frame-control-a`, `--frame-control-b`). */
const CONTROL_FRAME = ["#3a3a3c", "#1c1c1e"] as const;

/** The history's steps fade in and out where they stand (opacity only, on the UI thread). */
const HIST_IN = FadeIn.duration(180);
const HIST_OUT = FadeOut.duration(120);

/**
 * The agent's browser as its card (ADR 0040 §6–7), as on the web (`BrowserCard`).
 *
 * In the conversation the live page is always in view, in a frame of the agent's color (the web's `brw-mf`): its top
 * says the site and, on glass-white words, what the agent does now; a tap there opens its steps, newest first, over
 * the page. Take over, Stop and full screen (the agent's computer) sit on glass over the page: what the web shows on
 * hover is always there for a finger. In control the frame turns graphite, the request (or the site) is its title, an
 * address to open a site shows over a page with nothing on it, the app's own field types into the page, and the bar
 * under it hands back (Done, or Hand back for a take over; Give up on a request). While someone else is in control the
 * page stays theirs. Stopped, the frame closes into a light band of the agent's color that says who stopped it. The
 * page streams while the conversation is in front (and always for the person in control: their watching keeps it).
 *
 * On the agent's computer full screen (`surface`) the view's own head names it and says what goes on: the card keeps
 * only the request or the site, one action, the page, the person's controls and the last steps.
 */
export const BrowserCard = memo(function BrowserCard({
  agentId,
  run,
  handoff: given = null,
  claim = false,
  surface = false,
  canTakeOver = true,
  onClosed,
  style,
  profile,
}: {
  agentId: string;
  /** A shared browser profile (ADR 0110) instead of the agent's browser: "Log in" from the computer's page. */
  profile?: { id: string; name: string; machineId?: string };
  /** The agent's run in its browser (what it does now, its steps). */
  run?: LiveRun | null;
  /** A request for help this card answers (the request's own message). */
  handoff?: BrowserHandoff | null;
  /** Opened from a push or the inbox: take the control once. */
  claim?: boolean;
  /**
   * The agent's computer full screen: always open, nothing to fold; Take control also opens a closed browser,
   * and in control an empty or closed one gets an address to open (the phone has no other way to a site).
   */
  surface?: boolean;
  /** Take control may show: no hold or pause (the server still decides who may). */
  canTakeOver?: boolean;
  /** Whether the agent's browser is closed (the full-screen view's sub-line says so). */
  onClosed?: (closed: boolean) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const c = useColors();
  const { shadows } = useTheme();
  const reduced = useReducedMotion();
  const toast = useToast();
  const raised = useSurface("e2");
  const when = useWhen();
  const seat = useSeat(agentId);
  // The Cloud's computer is always on: when it doesn't answer, it says so.
  const cloud = useEdition() === "cloud";
  const now = useNow(15_000);
  const actions = useBrowserHandoffActions(orgId);
  const profileActions = useBrowserProfileMutations(orgId);
  const chat = !surface;
  // In the conversation the page is in view while the conversation is in front; full screen, always.
  const focused = useIsFocused();
  const inView = surface || focused;

  const agent = dir.agentById.get(agentId);
  const name = profile?.name ?? agent?.name ?? "";
  const g = genderOf(name);
  const grammar = agentGrammar(name);
  const color = agentLook(agent).color;
  // A take over has no message of its own: the agent's open request.
  const ofAgent = useAgentBrowserHandoff(orgId, agentId, !given && !profile);
  const handoff = given ?? (ofAgent.data && isOpenHandoff(ofAgent.data) ? ofAgent.data : null);
  // Watching is for everyone behind its work; driving it only for admins, its owner and who it asked (ADR 0040).
  const control = useAgentScreenControl(orgId, agentId, !given && !profile);
  const mayDrive = Boolean(profile) || given !== null || control.data !== false;
  // The person in control keeps watching wherever the card is: their watching is what keeps their control.
  const holding = Boolean(meId) && handoff?.status === "active" && handoff.controllerUserId === meId;
  const watching = inView || holding;
  // Its browser on the agent's screen, which this person may watch: the card shows that whole screen instead of the
  // browser's frames (ADR 0058 §7), only while in view with the app in front, and lingering a little after.
  const active = useAppActive(INACTIVE_GRACE_MS);
  const shown = inView && active;
  const screen = useBrowserScreen(orgId, agentId, {
    enabled: !surface && !profile,
    userId: meId ?? "",
    shown,
    holdsBrowser: holding,
  });
  const onScreen = screen.desktop;
  const [pageState, setPageState] = useState<DesktopViewState>("connecting");
  const watchRef = useRef<ScreenWatchHandle>(null);
  // The screen's view stays loaded while its stream lingers after the conversation goes behind another screen, so
  // coming back reuses the page and its socket; once gone, the next one opens afresh: nothing to drive until it's live.
  const screenMounted = onScreen && (shown || screen.connect);
  useEffect(() => {
    if (!screenMounted) setPageState("connecting");
  }, [screenMounted]);
  // In the conversation the page is a small picture among the messages: two frames a second follow the agent's work
  // without loading the scroll. Full screen and in control, the stream's own rate (ADR 0040 §7.1).
  const live = useLiveConnection(
    profile ? profileLiveKey(profile.id) : agentId,
    framesWanted({
      watching,
      profile: Boolean(profile),
      holding,
      settled: screen.settled,
      desktop: onScreen,
    }),
    surface || holding ? undefined : BROWSER_FPS.card,
  );
  // A profile whose browser is off on its computer: the switch in the page's place (ADR 0036 §8).
  const offHere = Boolean(profile) && live.unavailable === "unavailable" && browserOffMessage(live.message);
  const noAnswer = Boolean(profile) && live.unavailable === "unavailable" && browserNoAnswerMessage(live.message);
  const away = live.unavailable === "offline";
  const machines = useMachines(orgId, offHere || away);
  const profileMachine = offHere ? machines.data?.find((m) => m.id === profile?.machineId) : undefined;
  // Its computer away for what we do to it (a move, a restart…): said so, never that it isn't answering.
  const moving = away
    ? machines.data?.find((m) => (profile ? m.id === profile.machineId : m.agents.some((a) => a.id === agentId)))
    : undefined;
  const controller =
    live.handoff?.controllerUserId ??
    live.controllerUserId ??
    handoff?.controllerUserId ??
    // The desktop's controller holds the browser only while the browser is on that screen.
    (screen.status.data?.browserOnDesktop ? screen.status.data.controllerUserId : null) ??
    null;
  const mine = Boolean(meId) && controller === meId;
  const other = Boolean(controller) && !mine;
  const waiting = handoff?.status === "pending";
  const steps = browserSteps(run?.work);
  const lastStep = steps.at(-1);
  const helper = other && controller ? dir.nameOf({ type: "person", id: controller }) : "";
  const closed = !onScreen && live.unavailable === "closed";
  useEffect(() => onClosed?.(closed), [closed, onClosed]);
  // Take control needs a live page to drive; full screen, it also opens a closed browser (there is an address to open
  // a site there).
  const ready = onScreen ? pageState === "live" : watching && Boolean(live.frame) && !live.unavailable;
  const canTake = canTakeOver && (ready || (surface && closed));
  // Full screen in control with nothing to show (closed, empty, a blank page): an address to open a site.
  const goShown = mine && (closed || !live.frame || isBlankPage(live.frame.metadata.url));
  // Opening or reconnecting for too long says so, with Try again (as on the web). Only while the app's socket is
  // open: without a network no page can come, and the agent's browser isn't the one to blame.
  const [attempt, setAttempt] = useState(0);
  const waitingForPage =
    !onScreen &&
    watching &&
    live.online &&
    !live.hidden &&
    waitsForPage(live.unavailable) &&
    !(live.frame && !live.unavailable);
  const stuck = useBrowserStuck(waitingForPage, attempt);
  const note = pageNoteOf(live.unavailable, live.hidden, mine, stuck, noAnswer);
  // biome-ignore lint/correctness/useExhaustiveDependencies: said each time, also when a try that failed fails again
  useEffect(() => {
    if (mine && live.lost) toast({ title: t(live.lost.words), icon: "x" });
  }, [live.lost]);
  const doneLabel = handoff?.kind === "takeover" ? t("browser.inCard.handBack") : t("browser.inCard.done");
  // Stop here: the card says so until a new page comes, which only its frames tell (the browser is closed meanwhile).
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  useEffect(() => {
    if (live.frame) setStoppedAt(null);
  }, [live.frame]);
  // The steps over the page, opened from what the agent does now; closed when the person takes the control.
  const [hist, setHist] = useState(false);
  useEffect(() => {
    if (mine) setHist(false);
  }, [mine]);
  const [taking, setTaking] = useState(false);

  // A push or the inbox opened this request: it takes the control (first one wins).
  const claimed = useRef(false);
  useEffect(() => {
    if (!claim || claimed.current || !handoff || handoff.status !== "pending") return;
    claimed.current = true;
    actions.takeControl(handoff.id).catch(() => {});
  }, [claim, handoff, actions]);

  const failedToast = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  // Its buttons give the press's own haptic (`Button`, `IconButton`): none more here, or a press taps twice.
  const answer = async () => {
    if (handoff?.status !== "pending") return;
    try {
      await actions.takeControl(handoff.id);
    } catch {
      failedToast();
    }
  };
  const takeover = async () => {
    setTaking(true);
    try {
      if (profile) {
        await profileActions.takeover.mutateAsync(profile.id);
        return;
      }
      // From a run's card: bound to that run, so the card stays in this conversation while the run waits.
      const h = await actions.takeover(agentId, run?.runId);
      setStoppedAt(null);
      if (h.kind === "takeover" && h.runId && run) {
        rememberHeldPlace({ runId: h.runId, agentId, channelId: run.channelId, threadId: run.threadId });
      }
    } catch (err) {
      if ((err as { status?: number }).status === 409) toast({ title: t("browser.card.busy"), icon: "x" });
      else failedToast();
    } finally {
      setTaking(false);
    }
  };
  const finishing = useFinishHandoff(handoff, name, doneLabel);
  const couldnt = finishing.couldnt;
  // A profile's control has no task to report on: Hand back just hands it back.
  const handBack = () => {
    if (!profile) return finishing.handBack();
    void profileActions.handback.mutateAsync(profile.id).then(successHaptic, failedToast);
  };
  const stop = () => {
    Alert.alert(t(`mobile.browser.card.stopAsk${g}`, { name }), undefined, [
      { text: t("mobile.common.cancel"), style: "cancel" },
      {
        text: t("browser.watch.stop"),
        style: "destructive",
        onPress: () => void actions.stop(agentId).then(() => setStoppedAt(new Date().toISOString()), failedToast),
      },
    ]);
  };
  // Who may drive it restarts the browser, then watches again (this card's own watch may be what was refused);
  // someone who only watches watches again.
  const retry = () => {
    setAttempt((n) => n + 1);
    if (onScreen) {
      watchRef.current?.retry();
      void screen.status.refetch();
      return;
    }
    if (mayDrive && !profile) void actions.restart(agentId).catch(failedToast).finally(live.retry);
    // A profile's Chrome starts again with control taken again (the server warms it, or says why it can't).
    else if (profile && mayDrive)
      void profileActions.takeover
        .mutateAsync(profile.id)
        .catch((err) => toast({ title: profileRefusalLine(t, err), icon: "x" }))
        .finally(live.retry);
    else live.retry();
  };

  // ── The page with nothing (or something going on) to show: why, and the way out ──
  const coverWords = offHere
    ? t("browser.profiles.toolOff")
    : note.say === "starting"
      ? profile
        ? t("browser.profiles.opening", { name: profile.name })
        : t("browser.inCard.openingLong", grammar)
      : note.say === "hidden"
        ? // The card's top (or the full view's head) says who is in control; the page only why it hides.
          t("browser.inCard.hiddenHelp", grammar)
        : note.say === "offline" && moving?.moving
          ? maintenanceNamed(t, maintenanceOf(moving) ?? LEGACY_MOVE, moving.name)
          : t(pageGapKey(note.say, g, cloud), { name });
  const coverHelp =
    note.say === "starting"
      ? t("browser.inCard.openingHelp")
      : chat && mine && (note.say === "closed" || note.say === "ended")
        ? // The address to open a site is over the page in the conversation.
          t("browser.inCard.closedControl")
        : note.help && (note.help !== "stuckHelp" || mayDrive)
          ? t(`mobile.browser.live.${note.help}${g}`, { name })
          : null;
  const cover = (over: boolean, onSky: boolean) => (
    <View style={[styles.center, over ? styles.overlay : null]}>
      <View style={onSky ? [styles.onSky, raised] : styles.lines}>
        {note.spin ? (
          <PixelOrbit color={color} size={16} />
        ) : note.say === "hidden" ? (
          <Icon name="eyeoff" size={18} color={c.muted} />
        ) : note.say === "closed" || note.say === "ended" ? (
          <Icon name="globe" size={18} color={c.muted} />
        ) : null}
        <Text variant="small" tone="ink" style={[styles.semibold, styles.centerText]}>
          {coverWords}
        </Text>
        {coverHelp ? (
          <Text variant="caption" tone="muted" style={styles.centerText}>
            {coverHelp}
          </Text>
        ) : null}
        {offHere && profileMachine ? (
          <MachineToolButton machine={profileMachine} tool="browser" onAllowed={retry} />
        ) : note.say === "stuck" || note.say === "noAnswer" || (note.say === "unavailable" && profile) ? (
          <View style={styles.noteActs}>
            <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={retry} />
            {note.say !== "unavailable" && (
              <ReportProblemButton
                place="browser"
                code={note.say === "noAnswer" ? "browser.no_answer" : "browser.stuck"}
                context={{ agentId, ...(profile?.machineId ? { machineId: profile.machineId } : {}) }}
                timings={{ attempts: attempt + 1 }}
              />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
  // A page the agent shows at a phone's (or another) size says so, and the person in control can end it.
  const emulated = (frame: BrowserFrame | null) =>
    frame?.metadata.emulated ? (
      <View style={[styles.emu, raised]}>
        <Text variant="caption" tone="ink" style={styles.semibold}>
          {t(`browser.live.emulated.${frame.metadata.emulated}`, {
            size: `${frame.metadata.deviceWidth}×${frame.metadata.deviceHeight}`,
          })}
        </Text>
        {mine ? (
          <Button
            variant="ghost"
            size="sm"
            label={t("browser.live.normalSize")}
            disabled={profile ? profileActions.open.isPending : actions.opening}
            onPress={() =>
              void (
                profile
                  ? profileActions.open.mutateAsync({ profileId: profile.id, url: { go: "normalSize" } })
                  : actions.open(agentId, { go: "normalSize" })
              ).catch(failedToast)
            }
          />
        ) : null}
      </View>
    ) : null;
  const address = (
    <AddressBar
      name={name}
      cloud={cloud}
      onOpen={(url) =>
        profile ? profileActions.open.mutateAsync({ profileId: profile.id, url }) : actions.open(agentId, url)
      }
    />
  );
  const typing = (
    <TypeBar
      {...browserTyping(live.sendInput, () => toast({ title: t("desktop.clipboard.tooLong", grammar), icon: "x" }))}
    />
  );

  if (chat) {
    // The agent's own request is open and mine: its card (under the request) is the control, not this one.
    if (!given && handoff?.kind === "ask" && mine) return null;

    // Stop (here, or by someone else: everyone watching hears it): the frame closes into its band.
    const stopped = stoppedAt
      ? { at: stoppedAt, by: meId }
      : live.endedBy?.reason === "stopped"
        ? { at: live.endedBy.at ?? null, by: live.endedBy.userId ?? null }
        : null;
    if (stopped) {
      const byName = stopped.by && stopped.by !== meId ? dir.memberById.get(stopped.by)?.name : undefined;
      const time = stopped.at ? when.time(stopped.at) : "";
      const who =
        stopped.by === meId
          ? t("browser.watch.stoppedBy", { time })
          : byName
            ? t("browser.watch.stoppedByOther", { person: byName, time })
            : time
              ? t("browser.watch.stoppedAt", { time })
              : null;
      return (
        <EndBand color={color} style={[styles.frameRoom, style]}>
          <View style={styles.stoppedRow}>
            <Icon name="stop" size={14} color={c.muted} />
            <View style={styles.grow}>
              <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.semibold}>
                {t("browser.watch.stopped")}
              </Text>
              {who ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {who}
                </Text>
              ) : null}
            </View>
            {mine && handoff ? (
              <Button variant="primary" size="sm" label={doneLabel} loading={finishing.finishing} onPress={handBack} />
            ) : null}
          </View>
        </EndBand>
      );
    }

    // What the frame knows of the page, as the web's: closed (or ended), someone else's, why nothing can show.
    const gap = onScreen ? null : live.unavailable;
    const shut = gap === "closed" || gap === "ended";
    const hidden = !onScreen && live.hidden;
    const reconnecting = gap === "reconnecting";
    const blocker =
      gap === "offline" ||
      gap === "no_computer" ||
      gap === "forbidden" ||
      gap === "tooMany" ||
      (gap === "unavailable" && Boolean(profile));
    // What is shown of the page: nothing while it is closed or someone else's (their page stays theirs).
    const pic = shut || hidden ? null : live.frame;
    const sky = !onScreen && !pic && skyBehind(note);
    // In control with nothing to show: the address to open a site, over the page as a browser's own.
    const go = mine && !onScreen && (shut || !pic || isBlankPage(pic.metadata.url));
    const starting = !onScreen && !pic && !blocker && !reconnecting && !shut && !hidden;
    const nobody = !mine && !other;
    const going = nobody && !blocker && !shut && !stuck;
    const spinning = going || (reconnecting && !stuck);
    const [host, path] = hostAndPath(shut || hidden ? null : browserSiteUrl(pic?.metadata.url, steps));
    const ask = handoff?.kind === "ask" ? handoff.instructions : null;
    const asTitle = titleKind({ inControl: mine, ask, host, opening: starting && !stuck });
    const title =
      asTitle === "ask"
        ? (ask ?? "")
        : asTitle === "host"
          ? siteName(host)
          : asTitle === "opening"
            ? t("browser.inCard.opening")
            : t("browser.inCard.group", grammar);
    const line = browserCardLine(t, {
      grammar,
      inControl: mine,
      otherInControl: other,
      controllerName: helper,
      hidden,
      closed: shut,
      stuck,
      reconnecting,
      starting: starting || (!lastStep && !pic && !onScreen),
      ask,
      host,
      profile: profile ? { machineName: null } : null,
      now: lastStep ? lowerFirst(stepText(t, lastStep), i18n.language) : null,
    });
    const history = !mine && steps.length > 0;
    const full = (plate: boolean) => (
      <IconButton
        icon="fullscreen"
        small
        plate={plate}
        label={t("browser.inCard.full")}
        onPress={() => openComputer(agentId, seat)}
      />
    );
    // Take over (or Open the browser, closed), Stop and full screen, over the page: the web's hover toolbar, always
    // there for a finger. The steps, opened, take its place.
    const takeShown = nobody && mayDrive && canTakeOver && !blocker;
    const stopShown = nobody && !shut && !blocker && !profile;
    const overShown = nobody && !blocker && (!onScreen || pageState === "live") && !(hist && history);

    return (
      <View style={[styles.frame, styles.frameRoom, style]}>
        {/* The frame's color, 135° across it as the web's; graphite while the person is in control. */}
        <LinearGradient
          colors={mine ? CONTROL_FRAME : gradientOf(color)}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.top}>
          <View style={styles.site}>
            {asTitle === "host" ? <SiteIcon host={host} /> : <Icon name="globe" size={16} color={FRAME_INK} />}
            <Text
              variant="footnote"
              numberOfLines={asTitle === "ask" ? 2 : 1}
              style={[styles.shrink, styles.semibold, { color: FRAME_INK }]}
            >
              {title}
              {asTitle === "host" && path ? (
                <Text variant="footnote" style={[styles.medium, { color: FRAME_PATH }]}>
                  {path}
                </Text>
              ) : null}
            </Text>
          </View>
          <View style={styles.spacer} />
          {mine && !blocker ? full(true) : null}
          {mine ? null : (
            <PressScale
              fill={false}
              disabled={!history}
              onPress={() => setHist((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={line}
              accessibilityState={{ expanded: hist && history, disabled: !history }}
              accessibilityHint={hist ? t("browser.after.hideSteps") : t("browser.after.showSteps")}
              style={styles.now}
              contentStyle={styles.nowIn}
            >
              {spinning ? <InkOrbit size={12} color={FRAME_INK} /> : null}
              <Text variant="footnote" numberOfLines={1} style={[styles.shrink, { color: FRAME_NOW }]}>
                {withAgentFaces(line, [{ name, agentId }], 13)}
              </Text>
              {history ? (
                <View style={hist ? styles.flip : undefined}>
                  <Icon name="chev" size={12} color={FRAME_NOW} />
                </View>
              ) : null}
            </PressScale>
          )}
        </View>

        <View style={[styles.inner, { backgroundColor: c.raised }]}>
          {go ? <View style={styles.go}>{address}</View> : null}
          <View style={[styles.stage, { backgroundColor: c.sunken }]}>
            {onScreen ? (
              <>
                {/* Out of view its place keeps the screen's shape, so the conversation never jumps. */}
                {shown ? null : <View style={styles.screenRoom} />}
                {screenMounted ? (
                  <ScreenWatch
                    ref={watchRef}
                    agentId={agentId}
                    connect={screen.connect}
                    parked={!shown}
                    onState={(state) => {
                      setPageState(state);
                      screen.report(state);
                    }}
                    radius={0}
                  />
                ) : null}
              </>
            ) : (
              <View
                style={[styles.framePage, { backgroundColor: pic && !pic.metadata.emulated ? SITE_PAPER : c.sunken }]}
              >
                {sky ? (
                  <Sky color={color} surface="raised" depth={0.95} fade={0} style={StyleSheet.absoluteFill} />
                ) : null}
                {pic ? (
                  <FrameView
                    frame={pic}
                    enabled={mine}
                    onInput={live.sendInput}
                    cursor={{ agentId, name, color, pointer: controller ? null : live.pointer }}
                  />
                ) : null}
                {emulated(pic)}
                {!pic || gap ? cover(Boolean(pic), sky) : null}
              </View>
            )}
            {overShown ? (
              <View style={[styles.over, { boxShadow: shadows.e2 }]}>
                <Glass style={styles.overIn}>
                  {takeShown ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      label={shut ? t("browser.inCard.openBrowser") : t("browser.inCard.takeover")}
                      loading={taking}
                      onPress={takeover}
                    />
                  ) : null}
                  {stopShown ? (
                    <IconButton icon="stop" small label={t("mobile.browser.card.stop")} onPress={stop} />
                  ) : null}
                  {full(false)}
                </Glass>
              </View>
            ) : null}
            {hist && history ? (
              <>
                {/* A tap anywhere else on the page closes the steps. */}
                <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={() => setHist(false)} />
                <View pointerEvents="box-none" style={styles.histRoom}>
                  <Animated.View
                    entering={reduced ? undefined : HIST_IN}
                    exiting={reduced ? undefined : HIST_OUT}
                    style={[styles.hist, { boxShadow: shadows.e3 }]}
                  >
                    <Glass style={styles.histIn}>
                      <ScrollView nestedScrollEnabled contentContainerStyle={styles.histList}>
                        {[...steps].reverse().map((s, i) => {
                          const doing = i === 0 && s.running;
                          return (
                            <View key={s.id} style={[styles.histRow, doing && { backgroundColor: c.plate }]}>
                              <View style={styles.histMark}>
                                {doing ? (
                                  <PixelOrbit color={color} size={12} />
                                ) : (
                                  <Icon name={stepIcon(s.tool)} size={14} color={c.muted} />
                                )}
                              </View>
                              <Text
                                variant="footnote"
                                tone={doing ? "ink" : "muted"}
                                numberOfLines={doing ? 3 : 1}
                                style={[styles.grow, doing && styles.medium]}
                              >
                                {stepText(t, s)}
                              </Text>
                              {s.since ? (
                                <Text variant="caption" tone="faint" style={styles.num}>
                                  {when.time(new Date(s.since).toISOString())}
                                </Text>
                              ) : null}
                            </View>
                          );
                        })}
                      </ScrollView>
                    </Glass>
                  </Animated.View>
                </View>
              </>
            ) : null}
          </View>
          {mine ? (
            <View style={styles.control}>
              {typing}
              {/* The way back to the agent, as the web's: a word for it, Give up on a request, the main one last. */}
              <View style={styles.back}>
                {profile ? null : (
                  <Text variant="footnote" tone="ink" numberOfLines={1} style={styles.semibold}>
                    {t("browser.inCard.backTitle", grammar)}
                  </Text>
                )}
                <View style={styles.ways}>
                  {profile ? null : (
                    <Button
                      variant="text"
                      size="sm"
                      label={t("browser.inCard.addNote")}
                      onPress={finishing.leaveNote}
                    />
                  )}
                  <View style={styles.spacer} />
                  {ask ? (
                    <Button variant="secondary" size="sm" label={t("browser.inCard.giveUp")} onPress={couldnt} />
                  ) : null}
                  <Button
                    variant="primary"
                    size="sm"
                    label={profile ? t("browser.profiles.handBack") : doneLabel}
                    loading={finishing.finishing}
                    onPress={handBack}
                  />
                </View>
              </View>
            </View>
          ) : other && !hidden ? (
            <Text variant="footnote" tone="muted" style={styles.note}>
              {t("browser.inCard.otherHelp", { person: helper })}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  // ── The agent's computer full screen: what the view's head doesn't say ──
  // A take over asks nothing: its title is the site, as while watching.
  const asked = (mine || waiting) && handoff?.instructions ? handoff.instructions : "";
  const named = asked || hostAndPath(browserSiteUrl(live.frame?.metadata.url, steps))[0];
  const hasAction = Boolean(mine && handoff) || waiting || (!controller && canTake && mayDrive);
  const behind = !live.frame && skyBehind(note);

  return (
    <View style={[styles.card, raised, style]}>
      <Sky color={color} surface="raised" depth={0.95} fade={0} style={styles.sky} />
      {!named && !hasAction ? null : (
        <View style={styles.head}>
          {named ? (
            <Text variant="footnote" tone="ink" numberOfLines={asked ? 2 : 1} style={[styles.grow, styles.semibold]}>
              {named}
            </Text>
          ) : (
            <View style={styles.grow} />
          )}
          {mine && handoff ? (
            <Button
              variant="secondary"
              size="sm"
              icon="check"
              label={doneLabel}
              loading={finishing.finishing}
              onPress={handBack}
            />
          ) : waiting ? (
            <Button variant="primary" size="sm" label={t("mobile.browser.card.open")} onPress={answer} />
          ) : !controller && canTake && mayDrive ? (
            <Button variant="secondary" size="sm" label={t("desktop.takeover")} loading={taking} onPress={takeover} />
          ) : null}
        </View>
      )}
      <View
        style={[
          styles.page,
          // Nothing under the page (no controls, note or steps): it keeps the card's margin at the bottom too.
          !mine && !(helper && !live.hidden) && steps.length === 0 && styles.pageLast,
          behind ? null : { backgroundColor: c.sunken },
        ]}
      >
        {behind ? <Sky color={color} surface="raised" depth={0.95} fade={0} style={StyleSheet.absoluteFill} /> : null}
        {live.frame ? (
          <FrameView
            frame={live.frame}
            enabled={mine}
            onInput={live.sendInput}
            cursor={{ agentId, name, color, pointer: controller ? null : live.pointer }}
            edge={styles.page.borderRadius}
          />
        ) : null}
        {emulated(live.frame)}
        {!live.frame || live.unavailable ? cover(Boolean(live.frame), behind) : null}
      </View>
      {mine ? (
        <View style={styles.control}>
          {goShown ? address : null}
          {typing}
          {/* A profile goes back to its agents, not to one. A take over asked for nothing: it only hands back. */}
          <View style={styles.surfaceWays}>
            {profile ? null : (
              <Button variant="text" size="sm" label={t("browser.inCard.addNote")} onPress={finishing.leaveNote} />
            )}
            {handoff?.kind === "ask" ? (
              <Button variant="text" size="sm" label={t("mobile.browser.live.couldnt")} onPress={couldnt} />
            ) : null}
          </View>
        </View>
      ) : helper ? (
        live.hidden ? null : (
          <Text variant="small" tone="muted" style={styles.note}>
            {t("mobile.browser.live.watchOnly", { name: helper })}
          </Text>
        )
      ) : steps.length > 0 ? (
        <View style={styles.log}>
          {steps.slice(-LOG_LINES).map((s, i, shownSteps) => (
            <View
              key={s.id}
              style={[styles.step, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <Text
                variant="caption"
                tone={i === shownSteps.length - 1 ? "ink" : "muted"}
                numberOfLines={1}
                style={[styles.grow, i === shownSteps.length - 1 && styles.semibold]}
              >
                {stepText(t, s)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {waiting && handoff?.expiresAt ? (
        <Fuse color={color} remaining={handoffFuse(handoff, now)} style={styles.fuse} />
      ) : null}
    </View>
  );
});

/**
 * An agent's run in its browser as a row of the conversation: its framed page while it works. When its request for
 * help is the person's and in their control, that request's card (on its message) is the browser and this one steps
 * aside (`BrowserCard`), as on the web.
 */
export const BrowserRunCard = memo(function BrowserRunCard({ run }: { run: LiveRun }) {
  return <BrowserCard agentId={run.agentId} run={run} />;
});

/** The frame: 18 round with its cut corner at 6, the page and what goes under it 5 in, concentric with it. */
const FRAME = { radius: 18, cut: 6, inset: 5 } as const;
const INNER = FRAME.radius - FRAME.inset;
/** The full view's card corners, and the page inside it 8 pt in, concentric with them. */
const CARD = 20;
const PAGE_INSET = 8;

const styles = StyleSheet.create({
  noteActs: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  // ── The conversation's frame ──
  frameRoom: { marginTop: 12 },
  frame: {
    borderTopLeftRadius: FRAME.radius,
    borderTopRightRadius: FRAME.radius,
    borderBottomRightRadius: FRAME.radius,
    borderBottomLeftRadius: FRAME.cut,
    overflow: "hidden",
    paddingHorizontal: FRAME.inset,
    paddingBottom: FRAME.inset,
  },
  // A finger's 44 tall: what the agent does now opens its steps from here.
  top: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: TOUCH, paddingLeft: 8, paddingRight: 2 },
  site: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 },
  spacer: { flexGrow: 1 },
  now: { flexShrink: 1, maxWidth: "58%" },
  nowIn: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: TOUCH, paddingHorizontal: 6 },
  // The page and what goes under it, inside the frame: the frame's corners less its inset, the cut one too.
  inner: {
    borderTopLeftRadius: INNER,
    borderTopRightRadius: INNER,
    borderBottomRightRadius: INNER,
    borderBottomLeftRadius: FRAME.cut - FRAME.inset + 1,
    overflow: "hidden",
  },
  go: { padding: 8 },
  stage: { overflow: "hidden" },
  // A fixed shape: frames arriving never change the card's height, so the conversation never jumps. Its corners are
  // the frame's (the inner box clips it).
  framePage: { aspectRatio: 16 / 10, overflow: "hidden" },
  screenRoom: { aspectRatio: DEFAULT_DESKTOP.width / DEFAULT_DESKTOP.height },
  // Over the page's top right, on glass: the toolbar's buttons, each a finger's 44 by its reach. A capsule around the
  // capsule buttons, 4 out from them, so its ends follow theirs (the computer's dock, `AgentScreen`'s `dockGlass`).
  over: { position: "absolute", top: 8, right: 8, borderRadius: RADIUS.full },
  overIn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 4, borderRadius: RADIUS.full },
  histRoom: { position: "absolute", top: 8, right: 8, bottom: 8, left: 8, alignItems: "flex-end" },
  hist: { width: "100%", maxWidth: 300, maxHeight: "100%", borderRadius: 14 },
  histIn: { flexShrink: 1, borderRadius: 14 },
  histList: { padding: 6 },
  histRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9,
  },
  histMark: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  num: { fontVariant: ["tabular-nums"] },
  back: { gap: 2 },
  ways: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  stoppedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: TOUCH,
    paddingLeft: 12,
    paddingRight: 8,
  },
  // ── The full view's card ──
  card: { marginTop: 12, borderRadius: CARD, overflow: "hidden" },
  sky: { height: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  // A fixed shape: frames arriving never change the card's height.
  page: { aspectRatio: 16 / 10, marginHorizontal: PAGE_INSET, borderRadius: CARD - PAGE_INSET, overflow: "hidden" },
  pageLast: { marginBottom: PAGE_INSET },
  surfaceWays: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16 },
  log: { paddingHorizontal: 12, paddingVertical: 6 },
  step: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  fuse: { marginTop: 0 },
  // ── Both ──
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  lines: { alignItems: "center", gap: 8 },
  onSky: { alignItems: "center", gap: 4, maxWidth: 420, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14 },
  centerText: { textAlign: "center" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.35)" },
  emu: {
    position: "absolute",
    bottom: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 4,
    minHeight: 28,
    borderRadius: 999,
  },
  control: { padding: 10, gap: 8 },
  note: { paddingHorizontal: 12, paddingVertical: 10 },
  flip: { transform: [{ rotate: "180deg" }] },
});
