/**
 * The iPhone setup, in the welcome window (Preferences › This Mac's Show me how, iPhone steps): the Mac does what it
 * can by itself and says what only the person can do. Xcode (or the App Store, and the step goes on once it's
 * there), the iOS platform's download, the Apple Account in Xcode, then the iPhone's own steps as it reports them
 * (plugged in and trusted, Developer Mode, UI Automation, the test helper the Mac builds). Once our phone app is in the
 * App Store, a QR opens the same steps on the iPhone.
 */
import type { ControlIphoneSetup } from "@agenteschat/adapters/runner-control";
import {
  DDIS_UPDATE,
  iosMajor,
  isIphoneWifiReason,
  PHONE_APP_IN_STORE,
  reasonText,
  tooOldVersion,
  useIphoneRestart,
  useStalled,
  XCODE_FIX_COMMAND,
  type XcodeFixStage,
  xcodeFixStage,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Icon, InfoHint, PixelSpinner, QrCode, SettingsPath } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import {
  deviceServer,
  downloadDue,
  IPHONE_SETUP_STEPS,
  type IphoneSetupStep,
  iphoneHere,
  iphoneSteps,
  iphoneStepsUrl,
} from "../control/devices";
import { pairedHomes } from "../control/store";
import { useLocalServer, useWifiIphones } from "../hooks";
import { hintFor } from "../ui/settings";
import { useToast } from "../ui/Toast";

/** How often the Mac is asked while the window is open: Xcode installed, the download's progress, a new account. */
const ASK_MS = 2000;

/** Without the QR the steps take its column too, and the tip and the way out make one footer row under them. */
const NO_QR = { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "1fr auto" };
const NO_QR_SIDE = { flexDirection: "row", alignItems: "center", justifyContent: "space-between" } as const;

export function IphoneSetup({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const local = useLocalServer();
  const home = pairedHomes(useSnapshot())[0];
  const homeId = home?.homeId;
  const [setup, setSetup] = useState<ControlIphoneSetup | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (!homeId) return;
    let live = true;
    // One ask at a time: a slow `simctl` would otherwise stack a new check every tick.
    let asking = false;
    const ask = () => {
      if (asking) return;
      asking = true;
      void store
        .request(homeId, { type: "iphone.setup" })
        .then((s) => live && setSetup(s))
        .catch(() => {})
        .finally(() => {
          asking = false;
        });
    };
    ask();
    const timer = setInterval(ask, ASK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [store, homeId]);

  const download = () => {
    if (!homeId) return;
    void store
      .request(homeId, { type: "iphone.download" })
      .then(setSetup)
      .catch(() => {});
  };
  // The Mac's own work starts by itself, once: a failed download waits for Try again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `download` only reads `homeId`, already a dependency
  useEffect(() => {
    if (!downloadDue(setup) || asked.current) return;
    asked.current = true;
    download();
  }, [setup, homeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = (app: "xcode" | "appStore") => {
    if (homeId) void store.request(homeId, { type: "iphone.open", app }).catch(() => {});
  };
  /** Developer Mode: whether Xcode opened from its causes (null: not asked), and a look at the iPhone under way. */
  const [xcodeOpened, setXcodeOpened] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [causesAsked, setCausesAsked] = useState(false);
  const check = () => {
    if (!homeId || checking) return;
    setChecking(true);
    void store
      .request(homeId, { type: "iphone.look" })
      .then(() => setChecked(true))
      .catch((err: unknown) => toast(errorText(t, err), "alert"))
      .finally(() => setChecking(false));
  };
  const openXcode = () => {
    if (homeId)
      void store
        .request(homeId, { type: "iphone.open", app: "xcode" })
        .then((r) => setXcodeOpened(r.opened))
        .catch((err: unknown) => toast(errorText(t, err), "alert"));
  };
  const [terminal, setTerminal] = useState(false);
  /** This Mac fixes its own Xcode (macOS asks for its password for `select`), or stops the fix. */
  const fixXcode = (action: "start" | "cancel", kind: "select" | "update") => {
    if (action === "start") setTerminal(false);
    if (homeId)
      void store
        .request(homeId, { type: "iphone.fixXcode", action, kind })
        .then(setSetup)
        .catch((err: unknown) => toast(errorText(t, err), "alert"));
  };

  const phone = iphoneHere(home?.status?.phones);
  const reason = phone?.state === "ready" ? undefined : phone?.reason;
  const restart = useIphoneRestart(phone ? { key: phone.serial, reason } : null);
  const { states, current, done } = iphoneSteps(setup, phone, restart === "restarting");
  const mac = home?.status?.machine;
  // The server here's home points at its loopback, which a phone can't open: its public address instead.
  const server = home ? deviceServer(home, local) : null;
  const orgId = home?.status?.org?.id;
  const platform = setup?.platform;
  const macName = mac?.name ?? "";
  const phoneName = phone ? (phone.name ?? phone.model) : "";
  const tooOld = phone?.state === "unsupported";
  // A step that sits unchanged gets what most likely holds it. A download that moves is no stall, and an iPhone below
  // iOS 17 gets nothing, nor a step whose own text already says what to do (a helper the person must act on, no team),
  // nor one over Wi-Fi: those lines are about the cable.
  const progress = platform?.state === "downloading" ? `${platform.percent ?? ""}/${platform.done ?? ""}` : "";
  const quiet =
    phone?.transport === "wifi" ||
    (tooOld && current === "connected") ||
    (current === "helper" && states.helper === "needs") ||
    (current === "account" && (!!setup?.noTeam || reason === "apple_team_missing"));
  const stalled = useStalled(
    current && !quiet
      ? [current, setup ? "" : "asking", phone?.serial, reason, platform?.state, progress].join(":")
      : null,
  );
  const [plugged, setPlugged] = useState(false);
  const looking = current === "connected" && !phone;
  const near = useWifiIphones({ server, orgId: orgId ?? null, machineId: mac?.id ?? null }, looking);
  const pickOverWifi = (serial: string) => near.pick(serial).catch((err: unknown) => toast(errorText(t, err), "alert"));
  // iPhones on this Mac's Wi-Fi that trust it, under the step that waits for a cable.
  const wifiOffer = near.available.map((p) => (
    <span key={p.serial} className="dk-ip__act dk-ip__wifi">
      <span className="ac-hintline">
        <span>{t("devices.iphone.wifi.also", { name: p.name ?? p.model })}</span>
        <InfoHint name={hintFor(t, t("devices.iphone.wifi.use"), t("devices.iphone.wifi.hint")).name}>
          {t("devices.iphone.wifi.hint")}
        </InfoHint>
      </span>
      <Button
        size="sm"
        loading={near.using === p.serial}
        disabled={near.using !== null}
        onClick={() => void pickOverWifi(p.serial)}
      >
        {t("devices.iphone.wifi.use")}
      </Button>
    </span>
  ));
  const stall = (step: IphoneSetupStep) =>
    !setup
      ? t("desktop.iphone.checkingStall")
      : t(`devices.iphone.stall.${step === "connected" && phone ? "trust" : step}`, { mac: macName });

  const found: Partial<Record<IphoneSetupStep, ReactNode>> = {
    xcode: setup?.xcode,
    tools: platform?.state === "installed" ? t("devices.system.ios", { version: platform.version }) : null,
    account: setup?.account
      ? setup.account.personal
        ? t("desktop.iphone.personalTeam", { name: setup.account.name })
        : setup.account.name
      : null,
    connected: phone
      ? t("devices.iphone.connectedDone", { name: phone.name ?? phone.model, version: phone.osVersion })
      : null,
  };
  const hints: Partial<Record<IphoneSetupStep, string>> = {
    developerMode: t("desktop.iphone.devModeHint"),
    helper: t("desktop.iphone.helperHint"),
  };
  const tip = hintFor(t, t("desktop.iphone.tip"), t("desktop.iphone.tipHint"));
  const title = (step: IphoneSetupStep) =>
    step === "account"
      ? t("desktop.iphone.account")
      : step === "xcode" && setup?.xcodeBlocked
        ? t("devices.iphone.xcodeBlockedTitle")
        : t(`devices.iphone.steps.${step}`);

  const fix = setup?.fix;
  const fixLine = (stage: XcodeFixStage, kind: "select" | "update") =>
    stage === "asking"
      ? t("devices.iphone.xcodeFix.asking", { mac: macName })
      : stage === "running"
        ? t(kind === "update" ? "devices.iphone.xcodeFix.updating" : "devices.iphone.xcodeFix.running", {
            mac: macName,
          })
        : stage === "done"
          ? t("devices.iphone.xcodeFix.done", { mac: macName })
          : stage === "missed"
            ? t("devices.iphone.xcodeFix.missed", { mac: macName })
            : stage === "still"
              ? t(
                  fix?.still === "license"
                    ? "devices.iphone.xcodeFix.stillLicense"
                    : "devices.iphone.xcodeFix.stillCommandLineTools",
                  { mac: macName },
                )
              : fix?.message
                ? t("devices.iphone.xcodeFix.failed", { mac: macName, message: fix.message })
                : t("devices.iphone.xcodeFix.failedAny", { mac: macName });
  /** Xcode installed but not in use: this Mac fixes it behind its own password window, or the Terminal way. */
  const blockedLine = (blocked: "command_line_tools" | "license"): ReactNode => {
    const stage = xcodeFixStage(fix, "select", { mayFix: true, terminal });
    if (stage === "terminal")
      return (
        <>
          {t(blocked === "license" ? "devices.iphone.xcodeLicense" : "devices.iphone.xcodeCommandLineTools", {
            mac: macName,
          })}
          <pre className="dk-ip__cmd">{XCODE_FIX_COMMAND}</pre>
          <span className="dk-ip__act">
            <Button size="sm" onClick={() => fixXcode("start", "select")}>
              {t("devices.iphone.xcodeFix.fix")}
            </Button>
          </span>
        </>
      );
    if (stage === "still")
      return (
        <>
          {fixLine(stage, "select")}
          <pre className="dk-ip__cmd">{XCODE_FIX_COMMAND}</pre>
          <span className="dk-ip__act">
            <Button size="sm" variant="primary" onClick={() => fixXcode("start", "select")}>
              {t("desktop.common.retry")}
            </Button>
          </span>
        </>
      );
    if (stage === "asking")
      return (
        <Act text={fixLine(stage, "select")}>
          <Button size="sm" onClick={() => fixXcode("cancel", "select")}>
            {t("desktop.common.cancel")}
          </Button>
        </Act>
      );
    if (stage === "running" || stage === "done") {
      const step = stage === "done" ? 3 : (fix?.step ?? 0);
      return (
        <Act text={fixLine(stage, "select")}>
          {(["select", "license", "firstLaunch"] as const).map((phase, i) => (
            <span key={phase} className="ac-iconline dk-ip__phase" data-done={i < step ? "" : undefined}>
              <Icon name={i < step ? "check" : "dash"} size={14} />
              <span>{t(`devices.iphone.xcodeFix.phases.${phase}`)}</span>
            </span>
          ))}
        </Act>
      );
    }
    return (
      <Act
        text={
          stage === "offer"
            ? t(
                blocked === "license" ? "devices.iphone.xcodeFix.license" : "devices.iphone.xcodeFix.commandLineTools",
                {
                  mac: macName,
                },
              )
            : fixLine(stage, "select")
        }
      >
        <Button size="sm" variant="primary" onClick={() => fixXcode("start", "select")}>
          {stage === "offer" ? t("devices.iphone.xcodeFix.fix") : t("desktop.common.retry")}
        </Button>
        <Button size="sm" onClick={() => setTerminal(true)}>
          {t("devices.iphone.xcodeFix.terminal")}
        </Button>
      </Act>
    );
  };
  const updating =
    setup?.fix?.kind === "update" ? xcodeFixStage(fix, "update", { mayFix: true, terminal: false }) : null;

  const checkButton = (label: string) => (
    <Button size="sm" icon="refresh" loading={checking} disabled={checking} onClick={check}>
      {label}
    </Button>
  );

  /** What the step under way says, and its one action. */
  const line = (step: IphoneSetupStep): ReactNode => {
    switch (step) {
      case "xcode":
        if (!setup) return t("desktop.iphone.checking");
        if (setup.xcodeBlocked && reason !== "xcode_too_old") return blockedLine(setup.xcodeBlocked);
        return reason === "xcode_too_old" && phone?.osVersion ? (
          <>
            {t(setup.sdk ? "devices.iphone.xcodeOld" : "devices.iphone.xcodeOldAny", {
              name: phoneName,
              version: phone.osVersion,
              major: iosMajor(phone.osVersion),
              sdk: setup.sdk,
              mac: macName,
            })}
            <code className="dk-code-inline">{DDIS_UPDATE}</code>
            <span className="dk-ip__act">
              <Button size="sm" icon="external" onClick={() => open("appStore")}>
                {t("desktop.iphone.updateXcode")}
              </Button>
              <Button
                size="sm"
                disabled={updating === "running"}
                loading={updating === "running"}
                onClick={() => fixXcode("start", "update")}
              >
                {t(
                  updating === "missed" || updating === "failed"
                    ? "desktop.common.retry"
                    : "devices.iphone.xcodeFix.update",
                )}
              </Button>
            </span>
            {updating && updating !== "offer" && <span>{fixLine(updating, "update")}</span>}
          </>
        ) : reason === "xcode_too_old" ? (
          <Act text={reasonText(t, reason)}>
            <Button size="sm" icon="external" onClick={() => open("appStore")}>
              {t("desktop.iphone.updateXcode")}
            </Button>
          </Act>
        ) : (
          <Act text={t("desktop.iphone.xcodeText")}>
            <Button size="sm" icon="external" onClick={() => open("appStore")}>
              {t("devices.iphone.getXcode")}
            </Button>
          </Act>
        );
      case "tools":
        if (platform?.state === "failed")
          return (
            <Act text={t("desktop.iphone.toolsFailed", { message: platform.message })}>
              <Button size="sm" icon="refresh" onClick={download}>
                {t("desktop.common.retry")}
              </Button>
            </Act>
          );
        if (platform?.state === "downloading")
          return (
            <span className="dk-ip__download">
              <span>
                {platform.done && platform.total
                  ? t("desktop.iphone.toolsProgress", { done: platform.done, total: platform.total })
                  : platform.percent !== null
                    ? t("desktop.iphone.toolsPercent", { percent: Math.floor(platform.percent) })
                    : t("desktop.iphone.toolsStarting")}
              </span>
              <span
                className="dk-bar"
                role="progressbar"
                aria-label={t("devices.iphone.steps.tools")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={platform.percent ?? undefined}
              >
                <span style={{ width: `${platform.percent ?? 0}%` }} />
              </span>
            </span>
          );
        return reason === "device_support" ? reasonText(t, reason) : t("desktop.iphone.toolsStarting");
      case "account":
        return (
          <Act
            text={
              setup?.noTeam || reason === "apple_team_missing"
                ? t("devices.iphone.teamMissingText")
                : t("desktop.iphone.accountText")
            }
          >
            <Button size="sm" icon="external" onClick={() => open("xcode")}>
              {t("desktop.iphone.openXcode")}
            </Button>
          </Act>
        );
      case "connected":
        return reason === "untrusted" ? (
          t("devices.iphone.trustText")
        ) : phone && isIphoneWifiReason(reason) ? (
          t(`devices.iphone.wifiState.${reason}`, { name: phoneName })
        ) : reason === "locked" ? (
          t("desktop.iphone.unlockText")
        ) : tooOld && phone ? (
          t("devices.iphone.tooOld", { name: phoneName, version: tooOldVersion(t, phone.osVersion) })
        ) : looking && !plugged && !stalled ? (
          <>
            <Act text={t("devices.iphone.connectedText", { mac: macName })}>
              <Button size="sm" onClick={() => setPlugged(true)}>
                {t("devices.iphone.pluggedIn")}
              </Button>
            </Act>
            {wifiOffer}
          </>
        ) : (
          <>
            {t("devices.iphone.connectedText", { mac: macName })}
            {wifiOffer}
          </>
        );
      case "developerMode":
        if (restart === "restarting") return t("devices.iphone.devModeRestarting");
        return (
          <>
            {restart === "back" ? t("devices.iphone.devModeBack") : t("devices.iphone.devModeText")}
            {restart !== "back" && (
              <SettingsPath
                label={t("devices.onTheIphone")}
                segments={[
                  t("devices.iphone.path.settings"),
                  t("devices.iphone.path.privacy"),
                  t("devices.iphone.path.devMode"),
                ]}
              />
            )}
            <span className="dk-ip__act">{checkButton(t("devices.iphone.devModeCheck"))}</span>
            {checked && <span>{t("devices.iphone.devModeStillOff")}</span>}
            {stalled || causesAsked ? (
              <section className="dk-ip__causes" aria-labelledby="dk-devmode-title">
                <b id="dk-devmode-title">{t("devices.iphone.devModeMissing.title")}</b>
                {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under list-style: none */}
                <ul role="list">
                  <li className="ac-actline">
                    <span>
                      {xcodeOpened
                        ? t("devices.iphone.devModeMissing.opened", { mac: macName })
                        : xcodeOpened === false
                          ? t("devices.iphone.devModeMissing.hiddenOpen", { mac: macName })
                          : t("devices.iphone.devModeMissing.hidden")}
                    </span>
                    {xcodeOpened === null && (
                      <Button size="sm" icon="external" onClick={openXcode}>
                        {t("devices.iphone.devModeMissing.openXcode")}
                      </Button>
                    )}
                  </li>
                  <li className="ac-actline">
                    <span>{t("devices.iphone.devModeMissing.unlock")}</span>
                    {checkButton(t("devices.iphone.devModeMissing.check"))}
                  </li>
                </ul>
              </section>
            ) : (
              <button type="button" className="ac-link" aria-expanded="false" onClick={() => setCausesAsked(true)}>
                {t("devices.iphone.devModeMissing.title")}
              </button>
            )}
          </>
        );
      case "uiAutomation":
        return (
          <>
            {reason === "ui_not_authorized" ? t("devices.iphone.uiRefusedText") : t("devices.iphone.uiAutomationText")}
            <SettingsPath
              label={t("devices.onTheIphone")}
              segments={[
                t("devices.iphone.path.settings"),
                t("devices.iphone.path.developer"),
                t("devices.iphone.path.uiAutomation"),
              ]}
            />
          </>
        );
      default:
        if (reason === "helper_untrusted")
          return (
            <>
              {t("devices.iphone.helperUntrustedText")}
              <SettingsPath
                label={t("devices.onTheIphone")}
                segments={[
                  t("devices.iphone.path.settings"),
                  t("devices.iphone.path.general"),
                  t("devices.iphone.path.deviceManagement"),
                ]}
              />
            </>
          );
        if (reason === "team_limit") return t("devices.iphone.teamLimitText");
        return states.helper === "active" ? t("desktop.iphone.helperBuilding") : t("desktop.iphone.helperText");
    }
  };

  return (
    <div className="dk-fr" data-screen="iphone">
      <div className="dk-fr__body">
        <h1 className="dk-fr__h1sm">{t("devices.iphone.title")}</h1>
        <p className="dk-lead dk-fr__wide">{t("desktop.iphone.lead")}</p>
        <div className="dk-ip" style={PHONE_APP_IN_STORE.ios ? undefined : NO_QR}>
          <div className="dk-ip__main">
            <ol className="dk-fr__steps" aria-label={t("desktop.iphone.progress")}>
              {IPHONE_SETUP_STEPS.map((step) => {
                const state = states[step];
                const hint = hints[step];
                return (
                  <li
                    key={step}
                    className="ac-iconline"
                    data-state={state === "needs" ? "warn" : state}
                    aria-current={step === current ? "step" : undefined}
                  >
                    <span className="dk-fr__stepmark" aria-hidden="true">
                      {state === "active" ? (
                        <PixelSpinner size={16} color="sky" />
                      ) : state === "done" ? (
                        <Icon name="check" size={16} />
                      ) : state === "needs" ? (
                        <Icon name="alert" size={16} />
                      ) : (
                        <span className="dk-fr__stepdot" />
                      )}
                    </span>
                    <span className="dk-fr__steptext">
                      <span className="dk-fr__stepname">
                        {hint ? (
                          <span className="ac-hintline">
                            <b>{title(step)}</b>
                            <InfoHint name={hintFor(t, title(step), hint).name}>{hint}</InfoHint>
                          </span>
                        ) : (
                          <b>{title(step)}</b>
                        )}
                        {state === "done" && found[step] && <small>{found[step]}</small>}
                        {state !== "todo" && (
                          <span className="ac-visually-hidden">
                            {t(`desktop.here.stepState.${state === "needs" ? "warn" : state}`)}
                          </span>
                        )}
                      </span>
                      {(step === current || (step === "helper" && state === "todo")) && (
                        <span className="dk-fr__stepline" role={step === current ? "status" : undefined}>
                          {line(step)}
                          {step === current && step !== "developerMode" && (stalled || (looking && plugged)) && (
                            <span className="dk-ip__stall ac-iconline">
                              <Icon name="info" size={14} />
                              <span>{stall(step)}</span>
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div
              className="dk-bar"
              role="progressbar"
              aria-label={t("desktop.iphone.progress")}
              aria-valuemin={0}
              aria-valuemax={IPHONE_SETUP_STEPS.length}
              aria-valuenow={done}
            >
              <span style={{ width: `${(done / IPHONE_SETUP_STEPS.length) * 100}%` }} />
            </div>
            {current === null && phone && (
              <p className="dk-ip__ready ac-iconline" role="status">
                <Icon name="check" size={16} />
                <span>{t("devices.iphone.ready", { name: phone.name ?? phone.model })}</span>
              </p>
            )}
          </div>
          <aside className="dk-ip__side" style={PHONE_APP_IN_STORE.ios ? undefined : NO_QR_SIDE}>
            {PHONE_APP_IN_STORE.ios && server && orgId && mac && (
              <div className="dk-card dk-ip__qr" data-padded="">
                <QrCode text={iphoneStepsUrl(server, orgId, mac.id)} label={t("desktop.iphone.qrLabel")} />
                <p>{t("desktop.iphone.qr")}</p>
              </div>
            )}
            <span className="dk-ip__tip ac-hintline">
              <b>{t("desktop.iphone.tip")}</b>
              <InfoHint name={tip.name}>{tip.text}</InfoHint>
            </span>
            <span className="dk-ip__acts">
              {current === null ? (
                <Button variant="primary" onClick={onClose}>
                  {t("devices.done")}
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void host.showWindow("prefs").catch(() => {});
                      onClose();
                    }}
                  >
                    {t("desktop.common.back")}
                  </Button>
                  <Button onClick={onClose}>{t("desktop.common.cancel")}</Button>
                </>
              )}
            </span>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** A step's sentence with its one button under it. */
function Act({ text, children }: { text: string; children: ReactNode }) {
  return (
    <>
      {text}
      <span className="dk-ip__act">{children}</span>
    </>
  );
}
