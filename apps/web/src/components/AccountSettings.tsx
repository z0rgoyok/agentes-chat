import {
  type AgentStyle,
  ApiError,
  keys,
  useAiAccounts,
  useSetAgentStyle,
  useSetShowActivity,
} from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import {
  authErrorText,
  emailChangeRefusal,
  errorCode,
  errorText,
  REAUTH_SIGN_IN,
} from "@agenteschat/client/lib/errors";
import { CODE_LENGTH, typedCode } from "@agenteschat/client/lib/join-requests";
import { browserTimezone, isTimeZone, timezoneName, zoneDisplayName } from "@agenteschat/client/lib/routines";
import { isEmail } from "@agenteschat/client/lib/text";
import {
  AffixInput,
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  PlanMeter,
  ProviderLogo,
  Segmented,
  Switch,
  useNow,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import type { AuthResult } from "@/auth/client";
import { useAuth } from "@/auth/context";
import { AppIconDialog, AppIconPicture, useAppIcon, useAppIconName } from "@/components/AppIconPicker";
import { ChangeAvatarDialog } from "@/components/AvatarBuilder";
import { ChatLookSettings } from "@/components/ChatLookSettings";
import { DeleteWorkspaceDialog } from "@/components/DeleteWorkspace";
import { PrefRow } from "@/components/NoticePrefs";
import { OpenOnPhoneDialog } from "@/components/OpenOnPhone";
import { useOrg } from "@/components/org-context";
import { MyFace } from "@/components/ProfilePhoto";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useDirectory } from "@/hooks/useDirectory";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import { localePatch, rememberLocale } from "@/i18n";
import { picksAppIcon } from "@/lib/app-icon";
import { type MenuLook, menuLook, onMenuLookChange, setMenuLook } from "@/lib/context-menu";
import { inDesktopApp } from "@/lib/desktop";
import { useOpenParam } from "@/lib/open-param";
import { ownPlanLines, planMeterText } from "@/lib/plan-usage";
import { onSoundChoiceChange, type SoundChoice, setSoundChoice, soundChoice } from "@/lib/sounds";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { LanguageSelect } from "./LanguageSelect";

/**
 * Configurações › Sua conta: your profile in this workspace, your time zone, whether agents' work shows under their replies,
 * how agents talk to you (ADR 0147), opening the phone app and a password
 * for an account without one, your plans' limits (ADR 0063 §5), how conversations look to you, then what this device keeps for itself (theme,
 * the app icon (ADR 0179), language, sounds, the desktop app's menus), and last, deleting the account.
 */
export function AccountSection() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const api = useApi();
  const plans = ownPlanLines(t, useAiAccounts(org.id).data, dir.agents, me.user.id);
  const showActivity = useSetShowActivity(org.id);
  const agentStyle = useSetAgentStyle(org.id);
  const toast = useToast();
  // Looking at your plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  const theme = useTheme();
  const look = useSyncExternalStore(onMenuLookChange, menuLook, () => "ours" as const);
  const sounds = useSyncExternalStore(onSoundChoiceChange, soundChoice, soundChoice);
  const [profile, setProfile] = useState<"name" | "timezone" | null>(null);
  const [phone, setPhone] = useState(false);
  const icon = useAppIcon();
  const iconName = useAppIconName(icon);
  const [iconPicker, setIconPicker] = useState(false);
  // The e-mail, adding a password and deleting the account: their dialogs are the account button's, kept in the address
  // so a sign-in again comes back to them.
  const [, setAccount] = useOpenParam("account");
  const owner = org.role === "owner";
  const [deletingOrg, setDeletingOrg] = useState(false);
  const mine = dir.memberById.get(me.user.id);
  const zone = mine?.timezone || browserTimezone() || "UTC";
  return (
    <>
      <Card aria-label={t("shell.profile")}>
        <div className="settings-rows">
          <PrefRow
            id="account-profile"
            lead={<MyFace className="settings-row__face" />}
            label={t("shell.profile")}
            status={t("shell.profileHint")}
            onOpen={() => setProfile("name")}
          />
          <PrefRow
            id="account-email"
            icon="mail"
            label={t("shell.email.label")}
            status={me.user.email}
            onOpen={() => setAccount("email")}
          />
          <PrefRow
            id="account-zone"
            icon="clock"
            label={t("shell.timezone")}
            status={zoneDisplayName(zone, i18n.language) ?? timezoneName(zone, i18n.language)}
            onOpen={() => setProfile("timezone")}
          />
          <PrefRow
            id="account-activity"
            icon="layers"
            label={t("settings.account.activity")}
            hint={t("settings.account.activityHelp")}
            control={
              <Switch
                checked={org.showActivity === true}
                onCheckedChange={(on) =>
                  showActivity.mutate(on, { onError: () => toast.show(t("settings.account.activityFailed")) })
                }
                aria-label={t("settings.account.activity")}
              />
            }
          />
          {/* A server from before the choice sends no `agentStyle` and can't keep one. */}
          {org.agentStyle !== undefined && (
            <PrefRow
              id="account-agent-style"
              icon="message"
              label={t("settings.account.agentStyle")}
              hint={t("settings.account.agentStyleHelp")}
              control={
                <Segmented
                  size="sm"
                  label={t("settings.account.agentStyle")}
                  value={org.agentStyle ?? "simple"}
                  onValueChange={(v) =>
                    agentStyle.mutate(v as AgentStyle, {
                      onError: () => toast.show(t("settings.account.activityFailed")),
                    })
                  }
                  options={[
                    { value: "simple", label: t("settings.account.agentStyleSimple") },
                    { value: "technical", label: t("settings.account.agentStyleTechnical") },
                  ]}
                />
              }
            />
          )}
          <PrefRow
            id="account-phone"
            icon="phone"
            label={t("shell.openOnPhone")}
            status={t("shell.openOnPhoneHint")}
            onOpen={() => setPhone(true)}
          />
          <PrefRow
            id="account-password"
            icon="key"
            label={t(me.user.hasPassword === false ? "shell.addPassword" : "shell.newPassword")}
            status={t(me.user.hasPassword === false ? "shell.addPasswordHint" : "shell.newPasswordRow")}
            onOpen={() => setAccount("password")}
          />
        </div>
      </Card>
      {plans.length > 0 && (
        <Card aria-labelledby="account-plans">
          <CardHeader id="account-plans" title={t("settings.account.plans")} />
          <div className="settings-rows">
            {plans.map((p) => (
              <PrefRow
                key={p.key}
                id={`account-plan-${p.key}`}
                lead={<ProviderLogo id={p.logo} size="sm" />}
                label={p.name}
                status={<PlanMeter compact usage={p.usage} text={planMeterText(t, i18n.language)} />}
                onOpen={() =>
                  void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } })
                }
              />
            ))}
          </div>
        </Card>
      )}
      {/* A server from before the choice sends no `chatPrefs` and can't keep one. */}
      {org.chatPrefs !== undefined && <ChatLookSettings />}
      <Card aria-labelledby="account-device">
        <CardHeader id="account-device" title={t("settings.account.device")} />
        <div className="settings-rows">
          <PrefRow
            id="account-theme"
            icon="bulb"
            label={t("shell.theme")}
            control={
              <Segmented
                size="sm"
                label={t("shell.theme")}
                value={theme.preference}
                onValueChange={(v) => theme.setPreference(v as ThemePreference)}
                options={[
                  { value: "system", label: t("shell.themeSystem") },
                  { value: "light", label: t("shell.themeLight") },
                  { value: "dark", label: t("shell.themeDark") },
                ]}
              />
            }
          />
          {picksAppIcon() && (
            <PrefRow
              id="account-app-icon"
              lead={<AppIconPicture pick={icon} className="settings-row__app-icon" />}
              label={t("appIcon.title")}
              status={iconName}
              onOpen={() => setIconPicker(true)}
            />
          )}
          <PrefRow
            id="account-language"
            icon="globe"
            label={t("shell.language")}
            control={
              <LanguageSelect
                signedIn
                align="end"
                onPick={(choice) =>
                  void api.account.updateMe(localePatch(choice)).catch(() => rememberLocale(choice, true))
                }
              />
            }
          />
          <PrefRow
            id="account-sounds"
            icon="sound"
            label={t("shell.sounds")}
            control={
              <Segmented
                size="sm"
                label={t("shell.sounds")}
                value={sounds}
                onValueChange={(v) => setSoundChoice(v as SoundChoice)}
                options={[
                  { value: "tactile", label: t("shell.soundTactile") },
                  { value: "sky", label: t("shell.soundSky") },
                  { value: "pixel", label: t("shell.soundPixel") },
                  { value: "off", label: t("shell.soundOff") },
                ]}
              />
            }
          />
          {inDesktopApp() && (
            <PrefRow
              id="account-look"
              icon="pointer"
              label={t("contextMenu.look")}
              control={
                <Segmented
                  size="sm"
                  label={t("contextMenu.look")}
                  value={look}
                  onValueChange={(v) => setMenuLook(v as MenuLook)}
                  options={[
                    { value: "ours", label: t("contextMenu.lookOurs") },
                    { value: "system", label: t("contextMenu.lookSystem") },
                  ]}
                />
              }
            />
          )}
        </div>
        <AppIconDialog open={iconPicker} onClose={() => setIconPicker(false)} />
      </Card>
      <Card aria-labelledby="account-delete" className="settings-danger">
        <CardHeader
          id="account-delete"
          icon="trash"
          title={t(owner ? "deleteAccount.card.title" : "deleteAccount.menu")}
        />
        <div className="danger-pair">
          <div className="danger-pair__way">
            <p className="small muted">{t("deleteAccount.card.text")}</p>
            <Button size="sm" variant="danger" onClick={() => setAccount("delete")}>
              {t("deleteAccount.menu")}
            </Button>
          </div>
          {owner && (
            <div className="danger-pair__way">
              <p className="small muted">{t("deleteOrg.card.text", { name: org.name })}</p>
              <Button size="sm" variant="danger" onClick={() => setDeletingOrg(true)}>
                {t("deleteOrg.card.title")}
              </Button>
            </div>
          )}
        </div>
        {owner && <DeleteWorkspaceDialog org={org} open={deletingOrg} onClose={() => setDeletingOrg(false)} />}
      </Card>
      <ProfileDialog focus={profile} onClose={() => setProfile(null)} />
      <OpenOnPhoneDialog open={phone} onClose={() => setPhone(false)} />
    </>
  );
}

class AuthRefused extends Error {
  constructor(readonly result: Extract<AuthResult, { ok: false }>) {
    super(result.code);
  }
}

/**
 * "E-mail": the same account under a new address (ADR 0088 §2, addendum 2026-11-13). The new address, then the code
 * emailed to the current one, or for someone who can't open that inbox a sign-in again, which comes back here with the
 * address typed (the dialog is kept in the address, `?account=email`). A current address never confirmed gets no code:
 * only the sign-in again. Then a link goes to the new address, which changes once it is opened. On a server that sends
 * no e-mail it changes at once.
 */
export function EmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  // The code's: where it went, and when another may go.
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [done, setDone] = useState<{ status: "sent" | "changed"; email: string } | null>(null);
  const [reauth, setReauth] = useState(false);
  const signInAgain = useSignInAgain(me.user.email);
  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const change = useMutation({
    mutationFn: (input: { newEmail: string; code?: string }) => api.account.changeEmail(input),
    meta: { silent: true },
    onSuccess: (r) => {
      if (r.status === "code") {
        codeOut(r.email, r.resendIn);
        setCode("");
        return;
      }
      setDone(r);
      void qc.invalidateQueries({ queryKey: keys.me });
    },
    onError: (e) => {
      // A code went out a moment ago (a reload, another tab): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "reauth.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(sent?.email ?? me.user.email, retryIn);
      if (errorCode(e)?.startsWith("reauth.code")) setCode("");
      if (errorCode(e) === REAUTH_SIGN_IN) setReauth(true);
    },
  });
  const { reset } = change;
  useEffect(() => {
    if (!open) return;
    // Back from signing in again: the address typed before it.
    const typed = sessionStore.get(STORAGE_KEYS.emailChangeAsk);
    sessionStore.remove(STORAGE_KEYS.emailChangeAsk);
    setValue(typed ?? "");
    setCode("");
    setSent(null);
    setDone(null);
    setReauth(false);
    reset();
  }, [open, reset]);
  const left = sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 ? 1000 : false);
  const newEmail = value.trim();
  const ready = sent ? code.length === CODE_LENGTH : isEmail(newEmail);
  const refused = emailChangeRefusal(change.error);
  const said = refused && refused !== "wait" ? errorText(t, change.error) : null;
  const addressError = refused === "address" ? said : null;
  // Before a code field shows (the day's codes spent), a code's refusal stands on its own.
  const codeError = refused === "code" && sent && !reauth ? said : null;
  const other = said && !addressError && !codeError ? said : null;
  const signIn = () => {
    sessionStore.set(STORAGE_KEYS.emailChangeAsk, newEmail);
    void signInAgain();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.email.title")}
      closeLabel={t("common.close")}
      width={440}
    >
      {done ? (
        <>
          <DialogBody>
            <p aria-live="polite">
              {t(done.status === "changed" ? "shell.email.changed" : "shell.email.sent", { email: done.email })}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (reauth) signIn();
            else if (ready && !change.isPending) change.mutate(sent ? { newEmail, code } : { newEmail });
          }}
        >
          <Locked when={change.isPending}>
            <DialogBody>
              <Field
                label={t("shell.email.new")}
                id="me-email"
                hint={{ name: t("common.about", { label: t("shell.email.label") }), text: t("shell.email.help") }}
                error={addressError ?? undefined}
              >
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={me.user.email}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    // Another address takes its own code.
                    setSent(null);
                    setReauth(false);
                    setCode("");
                    reset();
                  }}
                  autoFocus
                />
              </Field>
              {sent && !reauth && (
                <Field
                  label={t("proof.code")}
                  id="me-email-code"
                  example={t("proof.sent", { email: sent.email })}
                  error={codeError ?? undefined}
                  labelAside={
                    <button
                      type="button"
                      className="ac-link ac-link--muted small"
                      disabled={left > 0 || change.isPending}
                      onClick={() => change.mutate({ newEmail })}
                    >
                      {left > 0 ? t("proof.resendIn", { time: formatTimeLeft(left) }) : t("proof.resend")}
                    </button>
                  }
                >
                  <Input
                    className="ac-input--code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => {
                      setCode(typedCode(e.target.value));
                      reset();
                    }}
                    autoFocus
                  />
                </Field>
              )}
              {sent && reauth && (
                <p className="ac-iconline">
                  <Icon name="lock" size={16} />
                  <span>{t("shell.email.signInInstead")}</span>
                </p>
              )}
              {sent && (
                <p className="small">
                  <button
                    type="button"
                    className="ac-link ac-link--muted"
                    onClick={() => {
                      // Another way to prove it: what the code was refused for no longer applies.
                      setReauth((r) => !r);
                      reset();
                    }}
                  >
                    {t(reauth ? "shell.email.useCode" : "shell.email.cantOpen")}
                  </button>
                </p>
              )}
              {other && <Alert>{other}</Alert>}
            </DialogBody>
          </Locked>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            {reauth ? (
              <Button type="submit" variant="primary">
                {t("proof.signInButton")}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!ready || change.isPending} loading={change.isPending}>
                {t("shell.email.change")}
              </Button>
            )}
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** "Perfil" and "Fuso horário": my name (the account's, the same in every workspace), photo, handle and time zone here. */
export function ProfileDialog({ focus, onClose }: { focus: "name" | "timezone" | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const mine = dir.memberById.get(me.user.id);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [zone, setZone] = useState("");
  const [useOrgZone, setUseOrgZone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setName(me.user.name);
    setHandle(mine?.handle ?? "");
    setZone(mine?.timezone || browserTimezone() || "UTC");
    setUseOrgZone(false);
    setError(null);
  }, [focus, mine, me.user.name]);
  const zoneOk = useOrgZone || isTimeZone(zone.trim());
  const nameOk = name.trim() !== "";
  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() !== me.user.name) {
        const result = await auth.updateName(name.trim());
        if (!result.ok) throw new AuthRefused(result);
      }
      await api.orgs.updateMe(org.id, {
        handle: handle.trim() || undefined,
        timezone: useOrgZone ? null : zone.trim(),
      });
    },
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.members(org.id) });
      void qc.invalidateQueries({ queryKey: keys.people(org.id) });
      toast.show(t("shell.profileSaved"));
      onClose();
    },
    onError: (e) => setError(e instanceof AuthRefused ? authErrorText(t, e.result) : errorText(t, e)),
  });
  return (
    <Dialog
      open={focus !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.profileTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (zoneOk && nameOk && !save.isPending) save.mutate();
        }}
      >
        <Locked when={save.isPending}>
          <DialogBody>
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              <Avatar name={me.user.name} size="lg" imageUrl={mine?.image ?? me.user.image} />
              <span style={{ fontWeight: 600, flex: 1 }}>{t("photo.label")}</span>
              <Button size="sm" type="button" onClick={() => setAsk(true)}>
                {t("photo.change")}
              </Button>
            </div>
            <Field label={t("auth.yourName")} id="me-name" error={nameOk ? undefined : t("shell.nameEmpty")}>
              <Input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={focus === "name"}
              />
            </Field>
            <Field label={t("shell.handle")} id="me-handle">
              <AffixInput prefix="@" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </Field>
            <Field
              label={t("shell.timezone")}
              id="me-zone"
              hint={{ name: t("common.about", { label: t("shell.timezone") }), text: t("shell.timezoneHelp") }}
              error={!zoneOk ? t("shell.timezoneInvalid") : undefined}
            >
              <ZoneSelect value={zone || "UTC"} disabled={useOrgZone} onChange={setZone} />
            </Field>
            <span className="row" style={{ gap: 8, alignItems: "center" }}>
              <Checkbox id="me-zone-org" checked={useOrgZone} onCheckedChange={setUseOrgZone} />
              <label htmlFor="me-zone-org">{t("shell.useOrgZone")}</label>
            </span>
            {error && <Alert>{error}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!zoneOk || !nameOk || save.isPending}
            loading={save.isPending}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
      <ChangeAvatarDialog open={ask} onClose={() => setAsk(false)} />
    </Dialog>
  );
}
