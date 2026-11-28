import { markTerms } from "@agenteschat/client/lib/search-filters";
import { matchesWords } from "@agenteschat/ui/search";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Icon,
  type IconName,
  SearchField,
  SHEET_X,
  Sheet,
  SheetBar,
  Text,
} from "@/ui";
import { AgentFace, Face } from "./Face";
import { useColors } from "./hooks";
import { SheetTitle } from "./PromptForm";
import { ActionList } from "./parts";
import { sectionsOf } from "./picker-sections";

/**
 * What leads an option: a person's photo (or initial), an agent's living face, an icon's tile, a mark of the caller's
 * own (a widget kind's glyph), or nothing.
 */
export type PickLeading =
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "icon"; name: IconName }
  | { kind: "node"; node: ReactNode };

export interface PickOption {
  key: string;
  label: string;
  /** A quieter line under it: a person's or an agent's role, a computer's state ("Desligado"). */
  sub?: string | undefined;
  /** Lines `sub` may take when it is a sentence that must be read whole; one when left out. */
  subLines?: number | undefined;
  leading?: PickLeading | undefined;
  /** Red, for the action menus that come here ("Apagar conta"). */
  destructive?: boolean | undefined;
  /** Its level in a tree (a folder picker): a guide line per level. Flat while the person searches. */
  depth?: number | undefined;
  /** The header of the group it opens and the ones after it share (an AI account's "Suas", "Do time"). */
  section?: string | undefined;
  /** Listed but not pickable (an account it can't think with): faint, its `sub` saying why. */
  disabled?: boolean | undefined;
  /** A short fact on the right, faint ("88%"). */
  value?: string | undefined;
  /** More words the search finds it by, never shown (an account's maker: "Claude"). */
  keywords?: string | undefined;
}

export interface PickAsk {
  title: string;
  /** One quiet line under the bar, when the choice needs saying what it changes. */
  note?: string | undefined;
  options: readonly PickOption[];
  /** The one in use: checked. */
  value?: string | null | undefined;
  /** A search field over the list; on its own from `SEARCH_FROM` options. */
  search?: boolean | undefined;
  /** A switch under the options that changes what a pick does ("Para todos os agentes do workspace"), off at first. */
  toggle?: { label: string; onChange: (on: boolean) => void } | undefined;
  /** The one in use lit and in semibold instead of a check (the AI choice's selects: no column of checks). */
  lit?: boolean | undefined;
}

/** From this many options the list gets its search field (people, languages, times, zones). */
const SEARCH_FROM = 9;
/** Faces stay alive in a short list; a long one draws them still, as long lists do everywhere. */
const LIVE_UP_TO = 12;
/**
 * A list with a search rests at 70% of the screen whatever matches, so it never jumps at a keystroke or collapses
 * when nothing does; while the person types it takes the whole screen, the list's room above the keyboard.
 */
const SEARCH_DETENTS = [0.7, 1];
const TYPING_DETENTS = [1];

type Pending = PickAsk & { mode: "pick" | "actions"; done: (key: string | null) => void };

let present: ((ask: Pending) => void) | null = null;

/**
 * One choice in the app's own sheet (never the system's alert list): the title in the sheet's bar (the task sheets'
 * `SheetBar`, no ×: the sheet goes with a pull down or a tap outside), an optional line under it, then a grouped list
 * where each option shows who or what it is (a face, a photo, a tile), a quieter line, and the check on the one in use;
 * a search field when the list is long. Resolves with the chosen key, or null when the person cancels (the scrim, a
 * flick down). The row's value changes
 * at once: the promise resolves on the pick while the sheet slides away.
 */
export function pickOne(ask: PickAsk): Promise<string | null> {
  return new Promise((resolve) => {
    if (!present) {
      resolve(null);
      return;
    }
    present({ ...ask, mode: "pick", done: resolve });
  });
}

/**
 * A short menu of actions in the app's own sheet, on every system (never the system's action sheet or an alert's
 * buttons): the title, then the actions as a list, each with its icon when the caller gives one, as a
 * conversation's "…" is. The action runs once the sheet is gone, so what it presents next (an alert, the photo
 * library) never lands under it. False when no host is mounted, and the caller keeps its own fallback.
 */
export function showActionSheet(
  title: string,
  actions: readonly {
    label: string;
    icon?: IconName | undefined;
    destructive?: boolean | undefined;
    checked?: boolean | undefined;
    onPress: () => void;
  }[],
): boolean {
  if (!present) return false;
  const options = actions.map((a, i) => ({
    key: String(i),
    label: a.label,
    destructive: a.destructive,
    ...(a.icon ? { leading: { kind: "icon" as const, name: a.icon } } : {}),
  }));
  const checkedAt = actions.findIndex((a) => a.checked);
  present({
    title,
    options,
    value: checkedAt >= 0 ? String(checkedAt) : null,
    mode: "actions",
    done: (key) => {
      if (key !== null) actions[Number(key)]?.onPress();
    },
  });
  return true;
}

/** The host of `pickOne` and `showActionSheet`, mounted once at the app's root. */
export function PickerHost() {
  const { t } = useTranslation();
  const c = useColors();
  const [ask, setAsk] = useState<Pending | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [toggled, setToggled] = useState(false);
  // What happens once the sheet is gone: an action menu's action, or a cancelled pick's null.
  const after = useRef<(() => void) | null>(null);
  const current = useRef<Pending | null>(null);

  useEffect(() => {
    present = (next) => {
      // A second ask while one shows: the first one is cancelled; an action still waiting for the last sheet to leave
      // runs now rather than under the new one.
      current.current?.done(null);
      const waiting = after.current;
      after.current = null;
      waiting?.();
      current.current = next;
      setQuery("");
      setTyping(false);
      setToggled(false);
      setAsk(next);
      setOpen(true);
    };
    return () => {
      present = null;
    };
  }, []);

  const finish = (key: string | null) => {
    const pending = current.current;
    if (!pending) return;
    current.current = null;
    // A pick changes its row now; an action waits for the sheet to be gone (it may present something).
    if (pending.mode === "pick" || key === null) pending.done(key);
    else after.current = () => pending.done(key);
    setOpen(false);
  };

  const options = ask?.options ?? [];
  const searchable = Boolean(ask) && ask?.mode === "pick" && (ask.search ?? options.length >= SEARCH_FROM);
  const typed = query.trim();
  // Every typed word, accents and case aside, in the option's name or its line (as the app's other pickers search).
  const shown = useMemo(
    () =>
      typed ? options.filter((o) => matchesWords(`${o.label} ${o.sub ?? ""} ${o.keywords ?? ""}`, typed)) : options,
    [options, typed],
  );
  const live = options.length <= LIVE_UP_TO;

  // A menu of actions has no bar: its title leads the list (below), and the scrim or a flick down cancels.
  const bar =
    ask?.mode === "pick" ? (
      <View>
        {/* No ×: a pick goes with a pull down or a tap outside, as the system's sheets (the scrim still cancels). */}
        <SheetBar title={ask.title} />
        {ask.note ? (
          <Text variant="footnote" tone="muted" style={styles.note} numberOfLines={2}>
            {ask.note}
          </Text>
        ) : null}
        {searchable ? (
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              placeholder={t("mobile.search.placeholder")}
              accessibilityLabel={t("mobile.search.placeholder")}
              returnKeyType="search"
            />
          </View>
        ) : null}
      </View>
    ) : null;

  return (
    <Sheet
      open={open}
      onClose={() => finish(null)}
      header={bar}
      {...(searchable ? { detents: typing ? TYPING_DETENTS : SEARCH_DETENTS } : {})}
      onGone={() => {
        const run = after.current;
        after.current = null;
        // A new ask may have come while this one left: it keeps its list.
        if (!current.current) setAsk(null);
        run?.();
      }}
    >
      {ask?.mode === "actions" ? (
        <View style={styles.actions}>
          {ask.title ? <SheetTitle title={ask.title} /> : null}
          <ActionList
            items={options.map((o) => ({
              key: o.key,
              label: o.label,
              ...(o.leading?.kind === "icon" ? { icon: o.leading.name } : {}),
              ...(o.destructive ? { danger: true } : {}),
              // The one in use, in a menu that is a short choice (a template, a level).
              ...(ask.value != null && o.key === ask.value
                ? { trailing: <Icon name="check" size={18} color={c.ink} /> }
                : {}),
              onPress: () => {
                haptics.selection();
                finish(o.key);
              },
            }))}
          />
        </View>
      ) : ask ? (
        sectionsOf(shown).map((group) => (
          <View key={group.key} style={group.title ? styles.section : null}>
            {group.title ? <GroupedHeader>{group.title}</GroupedHeader> : null}
            <GroupedList>
              {group.options.map((o) => {
                const picked = ask.value != null && o.key === ask.value;
                const lead = o.leading;
                return (
                  <GroupedRow
                    key={o.key}
                    label={o.label}
                    {...(typed
                      ? { labelParts: markTerms(o.label, [typed]) }
                      : ask.lit && picked
                        ? { labelParts: [{ text: o.label, mark: true }] }
                        : {})}
                    {...(o.sub ? { sub: o.sub } : {})}
                    {...(o.subLines ? { subLines: o.subLines } : {})}
                    {...(o.value ? { value: o.value } : {})}
                    {...(o.depth && !typed ? { depth: o.depth, labelLines: 0 } : {})}
                    {...(lead?.kind === "icon" ? { icon: lead.name } : {})}
                    {...(lead?.kind === "person"
                      ? { leading: <Face who={{ type: "person", id: lead.userId }} size={36} /> }
                      : lead?.kind === "agent"
                        ? { leading: <AgentFace agentId={lead.agentId} size={36} framed live={live} /> }
                        : lead?.kind === "node"
                          ? { leading: lead.node }
                          : {})}
                    danger={Boolean(o.destructive)}
                    {...(ask.lit ? { selected: picked } : { checked: picked })}
                    faint={Boolean(o.disabled)}
                    disabled={Boolean(o.disabled)}
                    onPress={() => {
                      haptics.selection();
                      finish(o.key);
                    }}
                  />
                );
              })}
            </GroupedList>
          </View>
        ))
      ) : null}
      {ask?.toggle ? (
        <View style={styles.toggle}>
          <GroupedList>
            <GroupedRow
              label={ask.toggle.label}
              labelLines={2}
              toggle={toggled}
              onPress={() => {
                const on = !toggled;
                setToggled(on);
                ask.toggle?.onChange(on);
              }}
            />
          </GroupedList>
        </View>
      ) : null}
      {ask && shown.length === 0 ? (
        <Text variant="subhead" tone="muted" style={styles.empty}>
          {t("mobile.picker.none", { text: typed })}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 4 },
  note: { textAlign: "center", paddingHorizontal: 24, paddingBottom: 8 },
  search: { paddingHorizontal: SHEET_X, paddingBottom: 12 },
  empty: { textAlign: "center", paddingVertical: 24 },
  // 24 under the list: the body's own 12 between them and 12 more.
  toggle: { marginTop: 12 },
  // As every sheet spaces a title and its list (`useSheetBody`).
  actions: { gap: 12 },
});
