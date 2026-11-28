import { type CodeSession, useCodeSession } from "@agenteschat/client";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Button, GROUPED_ROW, Icon, PressScale, SkeletonList, Text, useTheme } from "@/ui";
import { sessionCookieScript } from "../computer/screen-page";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import {
  TERMINAL_CAP,
  TERMINAL_END_WORDS,
  TERMINAL_ROW_KEYS,
  type TerminalCalls,
  type TerminalKey,
  type TerminalState,
  terminalCall,
  terminalEvent,
  terminalOpensAgain,
  terminalPageStays,
  terminalPageUrl,
} from "./terminal-page";

/**
 * A session's terminal (ADR 0215), pushed from its code screen and its "…": the web's Terminal on the phone, a shell
 * on the agent's computer started in the session's worktree, for the person's own commands. The server's
 * `/terminal.html` draws it (xterm, as the web's), filling the screen under the bar; tapping it brings the keyboard,
 * and the row under it holds the keys a phone keyboard lacks and a paste. Why it closed, in the web's words, with
 * "Open again" where that can change it. Its shell stays on the computer for a while when the screen goes, and comes
 * back the next time (`phoneTerminalKeep`).
 */
export function TerminalScreen({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const session = useCodeSession(orgId, sessionId);
  const s = session.data;
  return (
    <>
      <PushedHeader title={t("codeTerminal.label")} {...(s?.title ? { subtitle: s.title } : {})} />
      {session.isLoading ? (
        <ScrollView style={{ backgroundColor: c.bg }}>
          <SkeletonList rows={5} />
        </ScrollView>
      ) : !s ? (
        <ScrollView style={{ backgroundColor: c.bg }}>
          {session.isError ? (
            <LoadFailed onRetry={() => void session.refetch()} />
          ) : (
            <Text variant="callout" tone="muted" style={styles.note}>
              {t("codeSessions.view.gone")}
            </Text>
          )}
        </ScrollView>
      ) : s.worktree.state !== "ready" ? (
        <ScrollView style={{ backgroundColor: c.bg }}>
          <Text variant="callout" tone="muted" style={styles.note}>
            {s.worktree.state === "failed" ? t("codeSessions.view.failed") : t("codeSessions.panel.notReady")}
          </Text>
        </ScrollView>
      ) : (
        <TerminalView session={s} />
      )}
    </>
  );
}

/** The page, what it says around the shell, and the key row. */
function TerminalView({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const server = serverUrl();
  const web = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<TerminalState>("opening");
  // Its computer is too old for the session's folder: the shell started in the agent's folder.
  const [agentFolder, setAgentFolder] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const call = <K extends keyof TerminalCalls>(method: K, ...args: TerminalCalls[K]) =>
    web.current?.injectJavaScript(terminalCall({ cookie: lastCookie(), server }, method, ...args));
  const look = { dark: scheme === "dark", background: colors.bg, foreground: colors.ink };
  const lookKey = `${look.dark}${look.background}${look.foreground}`;
  // The app's theme changed: the terminal's colors with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the look is read whole when its key changes.
  useEffect(() => {
    if (ready) call("look", look);
  }, [ready, lookKey]);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const openAgain = () => {
    setAgentFolder(false);
    call("open");
  };
  const paste = async () => {
    const copied = await Clipboard.getStringAsync().catch(() => "");
    if (copied) call("type", copied);
  };
  const live = state === "live";
  const closed = state !== "opening" && state !== "live";
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: colors.bg }]} automaticOffset>
      {agentFolder ? (
        <View style={[styles.bar, { backgroundColor: colors.sunken }]}>
          <Text variant="footnote" style={{ color: colors.warn }}>
            {t("codeTerminal.agentFolder")}
          </Text>
        </View>
      ) : null}
      <View style={styles.fill}>
        <WebView
          ref={web}
          source={{ uri: terminalPageUrl(server, { orgId, agentId: session.agentId, sessionId: session.id }) }}
          originWhitelist={[new URL(server).origin]}
          onShouldStartLoadWithRequest={(request) => terminalPageStays(server, request.url)}
          injectedJavaScriptBeforeContentLoaded={sessionCookieScript(lastCookie(), server)}
          incognito
          javaScriptEnabled
          // The page never moves: the keyboard shrinks the screen (above) and the shell takes the room left.
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          androidLayerType="hardware"
          style={[styles.fill, { backgroundColor: colors.bg }]}
          onMessage={(e) => {
            const event = terminalEvent(server, e.nativeEvent);
            if (!event) return;
            if (event.type === "ready") {
              // The session's cookie in the page's own document first (`sessionAnswer`'s reason), then its colors and
              // the shell.
              web.current?.injectJavaScript(sessionCookieScript(lastCookie(), server));
              setReady(true);
              call("look", look);
              call("open");
            } else if (event.type === "state") setState(event.state);
            else setAgentFolder(true);
          }}
          onContentProcessDidTerminate={() => web.current?.reload()}
          onRenderProcessGone={() => web.current?.reload()}
        />
        {state === "opening" ? (
          <Text variant="footnote" tone="faint" style={styles.opening} pointerEvents="none">
            {t("codeTerminal.opening")}
          </Text>
        ) : null}
      </View>
      {closed ? (
        <View
          style={[
            styles.bar,
            styles.end,
            { backgroundColor: colors.sunken, paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) },
          ]}
        >
          <Text variant="subhead" style={styles.grow} accessibilityRole="text" accessibilityLiveRegion="polite">
            {t(TERMINAL_END_WORDS[state])}
          </Text>
          {terminalOpensAgain(state) ? (
            <Button variant="secondary" size="sm" label={t("codeTerminal.openAgain")} onPress={openAgain} />
          ) : null}
        </View>
      ) : (
        <KeyRow
          enabled={live}
          keyboard={keyboard}
          bottom={keyboard ? 6 : Math.max(insets.bottom, 6)}
          onKeyboard={() => (keyboard ? Keyboard.dismiss() : call("focus"))}
          onKey={(k) => call("key", k)}
          onPaste={() => void paste()}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/** The keys a phone keyboard lacks, the keyboard's own button first and a paste last; it scrolls sideways when narrow. */
function KeyRow({
  enabled,
  keyboard,
  bottom,
  onKeyboard,
  onKey,
  onPaste,
}: {
  enabled: boolean;
  keyboard: boolean;
  bottom: number;
  onKeyboard: () => void;
  onKey: (key: TerminalKey) => void;
  onPaste: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cap = [styles.keyCap, { backgroundColor: colors.sunken }, !enabled && styles.off];
  const label = (k: TerminalKey) =>
    k === "CtrlC" || k === "CtrlD" ? t(`mobile.coding.terminal.key.${k}`) : t(`mobile.browser.live.key.${k}`);
  return (
    <View style={[styles.row, { paddingBottom: bottom, borderTopColor: colors.separator }]}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.keys}
        accessibilityLabel={t("mobile.coding.terminal.keys")}
      >
        <PressScale
          to={0.92}
          fill={false}
          onPress={onKeyboard}
          disabled={!enabled}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.coding.terminal.keyboard")}
          accessibilityState={{ expanded: keyboard, disabled: !enabled }}
          hitSlop={4}
          style={cap}
          contentStyle={styles.keyCapIn}
        >
          <Icon name={keyboard ? "down" : "keyboard"} size={16} color={colors.ink2} />
        </PressScale>
        {TERMINAL_ROW_KEYS.map((k) => (
          <PressScale
            key={k}
            to={0.92}
            fill={false}
            onPress={() => onKey(k)}
            disabled={!enabled}
            accessibilityRole="button"
            accessibilityLabel={label(k)}
            hitSlop={4}
            style={cap}
            contentStyle={styles.keyCapIn}
          >
            <Text variant="footnote" tone="ink2" style={styles.mono}>
              {TERMINAL_CAP[k]}
            </Text>
          </PressScale>
        ))}
        <PressScale
          to={0.92}
          fill={false}
          onPress={onPaste}
          disabled={!enabled}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.coding.terminal.pasteHint")}
          hitSlop={4}
          style={cap}
          contentStyle={styles.keyCapIn}
        >
          <Text variant="footnote" tone="ink2" style={styles.medium}>
            {t("mobile.browser.live.paste")}
          </Text>
        </PressScale>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  note: { paddingHorizontal: GROUPED_ROW.padX, paddingTop: 16 },
  // Over the shell while it opens, where its first line will be (xterm's own padding).
  opening: { position: "absolute", top: 8, left: 12 },
  // What the screen says around the shell: on the sunken ground, at the rows' inset.
  bar: { paddingHorizontal: 16, paddingVertical: 10 },
  end: { flexDirection: "row", alignItems: "center", gap: 12 },
  row: { paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  keys: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8 },
  keyCap: { borderRadius: 10 },
  keyCapIn: { minWidth: 40, alignItems: "center", paddingVertical: 8, paddingHorizontal: 8 },
  off: { opacity: 0.4 },
  medium: { fontWeight: "500" },
  mono: { fontWeight: "500", fontVariant: ["tabular-nums"] },
});
