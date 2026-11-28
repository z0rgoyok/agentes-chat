import {
  keys,
  type SurfaceLink,
  type SurfaceLinkCode,
  type SurfaceLinks,
  useAgents,
  useConfirmSurfaceLink,
  useMintSurfaceCode,
  useRemoveSurfaceLink,
  useSetSurfaceNudge,
  useSetSurfacePin,
  useSurfaceLinks,
} from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { rightHandName } from "@agenteschat/client/lib/right-hand";
import {
  codeDeadline,
  DAY_HOURS,
  hourLabel,
  LINK_POLL_MS,
  NUDGE_AFTER_HOURS,
  newlyLinked,
  pinChosen,
  pinDigits,
  pinMismatch,
  type SurfaceRow,
  surfaceMarkUrl,
  surfaceRowOf,
} from "@agenteschat/client/lib/surface-links";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, StyleSheet, TextInput, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useAppActive } from "@/lib/useAppActive";
import { useOrg } from "@/providers/org";
import { Button, GroupedList, GroupedRow, haptics, Sheet, Text, useToast } from "@/ui";
import { iconUri } from "../connectors/logic";
import { confirmAction } from "../settings/parts";
import { useColors, useNow } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { MONO } from "../shared/parts";
import {
  codeIsStale,
  codeLeftText,
  linkAssistant,
  linkRanOut,
  linkStep,
  quietHoursText,
  surfaceRowText,
  surfaceSenderText,
} from "./surface";

/**
 * The outside chat surface's row in Notificações (ADR 0187), only where this account may link it: none opens the
 * sheet, pending opens it at the confirm, active shows the sender with Unlink, and a row under it to choose the PIN
 * (ADR 0226), which only the signed-in app can do.
 */
export function SurfaceLinkRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const links = useSurfaceLinks();
  const agents = useAgents(orgId);
  const remove = useRemoveSurfaceLink();
  const [open, setOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  // The server sends no event when a pending link runs out, so the clock drops it, quickly while the sheet is open.
  const now = useNow(open ? 5_000 : 60_000);
  const row = surfaceRowOf(links.data, now);
  if (row.kind === "hidden") return null;
  const assistant = rightHandName(agents.data);
  const text = surfaceRowText(t, row, assistant);
  const unlink = (link: SurfaceLink) =>
    confirmAction({
      title: t("surface.row.unlinkTitle", { surface: row.surface }),
      text: t("surface.row.unlinkText", { assistant: assistant ?? t("rightHand.labelCapitalized") }),
      action: t("surface.row.unlink"),
      cancel: t("mobile.common.cancel"),
      onConfirm: () =>
        remove.mutate(link.id, {
          onSuccess: () => haptics.success(),
          onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
        }),
    });
  return (
    <>
      <GroupedList>
        <GroupedRow
          media
          icon="chat"
          mark={iconUri(serverUrl(), surfaceMarkUrl(row.surface))}
          label={row.surface}
          labelLines={0}
          {...(text.sub ? { sub: text.sub, subLines: 0 } : {})}
          {...(text.below ? { belowText: text.below } : {})}
          {...(text.hint ? { hint: { name: t("common.about", { label: row.surface }), text: text.hint } } : {})}
          {...(text.value ? { value: text.value } : {})}
          disabled={remove.isPending}
          {...(row.kind === "active"
            ? { remove: { label: t("surface.row.unlink"), onPress: () => unlink(row.link) } }
            : { chevron: true, onPress: () => setOpen(true) })}
        />
        {row.kind === "active" ? (
          <GroupedRow
            icon="lock"
            label={row.link.pinSet ? t("surface.pin.change") : t("surface.pin.set")}
            chevron
            onPress={() => setPinOpen(true)}
          />
        ) : null}
        {row.kind === "active" && (
          <NudgeRows link={row.link} surface={row.surface} assistant={assistant ?? t("rightHand.labelCapitalized")} />
        )}
      </GroupedList>
      <SurfaceLinkSheet open={open} onClose={() => setOpen(false)} row={row} />
      <SurfacePinSheet
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        linkId={row.kind === "active" ? row.link.id : null}
        surface={row.surface}
      />
    </>
  );
}

/** Choosing the PIN, typed twice: the signed-in app is what lets it be chosen; a link from the chat never can. */
function SurfacePinSheet({
  open,
  onClose,
  linkId,
  surface,
}: {
  open: boolean;
  onClose: () => void;
  linkId: string | null;
  surface: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const save = useSetSurfacePin();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const error = pinMismatch(pin, again) ? t("surface.page.mismatch") : save.isError ? errorText(t, save.error) : null;
  const field = (value: string, set: (v: string) => void, label: string) => (
    <View style={[styles.pin, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <TextInput
        value={value}
        onChangeText={(v) => set(pinDigits(v))}
        placeholder={label}
        placeholderTextColor={c.faint}
        accessibilityLabel={label}
        keyboardType="number-pad"
        secureTextEntry
        textContentType="none"
        autoComplete="off"
        maxLength={6}
        editable={!save.isPending}
        style={[styles.pinInput, { color: c.ink }]}
      />
    </View>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      onGone={() => {
        setPin("");
        setAgain("");
        save.reset();
      }}
    >
      <View style={styles.col}>
        <Text variant="title">{t("surface.pin.title", { surface })}</Text>
        <Text variant="body" tone="muted">
          {t("surface.pin.text", { surface })}
        </Text>
        {field(pin, setPin, t("surface.page.choosePin"))}
        {field(again, setAgain, t("surface.page.repeatPin"))}
        {error ? (
          <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          variant="primary"
          wide
          label={t("surface.pin.save")}
          loading={save.isPending}
          disabled={!linkId || !pinChosen(pin, again)}
          onPress={() =>
            linkId &&
            save.mutate(
              { linkId, pin },
              {
                onSuccess: () => {
                  haptics.success();
                  toast({ title: t("surface.pinReset.done"), icon: "check" });
                  onClose();
                },
                onError: () => haptics.warning(),
              },
            )
          }
        />
      </View>
    </Sheet>
  );
}

/**
 * The unread nudge under the linked surface, as on the web (ADR 0234): its switch, then its delay and quiet hours,
 * each picked in the app's sheet and saved at once.
 */
function NudgeRows({ link, surface, assistant }: { link: SurfaceLink; surface: string; assistant: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useSetSurfaceNudge();
  const { nudge } = link;
  const change = (input: Partial<SurfaceLink["nudge"]>) =>
    save.mutate({ linkId: link.id, ...input }, { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) });
  const hours = DAY_HOURS.map((h) => ({ key: String(h), label: hourLabel(i18n.language, h) }));
  const pickAfter = async () => {
    const key = await pickOne({
      title: t("surface.nudge.after"),
      value: String(nudge.afterHours),
      options: NUDGE_AFTER_HOURS.map((h) => ({ key: String(h), label: t("surface.nudge.hours", { hours: h }) })),
    });
    if (key) change({ afterHours: Number(key) });
  };
  const pickQuiet = async () => {
    const from = await pickOne({ title: t("surface.nudge.quietFrom"), value: String(nudge.quietFrom), options: hours });
    if (!from) return;
    const to = await pickOne({ title: t("surface.nudge.quietTo"), value: String(nudge.quietTo), options: hours });
    if (to) change({ quietFrom: Number(from), quietTo: Number(to) });
  };
  const title = t("surface.nudge.title");
  const quiet = t("surface.nudge.quiet");
  return (
    <>
      <GroupedRow
        icon="bell"
        label={title}
        labelLines={0}
        hint={{ name: t("common.about", { label: title }), text: t("surface.nudge.hint", { assistant, surface }) }}
        toggle={nudge.on}
        disabled={save.isPending}
        onPress={() => change({ on: !nudge.on })}
      />
      {nudge.on && (
        <>
          <GroupedRow
            icon="clock"
            label={t("surface.nudge.after")}
            value={t("surface.nudge.hours", { hours: nudge.afterHours })}
            menu
            disabled={save.isPending}
            onPress={() => void pickAfter()}
          />
          <GroupedRow
            icon="mute"
            label={quiet}
            value={quietHoursText(t, i18n.language, nudge)}
            hint={{ name: t("common.about", { label: quiet }), text: t("surface.nudge.quietHint") }}
            menu
            disabled={save.isPending}
            onPress={() => void pickQuiet()}
          />
        </>
      )}
    </>
  );
}

/**
 * Linking, two steps in one sheet: "Open <surface>" with the code under it (renewed before it runs out), waiting for
 * the surface to bring it back; then the sender to confirm, with the consent line right over Confirm. The live event
 * moves it on, and so do a read every few seconds while it waits and one when the app comes back to the front.
 */
function SurfaceLinkSheet({
  open,
  onClose,
  row,
}: {
  open: boolean;
  onClose: () => void;
  row: Exclude<SurfaceRow, { kind: "hidden" }>;
}) {
  const { data } = useSurfaceLinks();
  const [linked, setLinked] = useState<SurfaceLink | null>(null);
  // The active links when the sheet opened: one more, confirmed on another device, ends it as linked.
  const [before, setBefore] = useState<string[] | null>(null);
  useEffect(() => {
    if (open && data) setBefore((b) => b ?? data.links.filter((l) => l.status === "active").map((l) => l.id));
  }, [open, data]);
  const done = linked ?? (before && newlyLinked(data, before));
  // Cleared once the sheet is gone, so the linked step stays on screen while it slides away.
  return (
    <Sheet
      open={open}
      onClose={onClose}
      onGone={() => {
        setLinked(null);
        setBefore(null);
      }}
    >
      <LinkSteps row={row} linked={done} onLinked={setLinked} onClose={onClose} />
    </Sheet>
  );
}

function LinkSteps({
  row,
  linked,
  onLinked,
  onClose,
}: {
  row: Exclude<SurfaceRow, { kind: "hidden" }>;
  linked: SurfaceLink | null;
  onLinked: (link: SurfaceLink) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const links = useSurfaceLinks();
  const step = linkStep(row, Boolean(linked));
  // The link answers in its own workspace, which may not be the one the phone is in (a code made elsewhere).
  const linkOrg = (linked ?? (row.kind === "pending" ? row.link : null))?.orgId ?? orgId;
  const assistant = linkAssistant(useAgents(linkOrg), t("rightHand.labelCapitalized"));
  // The failure of the last action, said in whichever step follows it (a refused confirm lands back on the code).
  const [error, setError] = useState<string | null>(null);
  // A confirm step that ran out falls back to a fresh code, saying why.
  const pendingLink = row.kind === "pending" ? row.link : null;
  const lastPending = useRef<SurfaceLink | null>(null);
  useEffect(() => {
    const last = lastPending.current;
    lastPending.current = pendingLink;
    if (!pendingLink && last && linkRanOut(last, Date.now())) setError(t("errors.surface.linkGone"));
  }, [pendingLink, t]);
  const active = useAppActive();
  const waiting = step === "code";
  const { refetch } = links;
  useEffect(() => {
    if (!waiting || !active) return;
    void refetch();
    const timer = setInterval(() => void refetch(), LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, active, refetch]);

  if (step === "linked" && linked)
    return (
      <View style={styles.col}>
        <Text variant="title">{t("surface.link.doneTitle", { surface: row.surface })}</Text>
        <Text variant="body" tone="muted">
          {t("surface.link.doneText", { assistant: assistant ?? t("rightHand.labelCapitalized") })}
        </Text>
        <Button variant="primary" wide label={t("mobile.common.done")} onPress={onClose} />
      </View>
    );
  if (step === "confirm" && row.kind === "pending")
    return (
      <ConfirmStep
        surface={row.surface}
        link={row.link}
        assistant={assistant}
        error={error}
        setError={setError}
        onLinked={onLinked}
      />
    );
  return <CodeStep surface={row.surface} assistant={assistant} error={error} setError={setError} />;
}

function CodeStep({
  surface,
  assistant,
  error,
  setError,
}: {
  surface: string;
  assistant: string | null;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const mint = useMintSurfaceCode();
  const [code, setCode] = useState<{ made: SurfaceLinkCode; deadline: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // A repaint every second for the countdown; the time itself is read just below.
  const now = useNow(1000);
  const stale = codeIsStale(code?.deadline ?? null, now);
  const { mutate, isPending } = mint;
  const make = () => {
    setFailed(false);
    mutate(orgId, {
      onSuccess: (made) => setCode({ made, deadline: codeDeadline(made, Date.now()) }),
      onError: (e) => {
        setFailed(true);
        setError(errorText(t, e));
      },
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new code only when the shown one is gone or ending
  useEffect(() => {
    if (stale && !isPending && !failed) make();
  }, [stale, isPending, failed]);

  return (
    <View style={styles.col}>
      <Text variant="title">
        {t("surface.link.title", { assistant: assistant ?? t("rightHand.labelCapitalized"), surface })}
      </Text>
      <Text variant="body" tone="muted">
        {t("mobile.surface.codeText")}
      </Text>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {code && !failed ? (
        <>
          <Button
            variant="primary"
            wide
            wrap
            label={t("surface.link.open", { surface })}
            onPress={() => {
              setError(null);
              void Linking.openURL(code.made.openUrl).catch(() =>
                setError(t("mobile.surface.openFailed", { surface })),
              );
            }}
          />
          <View style={styles.code}>
            <Text variant="small" tone="muted">
              {t("mobile.surface.orType")}
            </Text>
            <Text selectable style={[styles.mono, { color: c.ink }]}>
              {code.made.code}
            </Text>
            <Text variant="small" tone="faint">
              {codeLeftText(t, code.deadline, now)}
            </Text>
          </View>
        </>
      ) : failed ? (
        <Button
          variant="secondary"
          wide
          label={t("mobile.common.retry")}
          loading={isPending}
          onPress={() => {
            setError(null);
            make();
          }}
        />
      ) : (
        <View style={styles.making}>
          <ActivityIndicator color={c.muted} />
          <Text variant="small" tone="muted">
            {t("openOnPhone.making")}
          </Text>
        </View>
      )}
    </View>
  );
}

function ConfirmStep({
  surface,
  link,
  assistant,
  error,
  setError,
  onLinked,
}: {
  surface: string;
  link: SurfaceLink;
  assistant: string | null;
  error: string | null;
  setError: (error: string | null) => void;
  onLinked: (link: SurfaceLink) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const confirm = useConfirmSurfaceLink();
  const remove = useRemoveSurfaceLink();
  const yes = () => {
    setError(null);
    confirm.mutate(link.id, {
      onSuccess: (done) => {
        haptics.success();
        onLinked(done);
      },
      onError: (e) => {
        haptics.warning();
        setError(errorText(t, e));
      },
    });
  };
  const qc = useQueryClient();
  // The sender's pending link ends, out of the cache too so its card never comes back, and the sheet goes back to a
  // fresh code.
  const notMe = () => {
    const fresh = () => {
      qc.setQueryData<SurfaceLinks>(
        keys.surfaceLinks,
        (d) => d && { ...d, links: d.links.filter((l) => l.id !== link.id) },
      );
      setError(null);
    };
    remove.mutate(link.id, {
      onSuccess: fresh,
      onError: (e) => (errorCode(e) === "surface.link_gone" ? fresh() : setError(errorText(t, e))),
    });
  };
  const sender = surfaceSenderText(link);
  return (
    <View style={styles.col}>
      <Text variant="title">{t("surface.link.confirmTitle", { surface })}</Text>
      <View style={[styles.sender, { backgroundColor: c.sunken }]}>
        <Text variant="small" tone="muted">
          {t("surface.link.sentBy")}
        </Text>
        {sender.display ? (
          <Text variant="body" selectable style={styles.strong}>
            {sender.display}
          </Text>
        ) : null}
        {sender.profileName ? (
          <Text variant="body" tone="ink2" selectable>
            {sender.profileName}
          </Text>
        ) : null}
      </View>
      <Text variant="body" tone="muted">
        {t("surface.link.onlyYou")}
      </Text>
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {assistant ? (
        <Text variant="small" tone="muted">
          {t("surface.link.consent", { assistant, surface })}
        </Text>
      ) : (
        <ActivityIndicator color={c.muted} />
      )}
      <Button
        variant="primary"
        wide
        label={t("surface.link.confirm")}
        loading={confirm.isPending}
        disabled={!assistant || remove.isPending}
        onPress={yes}
      />
      <Button
        variant="ghost"
        wide
        label={t("surface.link.notMe")}
        loading={remove.isPending}
        disabled={confirm.isPending}
        onPress={notMe}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 16 },
  code: { alignItems: "center", gap: 4 },
  mono: { fontFamily: MONO, fontSize: 22, letterSpacing: 2 },
  making: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48 },
  sender: { borderRadius: 14, padding: 16, gap: 4 },
  strong: { fontWeight: "600" },
  pin: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  pinInput: { fontSize: 22, letterSpacing: 6, minHeight: 48 },
});
