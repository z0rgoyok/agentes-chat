import type { Credential, EndpointCheck, EndpointStyle } from "@agenteschat/client";
import { useAddCredential, useEndpointModels, useSetEndpointModels } from "@agenteschat/client";
import {
  CHECK_VIEW,
  CUSTOM_PROVIDER,
  checksInOrder,
  draftOfEndpoint,
  ENDPOINT_SEARCH_FROM,
  ENDPOINT_STYLES,
  type EndpointDraft,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  modelsShown,
  pricesProblem,
  withChecks,
  withListedModels,
  withoutModel,
  withTypedModel,
} from "@agenteschat/client/lib/endpoints";
import {
  AffixInput,
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  Field,
  FormActions,
  FormStack,
  Icon,
  Input,
  Locked,
  SearchField,
  Segmented,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * "Outro provedor" (ADR 0146): a workspace's own OpenAI- or Anthropic-compatible endpoint. The admin names it, picks
 * its API, types its address and key, fetches its models (or types their ids), chooses which agents may use and their
 * prices, then saves: the server runs one test call per model and the results show here. With `credential`, it
 * changes a saved endpoint's models and prices (its address and key stay). With `onCancel` it fills a dialog, its
 * body and footer; without, it is a block of a panel whose action comes up under it once there's something to save,
 * like the panel's own Salvar chave. `onDone` gets the key with its models' tests just run.
 */
export function EndpointForm({
  orgId,
  credential,
  lead,
  onCancel,
  onDone,
}: {
  orgId: string;
  credential?: Credential;
  /** The form's first field, owned by the caller (the provider's select): locked and laid out with the rest. */
  lead?: ReactNode;
  onCancel?: () => void;
  /** Its button stays busy while what it returns runs (the caller putting the key on an agent). */
  onDone: (saved: Credential) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [draft, setDraft] = useState<EndpointDraft>(() =>
    credential?.endpoint ? draftOfEndpoint(credential.label, credential.endpoint) : emptyEndpointDraft(),
  );
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const typedBox = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<{ cred: Credential; checks: EndpointCheck[] } | null>(null);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const search = (next: string) => {
    setPinned(new Set(draft.models.filter((m) => m.on).map((m) => m.id)));
    setQuery(next);
  };
  const searching = draft.models.length > ENDPOINT_SEARCH_FROM;
  const shown = searching ? modelsShown(draft.models, query, pinned) : draft.models;
  const list = useEndpointModels(orgId);
  const add = useAddCredential(orgId);
  const change = useSetEndpointModels(orgId);
  const editing = credential !== undefined;
  const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (id: string, patch: Partial<EndpointDraft["models"][number]>) =>
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const addTyped = () => {
    const next = withTypedModel(draft, typed);
    setTypedWrong(next === null);
    if (!next) return;
    setDraft(next);
    setTyped("");
    // The + turns off with the field empty, and a × leaves with its row: the keyboard stays in the form.
    typedBox.current?.focus();
  };
  const fetchModels = () =>
    list.mutate(
      { style: draft.style, baseURL: draft.baseURL.trim(), apiKey: draft.apiKey.trim() || undefined },
      { onSuccess: (r) => setDraft((d) => ({ ...withListedModels(d, r.models), baseURL: r.baseURL })) },
    );
  const save = () => {
    const models = endpointModelsOf(draft);
    if (!models) return;
    if (editing && credential) {
      change.mutate(
        { credentialId: credential.id, models },
        {
          onSuccess: (r) =>
            setSaved({
              cred: {
                ...credential,
                ...(credential.endpoint ? { endpoint: { ...credential.endpoint, models: r.models } } : {}),
              },
              checks: r.checks,
            }),
        },
      );
      return;
    }
    add.mutate(
      {
        provider: CUSTOM_PROVIDER,
        label: draft.name.trim(),
        apiKey: draft.apiKey.trim(),
        endpoint: { style: draft.style, baseURL: draft.baseURL.trim(), models },
      },
      { onSuccess: ({ checks, ...cred }) => setSaved({ cred, checks: checks ?? [] }) },
    );
  };
  const saving = add.isPending || change.isPending;
  const ready = editing ? endpointModelsOf(draft) !== null : endpointReady(draft);
  const unpriced = draft.models.some((m) => m.on && !m.input.trim() && !m.output.trim());

  const Body = onCancel ? DialogBody : FormStack;
  const Foot = onCancel ? DialogFooter : FormActions;

  if (saved) {
    return (
      <>
        <Body>
          {saved.cred.reused && (
            <SettingNote icon="check" live>
              {t("settings.keyResaved")}
            </SettingNote>
          )}
          <b>{t("endpoint.results")}</b>
          <ul className="ac-iconlist endpoint-checks">
            {checksInOrder(draft, saved.checks).map((c) => {
              const view = CHECK_VIEW[c.check];
              return (
                <li key={c.model} className="ac-iconline">
                  <Icon name={view.tone === "ok" ? "check" : "alert"} size={14} />
                  <span>
                    <b>{c.model}</b> · {t(view.key, { error: c.error ?? "" })}
                  </span>
                </li>
              );
            })}
          </ul>
        </Body>
        <Foot>
          <Button
            variant="primary"
            loading={closing}
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              try {
                await onDone(withChecks(saved.cred, saved.checks));
              } finally {
                setClosing(false);
              }
            }}
          >
            {t("endpoint.done")}
          </Button>
        </Foot>
      </>
    );
  }

  return (
    <>
      <Locked when={saving}>
        <Body>
          {lead}
          {!editing && (
            <>
              <Field label={t("endpoint.name")} id={`${ids}-name`}>
                <Input
                  value={draft.name}
                  maxLength={80}
                  placeholder={t("endpoint.namePlaceholder")}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </Field>
              <Field label={t("endpoint.style")} group>
                <Segmented<EndpointStyle>
                  label={t("endpoint.style")}
                  value={draft.style}
                  onValueChange={(style) => set({ style })}
                  options={ENDPOINT_STYLES.map((s) => ({ value: s, label: t(`endpoint.styles.${s}`) }))}
                />
              </Field>
              <Field
                label={t("endpoint.address")}
                id={`${ids}-url`}
                example={t("endpoint.addressHelp", { example: endpointBaseExample(draft.style) })}
              >
                <Input
                  value={draft.baseURL}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={endpointBaseExample(draft.style)}
                  onChange={(e) => set({ baseURL: e.target.value })}
                />
              </Field>
              <Field
                label={t("endpoint.key")}
                id={`${ids}-key`}
                hint={{ name: t("common.about", { label: t("endpoint.key") }), text: t("endpoint.keyHelp") }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field
            label={t("endpoint.addModel")}
            id={`${ids}-typed`}
            error={typedWrong ? t("endpoint.modelInvalid") : undefined}
            labelAside={
              !editing && (
                <button
                  type="button"
                  className="ac-link ac-link--muted small"
                  aria-busy={list.isPending || undefined}
                  disabled={list.isPending || !endpointAddressLooksValid(draft.baseURL)}
                  onClick={fetchModels}
                >
                  <span className="ac-iconline">
                    {list.isPending && <Spinner size={12} />}
                    {t("endpoint.fetch")}
                  </span>
                </button>
              )
            }
          >
            <AffixInput
              ref={typedBox}
              value={typed}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("endpoint.modelPlaceholder")}
              invalid={typedWrong}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="plus"
                  aria-label={t("endpoint.add")}
                  disabled={!typed.trim()}
                  onClick={addTyped}
                />
              }
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedWrong(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTyped();
              }}
            />
          </Field>
          {list.data?.error && (
            <SettingNote icon="alert">{t("endpoint.listFailed", { error: list.data.error })}</SettingNote>
          )}
          {draft.models.length > 0 && (
            <fieldset className="endpoint-models" aria-labelledby={`${ids}-choose`}>
              <span className="ac-field__label" id={`${ids}-choose`}>
                {t("endpoint.choose")}
              </span>
              {searching && (
                <SearchField
                  aria-label={t("endpoint.search")}
                  placeholder={t("endpoint.search")}
                  value={query}
                  onChange={(e) => search(e.target.value)}
                  onClear={() => search("")}
                  clearLabel={t("filters.clearSearch")}
                />
              )}
              {searching && shown.length === 0 && (
                <SettingNote icon="search">{t("endpoint.noMatch", { query: query.trim() })}</SettingNote>
              )}
              {shown.map((m) => {
                const problem = m.on ? pricesProblem(m) : null;
                return (
                  <div key={m.id} className="endpoint-model">
                    <Checkbox id={`${ids}-m-${m.id}`} checked={m.on} onCheckedChange={(on) => setModel(m.id, { on })} />
                    <label htmlFor={`${ids}-m-${m.id}`}>{m.id}</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t("common.removeName", { name: m.id })}
                      onClick={() => {
                        setDraft((d) => withoutModel(d, m.id));
                        typedBox.current?.focus();
                      }}
                    />
                    {m.on && (
                      <span className="endpoint-model__prices">
                        <Input
                          aria-label={t("endpoint.priceIn", { model: m.id })}
                          placeholder={t("endpoint.priceInShort")}
                          inputMode="decimal"
                          value={m.input}
                          invalid={problem !== null}
                          onChange={(e) => setModel(m.id, { input: e.target.value })}
                        />
                        <Input
                          aria-label={t("endpoint.priceOut", { model: m.id })}
                          placeholder={t("endpoint.priceOutShort")}
                          inputMode="decimal"
                          value={m.output}
                          invalid={problem !== null}
                          onChange={(e) => setModel(m.id, { output: e.target.value })}
                        />
                      </span>
                    )}
                    {m.on && draft.style === "openai" && (
                      <span className="endpoint-model__image-input">
                        <Checkbox
                          id={`${ids}-image-${m.id}`}
                          checked={m.imageInput === true}
                          onCheckedChange={(imageInput) => setModel(m.id, { imageInput })}
                        />
                        <label htmlFor={`${ids}-image-${m.id}`}>{t("endpoint.imageInput")}</label>
                      </span>
                    )}
                    {problem && (
                      <div className="ac-field__error endpoint-model__error" role="alert">
                        {t(problem === "both" ? "endpoint.priceBoth" : "endpoint.priceInvalid")}
                      </div>
                    )}
                  </div>
                );
              })}
              {draft.models.some((m) => m.on) && <span className="ac-field__example">{t("endpoint.priceUnit")}</span>}
            </fieldset>
          )}
          {unpriced && <SettingNote icon="info">{t("endpoint.unpriced")}</SettingNote>}
        </Body>
      </Locked>
      {(onCancel || ready || saving) && (
        <Foot note={saving ? t("endpoint.testing") : undefined}>
          {onCancel && (
            <Button onClick={onCancel} disabled={saving}>
              {t("common.cancel")}
            </Button>
          )}
          <Button variant="primary" loading={saving} disabled={!ready || saving} onClick={save}>
            {t(editing ? "endpoint.saveModels" : "endpoint.save")}
          </Button>
        </Foot>
      )}
    </>
  );
}
