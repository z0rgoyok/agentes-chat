import type { OrgSettings } from "@agenteschat/client";
import {
  keys,
  type Memory,
  useApi,
  useServerTelemetry,
  useSetServerTelemetry,
  useSettings,
  useTeamMemories,
  useUpdateSettings,
} from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Sheet,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { MemoryFix } from "../agents/AgentProfileScreen";
import { WorkspaceApprovalsRow } from "../agents/ApprovalsLevelRow";
import { useMemoryOriginText } from "../agents/useMemoryOriginText";
import { Note } from "../ai/parts";
import { ZoneList } from "../me/AccountPage";
import { PHOTO_MAX_BASE64, photoContentType } from "../me/logic";
import { useProblemReports } from "../report/ReportProblemButton";
import { ReportProblemSheet } from "../report/ReportProblemSheet";
import { LoadFailed } from "../shared/FirstUse";
import { useColors } from "../shared/hooks";
import { OrgAvatar } from "../shared/OrgAvatar";
import { errorHaptic, goBack, MONO, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { overLimit, TextArea } from "../shared/TextArea";
import { AccentRow } from "./AccentRow";
import { missingIdeas, nameOnLeave, withIdea, zoneLabel } from "./logic";
import { chooseAction, Gap, SettingsPage, Uploading } from "./parts";

/** The workspace's logo at the top of Geral (`OrgAvatar`'s corners: one cut, the other three round). */
const LOGO = 84;
/** The context saves this long after the last key (and when its field is left). */
const CONTEXT_SAVE_MS = 800;
const CONTEXT_LIMIT = { max: FIELD_LIMITS.workspaceContext };

/** The zone picked on Fuso (a screen pushed over Geral) goes back to Geral, which saves it. */
let zonePick: string | null = null;
const zoneListeners = new Set<() => void>();

function pickZone(zone: string | null) {
  zonePick = zone;
  for (const listener of zoneListeners) listener();
}

function useZonePick(): string | null {
  return useSyncExternalStore(
    (listener) => {
      zoneListeners.add(listener);
      return () => {
        zoneListeners.delete(listener);
      };
    },
    () => zonePick,
  );
}

/**
 * "Editar workspace" (the web's Geral), from the workspace's settings: its logo, name and time zone, whether agents
 * check what the team already did, the context every agent reads, the workspace's mode (ADR 0159 §4: who configures
 * it switches it on a screen of its own), and the usage report's switch for the installation's owner. Every change
 * saves by itself (the name when its field is left, the zone when picked, the context while typing), and "Salvo"
 * shows under the title; who can't change them reads them. Its owners delete it from the workspace's page
 * (`WorkspaceScreen`), the last row there. In a personal workspace it is About you (ADR 0159 §3): what the agents know
 * about the person first, in its own words, then the workspace's zone, name, check and mode, and no logo (switching
 * to team brings it back).
 */
export function GeneralScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const editable = can(org, "configure");
  const personal = isPersonal(org);
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [timezone, setTimezone] = useState("");
  const [uploading, setUploading] = useState(false);
  const loaded = useRef<string | null>(null);
  const contextTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const contextField = useRef<TextInputInstance | null>(null);
  const picked = useZonePick();

  // Filled once per workspace: a refetch after a save must not undo what is being typed.
  useEffect(() => {
    if (!settings.data || loaded.current === orgId) return;
    loaded.current = orgId;
    setName(settings.data.name);
    setContext(settings.data.context);
    setTimezone(settings.data.timezone);
  }, [settings.data, orgId]);

  // Back while typing: what was typed and not saved yet goes on the way out (only what was typed here, so a
  // change made elsewhere meanwhile isn't undone).
  const typed = useRef({ name: false, context: false });
  const latest = useRef({ name, context, settings: settings.data, editable });
  useEffect(() => {
    latest.current = { name, context, settings: settings.data, editable };
  });
  useEffect(
    () => () => {
      clearTimeout(contextTimer.current);
      const now = latest.current;
      if (!now.editable || !now.settings) return;
      const patch: Partial<OrgSettings> = {};
      const next = typed.current.name ? nameOnLeave(now.name, now.settings.name) : null;
      if (next && "save" in next) patch.name = next.save;
      if (typed.current.context && now.context !== now.settings.context) patch.context = now.context;
      if (Object.keys(patch).length === 0) return;
      void api.orgs.updateSettings(orgId, patch).then(
        (s) => {
          qc.setQueryData(keys.settings(orgId), s);
          void qc.invalidateQueries({ queryKey: keys.me });
        },
        () => undefined,
      );
    },
    [api, orgId, qc],
  );

  const save = (patch: Partial<OrgSettings>) => {
    if (!editable) return;
    update.mutate(patch, {
      // The control already shows the change (it moves as it is tapped); a screen reader hears that it stuck.
      onSuccess: () => AccessibilityInfo.announceForAccessibility(t("settings.savedShort")),
      onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per zone picked on Fuso (the save reads this render)
  useEffect(() => {
    if (!picked) return;
    pickZone(null);
    setTimezone(picked);
    if (picked !== settings.data?.timezone) save({ timezone: picked });
  }, [picked]);

  const changeName = (value: string) => {
    typed.current.name = true;
    setName(value);
  };
  const leaveName = () => {
    typed.current.name = false;
    const next = nameOnLeave(name, settings.data?.name);
    if (!next) return;
    if ("reset" in next) setName(next.reset);
    else save({ name: next.save });
  };
  const changeContext = (value: string) => {
    typed.current.context = true;
    setContext(value);
    clearTimeout(contextTimer.current);
    if (overLimit(value, CONTEXT_LIMIT)) return;
    contextTimer.current = setTimeout(() => {
      typed.current.context = false;
      save({ context: value });
    }, CONTEXT_SAVE_MS);
  };
  const flushContext = () => {
    clearTimeout(contextTimer.current);
    if (!typed.current.context) return;
    typed.current.context = false;
    if (settings.data && context !== settings.data.context && !overLimit(context, CONTEXT_LIMIT)) save({ context });
  };
  const addIdea = (label: string) => {
    changeContext(withIdea(context, label));
    requestAnimationFrame(() => contextField.current?.focus());
  };

  const refreshOrg = () => {
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.org(orgId) });
  };
  const uploadLogo = async (from: "library" | "camera") => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    };
    if (from === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast({ title: t("mobile.me.account.noCamera"), icon: "camera" });
        return;
      }
    }
    const res =
      from === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    const a = res.canceled ? null : res.assets[0];
    if (!a?.base64) return;
    if (a.base64.length > PHOTO_MAX_BASE64) {
      toast({ title: t("mobile.settings.logo.tooBig"), icon: "x" });
      return;
    }
    setUploading(true);
    try {
      await api.orgs.setLogo(orgId, {
        imageBase64: a.base64,
        contentType: photoContentType(a.mimeType, a.fileName, a.base64),
      });
      refreshOrg();
      successHaptic();
      toast({ title: t("orgLogo.saved") });
    } catch {
      errorHaptic();
      toast({ title: t("mobile.settings.logo.failed"), icon: "x" });
    } finally {
      setUploading(false);
    }
  };
  const removeLogo = async () => {
    try {
      await api.orgs.removeLogo(orgId);
      refreshOrg();
      successHaptic();
      toast({ title: t("orgLogo.removed") });
    } catch {
      errorHaptic();
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };
  const changeLogo = () =>
    chooseAction(
      t("orgLogo.title"),
      [
        { icon: "photos", label: t("mobile.me.account.fromLibrary"), onPress: () => void uploadLogo("library") },
        { icon: "camera", label: t("mobile.me.account.fromCamera"), onPress: () => void uploadLogo("camera") },
        ...(org?.logo
          ? [
              {
                icon: "trash" as const,
                label: t("orgLogo.remove"),
                destructive: true,
                onPress: () => void removeLogo(),
              },
            ]
          : []),
      ],
      t("mobile.common.cancel"),
    );

  const ideas = (["who", "now", "never"] as const).map((k) => t(modeKey(org, `settings.contextIdeas.${k}` as const)));
  const orgName = name.trim() || org?.name || "";
  const contextTitle = t(modeKey(org, "settings.contextTitle"), { name: orgName });
  const missing = missingIdeas(context, ideas);
  const input = [fieldText("callout"), styles.input, { color: c.ink }];

  const logo = (
    <View style={styles.logo}>
      <View>
        <OrgAvatar logo={org?.logo} size={LOGO} />
        {uploading ? <Uploading style={styles.logoBusy} /> : null}
      </View>
      {editable ? (
        // The design system's text button (its press and haptic), centered under the logo by its own box.
        <View>
          <Button
            variant="text"
            size="sm"
            label={org?.logo ? t("orgLogo.change") : t("orgLogo.add")}
            disabled={uploading}
            onPress={changeLogo}
          />
        </View>
      ) : null}
    </View>
  );
  const nameField = (
    <GroupedField key="name" label={t(modeKey(org, "settings.name"))}>
      <TextInput
        value={name}
        onChangeText={changeName}
        onBlur={leaveName}
        editable={editable}
        autoCapitalize="words"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        accessibilityLabel={t(modeKey(org, "settings.name"))}
        style={input}
      />
    </GroupedField>
  );
  const zoneField = (
    <GroupedField
      key="zone"
      label={t("settings.timezone")}
      hint={{ name: t("common.about", { label: t("settings.timezone") }), text: t("settings.timezoneHelp") }}
      {...(editable ? { onPress: () => router.push("/settings/zone") } : {})}
    >
      <Text variant="callout" numberOfLines={1}>
        {zoneLabel(timezone || "UTC", i18n.language)}
      </Text>
    </GroupedField>
  );
  const actionCheck = t(modeKey(org, "settings.actionCheck"));
  const checks = (
    <GroupedList>
      <GroupedRow
        label={actionCheck}
        labelLines={2}
        hint={{ name: t("common.about", { label: actionCheck }), text: t(modeKey(org, "settings.actionCheckHelp")) }}
        toggle={settings.data?.actionCheck ?? true}
        disabled={!editable || !settings.data}
        onPress={() => save({ actionCheck: !(settings.data?.actionCheck ?? true) })}
      />
    </GroupedList>
  );
  // The workspace's level reaches private agents too: owners and administrators only (ADR 0085 addendum of 2026-11-17).
  const approvals = can(org, "administrator") ? (
    <>
      <WorkspaceApprovalsRow />
      <Gap />
    </>
  ) : null;
  // Who the workspace is for (ADR 0159 §4): the mode it is in, and for who configures it the screen that switches it.
  const mode = (
    <GroupedList>
      <GroupedRow
        label={t("settings.mode.label")}
        hint={{
          name: t("common.about", { label: t("settings.mode.label") }),
          text: t(personal ? "settings.mode.personalHelp" : "settings.mode.teamHelp"),
        }}
        value={t(personal ? "settings.mode.personal" : "settings.mode.team")}
        {...(editable ? { chevron: true, onPress: () => router.push("/settings/mode") } : {})}
      />
    </GroupedList>
  );
  // The context is one field of the form: a group header over it (its ⓘ says who reads it), never a heading of its own.
  const contextPart = (
    <>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: contextTitle }),
          text: t("common.joinSentences", {
            a: t("settings.contextSubtitle"),
            b: t(modeKey(org, "settings.contextHelp"), { name: orgName }),
          }),
        }}
      >
        {contextTitle}
      </GroupedHeader>
      <TextArea
        ref={contextField}
        value={context}
        limit={CONTEXT_LIMIT}
        onChangeText={changeContext}
        onBlur={flushContext}
        editable={editable}
        placeholder={t(modeKey(org, "settings.contextPlaceholder"))}
        accessibilityLabel={t(modeKey(org, "settings.context"))}
        minHeight={168}
      />
      {editable && missing.length > 0 ? (
        <View style={styles.ideas}>
          <Text variant="footnote" tone="faint" style={styles.ideasLead}>
            {t("settings.contextMissing")}
          </Text>
          <View style={styles.ideaRow}>
            {missing.map((label) => (
              <Button
                key={label}
                size="sm"
                variant="secondary"
                icon="plus"
                label={label}
                onPress={() => addIdea(label)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </>
  );

  return (
    <SettingsPage
      title={
        personal
          ? t("settings.section.generalPersonal")
          : editable
            ? t("mobile.settings.edit")
            : t("settings.section.general")
      }
      frozen={settingsFrozen(org, "general")}
    >
      {!editable ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : null}
      {/* The form fills from the settings: until they come, the rows' shape (typing into an empty form would be lost). */}
      {!settings.data ? (
        settings.isError ? (
          <LoadFailed onRetry={() => void settings.refetch()} />
        ) : (
          <SkeletonList rows={3} />
        )
      ) : personal ? (
        // About you: what the agents know about the person first; the workspace's own rows under "This workspace".
        <>
          {contextPart}
          <GroupedHeader>{t("settings.orgTitlePersonal")}</GroupedHeader>
          <GroupedList>
            {zoneField}
            {nameField}
          </GroupedList>
          <Gap />
          {checks}
          <Gap />
          {approvals}
          {mode}
        </>
      ) : (
        <>
          {logo}
          <AccentRow editable={editable} />
          <Gap />
          <GroupedList>
            {nameField}
            {zoneField}
          </GroupedList>
          <Gap />
          {checks}
          <Gap />
          {approvals}
          {mode}
          {contextPart}
        </>
      )}

      <TeamMemory />
      <UsageStatistics />
      <ProblemReport />
    </SettingsPage>
  );
}

/**
 * Memória do time (ADR 0167): what people asked every agent to keep, with who and when, under the context every agent
 * reads. Who reviews memory taps one to change or forget it.
 */
function TeamMemory() {
  return (
    <SheetHostProvider>
      <TeamMemoryList />
    </SheetHostProvider>
  );
}

function TeamMemoryList() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const sheet = useSheet();
  const list = useTeamMemories(orgId);
  const originText = useMemoryOriginText();
  const reviews = can(org, "review_memory");
  if (!list.data) return null;
  const fix = (m: Memory) =>
    sheet.open(
      <MemoryFix
        memory={m}
        agentId=""
        agentName=""
        g=""
        source={originText(m)}
        title={t("teamMemory.title")}
        onSee={undefined}
        onDone={sheet.close}
      />,
    );
  return (
    <>
      <Gap />
      <GroupedHeader>{t("teamMemory.title")}</GroupedHeader>
      <GroupedList>
        {list.data.length === 0 ? (
          <GroupedRow label={t("teamMemory.empty")} labelLines={4} faint />
        ) : (
          list.data.map((m) => (
            <GroupedRow
              key={m.id}
              label={m.summary ?? memoryLine(t, m)}
              labelLines={6}
              sub={originText(m)}
              subLines={2}
              {...(reviews ? { chevron: true, onPress: () => fix(m) } : {})}
            />
          ))
        )}
      </GroupedList>
      <GroupedFooter>{t("teamMemory.help")}</GroupedFooter>
    </>
  );
}

/**
 * The usage report's switch (ADR 0060 §5) and "Ver o que é enviado". Only the installation's owner gets it (the API
 * answers null to everyone else, and on agentes.chat itself).
 */
function UsageStatistics() {
  const { t } = useTranslation();
  const toast = useToast();
  const telemetry = useServerTelemetry();
  const set = useSetServerTelemetry();
  const data = telemetry.data;
  if (!data) return null;
  // What is being saved shows at once: the switch moves as it is tapped, not when the server answers.
  const on = (set.isPending ? set.variables : undefined) ?? (data.enabled && !data.envOff);
  const envOff = data.envOff
    ? t(data.report.install === "desktop" ? "settings.telemetry.envOffDesktop" : "settings.telemetry.envOff")
    : null;
  return (
    <>
      <GroupedHeader>{t("settings.telemetry.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("settings.telemetry.label")}
          labelLines={3}
          hint={{
            name: t("common.about", { label: t("settings.telemetry.label") }),
            text: t("settings.telemetry.help"),
          }}
          toggle={on}
          disabled={data.envOff}
          onPress={() => set.mutate(!on, { onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }) })}
        />
        <GroupedRow label={t("settings.telemetry.see")} chevron onPress={() => router.push("/settings/telemetry")} />
      </GroupedList>
      {envOff ? <GroupedFooter>{envOff}</GroupedFooter> : null}
    </>
  );
}

/** "Send a report" for anything not tied to one screen: self-hosted servers only. */
function ProblemReport() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!useProblemReports()) return null;
  return (
    <>
      <GroupedHeader>{t("problemReport.settingsTitle")}</GroupedHeader>
      <GroupedList>
        <GroupedRow label={t("problemReport.button")} chevron onPress={() => setOpen(true)} />
      </GroupedList>
      <GroupedFooter>{t("problemReport.settingsText")}</GroupedFooter>
      <Sheet open={open} onClose={() => setOpen(false)}>
        {open && <ReportProblemSheet place="settings" onClose={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}

/** "O que é enviado": the next report, exactly (asked again when it opens). */
export function TelemetryScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const telemetry = useServerTelemetry();
  const { refetch } = telemetry;
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const report = telemetry.data?.report;
  return (
    <SettingsPage title={t("settings.telemetry.dialogTitle")}>
      <GroupedFooter>{t("settings.telemetry.dialogText")}</GroupedFooter>
      <Gap />
      {report ? (
        <GroupedList>
          <View style={styles.code}>
            <Text selectable style={[styles.mono, { color: c.ink }]}>
              {JSON.stringify(report, null, 2)}
            </Text>
          </View>
        </GroupedList>
      ) : telemetry.isError ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : telemetry.isLoading ? (
        <SkeletonList rows={3} />
      ) : null}
    </SettingsPage>
  );
}

/** Fuso horário of the workspace, pushed over Geral: a pick goes back to Geral, which saves it. */
export function OrgZonePage() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const settings = useSettings(orgId);
  return (
    <ZoneList
      title={t("settings.timezone")}
      value={settings.data?.timezone ?? "UTC"}
      onPick={(zone) => {
        if (zone) pickZone(zone);
        goBack();
      }}
    />
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  logo: { alignItems: "center", gap: 8, paddingTop: 14, paddingBottom: 14 },
  logoBusy: {
    width: LOGO,
    height: LOGO,
    borderTopLeftRadius: LOGO * 0.3,
    borderTopRightRadius: LOGO * 0.3,
    borderBottomRightRadius: LOGO * 0.3,
    borderBottomLeftRadius: LOGO * 0.09,
  },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  // "Still to say:" where a footer's words start, the ideas' buttons from the field's edge under it.
  ideas: { gap: 8, paddingTop: 10 },
  ideasLead: { paddingHorizontal: 16 },
  ideaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  code: { paddingHorizontal: 14, paddingVertical: 12 },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
});
