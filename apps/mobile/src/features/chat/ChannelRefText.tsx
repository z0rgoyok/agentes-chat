import {
  type Channel,
  channelsQuery,
  useApi,
  useArchivedChannels,
  useChannelCard,
  useJoinChannel,
  useUnarchiveChannel,
} from "@agenteschat/client";
import { joinable } from "@agenteschat/client/lib/channel-access";
import { channelCardFacts, resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { errorText } from "@agenteschat/client/lib/errors";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, View } from "react-native";
import { Button, Icon, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";

const NO_CHANNELS: Channel[] = [];

/**
 * `#name` in a message (the web's `ChannelRef`): a tap opens the channel it means, a long press shows its card
 * (topic, counts, Join or Open). A channel the viewer can't see stays the text as written; an archived one is
 * struck through and says so.
 */
export function ChannelRefText({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const orgId = useOrgId();
  const api = useApi();
  const sheet = useSheetIfAny();
  // Only the channel this name means from the list: the list is read again for a message anywhere in the workspace.
  const resolve = useCallback((all: Channel[]) => resolveChannelRef(name, refs, all), [name, refs]);
  const resolved = useQuery({ ...channelsQuery(api, orgId), select: resolve });
  // Before the list loads, as against an empty one.
  const ref = resolved.data === undefined ? resolveChannelRef(name, refs, NO_CHANNELS) : resolved.data;
  const lookup = useChannelCard(orgId, ref?.id ?? "", Boolean(ref && !ref.known));
  if (!ref || (!ref.known && !lookup.data)) return <RNText>{text}</RNText>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  const id = ref.id;
  const archived = !ref.known && lookup.data?.archived === true;
  const openCard = () => {
    if (sheet) sheet.open(<ChannelCardSheet channelId={id} name={shown} archived={archived} onDone={sheet.close} />);
  };
  const card = sheet
    ? {
        onLongPress: openCard,
        accessibilityActions: [{ name: "longpress", label: t("channelRefs.card", { name: shown }) }],
        onAccessibilityAction: openCard,
      }
    : {};
  if (archived) {
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={t("mobile.channelRef.archivedA11y", { name: shown })}
        onPress={() => toast({ title: t("mobile.channelRef.archived", { name: shown }), icon: "archive" })}
        {...card}
        style={[styles.ref, styles.archived, { color: c.muted }]}
      >
        #{shown}
      </RNText>
    );
  }
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("mobile.channelRef.a11y", { name: shown })}
      onPress={() => router.push(chatHref(id))}
      {...card}
      style={[styles.ref, { color: c.ink }]}
    >
      #{shown}
    </RNText>
  );
}

/**
 * A channel's card in a sheet: what it is, who is in it, and Join or Open (the web's hover card); an archived one, Restaurar
 * for who may bring it back. Its name and Open show at once (the message already knows them); what the card adds (its
 * facts, its topic, Join) comes in when it loads, never a spinner in their place.
 */
function ChannelCardSheet({
  channelId,
  name,
  archived: archivedHere,
  onDone,
}: {
  channelId: string;
  /** The name the message shows, until the card says its own. */
  name: string;
  /** Known archived already (the message's pill is struck through): no Open while the card loads. */
  archived: boolean;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const card = useChannelCard(orgId, channelId);
  const join = useJoinChannel(orgId, channelId);
  const restorable = useArchivedChannels(orgId, card.data?.archived === true).data?.some((x) => x.id === channelId);
  const restore = useUnarchiveChannel(orgId);
  const c = card.data;
  const openIt = () => {
    onDone();
    router.push(chatHref(channelId));
  };
  if (!c) {
    return (
      <>
        <SheetTitle
          leading={<Icon name={archivedHere ? "archive" : "hash"} size={20} />}
          title={`#${name}`}
          {...(card.isError ? { subtitle: t("channelRefs.gone") } : {})}
        />
        {card.isError || archivedHere ? null : (
          <View style={styles.actions}>
            <Button variant="secondary" wide label={t("channelRefs.open")} onPress={openIt} />
          </View>
        )}
      </>
    );
  }
  return (
    <>
      <SheetTitle
        leading={<Icon name={c.archived ? "archive" : c.visibility === "private" ? "lock" : "hash"} size={20} />}
        title={`#${c.name}`}
        subtitle={c.archived ? `${t("channelRefs.archived")} · ${channelCardFacts(t, c)}` : channelCardFacts(t, c)}
      />
      {c.topic ? <Text variant="body">{c.topic}</Text> : null}
      {c.archived && restorable ? (
        <View style={styles.actions}>
          <Button
            variant="secondary"
            wide
            label={t("channel.restore")}
            loading={restore.isPending}
            onPress={() =>
              restore.mutate(channelId, {
                onSuccess: () => {
                  toast({ title: t("channel.restored", { channel: c.name }), icon: "check" });
                  openIt();
                },
                onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
              })
            }
          />
        </View>
      ) : null}
      {c.archived ? null : (
        <View style={styles.actions}>
          {joinable(c) ? (
            <Button
              variant="primary"
              wide
              label={t("channelRefs.join")}
              loading={join.isPending}
              onPress={() =>
                join.mutate(undefined, {
                  onSuccess: openIt,
                  onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
                })
              }
            />
          ) : null}
          <Button variant="secondary" wide label={t("channelRefs.open")} onPress={openIt} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "700" },
  archived: { textDecorationLine: "line-through" },
  actions: { gap: 8 },
});
