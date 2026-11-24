import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { NativeTabs } from "expo-router/native-tabs";
import { memo, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { useUnreadConversations, useUnreadThreads, useWaitingCount } from "@/features/shared/queries";
import { ALONG_STRIP, alongInAccessory } from "@/features/work-along/logic";
import { AccessoryLine, AlongStrip, useHasWorkAlong } from "@/features/work-along/WorkAlong";
import { TAB_BADGE, tabBadge } from "@/lib/nav";
import { useOrg } from "@/providers/org";
import { type SFSymbolName, TabFoot, useTheme } from "@/ui";
import { type TabGlyph, tabGlyphKey } from "@/ui/tabGlyphs";
import { tabGlyphFamily } from "@/ui/tabIcons";

/**
 * The tabs. `sf`: the system's symbols on iOS, outline and filled when selected (as the system's own apps); Agentes
 * keeps our agent, which the system has no drawing of. Android draws our glyphs.
 */
const TABS: {
  name: string;
  glyph: TabGlyph;
  label: string;
  sf?: { default: SFSymbolName; selected: SFSymbolName };
  role?: "search";
  teamOnly?: true;
}[] = [
  {
    name: "(chats)",
    glyph: "chats",
    label: "mobile.tabs.chats",
    sf: { default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" },
  },
  // A conversation that branches is rare for one person: a personal workspace (ADR 0159) opens Threads from You › Work.
  {
    name: "threads",
    glyph: "threads",
    label: "mobile.tabs.threads",
    sf: { default: "bubble.left.and.text.bubble.right", selected: "bubble.left.and.text.bubble.right.fill" },
    teamOnly: true,
  },
  { name: "agents", glyph: "agents", label: "mobile.tabs.agents" },
  {
    name: "activity",
    glyph: "activity",
    label: "mobile.tabs.activity",
    sf: { default: "tray", selected: "tray.fill" },
  },
  // The search role: on iOS 26 the round button apart at the bar's end (like Music); a plain tab on Android. The
  // magnifier never fills, as the system's search tab.
  {
    name: "search",
    glyph: "search",
    label: "mobile.tabs.search",
    sf: { default: "magnifyingglass", selected: "magnifyingglass" },
    role: "search",
  },
];

/** Each tab's glyph, outline and filled when selected, made once: the bar is not handed new icons on every draw. */
const ICONS = Object.fromEntries(
  TABS.map((tab) => [
    tab.name,
    {
      default: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, false)} />,
      selected: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, true)} />,
    },
  ]),
);

/** iOS 26 holds the work-along line in the bar's own accessory; elsewhere it is a strip on the tab roots. */
const ACCESSORY = alongInAccessory(Platform.OS, Platform.Version);

/** What the bar shows besides its tabs: each badge's count, and whether a work line goes along. */
interface BarState {
  chats: number;
  threads: number;
  waiting: number;
  along: boolean;
}

const QUIET_BAR: BarState = { chats: 0, threads: 0, waiting: 0, along: false };

/**
 * Reads what the bar shows, in a leaf of its own that draws nothing. The lists behind it (conversations, threads,
 * runs) refresh at every message and step: each refresh redraws this leaf alone, and the layout (and the system bar
 * it configures) only when a count or the line itself changes. Handed over before the frame is shown, so a badge
 * never comes in a frame late.
 */
const BarSources = memo(function BarSources({ onChange }: { onChange: (bar: BarState) => void }) {
  const chats = useUnreadConversations();
  const threads = useUnreadThreads();
  const waiting = useWaitingCount();
  // Long work and what waits on you go with you across the tabs, the phone's Agora (iOS 26: the bar's accessory, the
  // system's glass; Android and older iOS: a strip over the bar, on the tab roots). "Esperando você" only where
  // something really waits on me (the home's strip and Atividade read the same list). The layout only knows whether
  // there is a line: the line reads its own words and clock, so its ticks never redraw the tab bar.
  const along = useHasWorkAlong();
  useLayoutEffect(() => onChange({ chats, threads, waiting, along }), [onChange, chats, threads, waiting, along]);
  return null;
});

/**
 * Conversas (the home), Threads (threads and missions), Agentes, Atividade and Buscar in the system tab bar
 * (UITabBarController on iOS, Liquid Glass on iOS 26; Material bottom navigation on Android). The system's symbols on
 * iOS (Agentes: our agent) and our own glyphs on Android, outline, filled when selected, as template images the bar
 * tints. Badges for unread conversations (Conversas: channels
 * and DMs; Threads: its rows, never both) and what waits on you. Every tab holds a stack with a native header. A
 * personal workspace (ADR 0159) leaves Threads out of the bar (`hidden`, the system bar's own way: changing it redraws
 * the tabs from Conversas); its row in You › Work opens the same list, pushed. A tab change is the system's own: no
 * animation and no haptic of ours (the system tab bars give none).
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const personal = isPersonal(useOrg().org);
  const [bar, setBar] = useState(QUIET_BAR);
  const { along } = bar;
  const counts: Record<string, number> = { "(chats)": bar.chats, threads: bar.threads, activity: bar.waiting };
  const foot = useMemo(() => (along && !ACCESSORY ? { node: <AlongStrip />, height: ALONG_STRIP } : null), [along]);
  // The bar's colors, built once per theme (the system bar is configured again whenever these change).
  const look = useMemo(
    () => ({
      iconColor: { default: colors.faint, selected: colors.ink },
      labelStyle: { default: { color: colors.faint }, selected: { color: colors.ink } },
      content: { backgroundColor: colors.bg },
    }),
    [colors],
  );
  return (
    <TabFoot.Provider value={foot}>
      <BarSources onChange={setBar} />
      <NativeTabs
        tintColor={colors.ink}
        iconColor={look.iconColor}
        labelStyle={look.labelStyle}
        backgroundColor={colors.bg}
        // iOS draws badge text in white whatever we ask: a red dark enough for it, in both themes.
        badgeBackgroundColor={TAB_BADGE.background}
        badgeTextColor={TAB_BADGE.text}
        indicatorColor={colors.sunken}
        rippleColor={colors.plate}
        labelVisibilityMode="labeled"
        // iOS 26: reading down a list, the bar folds to the current tab and comes back on the way up (the system's own).
        minimizeBehavior="onScrollDown"
      >
        {along && ACCESSORY ? (
          <NativeTabs.BottomAccessory>
            <AccessoryLine />
          </NativeTabs.BottomAccessory>
        ) : null}
        {TABS.map((tab) => {
          const label = t(tab.label);
          const count = counts[tab.name] ?? 0;
          const badge = tabBadge(count);
          return (
            <NativeTabs.Trigger
              key={tab.name}
              name={tab.name}
              hidden={personal && tab.teamOnly === true}
              {...(tab.role ? { role: tab.role } : {})}
              accessibilityLabel={badge ? t("mobile.tabs.withCount", { label, count }) : label}
              contentStyle={look.content}
            >
              {/* `sf` wins on iOS; `src` is Android's (and Agentes' on iOS). */}
              <NativeTabs.Trigger.Icon
                renderingMode="template"
                src={ICONS[tab.name]}
                {...(tab.sf ? { sf: tab.sf } : {})}
              />
              <NativeTabs.Trigger.Label>{label}</NativeTabs.Trigger.Label>
              {badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
            </NativeTabs.Trigger>
          );
        })}
      </NativeTabs>
    </TabFoot.Provider>
  );
}
