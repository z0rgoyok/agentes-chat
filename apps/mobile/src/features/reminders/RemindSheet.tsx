import { ApiError, type Message, type ReminderInput, useReminderAction } from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Card, Disclosure, Filters, IconButton, type IconName, Locked, Text, useToast } from "@/ui";
import { Face } from "../shared/Face";
import { useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, successHaptic, Tile, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import {
  atDayTime,
  checkWhen,
  dayChoices,
  dayOffsetOf,
  defaultCustom,
  deviceTimezone,
  isoWithOffset,
  MINUTE_STEP,
  type ReminderPreset,
  reminderErrorKey,
  reminderPresets,
  stepTime,
} from "./logic";

const PRESET_ICON: Record<ReminderPreset, IconName> = { inHour: "clock", tonight: "moon", tomorrowMorning: "sun" };

/** "Hoje, 19:00", "Amanhã, 9:00", "sexta, 23 de out., 14:30". */
export function useWhenLabel() {
  const { t } = useTranslation();
  const when = useWhen();
  return (at: Date, now = new Date()) => {
    const time = when.time(at.toISOString());
    const days = dayOffsetOf(at, now);
    if (days === 0) return t("mobile.remind.todayAt", { time });
    if (days === 1) return t("mobile.remind.tomorrowAt", { time });
    const day = new Intl.DateTimeFormat(when.locale, { weekday: "long", day: "numeric", month: "short" }).format(at);
    return t("mobile.remind.dayAt", { day, time });
  };
}

/** Sets a reminder for this conversation: the toast says when, or why it couldn't; `onDone` once it is set. */
function useCreateReminder({
  channelId,
  threadId,
  message,
}: {
  channelId: string;
  threadId: string | null;
  message: Message | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const whenLabel = useWhenLabel();
  const action = useReminderAction(useOrgId());
  const submit = (at: Date, text: string, onDone: () => void) => {
    if (action.isPending) return;
    const check = checkWhen(at, new Date());
    if (check !== "ok") {
      toast({ title: t(`mobile.remind.error.${check}`), icon: "x" });
      return;
    }
    const timezone = deviceTimezone();
    const input: ReminderInput = {
      channelId,
      at: isoWithOffset(at),
      ...(threadId ? { threadId } : {}),
      ...(message ? { messageId: message.id } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(timezone ? { timezone } : {}),
    };
    action.mutate(
      { type: "create", input },
      {
        onSuccess: () => {
          onDone();
          successHaptic();
          toast({ title: t("mobile.remind.done"), subtitle: whenLabel(at), icon: "clock" });
        },
        onError: (e) => {
          const key = reminderErrorKey(e instanceof ApiError ? e.code : null);
          toast({ title: t(`mobile.remind.error.${key}`), icon: "x" });
        },
      },
    );
  };
  return { submit, pending: action.isPending };
}

/**
 * "Lembrar": what (a message, or a line of text from the composer; the person taps the field, the keyboard never
 * comes up on its own) and when: a quick time, or "Escolher horário…", the next step as a sheet over this one (a
 * flick down comes back), never this sheet's content swapped in place. An agent of the conversation posts the
 * reminder where it was asked.
 */
export function RemindSheet({
  channelId,
  threadId,
  message = null,
  initialText = "",
}: {
  channelId: string;
  /** The thread on screen (the reminder lands there). */
  threadId: string | null;
  /** "Lembrar disso" on a message: its text is what to remember. */
  message?: Message | null;
  initialText?: string;
}) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const surface = useSurface();
  const whenLabel = useWhenLabel();
  const remind = useCreateReminder({ channelId, threadId, message });
  const [text, setText] = useState(initialText);
  // The quick times are fixed while the sheet is open.
  const now = useMemo(() => new Date(), []);
  const presets = useMemo(() => reminderPresets(now), [now]);
  // A message with no text of its own (a request card) still needs a line to remember.
  const needsText = !message || !previewOf(message.body);
  const ready = !needsText || text.trim().length > 0;
  const what = message ? previewOf(textOrMedia(t, message.body, message.meta)) || t("mobile.chat.approvalPreview") : "";

  return (
    <>
      <SheetTitle leading={<Tile icon="clock" />} title={t("mobile.remind.title")} subtitle={t("mobile.remind.sub")} />
      {message ? (
        <View style={[styles.preview, surface]}>
          <Face who={message.author} size={24} live={false} />
          <Text variant="small" tone="ink2" numberOfLines={3} style={styles.grow}>
            {what}
          </Text>
        </View>
      ) : null}
      {needsText ? (
        <Locked when={remind.pending}>
          <TextArea
            value={text}
            onChangeText={setText}
            placeholder={t("mobile.remind.placeholder")}
            accessibilityLabel={t("mobile.remind.what")}
            minHeight={64}
          />
        </Locked>
      ) : null}
      <ActionList
        items={[
          ...presets.map(({ preset, at }) => ({
            key: preset,
            icon: PRESET_ICON[preset],
            label: t(`mobile.remind.preset.${preset}`),
            hint: whenLabel(at, now),
            disabled: !ready || remind.pending,
            onPress: () => remind.submit(at, text, sheet.close),
          })),
          {
            key: "custom",
            icon: "pen" as const,
            label: t("mobile.remind.custom"),
            trailing: <Disclosure />,
            disabled: !ready,
            onPress: () =>
              sheet.push(
                <RemindAt
                  channelId={channelId}
                  threadId={threadId}
                  message={message}
                  text={text}
                  what={text.trim() || what}
                />,
              ),
          },
        ]}
      />
    </>
  );
}

/**
 * "Escolher horário…", over the quick times: the day (today and the next six) and the time, stepped in 15 minutes,
 * said back in words (or why it can't be), and "Lembrar neste horário". Set, every step of the sheet closes.
 */
function RemindAt({
  channelId,
  threadId,
  message,
  text,
  what,
}: {
  channelId: string;
  threadId: string | null;
  message: Message | null;
  /** What was written on the step before. */
  text: string;
  /** What is remembered, under the title. */
  what: string;
}) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const whenLabel = useWhenLabel();
  const { locale } = useWhen();
  const remind = useCreateReminder({ channelId, threadId, message });
  // The days are fixed while the sheet is open.
  const now = useMemo(() => new Date(), []);
  const days = useMemo(() => dayChoices(now, 7), [now]);
  const [custom, setCustom] = useState(() => defaultCustom(now));
  const at = atDayTime(days[custom.dayOffset] ?? now, custom.time);
  const check = checkWhen(at, new Date());
  const moveTime = (minutes: number) => setCustom((cur) => ({ ...cur, time: stepTime(cur.time, minutes) }));
  return (
    <>
      <SheetTitle leading={<Tile icon="clock" />} title={t("mobile.remind.title")} subtitle={what || undefined} />
      <Locked when={remind.pending} style={styles.custom}>
        <Filters
          items={days.map((d, i) => ({
            key: String(i),
            label:
              i === 0
                ? t("mobile.time.today")
                : i === 1
                  ? t("mobile.remind.tomorrow")
                  : new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" }).format(d).replace(".", ""),
          }))}
          value={String(custom.dayOffset)}
          onChange={(key) => setCustom((cur) => ({ ...cur, dayOffset: Number(key) }))}
        />
        <Card>
          <View style={styles.clock}>
            <Stepper
              value={String(custom.time.hour).padStart(2, "0")}
              label={t("mobile.remind.hour")}
              lessLabel={t("mobile.remind.hourLess")}
              moreLabel={t("mobile.remind.hourMore")}
              onLess={() => moveTime(-60)}
              onMore={() => moveTime(60)}
            />
            <Text variant="display" tone="faint">
              :
            </Text>
            <Stepper
              value={String(custom.time.minute).padStart(2, "0")}
              label={t("mobile.remind.minute")}
              lessLabel={t("mobile.remind.minuteLess", { n: MINUTE_STEP })}
              moreLabel={t("mobile.remind.minuteMore", { n: MINUTE_STEP })}
              onLess={() => moveTime(-MINUTE_STEP)}
              onMore={() => moveTime(MINUTE_STEP)}
            />
          </View>
        </Card>
      </Locked>
      <Text variant="small" tone={check === "ok" ? "muted" : "danger"} style={styles.center}>
        {check === "ok" ? whenLabel(at, now) : t(`mobile.remind.error.${check}`)}
      </Text>
      <Button
        variant="primary"
        wide
        icon="clock"
        label={t("mobile.remind.submit")}
        loading={remind.pending}
        disabled={check !== "ok"}
        onPress={() => remind.submit(at, text, sheet.close)}
      />
    </>
  );
}

/** "‹ 14 ›": a number with a step down and up (our buttons, no native picker). */
function Stepper({
  value,
  label,
  lessLabel,
  moreLabel,
  onLess,
  onMore,
}: {
  value: string;
  label: string;
  lessLabel: string;
  moreLabel: string;
  onLess: () => void;
  onMore: () => void;
}) {
  return (
    <View style={styles.stepper}>
      <IconButton icon="back" label={lessLabel} onPress={onLess} />
      <Text
        variant="display"
        style={styles.digits}
        accessibilityLabel={`${label} ${value}`}
        accessibilityLiveRegion="polite"
      >
        {value}
      </Text>
      <IconButton icon="right" label={moreLabel} onPress={onMore} />
    </View>
  );
}

const styles = StyleSheet.create({
  custom: { gap: 12 },
  grow: { flex: 1 },
  center: { textAlign: "center" },
  preview: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 18 },
  clock: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 12 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 2 },
  digits: { minWidth: 48, textAlign: "center", fontVariant: ["tabular-nums"] },
});
