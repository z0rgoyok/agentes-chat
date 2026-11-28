/**
 * The menu bar popover. While agents work on this computer: what they are doing now, grouped by
 * organization, folder requests on top, pause for the whole computer, and the way to the app, Preferences and
 * Quit. Otherwise (agentes.chat, or a server whose agents work elsewhere) a small card: what waits for you and
 * the way in. With agentes.chat running on this computer, its card comes first (its state, restart, stop) with
 * its banners. This window also owns the tray icon's state, answers the site's questions about this computer
 * and raises the notifications for folder requests (it lives, hidden, for as long as the app runs).
 */
import type {
  ControlAccessRequest,
  ControlAppUse,
  ControlBrowser,
  ControlJob,
} from "@agenteschat/adapters/runner-control";
import { joinNames } from "@agenteschat/client/lib/format";
import { Button, Icon, Kbd, normalizeAppearance, PixelSpinner, Segmented } from "@agenteschat/ui";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import { saidText, toolWords } from "../control/activity";
import {
  appUsesOf,
  BROWSER_NOTIFY_PREF,
  browserRowState,
  browsersOf,
  helpRequestKeys,
  newHelpRequests,
  siteLink,
} from "../control/browser";
import { ControlError } from "../control/client";
import { MENU_BAR_PREF, menuBarShown } from "../control/dock";
import { hereBanner, hereLine, isHereServer, type LocalServerStatus } from "../control/local-server";
import { menuLabels } from "../control/menu-labels";
import { NOTCH_PREF } from "../control/notch";
import { SITE_NOTIFY_PREF } from "../control/notify";
import { nextOffer, PAIR_OFFER_PREF, PAIR_OFFERED_PREF, targetKey } from "../control/pair";
import { combinedPause, extendPause, type PauseChoice, pauseUntil } from "../control/pause";
import { askKey, PERMISSION_ASK_PREF, PREPARE_PREF, permissionAsks } from "../control/permissions";
import {
  homeServer,
  type ServerList,
  type ServerWorkspaces,
  serverName,
  type VersionProblem,
  versionProblem,
} from "../control/server";
import { type Home, isIncompatible, isRefusedHome, orgName, pairedHomes } from "../control/store";
import { answerThisMac, type PrefsTab, whenHostHomeReady } from "../control/this-mac";
import { isOnline, macStateOf, trayStateOf } from "../control/tray";
import { AUTO_UPDATE_PREF, autoUpdateOn, installNight } from "../control/version";
import { agentOf, readPref, useLocalServer, useOnShown, usePending, useUpdateCheck, writePref } from "../hooks";
import type { BadgeCounts } from "../host/types";
import { AgentFace, Banner, BrandFace, Count, HelpLink, MacPortrait, MenuRow, OrgTile } from "../ui/bits";
import { CopyDetails } from "../ui/here";
import { needsPrepare } from "../ui/permissions";
import { useToast } from "../ui/Toast";
import { baseName, clock, shortPath, since } from "../ui/time";

const POP_WIDTH = 360;
/** Transparent margin around the card, so its shadow (`.dk-pop`) isn't cut by the window's edge. */
const POP_PAD = { x: 22, top: 6, bottom: 34 };
const POP_PADDING = `${POP_PAD.top}px ${POP_PAD.x}px ${POP_PAD.bottom}px`;

export function Popover() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const update = useUpdateCheck(true);
  const [pauseMenu, setPauseMenu] = useState(false);
  /** Which workspace's choices are open in the pause menu: "all" or a home's id. */
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  const [pending, run] = usePending<"resume" | "reconnect" | "plus">();
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLElement>(null);
  const bodyEnd = useRef<HTMLSpanElement>(null);
  const [more, setMore] = useState(false);

  const homes = pairedHomes(snap);
  const pause = combinedPause(homes.map((h) => h.status?.paused ?? { paused: false }));
  const pausedHomes = homes.filter((h) => h.status?.paused?.paused);
  const allPaused = pausedHomes.length === homes.length;
  const allOffline = homes.length > 0 && homes.every((h) => !isOnline(h));
  const jobs = homes.flatMap((h) => h.jobs);
  const runningJobs = useRef(0);
  runningJobs.current = jobs.length;
  const requests = homes.flatMap((h) => h.requests.map((r) => ({ home: h, request: r })));
  const picks = homes.filter((h) => h.pick);
  const incompatible = snap.homes.some(isIncompatible);
  const refused = homes.find(isRefusedHome);
  const outdated = homes.some((h) => h.status?.connection === "outdated");
  const machine = homes.find((h) => h.status?.machine)?.status?.machine?.name ?? t("desktop.tray.label");
  const [list, setList] = useState<ServerList>({ current: null, servers: [] });
  const [counts, setCounts] = useState<BadgeCounts>({ waiting: 0, unread: 0 });
  const local = useLocalServer();
  const localRuns = useRef(false);
  localRuns.current = local.run;
  const current = list.current;
  const readList = () =>
    void host
      .servers()
      .then(setList)
      .catch(() => {});
  useEffect(readList, [host]);
  useEffect(() => host.onBadge(setCounts), [host]);
  // The server open now, checked again each time the popover shows (the cover says it as the server opens).
  const [tooOld, setTooOld] = useState<VersionProblem | null>(null);
  useEffect(() => {
    if (!current) {
      setTooOld(null);
      return;
    }
    const ask = () =>
      void host
        .checkServer(current)
        .then((c) => setTooOld(versionProblem(c)))
        .catch(() => {});
    ask();
    return host.onShown((name) => {
      if (name === "popover") ask();
    });
  }, [host, current]);
  // The server here's address moves with reach: the list again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when its address or whether it runs changes
  useEffect(readList, [local.publicUrl, local.run]);

  // The server here's sync made a home: its first tools once its runner is up.
  useEffect(() => host.onNewHostHome((homeId) => whenHostHomeReady(store, homeId)), [host, store]);
  // Signed in to a workspace this computer doesn't work for yet: its card, once, in the welcome window.
  const workspacesSeen = useRef<ServerWorkspaces[] | null>(null);
  useEffect(
    () =>
      host.onWorkspaces(() => {
        void host
          .workspaces()
          .then((list) => {
            const before = workspacesSeen.current;
            workspacesSeen.current = list;
            const offered = readPref<string[]>(PAIR_OFFERED_PREF, []);
            const offer = nextOffer(list, before, store.getSnapshot(), offered);
            if (!offer) return;
            writePref(PAIR_OFFERED_PREF, [...offered, targetKey(offer)]);
            writePref(PAIR_OFFER_PREF, offer);
            return host.showWindow("welcome");
          })
          .catch(() => {});
      }),
    [host, store],
  );
  // One of its homes was refused by its organization (its token): the next sync asks for a new one, once a
  // while per organization.
  const rotated = useRef(new Map<string, number>());
  const refusedHere = homes
    .filter((h) => isRefusedHome(h) && !!local.url && homeServer(h) === local.url)
    .flatMap((h) => (h.status?.org?.id ? [h.status.org.id] : []))
    .filter((org) => Date.now() - (rotated.current.get(org) ?? 0) > 10 * 60_000);
  const refusedKey = refusedHere.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of refused homes changes
  useEffect(() => {
    if (refusedHere.length === 0) return;
    for (const org of refusedHere) rotated.current.set(org, Date.now());
    void host.syncLocalHomes(refusedHere).catch(() => {});
  }, [host, refusedKey]);

  // The tray icon follows the aggregate state.
  const tray = trayStateOf(homes, update.state.available || update.state.required || outdated);
  useEffect(() => {
    void host.setTrayState(tray).catch(() => {});
  }, [host, tray]);

  // On a Mac the menu bar icon shows while this computer works for agents or runs agentes.chat, unless the
  // person chose.
  const works = homes.length > 0;
  const busyHere = works || local.run;
  const [menuBarPref, setMenuBarPref] = useState(() => readPref<boolean | null>(MENU_BAR_PREF, null));
  const iconShown = menuBarShown(menuBarPref, busyHere);
  useEffect(() => {
    void host.setTrayVisible(iconShown, menuBarPref === false).catch(() => {});
  }, [host, iconShown, menuBarPref]);

  // The notch window lives only while it's on (Preferências → Geral): this window starts with the app.
  useEffect(() => {
    if (readPref(NOTCH_PREF, false)) void host.setNotch(true).catch(() => {});
  }, [host]);

  // An agent asking for help in its browser: a macOS notification, if the person turned it on
  // (Preferências → Geral; off by default). Requests already there at start don't notify.
  const statuses = homes.map((h) => h.status);
  const helpKeys = [...helpRequestKeys(statuses)].sort().join("|");
  const notified = useRef<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of requests changes
  useEffect(() => {
    if (notified.current === null) {
      notified.current = helpRequestKeys(statuses);
      return;
    }
    const fresh = newHelpRequests(notified.current, statuses);
    notified.current = helpRequestKeys(statuses);
    if (fresh.length === 0 || !readPref(BROWSER_NOTIFY_PREF, false)) return;
    for (const r of fresh) {
      const home = homes.find((h) => h.status === r.status);
      const agent = agentOf(home, { id: r.agentId, name: t("desktop.tray.browser.someAgent") });
      const body = [r.status.org?.name, r.request].filter(Boolean).join(" · ");
      void host.notify(t("desktop.tray.browser.notifTitle", { agent: agent.name }), body).catch(() => {});
    }
  }, [helpKeys]);

  // An OS permission an agent's work waits on here: the welcome window asks for it, once per new wait.
  const asks = permissionAsks(homes);
  const askKeys = asks.map(askKey).sort().join("|");
  const asked = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of waits changes
  useEffect(() => {
    const now = new Set(asks.map(askKey));
    const fresh = [...now].some((k) => !asked.current.has(k));
    asked.current = now;
    if (!fresh) return;
    writePref(PERMISSION_ASK_PREF, true);
    void host.showWindow("welcome").catch(() => {});
  }, [askKeys]);
  const openAsk = () => {
    writePref(PERMISSION_ASK_PREF, true);
    void host.showWindow("welcome").catch(() => {});
  };

  // "há 2 min" stays true.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Preferences › Updates › "Install updates by itself, at night": the update the check found installs in the
  // night's window once no agent works on this Mac, with "Update and reopen"'s path (its rollback included). A
  // night's try is made once: one that fails or finds nothing waits for the next night.
  const triedNight = useRef<string | null>(null);
  useEffect(() => {
    const night = installNight(new Date(now));
    if (!night || triedNight.current === night || !update.state.available || jobs.length > 0) return;
    if (!autoUpdateOn(readPref<boolean | null>(AUTO_UPDATE_PREF, null))) return;
    triedNight.current = night;
    void host.installUpdate().catch(() => {});
  }, [now, update.state.available, jobs.length, host]);

  // The menu's Quit asking here: the show it brings must not clear the question it shows for.
  const quitOnShow = useRef(false);
  useOnShown("popover", () => {
    setPauseMenu(false);
    setPauseFor(null);
    setConfirmQuit(quitOnShow.current);
    quitOnShow.current = false;
    setNow(Date.now());
    readList();
  });
  // Preferences changes these two in its own window: read them again when this one is in front.
  useEffect(() => {
    const reread = () => {
      setMenuBarPref(readPref<boolean | null>(MENU_BAR_PREF, null));
      readList();
    };
    window.addEventListener("storage", reread);
    return () => window.removeEventListener("storage", reread);
  });

  // The window follows the card's height, which `.dk-pop` caps. Its layout height: the drawn box is smaller
  // while the card's entrance animation scales it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the new card after switching views
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      void host.resize(POP_WIDTH + POP_PAD.x * 2, el.offsetHeight + POP_PAD.top + POP_PAD.bottom).catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [host, confirmQuit]);

  // The middle's end out of sight: it fades out at the bottom, so what's below reads as more to scroll to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the new middle after switching views
  useEffect(() => {
    const end = bodyEnd.current;
    if (!end || typeof IntersectionObserver === "undefined") return;
    // Crossings queued before the callback runs arrive together, oldest first.
    const io = new IntersectionObserver((entries) => setMore(entries.at(-1)?.isIntersecting === false), {
      root: end.parentElement,
    });
    io.observe(end);
    return () => io.disconnect();
  }, [works, confirmQuit]);

  // The site in the main window asking this Mac (ADR 0036): the popover owns the runners, so it answers.
  useEffect(() => {
    const off = host.onThisMac((id, request) => {
      const openPrefsOn = async (tab: PrefsTab) => {
        writePref("prefsTab", tab);
        await host.showWindow("prefs");
      };
      const showRequests = () => host.showWindow("popover");
      const localDir = () => host.localServer().then((s) => s.dir);
      const revealFolder = (path: string) => host.revealFolder(path);
      // Its agents work while the app runs; on a Mac, the permissions they need next, up front.
      const onPaired = (org: string) => {
        void host.setAutostart(true).catch(() => {});
        if (request.kind !== "connect") return;
        void needsPrepare(host)
          .then((needed) => {
            if (!needed) return;
            writePref(PREPARE_PREF, { org, server: request.origin });
            return host.showWindow("welcome");
          })
          .catch(() => {});
      };
      answerThisMac(
        {
          store,
          openPrefs: openPrefsOn,
          showRequests,
          localDir,
          revealFolder,
          onPaired,
          openPrivacy: (pane) => host.openPrivacy(pane),
        },
        request,
      )
        .then(
          (data) => host.thisMacReply(id, true, data ?? null),
          (err: unknown) => host.thisMacReply(id, false, err instanceof Error ? err.message : String(err)),
        )
        .catch(() => {});
    });
    // Requests the site sent while this window was starting were waiting for this (main_window.rs).
    void host.thisMacListening().catch(() => {});
    return off;
  }, [host, store]);

  // The site's notifications, unless the person turned them off (Preferences › General).
  useEffect(() => {
    void host.setSiteNotify(readPref(SITE_NOTIFY_PREF, true)).catch(() => {});
  }, [host]);

  // The menus and the pairing dialog in the app's language (menus.rs); the choices the popover owns come back here.
  useEffect(() => {
    void host.setAppMenu(menuLabels(t)).catch(() => {});
  }, [host, t]);
  const pauseRef = useRef<(choice: PauseChoice | "resume") => void>(() => {});
  useEffect(
    () =>
      host.onMenuAction((action) => {
        if (action === "updates" || action === "thisMac" || action === "servers") {
          if (action !== "thisMac") writePref("prefsTab", action);
          void host.showWindow("prefs").catch(() => {});
        } else if (action === "pause1h" || action === "pauseTomorrow" || action === "pauseManual") {
          pauseRef.current(action === "pause1h" ? "1h" : action === "pauseTomorrow" ? "tomorrow" : "manual");
        } else if (action === "resume") {
          pauseRef.current("resume");
        } else if (action === "hereRestart") {
          // The Mac's Servers › this computer's server › Restart (menus.rs).
          void host.restartLocalServer().catch(() => {});
        } else if (action === "quit" && runningJobs.current === 0 && !localRuns.current) {
          // Nothing running on this Mac: quits at once, like any Mac app.
          void host.quit().catch(() => {});
        } else if (action === "quit") {
          // Agents working here: ask first. From the menu the popover isn't in front, and it hides as soon as another
          // window takes focus (a window manager that focuses under the pointer hides it at once): the system's own
          // dialog asks instead. The popover's question when the system can't ask.
          void host
            .askQuit({
              title: t("desktop.tray.quitTitle"),
              body: localRuns.current ? t("desktop.tray.quitHereBody") : t("desktop.tray.quitBody"),
              quit: t("desktop.tray.quitConfirm"),
              cancel: t("desktop.common.cancel"),
            })
            .catch(() => {
              quitOnShow.current = true;
              setConfirmQuit(true);
              void host.showWindow("popover").catch(() => {});
            });
        } else {
          void host.showWindow("popover").catch(() => {});
        }
      }),
    [host, t],
  );

  /** Asks first only while agents work here or agentes.chat runs here; otherwise quits at once, like any app. */
  const quit = () => {
    if (busyHere) setConfirmQuit(true);
    else void host.quit().catch(() => {});
  };

  /** The main window on the server open now; the first run while there is none. */
  const openMain = () => {
    void (current ? host.openExternal(current) : host.showWindow("welcome")).catch(() => {});
    void host.hideWindow("popover").catch(() => {});
  };
  const openPrefs = (tab?: string) => {
    if (tab) writePref("prefsTab", tab);
    void host.showWindow("prefs").catch(() => {});
  };
  /**
   * "Reconnect this Mac": that organization's Computers settings in the main window, where its one-click
   * "This Mac" pairs the same home again (the same computer, with its agents and permissions).
   */
  const reconnectMac = (home: Home) => {
    const server = homeServer(home);
    const orgId = home.status?.org?.id;
    if (server && orgId)
      void host.openExternal(`${server}/org/${encodeURIComponent(orgId)}/settings/computers`).catch(() => {});
    void host.hideWindow("popover").catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmQuit) setConfirmQuit(false);
        else if (pauseMenu) setPauseMenu(false);
        else void host.hideWindow("popover").catch(() => {});
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        openMain();
      } else if (k === ",") {
        e.preventDefault();
        openPrefs();
      } else if (k === "q") {
        e.preventDefault();
        quit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Pauses every workspace's agents here, or only `home`'s. */
  const doPause = async (choice: PauseChoice, home?: Home) => {
    setPauseMenu(false);
    setPauseFor(null);
    const request = { type: "pause", until: pauseUntil(choice) } as const;
    try {
      await (home ? store.request(home.homeId, request) : store.requestAll(request));
      toast(
        t(
          choice === "1h"
            ? "desktop.tray.pausedFor1h"
            : choice === "tomorrow"
              ? "desktop.tray.pausedTomorrow"
              : "desktop.tray.pausedManual",
        ),
        "pause",
      );
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  const doResume = async () => {
    try {
      await store.requestAll({ type: "resume" });
      toast(t("desktop.tray.resumed"), "play");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  /** Drops every organization's connection and opens it again at once (a stuck or half-open one). */
  const doReconnect = async () => {
    try {
      await store.requestAll({ type: "reconnect" });
      toast(t("desktop.tray.reconnecting"), "refresh");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };
  const resume = () => void run("resume", doResume);
  const reconnect = () => void run("reconnect", doReconnect);
  pauseRef.current = (choice) => (choice === "resume" ? resume() : void doPause(choice));
  const plusHour = async () => {
    if (!pause) return;
    const request = { type: "pause", until: extendPause(pause) } as const;
    try {
      // Only the paused ones: the others keep working.
      await Promise.all(pausedHomes.map((h) => store.request(h.homeId, request)));
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  // A short screen lowers the card's cap (`.dk-pop`): the window, the card and its margins, opens under the menu
  // bar with nothing keeping it on screen, and the actions at its bottom have to stay there.
  const room = window.screen.availHeight - POP_PAD.top - POP_PAD.bottom;
  const shell = { padding: POP_PADDING, ...(room > 0 && { "--pop-room": `${room}px` }) } as CSSProperties;

  if (confirmQuit) {
    return (
      <div className="dk-pop-shell" style={shell}>
        <main className="dk-pop" ref={card} aria-label={t("desktop.tray.quitTitle")}>
          <div className="dk-confirm">
            <h2>{t("desktop.tray.quitTitle")}</h2>
            <p>{local.run ? t("desktop.tray.quitHereBody") : t("desktop.tray.quitBody")}</p>
            <div className="dk-confirm__foot">
              <Button variant="ghost" size="sm" onClick={() => setConfirmQuit(false)}>
                {t("desktop.common.cancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void host.quit()}>
                {t("desktop.tray.quitConfirm")}
              </Button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const mod = "⌘";
  const appRows = (
    <>
      <MenuRow
        icon="external"
        onClick={openMain}
        trailing={
          <>
            <Kbd>{mod}</Kbd>
            <Kbd>O</Kbd>
          </>
        }
      >
        {t("desktop.tray.open")}
      </MenuRow>
      <MenuRow
        icon="settings"
        onClick={() => openPrefs(update.state.available ? "updates" : undefined)}
        trailing={
          <>
            {update.state.available && <Icon name="download" size={14} />}
            <Kbd>{mod}</Kbd>
            <Kbd>,</Kbd>
          </>
        }
      >
        {t("desktop.tray.prefs")}
      </MenuRow>
    </>
  );
  const quitRow = (
    <section className="dk-psec">
      <MenuRow
        icon="stop"
        onClick={quit}
        trailing={
          <>
            <Kbd>{mod}</Kbd>
            <Kbd>Q</Kbd>
          </>
        }
      >
        {t("desktop.tray.quit")}
      </MenuRow>
    </section>
  );

  // Workspaces of other servers that use this Mac too, said under the server here's card.
  const others = homes.filter((h) => !isHereServer(local, homeServer(h)));
  const also = others.length > 0 && (
    <p className="dk-help dk-here__also">
      {others.slice(0, 2).map((h) => (
        <OrgTile key={h.homeId} logo={h.logo} size="sm" />
      ))}
      <span>
        {t("desktop.tray.alsoWorksFor", {
          orgs:
            others.length > 2
              ? t("desktop.tray.otherWorkspaces", { count: others.length })
              : joinNames(others.map(orgName), t),
        })}
      </span>
    </p>
  );
  const hereCard = local.run && <HereCard local={local} also={also} onPrefs={() => openPrefs("servers")} />;
  /** For 1 hour, Until tomorrow at 9 AM, Until I resume: for every workspace, or only `home`'s. */
  const pauseChoices = (home?: Home) => (
    <>
      <MenuRow icon="clock" onClick={() => void doPause("1h", home)}>
        {t("desktop.tray.pause1h")}
      </MenuRow>
      <MenuRow icon="calendar" onClick={() => void doPause("tomorrow", home)}>
        {t("desktop.tray.pauseTomorrow")}
      </MenuRow>
      <MenuRow icon="pause" onClick={() => void doPause("manual", home)}>
        {t("desktop.tray.pauseManual")}
      </MenuRow>
    </>
  );
  /** A workspace (or all of them) in the pause menu, its choices open under it. */
  const pauseTarget = (key: string, lead: ReactNode, label: string, home?: Home) => (
    <Fragment key={key}>
      <MenuRow
        lead={lead}
        expanded={pauseFor === key}
        onClick={() => setPauseFor((v) => (v === key ? null : key))}
        trailing={<Icon name={pauseFor === key ? "chevronDown" : "chevronRight"} size={14} />}
      >
        {label}
      </MenuRow>
      {pauseFor === key && <div className="dk-sub">{pauseChoices(home)}</div>}
    </Fragment>
  );

  // Nothing of this computer works for agents: the way into the app, and what waits there.
  if (!works) {
    return (
      <div className="dk-pop-shell" style={shell}>
        <main className="dk-pop" ref={card} aria-label={t("desktop.tray.label")}>
          <div className="dk-pop__body" data-more={more || undefined}>
            {hereCard || (
              <header className="dk-ph">
                <BrandFace size="md" />
                <span className="dk-ph__text">
                  <b>{current ? serverName(current) : t("desktop.tray.label")}</b>
                  <small>
                    {counts.waiting > 0
                      ? t("desktop.tray.waiting", { count: counts.waiting })
                      : t("desktop.tray.nothingWaiting")}
                  </small>
                </span>
              </header>
            )}
            {tooOld && current && (
              <Banner
                icon="alert"
                title={t(tooOld === "app-too-old" ? "desktop.connect.appTooOld" : "desktop.connect.serverTooOld", {
                  host: serverName(current),
                })}
                actions={
                  tooOld === "app-too-old" && (
                    <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                      {t("desktop.connect.checkUpdates")}
                    </Button>
                  )
                }
              />
            )}
            {!update.state.required && update.state.available && update.state.latest && (
              <Banner
                icon="download"
                title={t("desktop.tray.updateTitle", { version: update.state.latest.version })}
                actions={
                  <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                    {t("desktop.tray.updateSee")}
                  </Button>
                }
              />
            )}
            <span className="dk-pop__end" ref={bodyEnd} />
          </div>
          <div className="dk-pop__foot">
            <section className="dk-psec">{appRows}</section>
            {quitRow}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dk-pop-shell" style={shell}>
      <main className="dk-pop" ref={card} aria-label={t("desktop.tray.label")}>
        <div className="dk-pop__body" data-more={more || undefined}>
          {hereCard || (
            <header className="dk-ph">
              <MacPortrait state={macStateOf(homes)} />
              <span className="dk-ph__text">
                <b>{machine}</b>
                <small>
                  {[current && serverName(current), t("desktop.orgCount", { count: homes.length })]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </header>
          )}

          {tooOld && current && (
            <Banner
              icon="alert"
              title={t(tooOld === "app-too-old" ? "desktop.connect.appTooOld" : "desktop.connect.serverTooOld", {
                host: serverName(current),
              })}
              actions={
                tooOld === "app-too-old" && (
                  <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                    {t("desktop.connect.checkUpdates")}
                  </Button>
                )
              }
            />
          )}
          {incompatible && (
            <Banner icon="alert" title={t("desktop.tray.incompatibleTitle")}>
              {t("desktop.tray.incompatibleBody")}
            </Banner>
          )}
          {(update.state.required || outdated) && (
            <Banner
              icon="download"
              title={t("desktop.tray.requiredTitle")}
              actions={
                <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                  {t("desktop.tray.updateSee")}
                </Button>
              }
            >
              {t("desktop.tray.requiredBody")}
            </Banner>
          )}
          {refused && (
            <Banner
              icon="alert"
              title={t("desktop.tray.refusedTitle", { org: orgName(refused) })}
              actions={
                <>
                  <Button size="sm" variant="primary" icon="refresh" onClick={() => reconnectMac(refused)}>
                    {t("desktop.tray.reconnectMac")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openPrefs("general")}>
                    {t("desktop.tray.prefs")}
                  </Button>
                </>
              }
            >
              {t("desktop.tray.refusedBody")}
            </Banner>
          )}
          {allOffline && !refused && !outdated && (
            <Banner
              lead={<PixelSpinner size={16} />}
              title={
                navigator.onLine
                  ? t("desktop.tray.unreachable", { host: serverName(homeServer(homes[0] as Home) ?? current ?? "") })
                  : t("desktop.tray.offlineTitle")
              }
              actions={
                <Button
                  size="sm"
                  icon="refresh"
                  loading={pending === "reconnect"}
                  disabled={pending !== null}
                  onClick={reconnect}
                >
                  {t("desktop.tray.reconnect")}
                </Button>
              }
            >
              {navigator.onLine ? t("desktop.tray.unreachableBody") : t("desktop.tray.offlineBody")}
            </Banner>
          )}
          {pause && (
            <Banner
              icon="pause"
              title={
                pause.until
                  ? t("desktop.tray.pausedUntil", { time: clock(pause.until, i18n.language) })
                  : t("desktop.tray.pausedUntilResume")
              }
              actions={
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    icon="play"
                    loading={pending === "resume"}
                    disabled={pending !== null}
                    onClick={resume}
                  >
                    {t("desktop.tray.resumeNow")}
                  </Button>
                  {pause.until && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={pending === "plus"}
                      disabled={pending !== null}
                      onClick={() => void run("plus", plusHour)}
                    >
                      {t("desktop.tray.plusHour")}
                    </Button>
                  )}
                </>
              }
            >
              {allPaused
                ? t("desktop.tray.pausedBody")
                : t("desktop.tray.pausedSomeBody", { orgs: joinNames(pausedHomes.map(orgName), t) })}
            </Banner>
          )}
          {!update.state.required && update.state.available && update.state.latest && (
            <Banner
              icon="download"
              title={t("desktop.tray.updateTitle", { version: update.state.latest.version })}
              actions={
                <Button size="sm" variant="primary" onClick={() => openPrefs("updates")}>
                  {t("desktop.tray.updateSee")}
                </Button>
              }
            />
          )}

          {homes.map((h) => h.allowed && <AllowedBanner key={h.homeId} home={h} />)}

          {asks.map((a) => (
            <Banner
              key={askKey(a)}
              icon="lock"
              title={t("desktop.permissionAsk.trayTitle", {
                permission: t(`devices.permission.names.${a.need.permission}`),
              })}
              actions={
                <Button size="sm" variant="primary" onClick={openAsk}>
                  {t("desktop.pair.allow")}
                </Button>
              }
            >
              {t(`desktop.permissionAsk.why.${a.need.permission}`)}
            </Banner>
          ))}

          {requests.length + picks.length > 0 && (
            <section className="dk-psec">
              <div className="dk-pcap">
                {t("desktop.tray.requests")} <Count n={requests.length + picks.length} />
              </div>
              {picks.map((h) => (
                <PickCard key={h.homeId} home={h} now={now} />
              ))}
              {requests.map(({ home, request }) => (
                <RequestCard key={request.requestId} home={home} request={request} now={now} />
              ))}
            </section>
          )}

          <section className="dk-psec">
            <div className="dk-pcap">
              {t("desktop.tray.now")} <Count n={jobs.length} />
              {jobs.length > 0 && (
                <span className="dk-pcap__end">
                  <button type="button" className="ac-link dk-link" onClick={openMain}>
                    {t("desktop.tray.seeAll")} <Icon name="external" size={14} />
                  </button>
                </span>
              )}
            </div>
            <NowList homes={homes} paused={!!pause} now={now} />
          </section>
          <span className="dk-pop__end" ref={bodyEnd} />
        </div>

        <div className="dk-pop__foot dk-pop__foot--ruled">
          <section className="dk-psec">
            {pause && (
              <MenuRow icon="play" disabled={pending !== null} onClick={resume}>
                {t("desktop.tray.resume")}
              </MenuRow>
            )}
            {/* Some workspaces still running: each can be paused on its own. */}
            {homes.length > 0 && !allPaused && (
              <>
                <MenuRow
                  icon="pause"
                  expanded={pauseMenu}
                  onClick={() => {
                    setPauseFor(null);
                    setPauseMenu((v) => !v);
                  }}
                  trailing={<Icon name={pauseMenu ? "chevronDown" : "chevronRight"} size={14} />}
                >
                  {t("desktop.tray.pause")}
                </MenuRow>
                {pauseMenu && (
                  <div className="dk-sub">
                    {homes.length > 1 ? (
                      <>
                        {pauseTarget("all", <Icon name="layers" size={16} />, t("desktop.tray.pauseAll"))}
                        {homes
                          .filter((h) => !h.status?.paused?.paused)
                          .map((h) => pauseTarget(h.homeId, <OrgTile logo={h.logo} size="sm" />, orgName(h), h))}
                      </>
                    ) : (
                      pauseChoices()
                    )}
                    <span className="dk-help dk-sub__hint">
                      {t(local.run ? "desktop.tray.pauseHintServer" : "desktop.tray.pauseHint")}
                    </span>
                  </div>
                )}
              </>
            )}
            {homes.length > 0 && (
              <MenuRow icon="refresh" disabled={pending !== null} onClick={reconnect}>
                {t("desktop.tray.reconnect")}
              </MenuRow>
            )}
            {appRows}
          </section>
          {quitRow}
        </div>
      </main>
    </div>
  );
}

/**
 * The server here, on top: its state in a few words, Start in sight while it's stopped, `···` with Restart, Stop
 * (how long: an hour, until Start, or not with the app; ADR 0158) and Preferences (inline, as the pause menu: the
 * popover is a window of its own size), `also` (the other workspaces using this computer), and its banners: stopped
 * (Start it), not starting (why, Copy details, the logs, Try again), an update that went back (until dismissed).
 */
function HereCard({ local, also, onPrefs }: { local: LocalServerStatus; also?: ReactNode; onPrefs: () => void }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [more, setMore] = useState(false);
  const [stopMenu, setStopMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // The "went back" banner, dismissed for that version (it comes back for another one).
  const [backSeen, setBackSeen] = useState(() => readPref(BACK_SEEN_PREF, ""));
  const act = (run: () => Promise<void>) => async () => {
    setMore(false);
    setStopMenu(false);
    setBusy(true);
    try {
      await run();
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
    }
  };
  const banner = hereBanner(local);
  const running = local.phase === "running" || local.phase === "starting" || local.phase === "updating";
  const line = local.held
    ? local.heldUntil
      ? t("desktop.server.stoppedUntil", { time: clock(new Date(local.heldUntil).toISOString(), i18n.language) })
      : t("desktop.server.stoppedHeld")
    : t(hereLine(local));
  return (
    <>
      <header className="dk-ph">
        <span className="dk-logo dk-logo--soft dk-here__icon">
          <Icon name="computer" size={18} />
        </span>
        <span className="dk-ph__text">
          <b>{t("desktop.server.title")}</b>
          <small className={running && local.phase !== "running" ? "dk-shimmer" : undefined}>{line}</small>
        </span>
        {!running && (
          <Button size="sm" variant="primary" icon="play" loading={busy} onClick={act(() => host.startLocalServer())}>
            {t("desktop.server.start")}
          </Button>
        )}
        <button
          type="button"
          className="dk-iconbtn"
          aria-expanded={more}
          aria-label={t("desktop.servers.more", { host: t("desktop.server.title") })}
          onClick={() => {
            setStopMenu(false);
            setMore((v) => !v);
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </header>
      {more && (
        <div className="dk-sub dk-here__more">
          {running && (
            <>
              <MenuRow icon="refresh" disabled={busy} onClick={act(() => host.restartLocalServer())}>
                {t("desktop.server.restart")}
              </MenuRow>
              <MenuRow
                icon="stop"
                disabled={busy}
                expanded={stopMenu}
                onClick={() => setStopMenu((v) => !v)}
                trailing={<Icon name={stopMenu ? "chevronDown" : "chevronRight"} size={14} />}
              >
                {t("desktop.server.stop")}
              </MenuRow>
              {stopMenu && (
                <div className="dk-sub dk-here__stop">
                  <MenuRow icon="clock" onClick={act(() => host.stopLocalServer(false, 60))}>
                    {t("desktop.server.stopFor1h")}
                  </MenuRow>
                  <MenuRow icon="stop" onClick={act(() => host.stopLocalServer(false))}>
                    {t("desktop.server.stopUntilStart")}
                  </MenuRow>
                  {/* Not with the app any more: Preferences asks first and says where its data stays. */}
                  <MenuRow
                    icon="power"
                    onClick={() => {
                      setMore(false);
                      setStopMenu(false);
                      onPrefs();
                    }}
                  >
                    {t("desktop.server.stopForget")}
                  </MenuRow>
                  <span className="dk-help dk-sub__hint">{t("desktop.server.stopNote")}</span>
                </div>
              )}
            </>
          )}
          <MenuRow icon="settings" onClick={onPrefs}>
            {t("desktop.tray.prefs")}
          </MenuRow>
        </div>
      )}
      {also}
      {/* Stopped by the person, the header already says until when, with Start: no banner over it. */}
      {banner === "stopped" && !local.held && (
        <Banner
          icon="alert"
          title={t("desktop.server.stoppedBanner")}
          actions={
            <Button size="sm" variant="primary" icon="play" loading={busy} onClick={act(() => host.startLocalServer())}>
              {t("desktop.server.start")}
            </Button>
          }
        >
          {t("desktop.server.stoppedBody")}
        </Banner>
      )}
      {banner === "failing" && (
        <Banner
          icon="alert"
          title={t("desktop.server.failingBanner")}
          actions={
            <>
              <CopyDetails />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void host.revealFolder(logsFolder(local.dir)).catch(() => {})}
              >
                {t("desktop.server.showLogs")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="refresh"
                loading={busy}
                onClick={act(() => host.startLocalServer())}
              >
                {t("desktop.common.retry")}
              </Button>
            </>
          }
        >
          {t("desktop.server.failingWhy")} <HelpLink slug="run-on-your-computer">{t("desktop.server.help")}</HelpLink>
        </Banner>
      )}
      {banner === "back" && local.backTo !== backSeen && (
        <Banner
          icon="alert"
          title={t("desktop.server.updateBack", { version: local.backTo })}
          actions={
            <>
              <CopyDetails />
              <Button
                size="sm"
                onClick={() => {
                  writePref(BACK_SEEN_PREF, local.backTo ?? "");
                  setBackSeen(local.backTo ?? "");
                }}
              >
                {t("desktop.server.gotIt")}
              </Button>
            </>
          }
        >
          {t("desktop.server.updateBackBody")}
        </Banner>
      )}
    </>
  );
}

/** The version whose "went back" banner the person dismissed (`HereCard`). */
const BACK_SEEN_PREF = "hereBackSeen";

/** Where the server here writes its log (`logs/server.log` in its folder), with the folder's own separator. */
const logsFolder = (dir: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}logs`;

/** "Now": live jobs grouped by organization (each one has its own home on this computer). */
function NowList({ homes, paused, now }: { homes: Home[]; paused: boolean; now: number }) {
  const { t } = useTranslation();
  const rows = homes.map((h) => {
    const browsers = browsersOf(h.status);
    const uses = appUsesOf(h.status, now);
    const inBrowser = new Set(browsers.map((b) => b.agentId));
    // An agent in its browser shows once, as its browser row (its thinking is what drives it).
    const jobs = h.jobs.filter((j) => !(j.kind === "brain" && j.agent && inBrowser.has(j.agent.id)));
    return { home: h, browsers, uses, jobs };
  });
  const total = rows.reduce((n, r) => n + r.jobs.length + r.browsers.length + r.uses.length, 0);
  if (total === 0) {
    const someone = homes.flatMap((h) => h.status?.agents ?? [])[0];
    return (
      <div className="dk-empty">
        {someone ? (
          <AgentFace agent={someone} size="sm" state={paused ? "waiting" : "idle"} />
        ) : (
          <BrandFace size="sm" />
        )}
        <span className="dk-empty__text">
          <b>{paused ? t("desktop.tray.pausedEmptyTitle") : t("desktop.tray.calmTitle")}</b>
          <span>{paused ? t("desktop.tray.pausedEmptyBody") : t("desktop.tray.calmBody")}</span>
        </span>
      </div>
    );
  }
  return (
    <>
      {rows.map(({ home: h, browsers, uses, jobs }) => (
        <div key={h.homeId}>
          <div className="dk-ohead">
            <OrgTile logo={h.logo} size="sm" />
            {orgName(h)}
            <Count n={jobs.length + browsers.length + uses.length} />
            {jobs.length + browsers.length + uses.length === 0 && (
              <span className="dk-ohead__end">
                {isOnline(h) ? t("desktop.tray.nothingNow") : t("desktop.tray.waitingConnection")}
              </span>
            )}
          </div>
          {uses.map((u) => (
            <AppUseRow key={`apps:${u.agentId}`} home={h} use={u} />
          ))}
          {browsers.map((b) => (
            <BrowserRow key={`browser:${b.agentId}`} home={h} browser={b} />
          ))}
          {jobs.map((j) => (
            <JobRow key={j.id} home={h} job={j} now={now} />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * An agent in its browser: "Theo no navegador" with the
 * site and what it does, Ver and Parar; "Walter está no controle" while a person drives; "Theo
 * precisa de você" with Abrir when it asked for help.
 */
function BrowserRow({ home, browser }: { home: Home; browser: ControlBrowser }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const agent = agentOf(home, { id: browser.agentId, name: t("desktop.tray.browser.someAgent") });
  const color = normalizeAppearance(agent.look).color;
  const state = browserRowState(browser);
  const open = (path?: string) => {
    const server = homeServer(home);
    if (server) void host.openExternal(siteLink(server, path, server)).catch(() => {});
    void host.hideWindow("popover").catch(() => {});
  };
  const stop = async () => {
    setBusy(true);
    try {
      await store.request(home.homeId, { type: "browser.stop", agentId: browser.agentId });
      toast(t("desktop.tray.browser.stopped", { agent: agent.name }), "stop");
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const where = browser.host ?? t("desktop.tray.browser.noSite");
  const detail =
    state.kind === "needs"
      ? state.request
        ? `${where} · ${state.request}`
        : where
      : state.kind === "control"
        ? state.controller
          ? t("desktop.tray.browser.inControl", { person: state.controller })
          : t("desktop.tray.browser.someoneInControl")
        : browser.doing
          ? `${where} · ${t(`desktop.tray.browser.doing.${browser.doing}`)}`
          : where;

  if (confirm) {
    return (
      <div className="dk-job dk-job--browser dk-job--confirm">
        <span className="dk-job__text">
          <b>
            <span>{t("desktop.tray.browser.stopAsk", { agent: agent.name })}</span>
          </b>
          <small>{t("desktop.tray.browser.stopHint")}</small>
        </span>
        <span className="dk-job__acts">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void stop()}>
            {t("desktop.tray.browser.stopConfirm")}
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className={`dk-job dk-job--browser${state.kind === "needs" ? " dk-job--needs" : ""}`}>
      <span className="dk-job__av">
        <AgentFace agent={agent} size="sm" state={state.kind === "needs" ? "waiting" : "writing"} />
      </span>
      <span className="dk-job__text">
        <b>
          <span>
            {state.kind === "needs"
              ? t("desktop.tray.browser.needs", { agent: agent.name })
              : t("desktop.tray.browser.title", { agent: agent.name })}
          </span>
        </b>
        <small>
          {state.kind === "needs" ? <Icon name="globe" size={14} /> : <PixelSpinner size={14} color={color} />}
          <span className="dk-job__detail">{detail}</span>
        </small>
      </span>
      <span className="dk-job__acts">
        {state.kind === "needs" ? (
          <Button size="sm" variant="primary" onClick={() => open(state.link)}>
            {t("desktop.tray.browser.open")}
          </Button>
        ) : (
          <button
            type="button"
            className="dk-iconbtn"
            title={t("desktop.tray.browser.see")}
            aria-label={t("desktop.tray.browser.see")}
            onClick={() => open(state.link)}
          >
            <Icon name="external" size={14} />
          </button>
        )}
        <button
          type="button"
          className="dk-iconbtn"
          title={t("desktop.tray.browser.stop")}
          aria-label={t("desktop.tray.browser.stop")}
          onClick={() => setConfirm(true)}
        >
          <Icon name="stop" size={14} />
        </button>
      </span>
    </div>
  );
}

/**
 * An agent using one of the person's apps here (ADR 0258): "Theo está usando Mail", through the system's
 * accessibility (the person's mouse and keyboard stay theirs), with Parar: its next commands in the apps are refused.
 */
function AppUseRow({ home, use }: { home: Home; use: ControlAppUse }) {
  const { t } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const agent = agentOf(home, { id: use.agentId, name: t("desktop.tray.browser.someAgent") });
  const color = normalizeAppearance(agent.look).color;
  const stop = async () => {
    setBusy(true);
    try {
      await store.request(home.homeId, { type: "apps.stop", agentId: use.agentId });
      toast(t("desktop.tray.apps.stopped", { agent: agent.name }), "stop");
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk-job dk-job--browser">
      <span className="dk-job__av">
        <AgentFace agent={agent} size="sm" state="writing" />
      </span>
      <span className="dk-job__text">
        <b>
          <span>{t("desktop.tray.apps.title", { agent: agent.name, app: use.app })}</span>
        </b>
        <small>
          <PixelSpinner size={14} color={color} />
          <span className="dk-job__detail">{t("desktop.tray.apps.detail")}</span>
        </small>
      </span>
      <span className="dk-job__acts">
        <button
          type="button"
          className="dk-iconbtn"
          disabled={busy}
          title={t("desktop.tray.apps.stop")}
          aria-label={t("desktop.tray.apps.stop")}
          onClick={() => void stop()}
        >
          <Icon name="stop" size={14} />
        </button>
      </span>
    </div>
  );
}

function JobRow({ home, job, now }: { home: Home; job: ControlJob; now: number }) {
  const { t, i18n } = useTranslation();
  const agent = job.agent ? agentOf(home, job.agent) : null;
  const what = saidText(t, job, (iso) => clock(iso, i18n.language, new Date()));
  const color = normalizeAppearance(agent?.look).color;
  return (
    <div className="dk-job">
      <span className="dk-job__av">
        {agent ? <AgentFace agent={agent} size="sm" state="writing" /> : <BrandFace size="sm" />}
      </span>
      <span className="dk-job__text">
        <b>
          <span>{agent ? `${agent.name} · ${what}` : what}</span>
        </b>
        <small>
          <PixelSpinner size={14} color={color} />
          {job.background && <span>{t("desktop.tray.background")} ·</span>}
          {job.where && <span>{job.where}</span>}
          {job.command && <code className="dk-code-inline">{job.command}</code>}
        </small>
      </span>
      <span className="dk-job__end">{since(job.startedAt, t, now)}</span>
    </div>
  );
}

/** Its owner turned a tool on from the apps: said here until seen, with Undo (it goes off again on this computer). */
function AllowedBanner({ home }: { home: Home }) {
  const { t } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const allowed = home.allowed;
  if (!allowed) return null;
  const tool = toolWords(t, allowed.tool);
  const undo = async () => {
    setBusy(true);
    try {
      await store.request(home.homeId, { type: "tools.set", tool: allowed.tool, on: false });
      store.dismissAllowed(home.homeId);
      toast(t("desktop.tray.allowedUndone", { tool }), "check");
    } catch {
      toast(t("desktop.common.error"), "alert");
      setBusy(false);
    }
  };
  return (
    <Banner
      icon="check"
      title={t("desktop.tray.allowedTitle", { name: allowed.byName || orgName(home), tool })}
      actions={
        <>
          <Button size="sm" disabled={busy} onClick={() => void undo()}>
            {t("desktop.tray.allowedUndo")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => store.dismissAllowed(home.homeId)}>
            {t("desktop.tray.allowedOk")}
          </Button>
        </>
      }
    >
      {t("desktop.tray.allowedBody")}
    </Banner>
  );
}

/**
 * Someone asked from the apps for a folder here (`access.pick`): the person here picks it in the system's folder
 * picker, for the agent named or every agent of that organization here, or says not now. Nothing is allowed unpicked.
 */
function PickCard({ home, now }: { home: Home; now: number }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pick = home.pick;
  if (!pick) return null;
  const name = pick.byName || orgName(home);
  const agent = pick.agentId ? agentOf(home, { id: pick.agentId, name: pick.agentName ?? "" }) : null;
  // Answered (or the picker closed): the popover goes on hiding when it loses focus, as it does when opened by hand.
  const answered = () => void host.showWindow("popover").catch(() => {});
  const choose = async () => {
    setBusy(true);
    try {
      const path = await host.pickFolder().catch(() => null);
      answered();
      if (!path) return;
      const agents = agent ? [agent.id] : (home.status?.agents ?? []).map((a) => a.id);
      await store.request(home.homeId, { type: "folders.add", path, agents });
      store.dismissPick(home.homeId);
      const folder = baseName(path);
      toast(
        agent ? t("desktop.tray.allowedOne", { folder, agent: agent.name }) : t("desktop.tray.allowedAll", { folder }),
        "check",
      );
    } catch (err) {
      toast(
        err instanceof ControlError && ["invalid_path", "not_found", "bad_request"].includes(err.code)
          ? t("desktop.tray.answerFailed", { message: err.message })
          : t("desktop.common.error"),
        "alert",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk-banner dk-req">
      <div className="dk-req__who">
        {agent ? <AgentFace agent={agent} size="sm" state="waiting" /> : <OrgTile logo={home.logo} size="sm" />}
        <span className="dk-req__whotext">
          <b>
            {agent
              ? t("desktop.tray.pickTitleAgent", { name, agent: agent.name })
              : t("desktop.tray.pickTitle", { name })}
          </b>
          <small>
            {agent && <OrgTile logo={home.logo} size="sm" />}
            {orgName(home)} · {since(pick.at, t, now)}
          </small>
        </span>
      </div>
      <div className="dk-req__quote">{t("desktop.tray.pickBody")}</div>
      <div className="dk-banner__acts">
        <Button size="sm" variant="primary" icon="drive" loading={busy} onClick={() => void choose()}>
          {t("desktop.tray.pickChoose")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            store.dismissPick(home.homeId);
            answered();
          }}
        >
          {t("desktop.tray.deny")}
        </Button>
      </div>
    </div>
  );
}

/** An agent asks for a folder: Liberar (this agent or all) or Agora não. The click is on the machine. */
function RequestCard({ home, request, now }: { home: Home; request: ControlAccessRequest; now: number }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const [scope, setScope] = useState<"agent" | "all">("agent");
  const [busy, setBusy] = useState(false);
  const agent = agentOf(home, request.agent);
  const folder = baseName(request.path);
  const answer = async (decision: "granted" | "denied") => {
    setBusy(true);
    try {
      await store.request(home.homeId, { type: "access.answer", requestId: request.requestId, decision, scope });
      // Raised for this request (`raisePick`), the popover was kept up: answered, it hides on focus loss again.
      void host.showWindow("popover").catch(() => {});
      toast(
        decision === "denied"
          ? t("desktop.tray.denied", { agent: agent.name })
          : scope === "all"
            ? t("desktop.tray.allowedAll", { folder })
            : t("desktop.tray.allowedOne", { folder, agent: agent.name }),
        decision === "denied" ? "close" : "check",
      );
    } catch (err) {
      // The computer says why (the folder is gone, is a system folder, too many folders): the person can act on it.
      toast(
        err instanceof ControlError && ["invalid_path", "not_found", "bad_request"].includes(err.code)
          ? t("desktop.tray.answerFailed", { message: err.message })
          : t("desktop.common.error"),
        "alert",
      );
      setBusy(false);
    }
  };
  const options = useMemo(
    () => [
      { value: "agent" as const, label: t("desktop.tray.onlyAgent", { agent: agent.name }) },
      { value: "all" as const, label: t("desktop.tray.allAgents") },
    ],
    [t, agent.name],
  );
  return (
    <div className="dk-banner dk-req">
      <div className="dk-req__who">
        <AgentFace agent={agent} size="sm" state="waiting" />
        <span className="dk-req__whotext">
          <b>{t("desktop.tray.wantsFolder", { agent: agent.name })}</b>
          <small>
            <OrgTile logo={home.logo} size="sm" />
            {orgName(home)} · {since(request.at, t, now)}
          </small>
        </span>
      </div>
      {request.reason && <div className="dk-req__quote">“{request.reason}”</div>}
      <div className="dk-req__fold">
        <span className="dk-logo dk-logo--soft">
          <Icon name="drive" size={16} />
        </span>
        <span className="dk-req__foldtext">
          <b>{folder}</b>
          <span className="dk-path">{shortPath(request.path)}</span>
        </span>
      </div>
      <div className="dk-req__for">
        {t("desktop.tray.allowFor")}
        <Segmented
          size="sm"
          label={t("desktop.tray.allowFor")}
          value={scope}
          onValueChange={setScope}
          options={options}
        />
      </div>
      <div className="dk-banner__acts">
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void answer("granted")}>
          {t("desktop.tray.allow")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer("denied")}>
          {t("desktop.tray.deny")}
        </Button>
      </div>
    </div>
  );
}
