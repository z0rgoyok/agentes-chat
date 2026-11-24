import { useMe } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, LineIcon, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { sendConfirmationLink } from "../onboarding/ConfirmEmail";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/**
 * On top of Conversas for an account in a workspace whose address was never confirmed (`emailConfirmation`
 * `reminder`, ADR 0006, addendum 2026-11-22), in the outage notices' style, as the web's line: the workspace keeps
 * working; a new link, or a new address (Conta › E-mail).
 */
export function ConfirmEmailNotice() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const user = useMe().data?.user;
  const [sending, setSending] = useState(false);
  if (user?.emailConfirmation !== "reminder") return null;
  const title = t("auth.confirm.banner");
  const sub = t("auth.confirm.bannerSub", { email: user.email });
  const resend = async () => {
    setSending(true);
    const sent = await sendConfirmationLink(user.email);
    setSending(false);
    toast(
      sent ? { title: t("auth.newLinkSent", { email: user.email }) } : { title: t("mobile.app.failed"), icon: "x" },
    );
  };
  return (
    <View style={styles.list}>
      <View style={[styles.card, surface]}>
        <View style={styles.line} accessible accessibilityRole="summary" accessibilityLabel={`${title}. ${sub}`}>
          <LineIcon name="mail" variant="callout" size={16} color={c.amber} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold}>
              {title}
            </Text>
            <Text variant="small" tone="muted">
              {sub}
            </Text>
          </View>
        </View>
        <Button
          variant="primary"
          size="sm"
          wide
          label={t("auth.sendNewLink")}
          loading={sending}
          disabled={sending}
          onPress={() => void resend()}
        />
        <Button
          variant="secondary"
          size="sm"
          wide
          label={t("auth.confirm.change")}
          disabled={sending}
          onPress={() => router.push("/me/email")}
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
