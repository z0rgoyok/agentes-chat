import { reconnectCause, useApi, useReconnectCause } from "@agenteschat/client";
import { useNetworkState } from "expo-network";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRealtime } from "@/providers/realtime";
import { Button, Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "./hooks";

const ICON = { device: "wifi", server: "cloud", signedOut: "lock" } as const;

/**
 * A dropped live connection, said small and late: nothing for its first two minutes (it retries by itself), then a
 * pill under the status bar with why (no internet on the phone, the server not answering, signed out) and one way out.
 * It leaves once it reconnects.
 */
export function ReconnectPill() {
  const { t } = useTranslation();
  const c = useColors();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const { connection, status } = useRealtime();
  const network = useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const { cause, recheck } = useReconnectCause(status, () => reconnectCause(offline, () => api.account.me()));
  if (!cause) return null;
  return (
    <View pointerEvents="box-none" style={[styles.place, { top: insets.top + 8 }]}>
      <View accessibilityRole="alert" style={[styles.pill, { backgroundColor: c.raised, borderColor: c.line }]}>
        <Icon name={ICON[cause]} size={16} color={c.muted} />
        <Text variant="caption" tone="ink" style={styles.text}>
          {t(`reconnect.${cause}`)}
        </Text>
        {cause === "signedOut" ? (
          <Button
            variant="secondary"
            size="sm"
            label={t("reconnect.signIn")}
            onPress={() => router.replace("/sign-in")}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            label={t("reconnect.retry")}
            onPress={() => {
              connection?.checkAlive();
              recheck();
            }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    maxWidth: "100%",
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { flexShrink: 1 },
});
