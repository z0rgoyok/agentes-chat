import { useChannels, useDms, useSetChatPrefs, useSetConversationWallpaper } from "@agenteschat/client";
import { chatLookOf, textSizeOf } from "@agenteschat/client/lib/chat-look";
import {
  conversationWallpaperOf,
  defaultWallpaperOf,
  hasWallpaper,
  NO_WALLPAPER,
  resolveWallpaper,
  sameWallpaper,
  WALLPAPER_FAMILIES,
  type Wallpaper,
  type WallpaperHue,
  wallpaperHueOf,
} from "@agenteschat/client/lib/wallpaper";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { WALLPAPER_LIFT, WALLPAPER_PAGE } from "@agenteschat/ui/sky/wallpaper";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Icon,
  PressScale,
  SCREEN_X,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { ChatWallpaper, useWallpaperName, WallpaperThumb } from "../chat/ChatWallpaper";
import { bubbleFill } from "../chat/logic";
import { type WallpaperTarget, wallpaperHrefs, wallpaperKey } from "../chat/wallpaper-logic";
import { pickWallpaperPhoto, setPickedWallpaperPhoto } from "../chat/wallpaper-photo";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { ChatPreview, SAMPLE_HUE } from "./ChatLookPage";

/** Between the tiles, across and down. */
const GAP = 10;
/** A tile's width to its height, a phone's screen in small (as the design). */
const TILE_ASPECT = 0.64;
const FAMILIES = [
  { key: "sky", tiles: WALLPAPER_FAMILIES.sky },
  { key: "drawings", tiles: WALLPAPER_FAMILIES.drawings },
  { key: "color", tiles: WALLPAPER_FAMILIES.color },
] as const;

/**
 * One tile of the picker: the background at a tile's scale with a message from each side over it (theirs lifted, mine
 * in my bubble's color), a ring with a gap and a check on the one chosen. A tap applies it at once.
 */
function Tile({
  shows,
  on,
  label,
  mine,
  width,
  onPress,
}: {
  /** The background as the tile paints it ("auto" left as bands of colors where no one conversation gives it one). */
  shows: Wallpaper;
  on: boolean;
  label: string;
  /** My bubble's color here. */
  mine: string;
  width: number;
  onPress: () => void;
}) {
  const { colors, scheme } = useTheme();
  const height = Math.round(width / TILE_ASPECT);
  return (
    // The press scales; the pick's own selection tick is its haptic.
    <PressScale
      haptic={false}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={{ width, height }}
    >
      <View style={[styles.tile, { width, height, backgroundColor: WALLPAPER_PAGE[scheme] }]}>
        <ChatWallpaper wallpaper={shows} width={width} height={height} tile />
        <View style={[styles.mini, styles.miniTheirs, { backgroundColor: WALLPAPER_LIFT[scheme] }]} />
        <View style={[styles.mini, styles.miniMine, { backgroundColor: mine }]} />
        <View pointerEvents="none" style={[styles.edge, { borderColor: colors.line2 }]} />
      </View>
      {on ? (
        <>
          <View pointerEvents="none" style={[styles.ring, { borderColor: colors.ink }]} />
          <View
            pointerEvents="none"
            style={[styles.tick, { backgroundColor: colors.ink, borderColor: colors.grouped }]}
          >
            <Icon name="check" size={13} color={colors.raised} />
          </View>
        </>
      ) : null}
    </PressScale>
  );
}

/**
 * Background: the one behind every conversation (from You › Conversations), or one conversation's own (from its
 * options, with "Same as other conversations" on top to undo it). A preview of the look on top, then every
 * background by family, each tile applying at once (the preview follows), and a photo from the phone's library last.
 * Mine alone, on every device.
 */
export function WallpaperPage({ target }: { target: WallpaperTarget }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { colors, scheme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { orgId, org } = useOrg();
  const prefs = org?.chatPrefs;
  const setPrefs = useSetChatPrefs(orgId);
  const setOwn = useSetConversationWallpaper(orgId);
  const nameOf = useWallpaperName();
  const dir = useDirectory();
  const dms = useDms(orgId);
  const channels = useChannels(orgId);
  const one = "channelId" in target ? target.channelId : null;
  const dmRow = one ? dms.data?.find((d) => d.channelId === one) : undefined;
  const channel = one ? channels.data?.find((c) => c.id === one) : undefined;
  // For every conversation the preview is a DM with the sample's agent; names say what "auto" is (null: each one's own).
  const dm = one ? Boolean(dmRow) : true;
  const scope = one ? dm : null;
  const agent = dmRow?.with.type === "agent" ? dir.agentById.get(dmRow.with.id) : undefined;
  // The DM's agent, or the sample's for every conversation: my bubbles' color, and what "auto" takes.
  const color: AgentColorName = agent ? agentLook(agent).color : SAMPLE_HUE;
  const sampleHue = one ? null : SAMPLE_HUE;
  const ownHue: WallpaperHue | null = !dm ? null : agent ? wallpaperHueOf(color) : sampleHue;
  // For every conversation "auto" follows each one: its tile shows a band of a few agents' colors.
  const autoBands = !one;
  const { style, tone } = chatLookOf(prefs, dm, isPersonal(org), "phone");
  const mine = bubbleFill(dm ? color : "sky", tone, colors.bg, scheme === "dark");
  const others = defaultWallpaperOf(prefs);
  const own = one ? conversationWallpaperOf(prefs, one) : undefined;
  // What is checked: this conversation's own choice (none: "Same as other conversations"), or the one for all.
  const chosen = one ? own : others;
  const shown = resolveWallpaper(own ?? others, ownHue);
  const [preparing, setPreparing] = useState(false);

  const failed = () => toast({ title: t("settings.account.chat.wallpaper.failed"), icon: "x" });
  const apply = (w: Wallpaper | null) => {
    if (one) setOwn.mutate({ channelId: one, wallpaper: w }, { onError: failed });
    else if (w) setPrefs.mutate({ wallpaper: w }, { onError: failed });
  };
  const pick = (w: Wallpaper | null) => {
    if (w ? sameWallpaper(chosen, w) : chosen === undefined) return;
    haptics.selection();
    apply(w);
  };
  const choosePhoto = async () => {
    if (preparing) return;
    setPreparing(true);
    try {
      const photo = await pickWallpaperPhoto(target);
      if (photo === "failed") toast({ title: t("mobile.app.failed"), icon: "x" });
      else if (photo) {
        setPickedWallpaperPhoto(photo);
        router.push(wallpaperHrefs.photo);
      }
    } finally {
      setPreparing(false);
    }
  };

  const name = dmRow ? dmRow.with.name : channel ? `#${channel.name}` : "";
  const title = t("settings.account.chat.wallpaper.title");
  const sub = one ? t("settings.account.chat.wallpaper.onlyHere", { name }) : t("settings.account.chat.wallpaper.help");
  const skyHelp = !one
    ? t("settings.account.chat.wallpaper.skyAutoHelp")
    : dm
      ? t("settings.account.chat.wallpaper.skyAutoHelpDms")
      : t("settings.account.chat.wallpaper.skyAutoHelpChannels");
  const tileWidth = Math.floor((screenWidth - SCREEN_X * 2 - GAP * 3) / 4);
  const photoOn = chosen?.kind === "photo" ? chosen : null;
  return (
    <PushedLargeTitle title={title} grouped>
      <View style={styles.body}>
        <Text variant="subhead" tone="faint">
          {sub}
        </Text>
        <View style={styles.previewGap} />
        <ChatPreview style={style} tone={tone} size={textSizeOf(prefs)} dm={dm} wallpaper={shown} color={color} />
        <View style={styles.listGap} />
        <GroupedList>
          {one ? (
            <GroupedRow
              label={t("settings.account.chat.wallpaper.sameAsOthers")}
              value={nameOf(others, scope)}
              {...(hasWallpaper(others)
                ? { valueLeading: <WallpaperThumb wallpaper={resolveWallpaper(others, ownHue)} /> }
                : {})}
              checked={own === undefined}
              onPress={() => pick(null)}
            />
          ) : null}
          <GroupedRow
            label={t("settings.account.chat.wallpaper.none")}
            checked={chosen?.kind === "none"}
            onPress={() => pick(NO_WALLPAPER)}
          />
        </GroupedList>
        {FAMILIES.map((family) => (
          <View key={family.key}>
            <GroupedHeader>{t(`settings.account.chat.wallpaper.${family.key}`)}</GroupedHeader>
            <View style={styles.grid} accessibilityRole="radiogroup">
              {family.tiles.map((w) => (
                <Tile
                  key={wallpaperKey(w)}
                  shows={autoBands ? w : resolveWallpaper(w, ownHue)}
                  on={sameWallpaper(chosen, w)}
                  label={nameOf(w, scope)}
                  mine={mine}
                  width={tileWidth}
                  onPress={() => pick(w)}
                />
              ))}
            </View>
            {family.key === "sky" ? <GroupedFooter>{skyHelp}</GroupedFooter> : null}
          </View>
        ))}
        <GroupedHeader>{t("settings.account.chat.wallpaper.photos")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            icon="image"
            label={t("settings.account.chat.wallpaper.choosePhoto")}
            {...(photoOn
              ? { value: nameOf(photoOn, scope), valueLeading: <WallpaperThumb wallpaper={photoOn} /> }
              : {})}
            chevron
            disabled={preparing}
            onPress={() => void choosePhoto()}
          />
        </GroupedList>
      </View>
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  previewGap: { height: 16 },
  listGap: { height: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  tile: { borderRadius: 12, overflow: "hidden" },
  edge: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // A message from each side, as the design's: theirs higher on the left, mine lower on the right.
  mini: { position: "absolute", height: 10, borderRadius: 5, boxShadow: "0px 0px 0px 0.5px rgba(0, 0, 0, 0.08)" },
  miniTheirs: { left: 7, bottom: 36, width: "58%" },
  miniMine: { right: 7, bottom: 20, width: "44%" },
  // The chosen tile: a 2-point ring of ink, 2 points off its edge (the page shows through the gap).
  ring: { position: "absolute", top: -4, left: -4, right: -4, bottom: -4, borderRadius: 16, borderWidth: 2 },
  tick: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
