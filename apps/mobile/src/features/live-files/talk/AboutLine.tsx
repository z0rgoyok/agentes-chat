import type { ArtifactAuthor, ArtifactDetail, LiveKind, LiveRef } from "@agenteschat/client";
import { useArtifact } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { memo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName, Text, TOUCH } from "@/ui";
import { router } from "@/ui/navigation";
import { useRowDirectory, useRowMeId } from "../../chat/row-data";
import { chatHref } from "../../links/logic";
import { useColors, useOrgId } from "../../shared/hooks";
import { LIVE_ICON } from "../routes";
import { useOpenLiveRef } from "./hooks";
import { aboutParts, aboutWords } from "./logic";

/*
 * What the chat draws of a live file's conversation (ADR 0199): the line over a message about part of a file, the
 * quote over the composer, and where the file was made, at the top of its conversation.
 */

/** The line's height: 12 above and below make the 44 a finger needs. */
const LINE = 20;
const X = 16;

/** A comment pinned on a canvas wears the conversation's mark; anything else, its file's kind. */
const aboutIcon = (ref: Pick<LiveRef, "kind" | "selection">): IconName =>
  ref.selection?.point && !ref.selection.shapes?.length ? "chat" : LIVE_ICON[ref.kind];

/**
 * The line over a message about part of a file (`liveRef`): the kind's icon, what in bold, where quietly ("C2:D6"
 * "Custos"); my own message's on the right, over my bubble. A tap shows that part in the file.
 */
export function LiveAboutLine({
  liveRef,
  end = false,
  onOpen,
}: {
  liveRef: LiveRef;
  end?: boolean;
  onOpen?: (ref: LiveRef) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { what, where } = aboutParts(t, liveRef);
  return (
    <Pressable
      onPress={() => onOpen?.(liveRef)}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={t("live.conversation.aboutLine", { what, where })}
      hitSlop={{ top: (TOUCH - LINE) / 2, bottom: (TOUCH - LINE) / 2 }}
      style={({ pressed }) => [styles.line, end && styles.end, pressed && styles.pressed]}
    >
      <Icon name={aboutIcon(liveRef)} size={13} color={c.faint} />
      <Text variant="caption" tone="ink2" numberOfLines={1} style={styles.what}>
        {what}
      </Text>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.where}>
        {where}
      </Text>
    </Pressable>
  );
}

/** A message's line about its file, in a conversation: a tap shows that part on the file's screen. */
export function MessageAbout({ liveRef, messageId, end }: { liveRef: LiveRef; messageId: string; end?: boolean }) {
  const open = useOpenLiveRef();
  return <LiveAboutLine liveRef={liveRef} end={end ?? false} onOpen={(ref) => open(ref, messageId)} />;
}

/** "About C2:D6 in Costs" over the field, as "Replying to" looks; its × leaves the selection out. */
export function LiveQuoteBar({ liveRef, onDrop }: { liveRef: LiveRef; onDrop: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const selection = liveRef.selection;
  return (
    <View style={[styles.bar, { backgroundColor: c.sunken }]}>
      <Icon name={aboutIcon(liveRef)} size={16} color={c.muted} />
      <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.barWords}>
        {selection ? aboutWords(t, liveRef.kind, selection) : liveRef.title}
      </Text>
      <Pressable
        onPress={onDrop}
        accessibilityRole="button"
        accessibilityLabel={t("live.conversation.drop")}
        // A 16-point ×: 14 around it makes the 44 a finger needs.
        hitSlop={(TOUCH - X) / 2}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Icon name="x" size={X} color={c.muted} />
      </Pressable>
    </View>
  );
}

/** Where the file lives, as a conversation the phone opens: null when it lives in none this person reads. */
function placeOf(
  a: Pick<ArtifactDetail, "channelId" | "threadId" | "audience" | "createdBy">,
  meId: string | null,
  nameOf: (who: ArtifactAuthor) => string,
  t: (key: string, o?: Record<string, unknown>) => string,
): { words: string; href: ReturnType<typeof chatHref> | null } | null {
  if (!a.channelId) return null;
  const aud = a.audience;
  const reachable = !(aud.kind === "channel" && aud.outside) && !(aud.kind === "dm" && (aud.between || aud.gone));
  const href = reachable ? chatHref(a.channelId, a.threadId) : null;
  if (aud.kind === "channel") return { words: t("live.shell.meta.inChannel", { channel: aud.name }), href };
  if (aud.kind === "dm") {
    if (aud.between?.length) {
      return { words: t("live.shell.meta.between", { names: joinNames(aud.between.map(nameOf), t as never) }), href };
    }
    // The DM's other side as its maker sees it: the agent made it in the DM with me, so it's my conversation.
    const by = a.createdBy;
    const other: ArtifactAuthor | null =
      aud.with && (aud.with.type !== by.type || aud.with.id !== by.id)
        ? aud.with
        : meId
          ? { type: "person", id: meId }
          : null;
    return other ? { words: t("live.shell.meta.with", { name: nameOf(other) }), href } : null;
  }
  return { words: t("live.shell.meta.inConversation"), href };
}

/**
 * At the top of a file's conversation: "Atlas made this canvas from the conversation with Ada" (the conversation a
 * link), "Imported from Plan.docx by Ada" for a document opened from an upload.
 */
export const FileOrigin = memo(function FileOrigin({ artifactId, kind }: { artifactId: string; kind: LiveKind }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const file = useArtifact(orgId, artifactId).data;
  if (!file) return <View style={styles.originRoom} />;
  const name = dir.nameOf(file.createdBy);
  const content = file.content;
  const imported = content.kind === "document" ? content.preview?.source?.name : undefined;
  const place = imported ? null : placeOf(file, meId, dir.nameOf, t);
  const bold = <Text key="b" variant="caption" tone="ink2" style={styles.bold} />;
  const what = t(`live.conversation.this.${kind}`);
  const words = imported ? (
    <Trans i18nKey="mobile.live.talk.imported" values={{ name, file: imported }} components={[bold]} />
  ) : place ? (
    <Trans
      i18nKey="live.conversation.origin.from"
      values={{ name, what, place: place.words }}
      components={[
        bold,
        <Text
          key="place"
          variant="caption"
          // A way to the conversation in the words' own ink, underlined: the brand's blue is the agents', not links'.
          style={[styles.bold, place.href ? { color: c.ink2, textDecorationLine: "underline" } : null]}
          {...(place.href
            ? { onPress: () => place.href && router.push(place.href), accessibilityRole: "link" as const }
            : {})}
        />,
      ]}
    />
  ) : (
    <Trans i18nKey="live.conversation.origin.made" values={{ name, what }} components={[bold]} />
  );
  return (
    <View style={styles.origin}>
      <Icon name="link" size={13} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.originWords}>
        {words}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: LINE, maxWidth: "100%" },
  end: { alignSelf: "flex-end" },
  pressed: { opacity: 0.6 },
  what: { flexShrink: 0, maxWidth: "60%", fontWeight: "600" },
  where: { flexShrink: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  barWords: { flex: 1, fontWeight: "600" },
  origin: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  originWords: { flexShrink: 1, textAlign: "center" },
  originRoom: { height: 28 },
  bold: { fontWeight: "600" },
});
