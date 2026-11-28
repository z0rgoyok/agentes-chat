import { useMe } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, LineIcon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/**
 * On top of Conversas while an email invitation to another workspace waits for this account (`me.invitations`), as
 * the web's line: someone who made a workspace of their own on the way in can still join the one that invited them.
 */
export function InvitedNotice() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const invitation = useMe().data?.invitations?.[0];
  if (!invitation) return null;
  const org = invitation.orgName;
  const title = t("invite.invitedYouNoName", { org });
  return (
    <View style={styles.list}>
      <View style={[styles.card, surface]}>
        <View style={styles.line} accessible accessibilityRole="summary" accessibilityLabel={title}>
          <LineIcon name="mail" variant="callout" size={16} color={c.amber} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold}>
              {title}
            </Text>
          </View>
        </View>
        <Button
          variant="primary"
          size="sm"
          wide
          label={t("invite.enter", { org })}
          onPress={() => router.push({ pathname: "/invite/[token]", params: { token: invitation.token } })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
