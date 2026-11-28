import type { StorageConfig, StoragePlatform, StorageProvider, StorageTestResult } from "@agenteschat/client";
import {
  useMachines,
  useSaveStorage,
  useStartMigration,
  useStorage,
  useStorageMigration,
  useTestStorage,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { formatBytes } from "@agenteschat/client/lib/files";
import { computerStorage } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import {
  AWS_REGIONS,
  awsBucketPolicy,
  emptyStorageForm,
  missingFields,
  STORAGE_PROVIDERS,
  type StorageField,
  type StorageForm,
  stepErrorText,
  storageFormOf,
  storageUsageLine,
  toS3Input,
} from "@agenteschat/client/lib/storage";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  List,
  Locked,
  Meter,
  OptionLinks,
  RadioCard,
  RadioGroup,
  Select,
  SettingNote,
  UsageSwatch,
} from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { StorageMeter } from "@/components/Limits";
import { LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useRevealsFiles } from "@/components/ThisMac";
import { managedOf, useComputerEdition } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { copyText } from "@/lib/context-menu";
import { thisMac } from "@/lib/desktop";
import { softBreaks } from "@/lib/soft-breaks";
import { useToast } from "@/lib/toast";
import "./plan-usage.css";
import "./storage.css";

type Choice = "agentes" | "s3";
type BrandedProvider = Exclude<StorageProvider, "other">;

/** Each service's mark and color (`public/connectors`, see its README); "Other" has none. */
const MARKS: Record<BrandedProvider, { iconUrl: string; brandColor: string }> = {
  r2: { iconUrl: "/connectors/cloudflare.svg", brandColor: "#F38020" },
  s3: { iconUrl: "/connectors/amazons3.svg", brandColor: "#569A31" },
  b2: { iconUrl: "/connectors/backblaze.svg", brandColor: "#E21E29" },
};

/** Where each service's steps start, in its own dashboard. */
const LINKS = {
  r2: "https://dash.cloudflare.com/?to=/:account/r2/overview",
  s3: "https://console.aws.amazon.com/s3/home",
  iam: "https://console.aws.amazon.com/iam/home#/users",
  b2: "https://secure.backblaze.com/b2_buckets.htm",
} as const;

type StepText = `storage.connect.step.${"r2Bucket" | "r2Key" | "s3Bucket" | "s3User" | "s3Key" | "b2Bucket" | "b2Key"}`;

const STEP_ICON: Record<"ok" | "failed" | "skipped", IconName> = { ok: "check", failed: "close", skipped: "info" };

/** Where this server keeps files, as its admins read it: the folder by its path when the server says it. */
function PlatformLine({ platform }: { platform: StoragePlatform }) {
  const { t } = useTranslation();
  if (platform.kind !== "disk" || !platform.folder) return <>{t(`storage.serverText.${platform.kind}`)}</>;
  return <Trans i18nKey="storage.serverText.folder" components={{ folder: <PathCode path={platform.folder} /> }} />;
}

/** A path in code style that wraps after its separators, never inside a folder's name unless it must. */
function PathCode({ path }: { path: string }) {
  return <code style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{softBreaks(path)}</code>;
}

/**
 * A service's mark in its color, at an icon's size on the name's line (no tile: a tile beside a name and a line that
 * wraps would own a column); "Other" our database icon.
 */
function ProviderMark({ provider, size = 20 }: { provider: StorageProvider; size?: 14 | 16 | 20 }) {
  if (provider === "other") return <Icon name="database" size={size} className="storage-mark" />;
  const mark = MARKS[provider];
  return (
    <span
      className="storage-mark storage-mark--brand"
      aria-hidden="true"
      style={
        {
          "--connector-icon": `url("${mark.iconUrl}")`,
          "--connector-color": mark.brandColor,
          width: size,
          height: size,
        } as CSSProperties
      }
    />
  );
}

/** The storage in use, said by its service and bucket ("Cloudflare R2 · acme-files"), or by its address when unknown. */
function InUseLine({ config }: { config: StorageConfig }) {
  const { t } = useTranslation();
  const s3 = config.s3;
  if (!s3) return null;
  const provider = s3.provider && s3.provider !== "other" ? s3.provider : null;
  if (!provider) {
    let host = s3.endpoint;
    try {
      host = new URL(s3.endpoint).host;
    } catch {
      // A saved address that doesn't parse is shown as it was saved.
    }
    return <>{t("storage.connect.inUseAt", { bucket: s3.bucket, host })}</>;
  }
  return (
    <span className="storage-inuse">
      <ProviderMark provider={provider} size={14} />
      {t("storage.connect.inUse", { provider: t(`storage.connect.provider.${provider}`), bucket: s3.bucket })}
    </span>
  );
}

/**
 * Settings → Armazenamento (admins only): where files stay unless the workspace brings its own S3-compatible
 * storage. On the Cloud that is our storage; on a server people run, the server itself, said by where it keeps them.
 * Picking "Your own storage" offers "Connect storage", whose dialog walks through the chosen service (ADR 0019).
 */
export function StorageSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "configure");
  const storage = useStorage(org.id, admin);
  const limits = useWorkspaceLimits(org.id, admin);
  // Under a storage limit the meter above says what the files here take, against the limit: the option doesn't say it
  // again (nor before the limits answer, so the line never shows and goes).
  const metered = limits.data ? limits.data.storage.limitBytes !== null : limits.isPending;
  const edition = useComputerEdition(org.id);
  const reveals = useRevealsFiles();
  const [choice, setChoice] = useState<Choice>("agentes");
  const [connect, setConnect] = useState<"new" | "edit" | null>(null);
  useEffect(() => {
    if (storage.data) setChoice(storage.data.kind);
  }, [storage.data]);
  if (!admin) return null;
  const config = edition ? storage.data : undefined;
  const cloud = edition === "cloud";
  const place = t(cloud ? "storage.place.agentes" : "storage.place.server");
  return (
    <>
      {/* The page's title names the card: a title of its own would say it twice. */}
      <Card aria-label={t("storage.title")}>
        <StorageMeter />
        {(storage.isLoading || (storage.data && !edition)) && <LoadingCards count={2} />}
        {config && (
          <>
            <RadioGroup
              value={choice}
              onValueChange={(v) => setChoice(v as Choice)}
              aria-label={t("storage.options")}
              className="stack-4"
              style={{ gap: 8 }}
            >
              {(["agentes", "s3"] as const).map((k) => (
                <RadioCard
                  key={k}
                  value={k}
                  id={`storage-${k}`}
                  checked={choice === k}
                  title={t(k === "s3" ? "storage.s3" : cloud ? "storage.agentes" : "storage.server")}
                  description={
                    k === "s3" ? (
                      config.kind === "s3" ? (
                        <InUseLine config={config} />
                      ) : (
                        t("storage.s3Text")
                      )
                    ) : cloud ? (
                      t("storage.agentesText")
                    ) : (
                      <PlatformLine platform={config.platform} />
                    )
                  }
                  aside={
                    // The radio says which is in use until another is picked: then this says it.
                    config.kind === k && choice !== k ? <Chip icon="check">{t("storage.current")}</Chip> : undefined
                  }
                  detail={
                    config.kind === k && !(k === "agentes" && metered)
                      ? storageUsageLine(t, i18n.language, config)
                      : undefined
                  }
                />
              ))}
            </RadioGroup>
            {/* Under the options, not in one: each option is a label, which can't hold a button. */}
            {!cloud && reveals && config.platform.folder && (
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => void thisMac.revealFiles().catch(() => {})}>
                  {t("storage.showFolder")}
                </Button>
              </div>
            )}
            {config.kind === "s3" ? (
              <InUse config={config} place={place} onEdit={() => setConnect("edit")} />
            ) : (
              choice === "s3" && (
                // `ac-acts` straight in the card: on a phone its lone button takes the card's width.
                <div className="ac-acts">
                  <Button variant="primary" onClick={() => setConnect("new")}>
                    {t("storage.connect.open")}
                  </Button>
                </div>
              )
            )}
            <ConnectDialog
              open={connect !== null}
              editing={connect === "edit"}
              config={config}
              onOpenChange={(open) => {
                if (!open) setConnect(null);
              }}
            />
          </>
        )}
      </Card>
      <ComputerStorageCard />
    </>
  );
}

/**
 * The workspace's own Cloud computer's disk: what takes it by kind, as a bar with its legend (each kind's name and
 * amount, then what is free), and near full the way out: an agent clears caches and temporary files.
 */
function ComputerStorageCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const storage = computerStorage(managedOf(useMachines(org.id).data)?.disk ?? null);
  const lodi = rightHandOf(useDirectory(org.id).agents);
  if (!storage) return null;
  const size = (gb: number) => formatBytes(i18n.language, gb * 2 ** 30);
  return (
    <Card aria-labelledby="storage-computer">
      <CardHeader
        id="storage-computer"
        icon="computer"
        title={t("storage.computer.title")}
        subtitle={t("storage.computer.used", { used: size(storage.usedGb), size: size(storage.sizeGb) })}
      />
      <Meter
        value={storage.usedGb}
        max={storage.sizeGb}
        label={t("storage.computer.bar")}
        segments={storage.parts.map((p) => ({ key: p.key, value: p.gb, deep: p.light, light: p.dark }))}
      />
      {storage.parts.length > 0 ? (
        <div className="plan-legend storage-legend">
          {storage.parts.map((p) => (
            <span
              key={p.key}
              className="plan-legend__item"
              style={{ "--seg-deep": p.light, "--seg-light": p.dark } as CSSProperties}
            >
              <UsageSwatch />
              {t(`storage.computer.part.${p.key}`)} <b>{size(p.gb)}</b>
            </span>
          ))}
          <span className="plan-legend__item storage-legend__free">
            <UsageSwatch />
            {t("storage.computer.part.free")} <b>{size(storage.freeGb)}</b>
          </span>
        </div>
      ) : (
        <p className="small muted">{t("storage.computer.measuring")}</p>
      )}
      {storage.full && (
        <SettingNote
          icon="alert"
          action={
            lodi && mayAsk(org, lodi) ? <AskAgentButton agent={lodi} draft={t("storage.computer.ask")} /> : undefined
          }
        >
          {t("storage.computer.full", { free: size(storage.freeGb) })}
        </SettingNote>
      )}
    </Card>
  );
}

/** On the workspace's own storage: copying the files kept before, editing the connection, and the way back. */
function InUse({ config, place, onEdit }: { config: StorageConfig; place: string; onEdit: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveStorage(org.id);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="stack-4" style={{ gap: 12 }}>
      <CopyFiles config={config} place={place} />
      <div className="row" style={{ gap: 8 }}>
        <Button onClick={onEdit}>{t("storage.connect.edit")}</Button>
        <Button variant="ghost" onClick={() => setConfirm(true)}>
          {t("storage.back", { place })}
        </Button>
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("storage.backTitle", { place })}
        description={t("storage.backText", { place })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { kind: "agentes" },
                {
                  onSuccess: () => {
                    setConfirm(false);
                    toast.show(t("storage.backDone", { place }));
                  },
                },
              )
            }
          >
            {t("storage.back", { place })}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function CopyFiles({ config, place }: { config: StorageConfig; place: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const start = useStartMigration(org.id);
  const status = useStorageMigration(org.id, true);
  const m = status.data ?? config.migration;
  if (!m) {
    return (
      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <span className="small muted" style={{ flex: "1 1 240px" }}>
          {t("storage.copyText", { place })}
        </span>
        <Button disabled={start.isPending} loading={start.isPending} onClick={() => start.mutate()}>
          {t("storage.copy")}
        </Button>
      </div>
    );
  }
  return (
    <div className="stack-4" style={{ gap: 8 }}>
      <Meter value={m.copied} max={m.total} label={t("storage.copyProgress")} />
      <p className="small" role="status">
        {m.status === "done"
          ? t("storage.copyDone", { total: m.total })
          : m.status === "failed"
            ? t("storage.copyFailed", { copied: m.copied, total: m.total })
            : t("storage.copying", { copied: m.copied, total: m.total })}
      </p>
      {m.status === "failed" && (
        <>
          {m.error && <Alert>{m.error}</Alert>}
          <div className="row">
            <Button disabled={start.isPending} loading={start.isPending} onClick={() => start.mutate()}>
              {t("storage.resume")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "Connect storage" and "Edit connection": pick the service, follow its steps (each says where to click in that
 * service and takes what the step gives), test, then activate. Editing opens on the saved service's steps, the keys
 * blank (kept until replaced).
 */
function ConnectDialog({
  open,
  editing,
  config,
  onOpenChange,
}: {
  open: boolean;
  editing: boolean;
  config: StorageConfig;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<StorageProvider | null>(null);
  // Each opening is a fresh form, even on the same service: a new connection starts at the list, an edit on the
  // saved service with its saved settings.
  const [opening, setOpening] = useState(0);
  useEffect(() => {
    if (!open) return;
    setOpening((n) => n + 1);
    setProvider(editing ? (config.s3?.provider ?? "other") : null);
  }, [open, editing, config.s3?.provider]);
  if (!provider) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("storage.connect.pickTitle")}
        description={t("storage.connect.pickText")}
        closeLabel={t("common.close")}
        width={560}
      >
        <DialogBody>
          <OptionLinks
            className="storage-pick"
            options={STORAGE_PROVIDERS.map((p) => ({
              value: p,
              leading: (
                <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
                  <ProviderMark provider={p} size={16} />
                </span>
              ),
              title: t(`storage.connect.provider.${p}`),
              description: t(`storage.connect.providerText.${p}`),
              onSelect: () => setProvider(p),
            }))}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        </DialogFooter>
      </Dialog>
    );
  }
  return (
    <ProviderSteps
      // Another service or another opening is another form: nothing typed before carries over.
      key={`${opening}:${provider}`}
      open={open}
      onOpenChange={onOpenChange}
      provider={provider}
      editing={editing}
      config={config}
      onBack={() => setProvider(null)}
    />
  );
}

/** One service's steps and fields, the test's result, and the footer that tests, then activates. */
function ProviderSteps({
  open,
  onOpenChange,
  provider,
  editing,
  config,
  onBack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: StorageProvider;
  editing: boolean;
  config: StorageConfig;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const test = useTestStorage(org.id);
  const save = useSaveStorage(org.id);
  const start = editing ? storageFormOf(config) : emptyStorageForm;
  const [form, setForm] = useState<StorageForm>(start);
  const [touched, setTouched] = useState(false);
  // The settings the last test ran with, and its result.
  const [tested, setTested] = useState<{ sig: string; result: StorageTestResult } | null>(null);
  const saved = editing ? config.s3 : null;
  const input = toS3Input(provider, form);
  const sig = JSON.stringify(input);
  const missing = missingFields(provider, form, Boolean(saved));
  const current = tested?.sig === sig ? tested.result : null;
  const failed = current && !current.ok ? current : null;
  const stale = tested !== null && tested.sig !== sig;
  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  const busy = test.isPending || save.isPending;
  const set = <K extends StorageField>(k: K, v: StorageForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errorOf = (k: StorageField) => {
    if (!touched || !missing.includes(k)) return undefined;
    if (k !== "accessKeyId" && k !== "secretAccessKey") return t("storage.required");
    // "Other" keeps today's field names (Access key, Secret); the services' steps say "both keys".
    return provider === "other" ? t("storage.keysRequired") : t("storage.connect.stepError.keysRequired");
  };
  const runTest = () => {
    setTouched(true);
    if (missing.length > 0) return;
    test.mutate(input, { onSuccess: (result) => setTested({ sig, result }) });
  };
  const activate = () =>
    save.mutate(
      { kind: "s3", s3: input },
      {
        onSuccess: () => {
          toast.show(t("storage.activated"));
          onOpenChange(false);
        },
      },
    );
  /** A text field: its error once a test was tried, else the saved key's hint or what the service calls it. */
  const text = (k: Exclude<StorageField, "pathStyle">, label: string, example?: ReactNode, secret = false) => {
    const savedHint = !saved
      ? null
      : k === "accessKeyId"
        ? saved.accessKeyIdHint
        : k === "secretAccessKey"
          ? saved.secretHint
          : null;
    return (
      <Field
        label={label}
        id={`st-${k}`}
        example={savedHint ? t("storage.savedHint", { hint: savedHint }) : example}
        error={errorOf(k)}
      >
        <Input
          type={secret ? "password" : "text"}
          value={form[k]}
          onChange={(e) => set(k, e.target.value)}
          placeholder={k === "endpoint" && provider !== "b2" ? "https://" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    );
  };
  const keys = (keyName: string, secretName: string) => (
    <>
      {text("accessKeyId", t("storage.connect.accessKeyId"), keyName, true)}
      {text("secretAccessKey", t("storage.connect.secret"), secretName, true)}
    </>
  );
  const bucket = text("bucket", t("storage.connect.bucketName"));
  const permission = failed?.steps.some((s) => s.code === "storage.permission") ?? false;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(`storage.connect.${editing ? "editTitle" : "title"}.${provider}`)}
      description={editing ? t("storage.connect.editLede") : t(`storage.connect.lede.${provider}`)}
      closeLabel={t("common.close")}
      width={560}
      unsaved={dirty}
    >
      <DialogBody>
        <form
          className="ac-form"
          aria-label={t(`storage.connect.title.${provider}`)}
          onSubmit={(e) => e.preventDefault()}
        >
          <Locked when={busy}>
            {provider === "r2" && (
              <ol className="storage-steps">
                <Step n={1} title={t("storage.connect.step.bucketTitle")} text="storage.connect.step.r2Bucket">
                  <OutLink href={LINKS.r2}>{t("storage.connect.openR2")}</OutLink>
                  {bucket}
                </Step>
                <Step n={2} title={t("storage.connect.step.keyTitle")} text="storage.connect.step.r2Key">
                  {keys(t("storage.connect.theirName.r2Key"), t("storage.connect.theirName.r2Secret"))}
                  {text("endpoint", t("storage.connect.r2Endpoint"), t("storage.connect.theirName.r2Endpoint"))}
                </Step>
              </ol>
            )}
            {provider === "s3" && (
              <ol className="storage-steps">
                <Step n={1} title={t("storage.connect.step.bucketTitle")} text="storage.connect.step.s3Bucket">
                  <OutLink href={LINKS.s3}>{t("storage.connect.openS3")}</OutLink>
                  {bucket}
                  <Field label={t("storage.connect.region")} id="st-region" error={errorOf("region")}>
                    <Select
                      value={form.region || undefined}
                      onValueChange={(v) => set("region", v)}
                      placeholder={t("storage.connect.regionPick")}
                      options={AWS_REGIONS.map((code) => ({
                        value: code,
                        label: t("storage.connect.regionOption", {
                          name: t(`storage.connect.awsRegion.${code}`),
                          code,
                        }),
                      }))}
                    />
                  </Field>
                </Step>
                <Step n={2} title={t("storage.connect.step.userTitle")} text="storage.connect.step.s3User">
                  <div className="row" style={{ gap: 8 }}>
                    <Button
                      size="sm"
                      icon="copy"
                      disabled={!form.bucket.trim()}
                      onClick={() =>
                        void copyText(awsBucketPolicy(form.bucket), () =>
                          toast.show(t("storage.connect.policyCopied", { bucket: form.bucket.trim() })),
                        )
                      }
                    >
                      {t("storage.connect.copyPolicy")}
                    </Button>
                    <OutLink href={LINKS.iam} inline>
                      {t("storage.connect.openIam")}
                    </OutLink>
                  </div>
                </Step>
                <Step n={3} title={t("storage.connect.step.keyTitle")} text="storage.connect.step.s3Key">
                  {keys(t("storage.connect.theirName.s3Key"), t("storage.connect.theirName.s3Secret"))}
                </Step>
              </ol>
            )}
            {provider === "b2" && (
              <ol className="storage-steps">
                <Step n={1} title={t("storage.connect.step.bucketTitle")} text="storage.connect.step.b2Bucket">
                  <OutLink href={LINKS.b2}>{t("storage.connect.openB2")}</OutLink>
                  {bucket}
                  {text("endpoint", t("storage.connect.b2Endpoint"), t("storage.connect.theirName.b2Endpoint"))}
                </Step>
                <Step n={2} title={t("storage.connect.step.keyTitle")} text="storage.connect.step.b2Key">
                  {keys(t("storage.connect.theirName.b2Key"), t("storage.connect.theirName.b2Secret"))}
                </Step>
              </ol>
            )}
            {provider === "other" && (
              <>
                {text("endpoint", t("storage.endpoint"), t("storage.endpointHelp"))}
                {text("region", t("storage.region"))}
                {text("bucket", t("storage.bucket"))}
                {text("prefix", t("storage.prefix"), t("storage.prefixHelp"))}
                {text("accessKeyId", t("storage.accessKey"), undefined, true)}
                {text("secretAccessKey", t("storage.secret"), undefined, true)}
                <div className="row" style={{ alignItems: "center", gap: 8 }}>
                  <Checkbox
                    id="st-path"
                    checked={form.pathStyle}
                    onCheckedChange={(v) => set("pathStyle", v)}
                    aria-describedby="st-path-hint"
                  />
                  <span className="ac-hintline">
                    <label htmlFor="st-path">{t("storage.pathStyle")}</label>
                    <InfoHint id="st-path-hint" name={t("common.about", { label: t("storage.pathStyle") })}>
                      {t("storage.pathStyleHelp")}
                    </InfoHint>
                  </span>
                </div>
              </>
            )}
          </Locked>
          {current?.ok && (
            <section className="stack-4" style={{ gap: 8 }} aria-label={t("storage.steps")}>
              <SettingNote icon="check" live>
                {t("storage.connect.passed")}
              </SettingNote>
              <SettingNote icon="info" quiet>
                {t("storage.switchedNotice")}
              </SettingNote>
            </section>
          )}
          {failed && (
            <TestSteps
              result={failed}
              hint={
                permission && provider !== "other" ? (
                  <Trans
                    i18nKey={`storage.connect.permissionHint.${provider}`}
                    values={{ bucket: input.bucket }}
                    components={{ b: <b /> }}
                  />
                ) : (
                  t("storage.testFailed")
                )
              }
            />
          )}
          {stale && <p className="small muted">{t("storage.retestNeeded")}</p>}
        </form>
      </DialogBody>
      <DialogFooter>
        <Button onClick={editing ? () => onOpenChange(false) : onBack}>
          {editing ? t("common.cancel") : t("storage.connect.back")}
        </Button>
        {current?.ok ? (
          <Button variant="primary" disabled={save.isPending} loading={save.isPending} onClick={activate}>
            {editing ? t("storage.saveBucket") : t("storage.activate")}
          </Button>
        ) : (
          <Button variant="primary" disabled={test.isPending} loading={test.isPending} onClick={runTest}>
            {test.isPending ? t("storage.testing") : failed ? t("storage.connect.testAgain") : t("storage.test")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** A numbered step: the number, the title and what to do in the service, then the fields that step fills. */
function Step({ n, title, text, children }: { n: number; title: string; text: StepText; children?: ReactNode }) {
  return (
    <li className="storage-step">
      <span className="storage-step__n" aria-hidden="true">
        {n}
      </span>
      <div className="storage-step__main">
        <h3 className="storage-step__title">{title}</h3>
        <p className="storage-step__text">
          <Trans i18nKey={text} components={{ b: <b /> }} />
        </p>
        {children}
      </div>
    </li>
  );
}

/** A button that opens the service's own page in a new tab, the external mark after its words. */
function OutLink({ href, inline, children }: { href: string; inline?: boolean; children: ReactNode }) {
  const link = (
    <Button asChild size="sm">
      <a href={href} target="_blank" rel="noreferrer" className="storage-out">
        {children}
        <Icon name="external" size={14} />
      </a>
    </Button>
  );
  return inline ? link : <div className="row">{link}</div>;
}

/** A failed test: each step, the reason by its code in the person's language, and what to check. */
function TestSteps({ result, hint }: { result: StorageTestResult; hint: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="stack-4" style={{ gap: 8 }} aria-label={t("storage.steps")}>
      <List>
        {result.steps.map((s) => {
          const state = s.ok ? "ok" : s.error ? "failed" : "skipped";
          const reason = state === "failed" ? stepErrorText(t, s) : null;
          return (
            <div key={s.step} className="ac-list__row" data-step={s.step}>
              <span className="row" style={{ gap: 8, flex: 1, alignItems: "flex-start", flexWrap: "nowrap" }}>
                <Icon name={STEP_ICON[state]} aria-hidden="true" />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>{t(`storage.step.${s.step}`)}</span>
                  {reason && <span className="small muted">{reason}</span>}
                </span>
              </span>
              <Chip icon={STEP_ICON[state]}>
                {t(
                  state === "ok" ? "storage.stepOk" : state === "failed" ? "storage.stepFailed" : "storage.stepSkipped",
                )}
              </Chip>
            </div>
          );
        })}
      </List>
      <Alert>{hint}</Alert>
    </section>
  );
}
