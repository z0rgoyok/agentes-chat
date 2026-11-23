import {
  ApiError,
  keys,
  useApi,
  useWikiAction,
  useWikiPage,
  useWikiTree,
  type WikiPage,
  type WikiPageSummary,
} from "@agenteschat/client";
import { type AudienceChoice, EVERYONE } from "@agenteschat/client/lib/who-sees";
import { prefixLines, wikiQuery, wrapSelection } from "@agenteschat/client/lib/wiki";
import { diffLines } from "@agenteschat/ui/diff";
import { useQueryClient } from "@tanstack/react-query";
import { usePreventRemove } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
  View,
} from "react-native";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeInDown, FadeOut, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  DiffView,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  Icon,
  type IconName,
  Locked,
  RowPressable,
  SCREEN_X,
  Segmented,
  SheetScreen,
  Text,
  useFieldText,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { SheetHeader } from "../new/parts";
import { useFailed } from "../routines/hooks";
import { NEXT_FIELD } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useOrgId } from "../shared/hooks";
import { goBack, MONO, PushedHeader, successHaptic, Tile, tapHaptic } from "../shared/parts";
import { useWhoSeesDraft, WhoSeesRows } from "../shared/WhoSees";
import { foldersIn, suggestPages } from "./logic";
import { WikiDoc } from "./WikiDoc";
import { cleanFolder, FolderChips, openWikiPage } from "./WikiScreen";

type Mode = "write" | "view";
type Sel = { start: number; end: number };

/**
 * Writing a page: "Escrever | Ver" in the bar and Salvar on the right. Escrever is the page's
 * Markdown with a bar over the keyboard (negrito, itálico, título, lista, tarefa, [[link]], código, hide the
 * keyboard); typing `[[` suggests pages (or "Criar"). Ver is the page as it will read, not saved yet. A page that
 * changed meanwhile shows the conflict (the web's): the difference, and which one stays. Leaving with changes
 * asks first. `slug` edits a page; `title` and `folder` write a new one (created on Salvar). The keyboard comes up
 * only when the person taps the text, a new page too: a screen never opens with it up.
 */
export function WikiWriteScreen(props: { slug: string } | { title: string; folder: string; who?: string }) {
  const orgId = useOrgId();
  const slug = "slug" in props ? props.slug : null;
  const page = useWikiPage(orgId, slug);
  // The page to edit not here yet (it usually is: it was just open): its bar from the first frame, and if it failed
  // to load, what happened and the way to ask again, never a blank screen.
  if (slug && !page.data) return <WriterWaiting failed={page.isError} retry={() => void page.refetch()} />;
  return (
    <Writer
      page={page.data ?? null}
      title={"title" in props ? props.title : (page.data?.title ?? "")}
      folder={"folder" in props ? props.folder : (page.data?.folder ?? "")}
      audience={"who" in props && props.who ? { mode: "people", userIds: props.who.split(",") } : EVERYONE}
    />
  );
}

function WriterWaiting({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      {/* The writing's opaque bar from the first frame (a clear one here stayed clear over the text once it came). */}
      <PushedHeader title={t("wiki.edit")} />
      <ScrollView>{failed ? <LoadFailed onRetry={retry} /> : null}</ScrollView>
    </View>
  );
}

function Writer({
  page,
  title,
  folder,
  audience,
}: {
  page: WikiPage | null;
  title: string;
  folder: string;
  audience: AudienceChoice;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  // The room kept under the tools for the home indicator gives way as the keyboard rises: open, the tools sit right
  // on the keys (the keyboard already clears the indicator); closed, they sit above it.
  const keyboard = useReanimatedKeyboardAnimation();
  const homeRoom = useAnimatedStyle(() => ({ height: insets.bottom * (1 - keyboard.progress.get()) }));
  const tree = useWikiTree(orgId);
  const action = useWikiAction(orgId);
  const [mode, setMode] = useState<Mode>("write");
  const [body, setBody] = useState(page?.body ?? "");
  // The version this text started from: the page follows edits made elsewhere live, and saving over one of those
  // without its conflict screen would lose it.
  const [base] = useState(page?.version);
  const [sel, setSel] = useState<Sel>({ start: body.length, end: body.length });
  // A selection set by the bar or a suggestion; the field follows it once, then the person's caret again.
  const [pending, setPending] = useState<Sel | null>(null);
  const [conflict, setConflict] = useState<WikiPage | null>(null);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);
  const input = useRef<TextInputInstance>(null);
  const pages = useMemo(() => tree.data ?? [], [tree.data]);
  const dirty = page ? body !== page.body : body.trim() !== "";
  const token = mode === "write" && sel.start === sel.end ? wikiQuery(body, sel.start) : null;
  const suggestions = token ? suggestPages(pages, token.query, 3) : [];

  // Leaving with changes asks first (back, the edge swipe, close).
  usePreventRemove(dirty, ({ repeat }) => {
    if (leaving.current) return repeat();
    Alert.alert(t("mobile.wiki.discardTitle"), t("mobile.wiki.discardText"), [
      { text: t("mobile.wiki.keepWriting"), style: "cancel" },
      {
        text: t("mobile.wiki.discard"),
        style: "destructive",
        onPress: () => {
          leaving.current = true;
          repeat();
        },
      },
    ]);
  });

  const apply = (r: { text: string; start: number; end: number }) => {
    tapHaptic();
    setBody(r.text);
    setSel({ start: r.start, end: r.end });
    setPending({ start: r.start, end: r.end });
    input.current?.focus();
  };
  const tools: { key: string; label: string; icon?: IconName; text?: string; run: () => void }[] = [
    {
      key: "bold",
      label: t("wiki.editor.bold"),
      text: "B",
      run: () => apply(wrapSelection(body, sel.start, sel.end, "**", "**", t("wiki.editor.boldText"))),
    },
    {
      key: "italic",
      label: t("wiki.editor.italic"),
      text: "I",
      run: () => apply(wrapSelection(body, sel.start, sel.end, "_", "_", t("wiki.editor.italicText"))),
    },
    {
      key: "heading",
      label: t("wiki.editor.heading"),
      text: "H",
      run: () => apply(prefixLines(body, sel.start, sel.end, "## ")),
    },
    {
      key: "list",
      label: t("wiki.editor.list"),
      icon: "list",
      run: () => apply(prefixLines(body, sel.start, sel.end, "- ")),
    },
    {
      key: "task",
      label: t("wiki.editor.task"),
      icon: "checkc",
      run: () => apply(prefixLines(body, sel.start, sel.end, "- [ ] ")),
    },
    {
      key: "link",
      label: t("wiki.editor.link"),
      text: "[[ ]]",
      run: () => apply(wrapSelection(body, sel.start, sel.end, "[[", "]]", "")),
    },
    {
      key: "code",
      label: t("wiki.editor.code"),
      icon: "code",
      run: () => apply(wrapSelection(body, sel.start, sel.end, "`", "`", t("wiki.editor.codeSample"))),
    },
  ];
  const pick = (title: string) => {
    if (!token) return;
    const caret = token.start + 2 + token.query.length;
    const rest = body.slice(caret).replace(/^\]\]/, "");
    const inserted = `[[${title}]]`;
    const at = token.start + inserted.length;
    apply({ text: body.slice(0, token.start) + inserted + rest, start: at, end: at });
  };

  const done = (saved: WikiPage, created: boolean) => {
    // Already left while it saved (the discard alert): it is saved all the same, and nothing moves them again.
    const left = leaving.current;
    leaving.current = true;
    successHaptic();
    toast({ title: created ? t("wiki.created") : t("wiki.saved") });
    if (left) return;
    if (created) router.replace(`/wiki/${encodeURIComponent(saved.slug)}`);
    else goBack();
  };
  const save = async (baseVersion?: number) => {
    if (saving) return;
    Keyboard.dismiss();
    setSaving(true);
    try {
      if (!page) {
        const created = await action.mutateAsync({
          type: "create",
          input: { title: title.trim(), folder: cleanFolder(folder), body, audience },
        });
        done(created, true);
      } else {
        const saved = await action.mutateAsync({
          type: "update",
          slug: page.slug,
          input: { body, baseVersion: baseVersion ?? base ?? page.version },
        });
        done(saved, false);
      }
    } catch (e) {
      if (page && e instanceof ApiError && e.code === "version_conflict") {
        const latest = await api.wiki.get(orgId, page.slug).catch(() => null);
        if (latest) {
          qc.setQueryData(keys.wikiPage(orgId, page.slug), latest);
          setConflict(latest);
        } else failed(e);
      } else failed(e);
    } finally {
      setSaving(false);
    }
  };

  // A link in the preview opens its page over the writing (back returns to it, nothing lost); one to a page that
  // doesn't exist yet says so, instead of a tap that does nothing.
  const previewLink = (_title: string, linked: WikiPageSummary | undefined) => {
    if (linked) openWikiPage(linked.slug);
    else toast({ title: t("wiki.missingTitle") });
  };

  if (conflict && page) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("wiki.conflictTitle")} />
        <ScrollView contentContainerStyle={[styles.conflict, { paddingBottom: insets.bottom + 24 }]}>
          {/* The bar says what this is ("Conflito"); the words under it say what happened. */}
          <Text variant="subhead" tone="muted">
            {t("mobile.wiki.conflictText", { version: conflict.version })}
          </Text>
          <Text variant="footnote" tone="faint" style={styles.gapTop}>
            {t("mobile.wiki.conflictDiff")}
          </Text>
          <DiffView lines={diffLines(conflict.body.split("\n"), body.split("\n"))} />
          <View style={styles.acts}>
            <Button
              variant="primary"
              wide
              label={t("wiki.keepMine")}
              loading={saving}
              onPress={() => void save(conflict.version)}
            />
            <Button
              variant="ghost"
              wide
              label={t("wiki.keepTheirs")}
              disabled={saving}
              onPress={() => {
                leaving.current = true;
                goBack();
              }}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={
          <Segmented
            items={[
              { key: "write", label: t("wiki.editor.modes.write") },
              { key: "view", label: t("mobile.wiki.view") },
            ]}
            value={mode}
            onChange={(k) => {
              if (k === "view") Keyboard.dismiss();
              setMode(k as Mode);
            }}
          />
        }
        action={{ label: t("common.save"), onPress: () => void save(), disabled: saving || (Boolean(page) && !dirty) }}
      />
      {mode === "view" ? (
        <ScrollView contentContainerStyle={[styles.preview, { paddingBottom: insets.bottom + 32 }]}>
          {folder ? (
            <Text variant="subhead" tone="faint">
              {folder}
            </Text>
          ) : null}
          <Text variant="display2" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="footnote" tone="faint">
            {t("mobile.wiki.notSaved")}
          </Text>
          <View style={styles.body}>
            {body.trim() ? (
              <WikiDoc body={body} pages={pages} onOpenLink={previewLink} />
            ) : (
              <Text variant="body" tone="faint">
                {t("mobile.wiki.blank")}
              </Text>
            )}
          </View>
        </ScrollView>
      ) : (
        // Measured where it really is on the screen (under the bar), so the keyboard's room is the keys' whole height and
        // the tools ride on top of them instead of a bar's height behind them.
        <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.fill}>
          <View style={styles.head}>
            <Text variant="title" numberOfLines={1}>
              {title}
            </Text>
            {folder ? (
              <View style={styles.folder}>
                <Icon name="archive" size={13} color={c.faint} />
                <Text variant="footnote" tone="faint" style={styles.shrink}>
                  {folder}
                </Text>
              </View>
            ) : null}
          </View>
          <Locked when={saving} style={styles.fill}>
            <TextInput
              ref={input}
              value={body}
              onChangeText={setBody}
              onSelectionChange={(e: TextInputSelectionChangeEvent) => {
                setSel(e.nativeEvent.selection);
                if (pending) setPending(null);
              }}
              {...(pending ? { selection: pending } : {})}
              multiline
              textAlignVertical="top"
              autoCapitalize="sentences"
              placeholder={t("mobile.wiki.placeholder")}
              placeholderTextColor={c.faint}
              accessibilityLabel={t("wiki.editorLabel", { title })}
              style={[styles.source, { color: c.ink2 }]}
            />
          </Locked>
          {suggestions.length > 0 || token ? (
            // Rises in as the chat's pickers do, as `[[` starts a link.
            <Animated.View
              entering={reduced ? undefined : FadeInDown.duration(160)}
              exiting={reduced ? undefined : FadeOut.duration(100)}
              style={[styles.suggest, { backgroundColor: c.raised, borderColor: c.line2 }]}
            >
              {suggestions.map((p) => (
                <RowPressable key={p.id} onPress={() => pick(p.title)} style={styles.suggestRow}>
                  <Tile icon="file" size={30} />
                  <View style={styles.grow}>
                    <Text variant="callout" numberOfLines={1}>
                      {p.title}
                    </Text>
                    {p.folder ? (
                      <Text variant="caption" tone="faint" numberOfLines={1}>
                        {p.folder}
                      </Text>
                    ) : null}
                  </View>
                </RowPressable>
              ))}
              {token?.query.trim() && !suggestions.some((p) => p.title === token.query.trim()) ? (
                <Pressable
                  onPress={() => pick(token.query.trim())}
                  style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: c.sunken }]}
                >
                  <Tile icon="plus" size={30} />
                  <Text variant="callout" style={styles.grow} numberOfLines={1}>
                    {t("mobile.wiki.createLink", { title: token.query.trim() })}
                  </Text>
                </Pressable>
              ) : null}
            </Animated.View>
          ) : null}
          <Locked when={saving}>
            <View style={[styles.bar, { borderTopColor: c.line2, paddingBottom: 6 }]}>
              {tools.map((tool) => (
                <Pressable
                  key={tool.key}
                  accessibilityRole="button"
                  accessibilityLabel={tool.label}
                  onPress={tool.run}
                  hitSlop={4}
                  style={({ pressed }) => [styles.tool, pressed && { backgroundColor: c.sunken }]}
                >
                  {tool.icon ? (
                    <Icon name={tool.icon} size={20} color={c.ink2} />
                  ) : (
                    <Text
                      variant="callout"
                      style={[styles.toolText, { color: c.ink2 }, tool.key === "italic" && styles.italic]}
                    >
                      {tool.text}
                    </Text>
                  )}
                </Pressable>
              ))}
              <View style={styles.grow} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("mobile.wiki.hideKeyboard")}
                onPress={() => Keyboard.dismiss()}
                hitSlop={4}
                style={({ pressed }) => [styles.tool, pressed && { backgroundColor: c.sunken }]}
              >
                <Icon name="keyboard" size={20} color={c.ink2} />
              </Pressable>
            </View>
          </Locked>
          <Animated.View style={homeRoom} />
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

/**
 * "Nova página" (a sheet over the wiki): the sheet's bar, then the title and the folder as a form's fields, the folders
 * in use as one-tap choices, who sees it (the web's three choices, the people under them when it's some of them), and
 * "Criar e escrever", which closes the sheet and opens the writing. Nothing is created until Salvar there. The sheet
 * comes up with the keyboard down: the person taps the field.
 */
export function WikiNewSheet({
  title: initialTitle = "",
  folder: initialFolder = "",
}: {
  title?: string;
  folder?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const words = useFieldText("body");
  const orgId = useOrgId();
  const toast = useToast();
  const tree = useWikiTree(orgId);
  const [title, setTitle] = useState(initialTitle);
  const [folder, setFolder] = useState(initialFolder);
  const sees = useWhoSeesDraft(EVERYONE);
  const folders = foldersIn(tree.data ?? []);
  const existing = (tree.data ?? []).find((p) => p.title.toLowerCase() === title.trim().toLowerCase());
  const go = () => {
    const name = title.trim();
    if (!name) {
      toast({ title: t("wiki.form.required"), icon: "x" });
      return;
    }
    goBack();
    if (existing) openWikiPage(existing.slug);
    else {
      const who = sees.choice.mode === "people" ? { who: sees.choice.userIds.join(",") } : {};
      router.push({ pathname: "/wiki-write", params: { title: name, folder: cleanFolder(folder), ...who } });
    }
  };
  const input = [styles.input, words, { color: c.ink }];
  return (
    <SheetScreen>
      <SheetHeader title={t("wiki.newPage")} />
      <View>
        <GroupedList>
          <GroupedField label={t("wiki.form.title")}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t("wiki.form.titlePlaceholder")}
              placeholderTextColor={c.faint}
              {...NEXT_FIELD}
              style={input}
            />
          </GroupedField>
          <GroupedField label={t("wiki.form.folder")}>
            <TextInput
              value={folder}
              onChangeText={setFolder}
              placeholder={t("wiki.form.folderPlaceholder")}
              placeholderTextColor={c.faint}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={go}
              style={input}
            />
          </GroupedField>
        </GroupedList>
        {existing ? <GroupedFooter>{t("mobile.wiki.exists")}</GroupedFooter> : null}
      </View>
      {folders.length > 0 ? <FolderChips folders={folders} value={cleanFolder(folder)} onPick={setFolder} /> : null}
      {/* Who sees it, always in sight as a choice of three: never a row that opens a list under itself. */}
      {existing ? null : (
        <View>
          <GroupedHeader>{t("whoSees.label")}</GroupedHeader>
          <View style={styles.sees}>
            <WhoSeesRows draft={sees} />
          </View>
          <GroupedFooter>{t("whoSees.admins")}</GroupedFooter>
        </View>
      )}
      <Button
        variant="primary"
        wide
        disabled={!sees.ready}
        label={existing ? t("mobile.wiki.openExisting") : t("mobile.wiki.createAndWrite")}
        onPress={go}
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  head: { paddingHorizontal: SCREEN_X, paddingTop: 10, gap: 2 },
  folder: { flexDirection: "row", alignItems: "center", gap: 6 },
  source: { flex: 1, paddingHorizontal: SCREEN_X, paddingTop: 10, fontFamily: MONO, fontSize: 15, lineHeight: 23 },
  suggest: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  suggestRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 8,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tool: {
    minWidth: 38,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  toolText: { fontWeight: "700" },
  italic: { fontStyle: "italic", fontWeight: "500" },
  preview: { paddingHorizontal: SCREEN_X, paddingTop: 12, gap: 4 },
  body: { paddingTop: 14 },
  conflict: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  gapTop: { marginTop: 8 },
  acts: { gap: 6, marginTop: 12 },
  // A form field's input in its row (the label's column beside it).
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  // The three choices and the people under them, apart as two groups.
  sees: { gap: 12 },
});
