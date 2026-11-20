import { usePinMessage, useToggleReaction } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { type Href, Link } from "expo-router";
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Platform, View } from "react-native";
import { useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { QUICK_REACTIONS } from "./logic";
import { useRowDirectory, useRowMeId } from "./row-data";
import { type MessageAction, type MessageActionHands, type MessageActionsContext, messageActionsOf } from "./sheets";

/** The system's symbol beside a menu action. */
export type MenuSymbol = NonNullable<ComponentProps<typeof Link.MenuAction>["icon"]>;

/** A menu action: its words, the system's symbol beside them, and what it does. */
export interface MenuItem {
  key: string;
  label: string;
  icon?: MenuSymbol | undefined;
  destructive?: boolean | undefined;
  onPress: () => void;
}

const noop = () => {};

/** No groups: the menu isn't built yet. */
const NO_GROUPS: MenuItem[][] = [];

/**
 * The system's context menu on a message (iOS): hold it and the platform lifts the row, dims the rest and shows the
 * reactions as a palette, then the actions in groups. No tap goes anywhere: the row's own link is kept from
 * navigating, so the menu is the one thing the hold adds. Where the platform has no such menu (Android), the row
 * is handed back as it is and its long press opens the app's sheet.
 *
 * `groups` null: not built yet (`MessageMenuFor`). The menu then holds one hidden item, so a hold that comes first
 * opens no empty row; the platform reads the actions only as its menu shows, and the ones built meanwhile take its
 * place.
 */
export function MessageMenu({
  href,
  reactions,
  onReact,
  reactLabel,
  groups,
  onArm,
  children,
}: {
  href: string;
  /** The quick reactions, as one palette row at the top. */
  reactions: readonly string[];
  onReact: (emoji: string) => void;
  /** The palette's name, read aloud. */
  reactLabel: string;
  /** The actions, each group divided from the next; null until they are built. */
  groups: MenuItem[][] | null;
  /** A finger landed on the row: build the menu now, before a hold opens it. */
  onArm?: (() => void) | undefined;
  children: ReactNode;
}) {
  if (Platform.OS !== "ios") return <>{children}</>;
  return (
    <Link href={href as Href} asChild onPress={(e) => e.preventDefault()}>
      <Link.Trigger>
        {/* One plain view for the menu to lift (the row can be a fragment: a pair row, a quote). */}
        <View collapsable={false} onTouchStart={onArm}>
          {children}
        </View>
      </Link.Trigger>
      <Link.Menu>
        {groups === null ? <Link.MenuAction hidden onPress={noop} /> : null}
        {reactions.length > 0 ? (
          <Link.Menu title={reactLabel} palette inline>
            {reactions.map((emoji) => (
              <Link.MenuAction key={emoji} onPress={() => onReact(emoji)}>
                {emoji}
              </Link.MenuAction>
            ))}
          </Link.Menu>
        ) : null}
        {(groups ?? NO_GROUPS)
          .filter((g) => g.length > 0)
          .map((group) => (
            <Link.Menu key={group[0]?.key ?? ""} inline>
              {group.map((it) => (
                <Link.MenuAction
                  key={it.key}
                  {...(it.icon ? { icon: it.icon } : {})}
                  {...(it.destructive ? { destructive: true } : {})}
                  onPress={it.onPress}
                >
                  {it.label}
                </Link.MenuAction>
              ))}
            </Link.Menu>
          ))}
      </Link.Menu>
    </Link>
  );
}

/** A message still on its way has no reactions: the server doesn't know it yet. */
const NO_REACTIONS: readonly string[] = [];

/** A message's action as the system's menu takes it. */
const menuItemOf = (a: MessageAction): MenuItem => ({
  key: a.key,
  label: a.label,
  icon: a.symbol,
  destructive: a.danger,
  onPress: a.onPress ?? noop,
});

/** The writes a menu's actions make, mounted with its actions (`MenuWrites`). */
type Writes = Pick<MessageActionHands, "toggle" | "pin">;

/**
 * A message's row under the system's menu, with the same actions as the app's sheet (`messageActionsOf`): the
 * conversation wraps every row in it, a message still on its way included (its menu holds only what works before the
 * server has it, copying its words), so the row stays mounted when it turns sent. `href` is the message's own place,
 * never navigated to.
 *
 * Built only once a finger lands on the row (`onArm`): the list mounts a row each time it scrolls into view, and each
 * built its actions (their queries, its text's charts) and some twenty of the system's menu views that only a hold
 * reads. A hold starts with the finger landing, and its menu shows half a second later, long after the actions are
 * built. With a screen reader on, every menu is built as its row mounts, since its menu also opens without a touch.
 */
export function MessageMenuFor({
  context,
  href,
  children,
}: {
  context: MessageActionsContext;
  href: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const toast = useToast();
  const qc = useQueryClient();
  const reader = useScreenReaderOn();
  const [touched, setTouched] = useState(false);
  const arm = useCallback(() => setTouched(true), []);
  const armed = touched || reader;
  const writes = useRef<Writes | null>(null);
  // The system closes its menu by itself: nothing to close before an action.
  const actions = armed
    ? messageActionsOf(context, noop, {
        t,
        orgId,
        meId,
        dir,
        toast,
        qc,
        toggle: (input, options) => writes.current?.toggle(input, options),
        pin: (input, options) => writes.current?.pin(input, options),
      })
    : null;
  const items = actions ? actions.groups.map((g) => g.map(menuItemOf)) : null;
  return (
    <>
      {armed ? <MenuWrites messageId={context.message.id} into={writes} /> : null}
      <MessageMenu
        href={href}
        reactions={armed && !context.message.local ? QUICK_REACTIONS : NO_REACTIONS}
        onReact={actions ? actions.react : noop}
        reactLabel={t("mobile.chat.react")}
        groups={items}
        onArm={armed ? undefined : arm}
      >
        {children}
      </MessageMenu>
    </>
  );
}

/** The menu's two writes, mounted with its actions: a row nobody holds never subscribes to them. */
function MenuWrites({ messageId, into }: { messageId: string; into: RefObject<Writes | null> }) {
  const orgId = useOrgId();
  const toggle = useToggleReaction(orgId, messageId).mutate;
  const pin = usePinMessage(orgId).mutate;
  useImperativeHandle(into, () => ({ toggle, pin }), [toggle, pin]);
  return null;
}

/** Whether a screen reader is on: read once for every row, and followed. */
let readerOn = false;
let readerRead = false;
const readerListeners = new Set<() => void>();

function subscribeReader(listener: () => void) {
  if (!readerRead) {
    readerRead = true;
    const set = (on: boolean) => {
      readerOn = on;
      for (const l of readerListeners) l();
    };
    void AccessibilityInfo.isScreenReaderEnabled().then(set);
    AccessibilityInfo.addEventListener("screenReaderChanged", set);
  }
  readerListeners.add(listener);
  return () => {
    readerListeners.delete(listener);
  };
}

const useScreenReaderOn = () => useSyncExternalStore(subscribeReader, () => readerOn);
