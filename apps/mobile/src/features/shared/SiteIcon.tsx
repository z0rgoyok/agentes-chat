import { siteName } from "@agenteschat/client/lib/sites";
import { Image as SiteImage } from "expo-image";
import { useState } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import { useColors } from "./hooks";

/** A site's paper and letter, the same in both themes (the web's `--site-paper`, `--site-ink`). */
export const SITE_PAPER = "#ffffff";
const SITE_INK = "#111111";
/** A plain host ("example.com", "localhost:3000"): only those get their icon asked for. */
const PLAIN_HOST = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * A site's own icon (its `/favicon.ico`), or its first letter when it has none or `letterOnly` (an app on the desktop):
 * one 18-point tile either way, so the line never shifts (the web's `SiteIcon`). Decorative: the words beside name it.
 * The agent's browser draws it by the page it is on, and a table by each site a cell links to.
 */
export function SiteIcon({ host, letterOnly = false }: { host: string; letterOnly?: boolean }) {
  const c = useColors();
  // Keyed by the host it failed for: a new site gets a new try with nothing to reset.
  const [failed, setFailed] = useState<string | null>(null);
  const letter = siteName(host).charAt(0);
  const plain = letterOnly || failed === host || !PLAIN_HOST.test(host);
  return (
    <View
      style={[styles.siteIcon, { borderColor: c.line2 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {plain ? (
        <RNText style={styles.siteLetter} allowFontScaling={false}>
          {letter}
        </RNText>
      ) : (
        <SiteImage
          source={{ uri: `https://${host}/favicon.ico` }}
          style={styles.favicon}
          contentFit="contain"
          onError={() => setFailed(host)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  siteIcon: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: SITE_PAPER,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  favicon: { width: 14, height: 14 },
  siteLetter: { color: SITE_INK, fontSize: 10, lineHeight: 12, fontWeight: "700", textTransform: "uppercase" },
});
