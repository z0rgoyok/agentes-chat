import { useNotificationAction, useNotificationReply, useNotifications } from "@agenteschat/client";
import { quickReply } from "@agenteschat/client/lib/notifications";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GroupedList,
  GroupedRow,
  type HeaderAction,
  Locked,
  SCREEN_X,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { notificationHref } from "../links/logic";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { placeOf } from "./logic";
import { OpenItemHead } from "./OpenItem";

/**
 * An agent's question, open from the inbox on a screen of its own: the agent on its sky, who asks and where, the
 * question, and the answers it suggested one a row (a tap answers), then an answer of one's own. Answered, it goes
 * back to the inbox, where the question is gone. `id`: the question's notification.
 */
export function QuestionScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const toast = useToast();
  const deleting = Boolean(useOrg().org?.deletion);
  const list = useNotifications(orgId, "waiting");
  const n = list.data?.pages.flatMap((p) => p.items).find((x) => x.id === id);
  const { mutate: act } = useNotificationAction(orgId);
  const reply = useNotificationReply(orgId);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  // Opened is read.
  const unread = n ? n.readAt === null : false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per question, when it is first read
  useEffect(() => {
    if (n && unread) act({ type: "read", item: n, read: true });
  }, [n?.id, unread]);

  if (!n)
    return (
      <PushedLargeTitle title="" collapsed>
        {list.isPending ? (
          <SkeletonList rows={2} />
        ) : list.isError ? (
          <LoadFailed onRetry={() => void list.refetch()} />
        ) : (
          // Answered somewhere else in the meantime: nothing waits here.
          <EmptyState size="inline" title={t("notifications.noneWaiting")} />
        )}
      </PushedLargeTitle>
    );

  const { target, suggestions, readOnly } = quickReply(n, deleting);
  const actor = n.actors[0];
  const who = actor ? { type: actor.type === "agent" ? ("agent" as const) : ("person" as const), id: actor.id } : null;
  const name = dir.nameOf(who);
  const title = n.latest.title ?? n.latest.text ?? "";
  const context = n.latest.title ? n.latest.text : null;
  const where = [name, placeOf(n), when.short(n.updatedAt)].filter(Boolean).join(" · ");
  const href = notificationHref(n);
  const answer = (text: string, choice = false) => {
    const body = text.trim();
    if (!target || !body || reply.isPending) return;
    reply.mutate(
      { target, text: body, choice },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: choice ? t("island.answered", { choice: body }) : t("island.sent"),
            ...(who?.type === "agent" ? { agentId: who.id } : {}),
          });
          goBack();
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };
  // The conversation it was asked in, one tap away.
  const actions: HeaderAction[] = href
    ? [
        {
          icon: "message",
          sf: "bubble.left",
          label: t("notifications.wait.openThread"),
          onPress: () => router.push(href),
        },
      ]
    : [];
  return (
    <PushedLargeTitle title="" collapsed grouped keyboard actions={actions}>
      <OpenItemHead agentId={who?.type === "agent" ? who.id : null} grouped />
      <View style={styles.in}>
        <View style={styles.words}>
          <Text variant="footnote" tone="muted">
            {where}
          </Text>
          <Text variant="title2">{title}</Text>
          {context ? (
            <Text variant="body" tone="muted">
              {context}
            </Text>
          ) : null}
        </View>
        {readOnly ? (
          <Text variant="footnote" tone="muted">
            {t("deleting.composer")}
          </Text>
        ) : typing || suggestions.length === 0 ? (
          <View style={styles.own}>
            <Locked when={reply.isPending}>
              <TextArea
                value={draft}
                onChangeText={setDraft}
                placeholder={t("island.placeholder")}
                accessibilityLabel={t("island.reply")}
                autoFocus={typing}
              />
            </Locked>
            <Button
              variant="primary"
              wide
              label={t("island.send")}
              loading={reply.isPending}
              disabled={!draft.trim()}
              onPress={() => answer(draft)}
            />
          </View>
        ) : (
          <GroupedList>
            {suggestions.map((s) => (
              <GroupedRow key={s} label={s} labelLines={3} disabled={reply.isPending} onPress={() => answer(s, true)} />
            ))}
            <GroupedRow
              label={t("ask.otherAnswer")}
              chevron
              disabled={reply.isPending}
              onPress={() => setTyping(true)}
            />
          </GroupedList>
        )}
      </View>
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  in: { paddingHorizontal: SCREEN_X, paddingTop: 12, gap: 24 },
  words: { gap: 6 },
  own: { gap: 12 },
});
