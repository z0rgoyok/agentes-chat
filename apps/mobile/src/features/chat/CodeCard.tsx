import {
  type CodeToken,
  type CodeTokenKind,
  codeLabel,
  formatJson,
  highlightCode,
  isJsonLang,
} from "@agenteschat/client/lib/code";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, ScrollView, type ScrollViewInstance, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EmptyState,
  Icon,
  PressScale,
  SheetBar,
  Text,
  TOOL_H,
  TOUCH,
  useReducedMotion,
  useRouteSheetScrollable,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "../shared/hooks";
import { copyText, MONO } from "../shared/parts";
import { CHAT_TEXT_MAX_SCALE, chatCodeOf } from "./logic";
import { useRowLook } from "./look";

/** Lines a card shows in the conversation; the rest open in full screen. */
const SHOWN = 14;

/** The token colors (the web's, both themes). */
const TOKEN = {
  light: { keyword: "#7a3fd1", string: "#1f7a45", number: "#b05a00", function: "#0b62c9" },
  dark: { keyword: "#c29bff", string: "#7fd4a0", number: "#f0b35a", function: "#79b8ff" },
} as const;

/** The code open in full screen (a route can't carry a long text in its URL). */
let opened: { lang: string; text: string } | null = null;

function openFull(lang: string, text: string) {
  opened = { lang, text };
  router.push("/code");
}

/**
 * Fenced code in a message: the language on top, copy (the icon turns
 * into a check and "Copiado") and full screen, a native form sheet: the system
 * shrinks and dims the conversation behind it and closes it with a drag. Long code shows its first lines
 * and "Ver as N linhas". Colors from the shared highlighter (`@agenteschat/client/lib/code`). JSON reads formatted
 * (`formatJson`) and wrapped, the text as written one press away ("Original"), as on the web; copy takes what shows.
 */
export const CodeCard = memo(function CodeCard({ lang, text }: { lang: string; text: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const formatted = useMemo(() => (isJsonLang(lang) ? formatJson(text) : null), [lang, text]);
  const [raw, setRaw] = useState(false);
  const pretty = formatted !== null && !raw;
  const code = pretty ? formatted : text;
  const lines = useMemo(() => highlightCode(code, lang), [code, lang]);
  const shown = lines.length > SHOWN + 2 ? lines.slice(0, SHOWN) : lines;
  return (
    <View style={[styles.card, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <View style={styles.top}>
        <Text variant="label" tone="faint" style={styles.lang} numberOfLines={1}>
          {codeLabel(lang) || t("mobile.code.label")}
        </Text>
        {formatted !== null && formatted !== text.trim() ? (
          <RawToggle on={raw} onPress={() => setRaw((r) => !r)} />
        ) : null}
        <CopyButton text={code} />
        <PressScale
          to={0.88}
          onPress={() => openFull(lang, code)}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.code.fullScreen")}
          hitSlop={6}
          style={styles.tool}
          contentStyle={styles.toolIn}
        >
          <Icon name="expand" size={18} color={c.muted} />
        </PressScale>
      </View>
      {pretty ? (
        <View style={styles.body}>
          <CodeText lines={shown} wrap />
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.body}>
          <CodeText lines={shown} />
        </ScrollView>
      )}
      {shown.length < lines.length ? (
        <PressScale
          onPress={() => openFull(lang, code)}
          accessibilityRole="button"
          style={[styles.more, { borderTopColor: c.line }]}
          contentStyle={[styles.center, styles.moreIn]}
        >
          <Text variant="footnote" tone="muted">
            {t("mobile.code.more", { count: lines.length })}
          </Text>
        </PressScale>
      ) : null}
    </View>
  );
});

/** "Original": a formatted block (JSON) shown as it was written while on. */
export function RawToggle({ on, onPress }: { on: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      // 28 drawn in the card's 38-point head: 8 above and below reach the 44 a finger needs.
      hitSlop={RAW_SLOP}
      style={[styles.raw, { backgroundColor: on ? c.ink : c.plate }]}
      contentStyle={styles.center}
    >
      <Text variant="label" style={{ color: on ? c.bg : c.ink2 }}>
        {t("mobile.code.raw")}
      </Text>
    </PressScale>
  );
}

export function CodeText({
  lines,
  numbered = false,
  wrap = false,
}: {
  lines: CodeToken[][];
  numbered?: boolean;
  wrap?: boolean;
}) {
  const c = useColors();
  const { scheme } = useTheme();
  // In a conversation, the person's Tamanho do texto, as the words around it; full screen keeps its own size.
  const sized = useRowLook().text;
  const colors = TOKEN[scheme];
  const color = (kind: CodeTokenKind) =>
    kind === "plain"
      ? undefined
      : kind === "comment"
        ? c.faint
        : kind === "inserted"
          ? c.ok
          : kind === "property"
            ? colors.function
            : kind === "deleted"
              ? c.danger
              : colors[kind];
  const gutter = String(lines.length).length;
  return (
    <RNText
      selectable
      style={[styles.mono, sized ? chatCodeOf(sized) : null, { color: c.ink2 }, wrap ? styles.wrap : null]}
      maxFontSizeMultiplier={sized ? CHAT_TEXT_MAX_SCALE : undefined}
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one block, in order
        <RNText key={i}>
          {numbered ? <RNText style={{ color: c.faint }}>{`${String(i + 1).padStart(gutter, " ")}  `}</RNText> : null}
          {line.map((tok, j) => (
            <RNText
              // biome-ignore lint/suspicious/noArrayIndexKey: the tokens of one line, in order
              key={j}
              style={[
                color(tok.kind) ? { color: color(tok.kind) } : null,
                tok.kind === "comment" ? styles.italic : null,
              ]}
            >
              {tok.text}
            </RNText>
          ))}
          {i < lines.length - 1 ? "\n" : ""}
        </RNText>
      ))}
    </RNText>
  );
}

/**
 * Copy; then the icon turns into a check and "Copiado" shows beside it for a moment. When the system refuses, a toast
 * says so (the button itself stays as it was).
 */
function CopyButton({ text, plate = false }: { text: string; plate?: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const reduced = useReducedMotion();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) {
        toast({ title: t("mobile.app.failed"), icon: "x" });
        return;
      }
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1400);
    });
  };
  return (
    <PressScale
      to={0.88}
      onPress={copy}
      accessibilityRole="button"
      accessibilityLabel={done ? t("mobile.code.copied") : t("mobile.code.copy")}
      hitSlop={6}
      style={[styles.tool, done ? styles.toolDone : null, plate ? { backgroundColor: c.plate } : null]}
      contentStyle={styles.toolIn}
    >
      <Icon name={done ? "check" : "copy"} size={18} color={done ? c.ok : c.muted} />
      {done ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
          <Text variant="label" style={{ color: c.ok }}>
            {t("mobile.code.copied")}
          </Text>
        </Animated.View>
      ) : null}
    </PressScale>
  );
}

/** The full screen code (`/code`, a sheet): line numbers, wrap on demand, copy. */
export function CodeSheet() {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  // The sheet's scroll view (dragging at its top moves the sheet).
  const scroll = useRef<ScrollViewInstance>(null);
  useRouteSheetScrollable(scroll);
  const [wrap, setWrap] = useState(false);
  const code = opened;
  const lines = code ? highlightCode(code.text, code.lang) : [];
  if (!code) {
    return (
      // Opened again with nothing to show (the app started over on it): said as every empty place says it, with the
      // sheet's bar to close it.
      <View style={styles.sheet}>
        <SheetBar onClose={() => router.back()} />
        <View style={styles.gone}>
          <EmptyState size="panel" icon="code" title={t("mobile.code.gone")} />
        </View>
      </View>
    );
  }
  return (
    <ScrollView
      ref={scroll}
      style={styles.fill}
      // The bar and its tools ride pinned at the top, on the sheet's color as the code passes under them.
      stickyHeaderIndices={[0]}
      contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
    >
      <View style={{ backgroundColor: c.grouped }}>
        <SheetBar
          title={codeLabel(code.lang) || t("mobile.code.label")}
          onClose={() => router.back()}
          trailing={<CopyButton text={code.text} plate />}
        />
        <View style={styles.sheetTools}>
          <PressScale
            onPress={() => setWrap((w) => !w)}
            accessibilityRole="switch"
            accessibilityState={{ checked: wrap }}
            // A toolbar's 32-point pill: the slop gives it the 44 a finger needs.
            hitSlop={(TOUCH - TOOL_H) / 2}
            style={[styles.pill, { backgroundColor: wrap ? c.ink : c.plate }]}
            contentStyle={styles.center}
          >
            <Text variant="label" style={{ color: wrap ? c.bg : c.ink2 }}>
              {t("mobile.code.wrap")}
            </Text>
          </PressScale>
        </View>
      </View>
      {wrap ? (
        <View style={styles.sheetBody}>
          <CodeText lines={lines} numbered wrap />
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sheetBody}>
          <CodeText lines={lines} numbered />
        </ScrollView>
      )}
    </ScrollView>
  );
}

/** "Original"'s 28 points and the slop that makes them 44. */
const RAW_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  // The language starts where the code does (the body's 14).
  top: { flexDirection: "row", alignItems: "center", gap: 2, height: 38, paddingLeft: 14, paddingRight: 4 },
  lang: { flex: 1 },
  // Round while it holds the icon alone (its least width centers it), a pill once "Copied" shows.
  tool: {
    height: 32,
    minWidth: 32,
    paddingHorizontal: 6,
    borderRadius: 16,
  },
  toolIn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  center: { alignItems: "center", justifyContent: "center" },
  toolDone: { paddingHorizontal: 10 },
  body: { paddingHorizontal: 14, paddingBottom: 12 },
  // "Ver as N linhas": the card's last row, as tall as a finger's target.
  more: { borderTopWidth: StyleSheet.hairlineWidth },
  moreIn: { minHeight: TOUCH },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 20 },
  wrap: { flexShrink: 1 },
  italic: { fontStyle: "italic" },
  sheet: { flex: 1 },
  gone: { flex: 1, justifyContent: "center", padding: 24 },
  sheetTools: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  pill: { minHeight: TOOL_H, paddingHorizontal: 14, borderRadius: TOOL_H / 2 },
  raw: { height: 28, paddingHorizontal: 12, marginRight: 4, borderRadius: 14 },
  fill: { flex: 1 },
  sheetBody: { paddingHorizontal: 16, paddingTop: 4 },
});
