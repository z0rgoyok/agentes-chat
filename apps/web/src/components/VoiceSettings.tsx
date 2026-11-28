import type { LocalSpeech, SpeechKey, SpeechProvider } from "@agenteschat/client";
import {
  useInstallSpeechLocal,
  useRemoveSpeechKey,
  useRemoveSpeechLocal,
  useSaveSpeechKey,
  useSettings,
  useSpeechKey,
  useSpeechLocal,
  useUpdateSettings,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Card,
  Chip,
  Icon,
  Input,
  Locked,
  Meter,
  ProviderLogo,
  Radio,
  RadioGroup,
  SettingNote,
  Switch,
} from "@agenteschat/ui";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";

/** Who can be chosen, in the order the list shows them. Their names are the providers' own. */
const PROVIDERS: { id: SpeechProvider; name: string }[] = [
  { id: "assemblyai", name: "AssemblyAI" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "soniox", name: "Soniox" },
  { id: "groq", name: "Groq" },
  { id: "openai", name: "OpenAI" },
  { id: "deepinfra", name: "DeepInfra" },
];

/** Configurações › Voz (ADR 0100). Who configures the workspace changes it; everyone else reads it. */
export function VoiceSettingsSection() {
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const editable = can(org, "configure");
  if (!settings.data) {
    return settings.isError ? (
      <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
    ) : (
      <LoadingList count={1} avatar={false} trailing />
    );
  }
  const on = (update.isPending ? update.variables?.voiceMessages : undefined) ?? settings.data.voiceMessages;
  return (
    <VoiceSettingsCard
      on={on}
      available={settings.data.voiceAvailable}
      micAlways={settings.data.speechState !== undefined}
      editable={editable}
      onChange={(voiceMessages) => {
        if (editable) update.mutate({ voiceMessages });
      }}
    />
  );
}

/**
 * The card of Configurações › Voz (ADR 0100): the workspace's switch, and on a server that isn't agentes.chat's own, for
 * its owner, who turns voice into text (the API answers null to everyone else). A key is tried with the provider
 * before it is kept, sealed on the server and never shown again.
 */
export function VoiceSettingsCard({
  on,
  available,
  micAlways = false,
  editable,
  onChange,
}: {
  on: boolean;
  available: boolean;
  /** The server records with no engine too (`speechState`): the switch works, notes go as audio meanwhile. */
  micAlways?: boolean;
  editable: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const speech = useSpeechKey();
  const view = speech.data;
  // Asked only of the owner, who alone gets the picker (`speechKey` answers null to everyone else).
  const local = useSpeechLocal(Boolean(view));
  // With no engine, the way to one: below, for the installation's owner (the only one the picker answers), else who.
  const noEngine = view
    ? "voice.settings.noEngineHere"
    : speech.isPending
      ? "voice.settings.noEngine"
      : "voice.settings.noEngineAsk";
  return (
    <Card aria-label={t("voice.settings.title")}>
      <div className="settings-rows">
        <PrefRow
          id="media-voice-on"
          icon="mic"
          label={t("voice.settings.on")}
          hint={available ? t("voice.settings.onHelp") : undefined}
          status={!available && t(noEngine)}
          control={
            <Switch
              checked={(micAlways || available) && on}
              onCheckedChange={onChange}
              disabled={!editable || !(micAlways || available)}
              aria-label={t("voice.settings.on")}
            />
          }
        />
      </div>
      {view && local.data && <LocalSpeechChoice view={local.data} />}
      {view && <SpeechProviderPicker view={view} />}
    </Card>
  );
}

/** What turns voice into text, for the installation's owner: here and in the first press's dialog (`VoiceSetupDialog`). */
export function SpeechProviderPicker({ view, onSaved }: { view: SpeechKey; onSaved?: () => void }) {
  const { t } = useTranslation();
  const save = useSaveSpeechKey();
  const remove = useRemoveSpeechKey();
  const [provider, setProvider] = useState<SpeechProvider>(view.provider ?? "assemblyai");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const field = useId();
  const local = provider === "local";
  const name = PROVIDERS.find((p) => p.id === provider)?.name ?? "";
  const pick = (next: string) => {
    setProvider(next as SpeechProvider);
    setValue("");
    setError(null);
    setTested(false);
  };
  const test = () => {
    setError(null);
    setTested(false);
    const typed = value.trim();
    save.mutate(local ? { provider, baseUrl: typed } : { provider, apiKey: typed }, {
      onSuccess: () => {
        setValue("");
        setTested(true);
        onSaved?.();
      },
      onError: (e) => setError(errorText(t, e)),
    });
  };
  return (
    <div className="voice-engine">
      <div className="voice-engine__body">
        <h3 className="voice-engine__title">{t("voice.settings.engineTitle")}</h3>
        <Locked when={save.isPending || remove.isPending}>
          <RadioGroup
            className="voice-engine__tiles"
            value={provider}
            onValueChange={pick}
            aria-label={t("voice.settings.engineTitle")}
          >
            {PROVIDERS.map((p) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is its control
              <label key={p.id} className="voice-tile">
                <Radio className="voice-tile__radio" value={p.id} aria-label={p.name} />
                <ProviderLogo id={p.id} size="sm" />
                <span className="voice-tile__name">{p.name}</span>
                <span className="voice-tile__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              </label>
            ))}
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is its control */}
            <label className="voice-tile">
              <Radio className="voice-tile__radio" value="local" aria-label={t("voice.settings.own")} />
              <span className="voice-tile__own" aria-hidden="true">
                <Icon name="computer" size={16} />
              </span>
              <span className="voice-tile__name">{t("voice.settings.own")}</span>
              <span className="voice-tile__check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            </label>
          </RadioGroup>
          <label className="voice-engine__label" htmlFor={field}>
            {local ? t("voice.settings.address") : t("voice.settings.key", { name })}
          </label>
          <span className="voice-engine__field">
            <Input
              id={field}
              type={local ? "text" : "password"}
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={local ? "http://speech:8000/v1" : t("voice.settings.keyPlaceholder")}
              invalid={Boolean(error)}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
                setTested(false);
              }}
            />
            <Button disabled={!value.trim()} loading={save.isPending} onClick={test}>
              {t("voice.settings.test")}
            </Button>
          </span>
        </Locked>
        {error ? (
          <p className="ac-field__error">{error}</p>
        ) : tested ? (
          <SettingNote icon="check">{t("voice.settings.tested")}</SettingNote>
        ) : (
          <p className="ac-field__example">{local ? t("voice.settings.ownHelp") : t("voice.settings.sealed")}</p>
        )}
        {!local && <SettingNote icon="info">{t("voice.settings.leaves", { name })}</SettingNote>}
        {view.state === "invalid" && <SettingNote icon="alert">{t("voice.settings.invalid")}</SettingNote>}
        {view.provider && (
          <span className="voice-engine__saved">
            <Chip icon="check" tone="done">
              {view.provider === "local"
                ? t("voice.settings.own")
                : (PROVIDERS.find((p) => p.id === view.provider)?.name ?? "")}
            </Chip>
            {view.hint && (
              <span className="small muted">
                {view.provider === "local" ? view.hint : t("settings.keyEndsIn", { hint: view.hint })}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ac-btn--danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined)}
            >
              {t("settings.remove")}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Where its words come from when the browser is on the server's own computer (the desktop app's own server). */
const onThisComputer = () => ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);

/**
 * "On this computer": the speech model downloaded to the server's own computer and run there (`speech-local.ts`),
 * for the installation's owner. The first choice when it fits; when it doesn't, the real reason in numbers.
 */
export function LocalSpeechChoice({ view, onReady }: { view: LocalSpeech; onReady?: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const install = useInstallSpeechLocal();
  const remove = useRemoveSpeechLocal();
  const bytes = (n: number) => formatBytes(i18n.language, n);
  const s = view.status;
  const here = onThisComputer();
  const ready = s.state === "ready";
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);
  const start = () => install.mutate(undefined, { onError: (e) => toast.show(errorText(t, e), "error") });
  const why =
    view.fit === "memory"
      ? t("voice.local.tooSmall", { memory: bytes(view.memoryBytes) })
      : view.fit === "disk"
        ? t("voice.local.noDisk", { free: bytes(view.freeDiskBytes ?? 0), need: bytes(view.needDiskBytes) })
        : view.fit === "platform"
          ? t("voice.local.noBuild")
          : null;
  return (
    <div className="voice-engine">
      <div className="voice-engine__body">
        <h3 className="voice-engine__title">{t(here ? "voice.local.titleHere" : "voice.local.titleServer")}</h3>
        {s.state === "downloading" ? (
          <>
            <Meter value={s.doneBytes} max={s.totalBytes} label={t("voice.local.downloading")} />
            <span className="voice-engine__saved">
              <span className="small muted">
                {t("voice.local.progress", { done: bytes(s.doneBytes), total: bytes(s.totalBytes) })}
              </span>
              <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
                {t("common.cancel")}
              </Button>
            </span>
            <p className="ac-field__example">{t("voice.local.meanwhile")}</p>
          </>
        ) : s.state === "starting" ? (
          <SettingNote icon="clock" live>
            {t("voice.local.starting")}
          </SettingNote>
        ) : ready ? (
          <span className="voice-engine__saved">
            <Chip icon="check" tone="done">
              {t(here ? "voice.local.titleHere" : "voice.local.titleServer")}
            </Chip>
            <a className="small" href={NOTICE_URL} target="_blank" rel="noreferrer">
              {t("voice.local.licenses")}
            </a>
            <Button
              size="sm"
              variant="ghost"
              className="ac-btn--danger"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("settings.remove")}
            </Button>
          </span>
        ) : s.state === "failed" ? (
          <>
            <SettingNote icon="alert">
              {s.reason === "download"
                ? t("voice.local.stopped", { detail: s.detail })
                : s.reason === "disk"
                  ? t("voice.local.diskFull")
                  : t("voice.local.didntStart", { detail: s.detail })}
            </SettingNote>
            <span className="voice-engine__saved">
              <Button size="sm" loading={install.isPending} onClick={start}>
                {t(s.reason === "download" ? "voice.local.resume" : "common.retry")}
              </Button>
              {s.reason === "start" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyText(s.detail, () => toast.show(t("voice.local.copied")))}
                >
                  {t("voice.local.copy")}
                </Button>
              )}
            </span>
          </>
        ) : (
          <>
            <p className="ac-field__example">
              {t(here ? "voice.local.textHere" : "voice.local.textServer", { size: bytes(view.sizeBytes) })}
            </p>
            {why && <SettingNote icon="info">{why}</SettingNote>}
            <span className="voice-engine__saved">
              <Button
                variant="primary"
                icon="download"
                disabled={why !== null}
                loading={install.isPending}
                onClick={start}
              >
                {t("voice.local.download")}
              </Button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const NOTICE_URL = "https://github.com/agentes-chat/agentes-chat/blob/main/tools/speech-helper/NOTICE";
