import { instanceQuery, useApi } from "@agenteschat/client";
import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { accountLabel, setServer, useServer, useServerToReturn } from "@/lib/server";
import { Text } from "../Text";
import { AuthLink } from "./AuthLink";

/** Whether the phone's server now is the Cloud: what the server says, its host until it answered. */
export function useOnCloud(): boolean {
  const server = useServer();
  const cloud = useQuery(instanceQuery(useApi())).data?.cloud;
  return cloud ?? serverHost(server) === serverHost(CLOUD_SERVER);
}

/** Fixed service identity; switching between accounts on this service is still supported. */
export function AuthFootLine() {
  const { t } = useTranslation();
  const back = useServerToReturn();
  return (
    <View style={styles.foot}>
      <Text variant="footnote" tone="faint">
        Tich Rooms
      </Text>
      {back ? (
        <AuthLink
          label={t("mobile.auth.server.backTo", { host: accountLabel(back) ?? serverHost(back) })}
          onPress={() => void setServer(back)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { alignItems: "center", gap: 12, alignSelf: "stretch" },
});

/** The old name, for anything still importing it: the same line. */
export const ServerLine = AuthFootLine;
