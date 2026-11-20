import { ApiError, keys, useApi, useMe, useSettings } from "@agenteschat/client";
import { emailChangeRefusal, errorCode, errorText, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { CODE_LENGTH, typedCode } from "@agenteschat/client/lib/join-requests";
import { browserTimezone, zoneDisplayName } from "@agenteschat/client/lib/routines";
import { isEmail } from "@agenteschat/client/lib/text";
import { filterZones, type ZoneOption, zoneOptions } from "@agenteschat/ui/timezones";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { authClient } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { useOrg, useOrgMaybe } from "@/providers/org";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PersonAvatar,
  SearchField,
  SHEET_X,
  Sheet,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openOwnPage } from "../ai/parts";
import { SheetHeader } from "../new/parts";
import { ResendCode, Uploading, useUnsavedGuard } from "../settings/parts";
import { confirmDeleteWorkspace } from "../settings/WorkspaceScreen";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { goBack, PushedHeader } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";
import { type AccountDraft, accountChanges, accountProblem, handleErrorKey } from "./logic";
import { Page, refreshProfile, setAccountDraft, useAccountDraft, useChangePhoto } from "./parts";

/** The photo on Conta. */
const PHOTO = 92;

/** A zone as the list says it: "Horário de Brasília" (a friendly name) or the city. */
const zoneName = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * Conta: the photo and "Alterar foto", Nome (editable), E-mail (read only),
 * then in this workspace your @ and the time zone (Fuso, pushed over it), as the web's Perfil. "OK" in the bar
 * saves and goes back; Apagar conta at the end.
 */
export function AccountPage() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const dir = useDirectory();
  const mine = meId ? dir.memberById.get(meId) : undefined;
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  // The form starts from the profile when Conta opens (Fuso, over it, changes its zone) and is dropped when it closes.
  // Taken once both the account and this workspace's profile are in, so an @ still loading never reads as empty.
  const loaded = Boolean(me.data && mine);
  const [initial, setInitial] = useState<AccountDraft>(() => ({
    name: me.data?.user.name ?? "",
    handle: mine?.handle ?? "",
    zone: mine?.timezone ?? null,
  }));
  const [seeded, setSeeded] = useState(loaded);
  useEffect(() => {
    if (seeded || !loaded) return;
    setSeeded(true);
    setInitial({ name: me.data?.user.name ?? "", handle: mine?.handle ?? "", zone: mine?.timezone ?? null });
  }, [seeded, loaded, me.data, mine]);
  useEffect(() => {
    setAccountDraft(initial);
    return () => setAccountDraft(null);
  }, [initial]);
  const draft = useAccountDraft() ?? initial;
  const setDraft = setAccountDraft;
  const [saving, setSaving] = useState(false);
  const { changePhoto, uploading } = useChangePhoto();
  const [error, setError] = useState<string | null>(null);
  const handleField = useRef<TextInputInstance | null>(null);

  // A message from the last OK goes away once the form changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared on every edit of the form
  useEffect(() => setError(null), [draft]);

  const problem = accountProblem(draft);
  const changes = accountChanges(initial, draft);
  const changed = Boolean(changes.name || changes.profile);
  // Show what's wrong once the person changed something (not on a fresh, untouched form).
  const shownProblem = changed && problem ? t(`mobile.me.account.${problem}`) : null;
  // Back with a changed name, @ or zone asks first; Fuso and E-mail open over this screen and keep the form.
  const leave = useUnsavedGuard(changed);

  const save = async () => {
    if (saving) return;
    // Nothing to save (a new photo saves on its own): OK just closes, as it says.
    if (!changed) return goBack();
    if (problem) return setError(t(`mobile.me.account.${problem}`));
    setSaving(true);
    setError(null);
    try {
      if (changes.name) {
        const res = await authClient().updateUser({ name: changes.name });
        if (res.error) throw new Error(res.error.message ?? "");
      }
      if (changes.profile) await api.orgs.updateMe(org.orgId, changes.profile);
      refreshProfile(qc, org.orgId);
      toast({ title: t("mobile.me.account.saved") });
      leave();
      goBack();
    } catch (e) {
      const key = e instanceof ApiError ? handleErrorKey(e.code) : null;
      setError(key ? t(`mobile.me.account.${key}`) : t("mobile.app.failed"));
    } finally {
      setSaving(false);
    }
  };

  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  const zoneLabel = draft.zone ? zoneName(draft.zone, i18n.language) : t("mobile.me.account.orgZone");
  return (
    <Page
      title={t("mobile.me.account.title")}
      action={{
        label: t("mobile.me.account.save"),
        disabled: saving,
        onPress: () => void save(),
      }}
      locked={saving}
    >
      <View style={styles.photo}>
        <View>
          <PersonAvatar name={draft.name || "?"} size={PHOTO} photo={photo} />
          {uploading ? <Uploading style={styles.photoBusy} /> : null}
        </View>
        {/* The design system's text button (its press and haptic), centered under the photo by its own box. */}
        <View>
          <Button
            variant="text"
            size="sm"
            label={t("mobile.me.account.changePhoto")}
            disabled={uploading}
            onPress={changePhoto}
          />
        </View>
      </View>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.name")}>
          <TextInput
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            placeholder={t("mobile.me.account.namePlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            // Return hands the keyboard to the @ below, never closing it.
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => handleField.current?.focus()}
            accessibilityLabel={t("mobile.me.account.name")}
            style={input}
          />
        </GroupedField>
        <GroupedField label={t("mobile.me.account.email")} onPress={() => router.push("/me/email")}>
          <Text variant="callout" numberOfLines={1}>
            {me.data?.user.email ?? ""}
          </Text>
        </GroupedField>
      </GroupedList>
      <GroupedHeader>{t("mobile.me.account.inWorkspace", { org: org.org?.name ?? "" })}</GroupedHeader>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.handle")}>
          <View style={styles.handle}>
            <Text variant="callout" tone="faint">
              @
            </Text>
            <TextInput
              ref={handleField}
              value={draft.handle}
              onChangeText={(handle) => setDraft({ ...draft, handle })}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="done"
              accessibilityLabel={t("mobile.me.account.handle")}
              style={input}
            />
          </View>
        </GroupedField>
        <GroupedField
          label={t("mobile.me.account.timezone")}
          hint={{
            name: t("common.about", { label: t("mobile.me.account.timezone") }),
            text: t("mobile.me.account.timezoneHint"),
          }}
          onPress={() => router.push("/me/zone")}
        >
          <Text variant="callout" numberOfLines={1}>
            {zoneLabel}
          </Text>
        </GroupedField>
      </GroupedList>
      {shownProblem || error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {shownProblem ?? error}
        </Text>
      ) : null}
      <View style={styles.gapBig} />
      <GroupedList>
        <GroupedRow
          icon="x"
          label={t("mobile.me.deleteAccount")}
          danger
          chevron
          onPress={() => router.push("/account-delete")}
        />
      </GroupedList>
      <GroupedFooter>{t("deleteAccount.card.text")}</GroupedFooter>
      {org.org?.role === "owner" ? (
        <>
          <View style={styles.gapBig} />
          <GroupedList>
            {/* Red words alone, as on the workspace's settings, and the same confirmation before the proof. */}
            <GroupedRow
              label={t("deleteOrg.card.title")}
              danger
              onPress={() => confirmDeleteWorkspace(t, org.org?.name ?? "")}
            />
          </GroupedList>
          <GroupedFooter>{t("deleteOrg.card.text", { name: org.org.name })}</GroupedFooter>
        </>
      ) : null}
    </Page>
  );
}

/**
 * E-mail, pushed over Conta: the same account under a new address, as on the web (ADR 0088 §2, addendum 2026-11-13). The
 * new address, then the code emailed to the current one, then a link to the new address, which changes it once opened.
 * Someone who can't open that inbox, or whose address was never confirmed (no code goes there), signs in again on the
 * website, where the same dialog opens: the phone has no sign-in while signed in, and signing out here would drop the
 * messages it is still sending. On a server that sends no e-mail it changes at once.
 */
export function EmailPage() {
  const { t } = useTranslation();
  const me = useMe();
  const api = useApi();
  const org = useOrg();
  const qc = useQueryClient();
  const c = useColors();
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  // The code's: where it went, and when another may go.
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [done, setDone] = useState<{ status: "sent" | "changed"; email: string } | null>(null);
  const [cantOpen, setCantOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = me.data?.user.email ?? "";
  const newEmail = value.trim();
  const ready = sent ? code.length === CODE_LENGTH : isEmail(newEmail);
  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const ask = async (withCode: boolean) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.account.changeEmail(withCode ? { newEmail, code } : { newEmail });
      if (r.status === "code") {
        codeOut(r.email, r.resendIn);
        setCode("");
        return;
      }
      setDone(r);
      await qc.invalidateQueries({ queryKey: keys.me });
    } catch (e) {
      const refused = emailChangeRefusal(e);
      // A code went out a moment ago (another try, another device): that one is still good.
      if (refused === "wait") codeOut(sent?.email ?? current, e instanceof ApiError ? Number(e.params?.retryIn) : 60);
      else {
        if (refused === "code") setCode("");
        if (errorCode(e) === REAUTH_SIGN_IN) setCantOpen(true);
        setError(errorText(t, e));
      }
    } finally {
      setSending(false);
    }
  };
  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  return (
    <Page
      title={t("shell.email.title")}
      {...(done
        ? {}
        : {
            action: {
              label: t("shell.email.change"),
              disabled: sending || !ready,
              onPress: () => void ask(sent !== null),
            },
          })}
      locked={sending}
    >
      {done ? (
        <Text variant="callout" style={styles.error} accessibilityLiveRegion="polite">
          {t(done.status === "changed" ? "shell.email.changed" : "shell.email.sent", { email: done.email })}
        </Text>
      ) : (
        <>
          <GroupedList>
            <GroupedField label={t("shell.email.new")}>
              <TextInput
                value={value}
                onChangeText={(v) => {
                  setValue(v);
                  // Another address takes its own code.
                  setSent(null);
                  setCode("");
                  setCantOpen(false);
                  setError(null);
                }}
                placeholder={current}
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (isEmail(newEmail)) void ask(false);
                }}
                accessibilityLabel={t("shell.email.new")}
                style={input}
              />
            </GroupedField>
            {sent ? (
              <GroupedField label={t("proof.code")}>
                <TextInput
                  value={code}
                  onChangeText={(v) => {
                    setCode(typedCode(v));
                    setError(null);
                  }}
                  autoFocus
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    if (code.length === CODE_LENGTH) void ask(true);
                  }}
                  accessibilityLabel={t("proof.code")}
                  style={input}
                />
              </GroupedField>
            ) : null}
          </GroupedList>
          <GroupedFooter>{sent ? t("proof.sent", { email: sent.email }) : t("shell.email.help")}</GroupedFooter>
          {error ? (
            <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          {sent ? (
            <View style={styles.acts}>
              <ResendCode resendAt={sent.resendAt} disabled={sending} onPress={() => void ask(false)} />
              <Button
                variant="ghost"
                size="sm"
                label={t("shell.email.cantOpen")}
                onPress={() => {
                  setCantOpen((open) => !open);
                  setError(null);
                }}
              />
            </View>
          ) : null}
          {cantOpen ? (
            <View style={styles.web}>
              {sent ? (
                <Text variant="footnote" tone="muted">
                  {t("mobile.me.account.emailWebLead")}
                </Text>
              ) : null}
              <Button
                variant="secondary"
                label={t("mobile.me.account.emailWeb")}
                onPress={() => openOwnPage(`${serverUrl()}/org/${org.orgId}/settings/account?account=email`)}
              />
            </View>
          ) : null}
        </>
      )}
    </Page>
  );
}

/** Fuso, pushed over Conta: a pick goes into Conta's form and back to it ("Usar o fuso do workspace" is null). */
export function ZonePage() {
  const { t } = useTranslation();
  const draft = useAccountDraft();
  return (
    <ZoneList
      title={t("mobile.me.zone.title")}
      value={draft?.zone ?? null}
      withWorkspace
      onPick={(zone) => {
        if (draft) setAccountDraft({ ...draft, zone });
        goBack();
      }}
    />
  );
}

interface ZoneListProps {
  title: string;
  value: string | null;
  withWorkspace?: boolean;
  onPick: (zone: string | null) => void;
}

/**
 * A time zone chosen on a screen of its own (Conta's Fuso, a routine's "Fuso horário"): the search, "Usar o fuso do
 * workspace" (`withWorkspace`: a pick of null), then the suggested zones and every other. Inside a workspace its zone
 * and its people's are suggested too; before there is one, the phone's. The first run picks it in `ZoneSheet`.
 */
export function ZoneList(props: ZoneListProps) {
  const org = useOrgMaybe();
  return org ? <WorkspaceZoneList {...props} orgId={org.orgId} /> : <ZonePicker {...props} orgZone={null} people="" />;
}

/** In a workspace: its own zone and its people's suggested first. */
function WorkspaceZoneList({ orgId, ...props }: ZoneListProps & { orgId: string }) {
  const settings = useSettings(orgId);
  const dir = useDirectory();
  const people = [...dir.memberById.values()].map((m) => m.timezone).join(",");
  return <ZonePicker {...props} orgZone={settings.data?.timezone ?? null} people={people} />;
}

/** The zones to offer: the suggested ones first (the one in use, the phone's, the workspace's, its people's), then all. */
function useZoneOptions(value: string | null, orgZone: string | null, people: string) {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const suggested = [value ?? "", browserTimezone() ?? "", orgZone ?? "", ...people.split(","), "UTC"].filter(
      Boolean,
    );
    return zoneOptions(suggested, (z) => zoneDisplayName(z, i18n.language));
  }, [value, orgZone, people, i18n.language]);
}

/**
 * The first run's time zone, in a sheet over it (the first run sits outside the navigator, so no screen is pushed):
 * the sheet's bar with × and the search stay on top while the zones scroll under them, the phone's own suggested
 * first. The zones are drawn only while the sheet is up, so the long list costs the screen under it nothing.
 */
export function ZoneSheet({
  open,
  onClose,
  title,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  value: string | null;
  onPick: (zone: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // From the moment it opens until it is off the screen, so the list never empties while the sheet slides away.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      onGone={() => {
        setShown(false);
        setQuery("");
      }}
      header={
        <View style={styles.sheetHead}>
          <SheetHeader title={title} onPress={onClose} />
          <SearchField value={query} onChangeText={setQuery} placeholder={t("mobile.me.zone.search")} />
        </View>
      }
    >
      {shown ? <ZoneSheetRows value={value} query={query} onPick={onPick} /> : null}
    </Sheet>
  );
}

/** The sheet's zones as grouped rows (a sheet scrolls a plain view, so the list isn't virtualized here). */
function ZoneSheetRows({
  value,
  query,
  onPick,
}: {
  value: string | null;
  query: string;
  onPick: (zone: string) => void;
}) {
  const { t } = useTranslation();
  const options = useZoneOptions(value, null, "");
  const q = query.trim();
  const row = (o: ZoneOption) => (
    <GroupedRow
      key={o.zone}
      label={o.name}
      value={o.offsetLabel}
      checked={o.zone === value}
      onPress={() => onPick(o.zone)}
    />
  );
  if (q) {
    const found = filterZones([...options.suggested, ...options.rest], q);
    return found.length > 0 ? (
      <GroupedList>{found.map(row)}</GroupedList>
    ) : (
      <GroupedFooter>{t("mobile.me.zone.none")}</GroupedFooter>
    );
  }
  return (
    <>
      <GroupedHeader>{t("mobile.me.zone.suggested")}</GroupedHeader>
      <GroupedList>{options.suggested.map(row)}</GroupedList>
      <GroupedHeader>{t("mobile.me.zone.all")}</GroupedHeader>
      <GroupedList>{options.rest.map(row)}</GroupedList>
    </>
  );
}

function ZonePicker({
  title,
  value,
  withWorkspace = false,
  onPick,
  orgZone,
  people,
}: ZoneListProps & {
  orgZone: string | null;
  /** The people's zones, comma-separated (a stable dependency). */
  people: string;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const options = useZoneOptions(value, orgZone, people);
  const q = query.trim();
  const rows: (ZoneOption | { header: string })[] = q
    ? filterZones([...options.suggested, ...options.rest], q)
    : [
        { header: t("mobile.me.zone.suggested") },
        ...options.suggested,
        { header: t("mobile.me.zone.all") },
        ...options.rest,
      ];
  // A group starts after a header (or the top) and ends before the next one (or the end).
  const edge = (i: number) => {
    const row = rows[i];
    return row === undefined || "header" in row;
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped />
      <FlatList
        data={rows}
        keyExtractor={(r) => ("header" in r ? `h:${r.header}` : r.zone)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        initialNumToRender={20}
        contentContainerStyle={[styles.zoneList, { paddingBottom: 24 + insets.bottom }]}
        ListHeaderComponent={
          <>
            <View style={styles.search}>
              <SearchField value={query} onChangeText={setQuery} placeholder={t("mobile.me.zone.search")} />
            </View>
            {q || !withWorkspace ? null : (
              <GroupedList>
                <GroupedRow
                  label={t("mobile.me.zone.useOrg")}
                  {...(orgZone ? { sub: zoneName(orgZone, i18n.language) } : {})}
                  checked={value === null}
                  onPress={() => onPick(null)}
                />
              </GroupedList>
            )}
          </>
        }
        ListEmptyComponent={<GroupedFooter>{t("mobile.me.zone.none")}</GroupedFooter>}
        renderItem={({ item, index }) =>
          "header" in item ? (
            <GroupedHeader>{item.header}</GroupedHeader>
          ) : (
            <ZoneRow
              option={item}
              checked={item.zone === value}
              first={edge(index - 1)}
              last={edge(index + 1)}
              onPress={() => onPick(item.zone)}
            />
          )
        }
      />
    </View>
  );
}

/**
 * One zone, a row of a GroupedList drawn piece by piece so the long list stays virtualized: the group's corners on its
 * first and last row, the hairline from the text on, and the group's shadow kept to its sides where two rows meet.
 */
function ZoneRow({
  option,
  checked,
  first,
  last,
  onPress,
}: {
  option: ZoneOption;
  checked: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={[styles.zoneClip, first && styles.zoneClipFirst, last && styles.zoneClipLast]}>
      <View
        style={[
          styles.zoneRow,
          first && styles.zoneFirst,
          last && styles.zoneLast,
          { backgroundColor: c.raised, boxShadow: first ? `${shadows.e1}, ${shadows.top}` : shadows.e1 },
        ]}
      >
        {first ? null : <View style={[styles.zoneDivider, { backgroundColor: c.line2 }]} />}
        <GroupedRow label={option.name} value={option.offsetLabel} checked={checked} onPress={onPress} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The zones sheet's bar and search, on every sheet's side margin, over the list.
  sheetHead: { paddingHorizontal: SHEET_X, paddingBottom: 8, gap: 4 },
  fill: { flex: 1 },
  photo: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 14 },
  photoBusy: { width: PHOTO, height: PHOTO, borderRadius: PHOTO / 2 },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  handle: { flexDirection: "row", alignItems: "center", gap: 1 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
  // Under the code's footer: its two quiet actions, their words on the footer's 16 (a small button pads 12), then the
  // way to the website when asked for.
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4, paddingTop: 4 },
  web: { gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  gapBig: { height: 24 },
  search: { paddingTop: 4, paddingBottom: 8 },
  zoneList: { paddingHorizontal: 16 },
  // Room for the shadow beside the rows (and above and below the group), cut where two rows meet: no line across.
  zoneClip: { overflow: "hidden", marginHorizontal: -6, paddingHorizontal: 6 },
  zoneClipFirst: { marginTop: -6, paddingTop: 6 },
  zoneClipLast: { marginBottom: -6, paddingBottom: 6 },
  // GroupedList's numbers: radius 14, the hairline from the row's text on.
  zoneRow: { overflow: "hidden" },
  zoneFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  zoneLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  zoneDivider: { height: StyleSheet.hairlineWidth, marginLeft: GROUPED_ROW.padX },
});
