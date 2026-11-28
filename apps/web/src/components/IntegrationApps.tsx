import type { IntegrationApp, IntegrationAppSecrets } from "@agenteschat/client";
import { useChannels, useIntegrationAppActions, useIntegrationApps } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { INTEGRATION_NAME_MAX, integrationAddresses, integrationFacts } from "@agenteschat/client/lib/integrations";
import { PROJECT_COLORS } from "@agenteschat/client/lib/issue-projects";
import {
  Alert,
  AppMark,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  EmptyState,
  Field,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  Select,
  SettingNote,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingList } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import "./ai-apps.css";

type Access = "none" | "read" | "post";
type Confirm = { kind: "revoke" | "newToken" | "newSecret" | "remove"; app: IntegrationApp };
/** What shows once, after a change made it. */
type Shown = { kind: "token" | "secret"; name: string; value: string };

/**
 * Settings › Connectors › Integrations (ADR 0251): apps that post in chosen channels as themselves. Each one's token
 * and its webhook's signing secret show once, in a dialog closed only after copying.
 */
export function IntegrationAppsSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const list = useIntegrationApps(org.id);
  const look = useRightHandLook();
  const [editing, setEditing] = useState<IntegrationApp | "new" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [shown, setShown] = useState<Shown[]>([]);
  const addresses = integrationAddresses(window.location.origin);
  const show = (name: string, out: IntegrationAppSecrets) =>
    setShown([
      ...(out.token ? [{ kind: "token" as const, name, value: out.token }] : []),
      ...(out.webhookSecret ? [{ kind: "secret" as const, name, value: out.webhookSecret }] : []),
    ]);
  const apps = list.data ?? [];
  return (
    <>
      <Card aria-labelledby="integrations-api" className="apps-server">
        <span className="list-col apps-server__text">
          <h2 id="integrations-api" className="ac-card__title">
            {t("integrations.api")}
          </h2>
          <span className="small muted">{t("integrations.apiHelp")}</span>
        </span>
        <div className="apps-server__address">
          <CommandBlock command={addresses.api} copied={t("integrations.apiCopied")} />
          <CommandBlock command={addresses.mcp} copied={t("integrations.apiCopied")} />
        </div>
        {apps.length > 0 && (
          <Button className="apps-server__connect" variant="primary" icon="plus" onClick={() => setEditing("new")}>
            {t("integrations.connect")}
          </Button>
        )}
      </Card>
      {list.isLoading ? (
        <LoadingList count={2} trailing />
      ) : list.isError && !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : apps.length === 0 ? (
        <EmptyState
          size="panel"
          agent={look}
          title={t("integrations.emptyTitle")}
          actions={
            <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
              {t("integrations.connect")}
            </Button>
          }
        >
          {t("integrations.empty")}
        </EmptyState>
      ) : (
        <List aria-label={t("settings.section.integrations")}>
          {apps.map((app) => (
            <div key={app.id} className="ac-list__row app-row ac-mediarow ac-mediarow--row">
              <span className="ac-mediarow__face">
                <AppMark color={app.color} name={app.name} size={24} />
              </span>
              <span className="ac-mediarow__head">
                <span className="list-title">
                  <span className="app-row__name">{app.name}</span>
                </span>
              </span>
              <span className="ac-mediarow__end">
                <RowMenu app={app} onEdit={() => setEditing(app)} onConfirm={(kind) => setConfirm({ kind, app })} />
              </span>
              <span className="ac-mediarow__body small muted">{integrationFacts(t, i18n.language, app)}</span>
            </div>
          ))}
        </List>
      )}
      <p className="page__note">
        <HelpLink slug="integration-apps">{t("integrations.help")}</HelpLink>
      </p>
      {editing && (
        <AppDialog
          app={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name, out) => {
            setEditing(null);
            show(name, out);
          }}
        />
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} onShown={show} />
      {shown[0] && <ShownOnce shown={shown[0]} onClose={() => setShown(shown.slice(1))} />}
    </>
  );
}

function RowMenu({
  app,
  onEdit,
  onConfirm,
}: {
  app: IntegrationApp;
  onEdit: () => void;
  onConfirm: (kind: Confirm["kind"]) => void;
}) {
  const { t } = useTranslation();
  const label = t("integrations.actions", { name: app.name });
  return (
    <span className="ac-captail ac-captop">
      <Menu
        align="end"
        label={label}
        trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
      >
        <MenuItem icon="edit" onSelect={onEdit}>
          {t("integrations.edit")}
        </MenuItem>
        <MenuItem icon="key" onSelect={() => onConfirm("newToken")}>
          {t("integrations.newToken")}
        </MenuItem>
        {app.webhookUrl && (
          <MenuItem icon="refresh" onSelect={() => onConfirm("newSecret")}>
            {t("integrations.newSecret")}
          </MenuItem>
        )}
        {app.tokenHint && (
          <MenuItem icon="block" danger onSelect={() => onConfirm("revoke")}>
            {t("integrations.revoke")}
          </MenuItem>
        )}
        <MenuItem icon="trash" danger onSelect={() => onConfirm("remove")}>
          {t("integrations.remove")}
        </MenuItem>
      </Menu>
    </span>
  );
}

/** A new app, or an app's name, color, channels and webhook. */
function AppDialog({
  app,
  onClose,
  onSaved,
}: {
  app: IntegrationApp | null;
  onClose: () => void;
  onSaved: (name: string, out: IntegrationAppSecrets) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id).data ?? [];
  const { create, update } = useIntegrationAppActions(org.id);
  const [name, setName] = useState(app?.name ?? "");
  const [color, setColor] = useState(app?.color ?? "teal");
  const [access, setAccess] = useState<Record<string, Access>>(
    Object.fromEntries((app?.channels ?? []).map((c) => [c.channelId, c.canPost ? "post" : "read"])),
  );
  const [webhook, setWebhook] = useState(app?.webhookUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;
  const clean = name.trim();
  const picked = Object.entries(access)
    .filter(([, a]) => a !== "none")
    .map(([channelId, a]) => ({ channelId, canPost: a === "post" }));
  const submit = () => {
    if (!clean || pending) return;
    setError(null);
    const input = { name: clean, color, channels: picked, webhookUrl: webhook.trim() || null };
    const done = {
      onSuccess: (out: IntegrationAppSecrets) => onSaved(clean, out),
      onError: (err: unknown) => setError(errorText(t, err)),
    };
    if (app) update.mutate({ appId: app.id, input }, done);
    else create.mutate(input, done);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={app ? t("integrations.edit") : t("integrations.connect")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={pending}>
          <DialogBody className="apps-token">
            <Field label={t("integrations.name")} id="integration-name">
              <Input
                value={name}
                maxLength={INTEGRATION_NAME_MAX}
                autoComplete="off"
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="roles-colors" role="radiogroup" aria-label={t("integrations.color")}>
              {PROJECT_COLORS.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t("integrations.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c, 8)}")` }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <Field
              label={t("integrations.channels")}
              id="integration-channels"
              hint={{ name: t("integrations.channels"), text: t("integrations.channelsHelp") }}
            >
              {channels.length === 0 ? (
                <SettingNote icon="info" quiet>
                  {t("integrations.channelsEmpty")}
                </SettingNote>
              ) : (
                <List aria-label={t("integrations.channels")}>
                  {channels.map((c) => (
                    <div key={c.id} className="ac-list__row integration-channel">
                      <span className="integration-channel__name">#{c.name}</span>
                      <Select<Access>
                        size="sm"
                        align="end"
                        aria-label={`#${c.name}`}
                        value={access[c.id] ?? "none"}
                        onValueChange={(v) => setAccess({ ...access, [c.id]: v })}
                        options={(["none", "read", "post"] as const).map((v) => ({
                          value: v,
                          label: t(`integrations.access.${v}`),
                        }))}
                      />
                    </div>
                  ))}
                </List>
              )}
            </Field>
            <Field
              label={t("integrations.webhook")}
              id="integration-webhook"
              hint={{ name: t("integrations.webhook"), text: t("integrations.webhookHelp") }}
            >
              <Input
                type="url"
                value={webhook}
                placeholder="https://relay.example.com/agentes"
                maxLength={2048}
                onChange={(e) => setWebhook(e.target.value)}
              />
            </Field>
            {error && <Alert>{error}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!clean || pending}>
            {app ? t("integrations.save") : t("integrations.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Revogar token, Novo token, Remover: each says what stops at once. */
function ConfirmDialog({
  confirm,
  onClose,
  onShown,
}: {
  confirm: Confirm | null;
  onClose: () => void;
  onShown: (name: string, out: IntegrationAppSecrets) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useIntegrationAppActions(org.id);
  const kind = confirm?.kind;
  const name = confirm?.app.name ?? "";
  const mutation =
    kind === "remove"
      ? actions.remove
      : kind === "revoke"
        ? actions.revokeToken
        : kind === "newSecret"
          ? actions.newWebhookSecret
          : actions.newToken;
  const words =
    kind === "remove"
      ? ({ title: "integrations.removeTitle", text: "integrations.removeText", action: "integrations.remove" } as const)
      : kind === "revoke"
        ? ({
            title: "integrations.revokeTitle",
            text: "integrations.revokeText",
            action: "integrations.revoke",
          } as const)
        : kind === "newSecret"
          ? ({
              title: "integrations.newSecretTitle",
              text: "integrations.newSecretText",
              action: "integrations.newSecret",
            } as const)
          : ({
              title: "integrations.newTokenTitle",
              text: "integrations.newTokenText",
              action: "integrations.newToken",
            } as const);
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(words.title, { name })}
      description={t(words.text)}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant={kind === "newToken" || kind === "newSecret" ? "primary" : "danger"}
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onClick={() =>
            confirm &&
            (mutation.mutate as (id: string, o: object) => void)(confirm.app.id, {
              onSuccess: (out: unknown) => {
                onClose();
                if (kind === "newToken" || kind === "newSecret") onShown(name, out as IntegrationAppSecrets);
                else toast.show(kind === "remove" ? t("integrations.removed", { name }) : t("integrations.revoked"));
              },
              onError: (err: unknown) => toast.show(errorText(t, err)),
            })
          }
        >
          {t(words.action)}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** A token or a webhook secret, shown once: closed only after copying it, or after a second "leave without it". */
function ShownOnce({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const token = shown.kind === "token";
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        if (copied) onClose();
        else setLeaving(true);
      }}
      title={t(token ? "integrations.tokenTitle" : "integrations.secretTitle", { name: shown.name })}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogBody className="apps-token">
        <Alert tone="neutral">{t("apps.tokens.once")}</Alert>
        <CommandBlock
          command={shown.value}
          copied={t(token ? "apps.tokens.copied" : "integrations.secretCopied")}
          copyLabel={token ? t("apps.tokens.copy") : undefined}
          onCopied={() => setCopied(true)}
        />
        <SettingNote icon="info">{t(token ? "integrations.tokenUse" : "integrations.secretUse")}</SettingNote>
        {leaving && !copied && <Alert>{t("apps.tokens.leaveText")}</Alert>}
      </DialogBody>
      <DialogFooter>
        {leaving && !copied && (
          <Button variant="danger" onClick={onClose}>
            {t("apps.tokens.leave")}
          </Button>
        )}
        <Button variant="primary" disabled={!copied} onClick={onClose}>
          {t("apps.tokens.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
