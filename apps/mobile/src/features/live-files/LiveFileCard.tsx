import { type ArtifactDetail, useLivePresence } from "@agenteschat/client";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { LineIcon, MESSAGE_CARD_X, PressScale, Sky, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useMessageCardFrame } from "../chat/look";
import { useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { LIVE_ICON, liveRoute } from "./routes";
import { PresentFaces } from "./shared/HereFaces";
import { LiveCover, liveCoverContent } from "./shared/LiveCover";

/** The cover's height on a message, and on a message holding nothing else. */
const COVER = 132;

/**
 * A live file on its message (ADR 0196 §9), as a block's card is (a hairline, the bottom-left corner cut, the agent's
 * sky along its top when an agent made it): what it holds drawn small from its preview (never the document itself, so
 * a conversation opens no file), its name, its kind and size, and the faces of who is in it now. A tap opens it on its
 * own screen, as it is now. In a message, the message card's corners, as every card there (`useMessageCardCorners`).
 */
export const LiveFileCard = memo(function LiveFileCard({ detail, width }: { detail: ArtifactDetail; width: number }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const card = useMessageCardFrame();
  const orgId = useOrgId();
  const dir = useDirectory();
  const presence = useLivePresence(orgId, [detail.id]);
  const content = liveCoverContent(detail.content);
  if (!content) return null;
  const kind = content.kind;
  // A document (ADR 0200) says only what it is; the others how big they are.
  const meta =
    content.kind === "spreadsheet"
      ? t("mobile.live.card.sheets", { count: content.preview.sheets })
      : content.kind === "slides"
        ? t("mobile.live.card.slides", { count: content.preview.count })
        : content.kind === "canvas"
          ? t("mobile.live.card.shapes", { count: content.preview.count })
          : null;
  const label = meta ? `${t(`artifacts.kind.${kind}`)} · ${meta}` : t(`artifacts.kind.${kind}`);
  const byAgent = detail.createdBy.type === "agent" ? detail.createdBy.id : null;
  return (
    <PressScale
      haptic={false}
      onPress={() => router.push(liveRoute(kind, detail.id))}
      accessibilityRole="button"
      accessibilityLabel={`${detail.title}, ${label}`}
      style={[styles.card, { width }, card.style]}
    >
      <View
        style={[styles.cover, { height: COVER, borderBottomColor: c.line }]}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <LiveCover content={content} width={width} height={COVER} />
        {byAgent ? (
          <Sky
            color={agentLook(dir.agentById.get(byAgent)).color}
            surface="raised"
            depth={0.95}
            fade={0}
            style={styles.sky}
          />
        ) : null}
      </View>
      <View style={styles.foot}>
        {/* On the title's first line, as an attachment's icon: centred on the whole foot it floated between lines. */}
        <LineIcon name={LIVE_ICON[kind]} size={16} color={c.faint} variant="subhead" />
        <View style={styles.words}>
          <Text variant="cardTitle" numberOfLines={2}>
            {detail.title}
          </Text>
          <Text variant="footnote" tone="faint" numberOfLines={1}>
            {label}
          </Text>
        </View>
        <PresentFaces present={presence.data?.[detail.id]} ring={card.fill} />
      </View>
    </PressScale>
  );
});

const styles = StyleSheet.create({
  // A block's card: rounded, the bottom-left corner cut, a hairline.
  card: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  cover: { overflow: "hidden", borderBottomWidth: StyleSheet.hairlineWidth },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 6, opacity: 0.7 },
  foot: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: MESSAGE_CARD_X,
    paddingVertical: 10,
  },
  words: { flex: 1, minWidth: 0 },
});
