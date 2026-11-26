import { type Credential, type EndpointCheck, keys, useApi } from "@agenteschat/client";
import {
  CHECK_VIEW,
  CUSTOM_PROVIDER,
  checksInOrder,
  ENDPOINT_SEARCH_FROM,
  ENDPOINT_STYLES,
  type EndpointDraft,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  IMAGE_INPUT_MODES,
  type ImageInputMode,
  imageInputMode,
  imageInputOverride,
  modelsShown,
  pricesProblem,
  withChecks,
  withListedModels,
  withoutModel,
  withTypedModel,
} from "@agenteschat/client/lib/endpoints";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  IconButton,
  Locked,
  SearchField,
  Segmented,
  Text,
  useTheme,
} from "@/ui";
import { Note } from "./parts";

/**
 * "Outro provedor" on the phone (ADR 0146), the web's `EndpointForm`: a workspace's own OpenAI- or
 * Anthropic-compatible endpoint, its models fetched or typed, their prices, then saved with one test per model.
 * `onDone` gets the key with its models' tests just run; Concluir stays busy while what it returns runs.
 */
export function EndpointForm({
  orgId,
  onDone,
}: {
  orgId: string;
  onDone: (saved: Credential) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<EndpointDraft>(emptyEndpointDraft);
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<{ key: Credential; checks: EndpointCheck[] } | null>(null);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const search = (next: string) => {
    setPinned(new Set(draft.models.filter((m) => m.on).map((m) => m.id)));
    setQuery(next);
  };
  const searching = draft.models.length > ENDPOINT_SEARCH_FROM;
  const shown = searching ? modelsShown(draft.models, query, pinned) : draft.models;
  const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (id: string, patch: Partial<EndpointDraft["models"][number]>) =>
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  const locked = saving || listing;

  const fetchModels = async () => {
    setListing(true);
    setListError(null);
    try {
      const r = await api.agents.endpointModels(orgId, {
        style: draft.style,
        baseURL: draft.baseURL.trim(),
        apiKey: draft.apiKey.trim() || undefined,
      });
      setDraft((d) => ({ ...withListedModels(d, r.models), baseURL: r.baseURL }));
      setListError(r.error ?? null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setListing(false);
    }
  };
  const addTyped = () => {
    const next = withTypedModel(draft, typed);
    setTypedWrong(next === null);
    if (!next) return;
    setDraft(next);
    setTyped("");
  };
  const save = async () => {
    const models = endpointModelsOf(draft);
    if (!models || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const { checks, ...key } = await api.agents.addCredential(orgId, {
        provider: CUSTOM_PROVIDER,
        label: draft.name.trim(),
        apiKey: draft.apiKey.trim(),
        endpoint: { style: draft.style, baseURL: draft.baseURL.trim(), models },
      });
      setSaved({ key, checks: checks ?? [] });
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      void qc.invalidateQueries({ queryKey: keys.models });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <View style={styles.gap}>
        {saved.key.reused ? (
          <Note icon="check" live inset>
            {t("settings.keyResaved")}
          </Note>
        ) : null}
        <GroupedHeader>{t("endpoint.results")}</GroupedHeader>
        <GroupedList>
          {checksInOrder(draft, saved.checks).map((r) => (
            <GroupedRow
              key={r.model}
              icon={CHECK_VIEW[r.check].tone === "ok" ? "check" : CHECK_VIEW[r.check].tone === "warn" ? "info" : "x"}
              label={r.model}
              sub={t(CHECK_VIEW[r.check].key, { error: r.error ?? "" })}
              subLines={3}
            />
          ))}
        </GroupedList>
        <Button
          variant="primary"
          wide
          label={t("endpoint.done")}
          loading={closing}
          disabled={closing}
          onPress={async () => {
            setClosing(true);
            try {
              await onDone(withChecks(saved.key, saved.checks));
            } finally {
              setClosing(false);
            }
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.gap}>
      <Locked when={locked} style={styles.gap}>
        <GroupedList>
          <GroupedField label={t("endpoint.name")}>
            <TextInput
              value={draft.name}
              onChangeText={(name) => set({ name })}
              placeholder={t("endpoint.namePlaceholder")}
              placeholderTextColor={c.faint}
              maxLength={80}
              autoCorrect={false}
              accessibilityLabel={t("endpoint.name")}
              style={input}
            />
          </GroupedField>
        </GroupedList>
        <View>
          <GroupedHeader>{t("endpoint.style")}</GroupedHeader>
          <Segmented
            wide="fit"
            items={ENDPOINT_STYLES.map((s) => ({ key: s, label: t(`endpoint.styles.${s}`) }))}
            value={draft.style}
            onChange={(style) => set({ style: style as EndpointDraft["style"] })}
          />
        </View>
        <GroupedList>
          <GroupedField label={t("endpoint.address")}>
            <TextInput
              value={draft.baseURL}
              onChangeText={(baseURL) => set({ baseURL })}
              placeholder={endpointBaseExample(draft.style)}
              placeholderTextColor={c.faint}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              accessibilityLabel={t("endpoint.address")}
              style={input}
            />
          </GroupedField>
          <GroupedField
            label={t("endpoint.key")}
            hint={{ name: t("common.about", { label: t("endpoint.key") }), text: t("endpoint.keyHelp") }}
          >
            <TextInput
              value={draft.apiKey}
              onChangeText={(apiKey) => set({ apiKey })}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("endpoint.key")}
              style={input}
            />
          </GroupedField>
        </GroupedList>
        <GroupedFooter>{t("endpoint.addressHelp", { example: endpointBaseExample(draft.style) })}</GroupedFooter>
      </Locked>
      <GroupedHeader
        aside={
          <Button
            variant="text"
            size="sm"
            label={t("endpoint.fetch")}
            loading={listing}
            disabled={saving || !endpointAddressLooksValid(draft.baseURL)}
            onPress={() => void fetchModels()}
          />
        }
      >
        {t("endpoint.addModel")}
      </GroupedHeader>
      <Locked when={locked} style={styles.gap}>
        <GroupedList>
          <GroupedField label={t("endpoint.models")}>
            <View style={styles.addRow}>
              <TextInput
                value={typed}
                onChangeText={(v) => {
                  setTyped(v);
                  setTypedWrong(false);
                }}
                placeholder={t("endpoint.modelPlaceholder")}
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={addTyped}
                accessibilityLabel={t("endpoint.addModel")}
                style={input}
              />
              <IconButton icon="plus" label={t("endpoint.add")} disabled={!typed.trim()} onPress={addTyped} />
            </View>
          </GroupedField>
        </GroupedList>
        {/* Under the field, on the footers' edge: what it said about what was typed. */}
        {typedWrong ? (
          <GroupedFooter>
            <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
              {t("endpoint.modelInvalid")}
            </Text>
          </GroupedFooter>
        ) : null}
        {listError ? (
          <Note icon="x" inset>
            {t("endpoint.listFailed", { error: listError })}
          </Note>
        ) : null}
        {draft.models.length > 0 ? (
          <>
            <GroupedHeader>{t("endpoint.choose")}</GroupedHeader>
            {searching ? (
              <SearchField
                value={query}
                onChangeText={search}
                placeholder={t("endpoint.search")}
                accessibilityLabel={t("endpoint.search")}
                raised
              />
            ) : null}
            {shown.length === 0 ? (
              <GroupedFooter>{t("endpoint.noMatch", { query: query.trim() })}</GroupedFooter>
            ) : (
              <GroupedList>
                {shown.map((m) => (
                  <GroupedRow
                    key={m.id}
                    label={m.id}
                    checked={m.on}
                    onPress={() => setModel(m.id, { on: !m.on })}
                    remove={{
                      label: t("common.removeName", { name: m.id }),
                      onPress: () => setDraft((d) => withoutModel(d, m.id)),
                    }}
                  />
                ))}
              </GroupedList>
            )}
            {draft.models
              .filter((m) => m.on)
              .map((m) => {
                const problem = pricesProblem(m);
                return (
                  <View key={m.id} style={styles.gap}>
                    <GroupedHeader>{`${m.id} · ${t("endpoint.priceUnit")}`}</GroupedHeader>
                    {draft.style === "openai" ? (
                      <View>
                        <GroupedHeader>{t("endpoint.imageInput")}</GroupedHeader>
                        <Segmented
                          wide="fit"
                          items={IMAGE_INPUT_MODES.map((key) => ({ key, label: t(`endpoint.imageInputModes.${key}`) }))}
                          value={imageInputMode(m.imageInput)}
                          onChange={(mode) =>
                            setModel(m.id, { imageInput: imageInputOverride(mode as ImageInputMode) })
                          }
                        />
                      </View>
                    ) : null}
                    <GroupedList>
                      <GroupedField label={t("endpoint.priceInShort")}>
                        <TextInput
                          value={m.input}
                          onChangeText={(v) => setModel(m.id, { input: v })}
                          keyboardType="decimal-pad"
                          accessibilityLabel={t("endpoint.priceIn", { model: m.id })}
                          style={input}
                        />
                      </GroupedField>
                      <GroupedField label={t("endpoint.priceOutShort")}>
                        <TextInput
                          value={m.output}
                          onChangeText={(v) => setModel(m.id, { output: v })}
                          keyboardType="decimal-pad"
                          accessibilityLabel={t("endpoint.priceOut", { model: m.id })}
                          style={input}
                        />
                      </GroupedField>
                    </GroupedList>
                    {problem ? (
                      <GroupedFooter>
                        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
                          {t(problem === "both" ? "endpoint.priceBoth" : "endpoint.priceInvalid")}
                        </Text>
                      </GroupedFooter>
                    ) : null}
                  </View>
                );
              })}
          </>
        ) : null}
      </Locked>
      {draft.models.some((m) => m.on && !m.input.trim() && !m.output.trim()) ? (
        <Note icon="info" inset>
          {t("endpoint.unpriced")}
        </Note>
      ) : null}
      {failed ? (
        <Note icon="x" live inset>
          {t("mobile.ai.failed")}
        </Note>
      ) : null}
      <Button
        variant="primary"
        wide
        label={saving ? t("endpoint.testing") : t("endpoint.save")}
        loading={saving}
        disabled={!endpointReady(draft) || listing}
        onPress={() => void save()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  addRow: { flexDirection: "row", alignItems: "center" },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
});
