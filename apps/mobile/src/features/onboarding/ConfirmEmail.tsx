import { keys, meQuery, useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { isEmail } from "@agenteschat/client/lib/text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { signOut } from "@/features/account";
import { authClient } from "@/lib/auth";
import { Button, Locked, Text } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";

/** How often the screen asks whether the link was opened, maybe on another device. */
const OPENED_POLL_MS = 3000;
/** How long before the screen says where else the email may be: help shows inline after a wait. */
const SPAM_HINT_MS = 30_000;

/** A new link to `email` (Better Auth's, rate limited per address): true once it went. */
export async function sendConfirmationLink(email: string) {
  const res = await authClient()
    .sendVerificationEmail({ email })
    .catch(() => null);
  return Boolean(res && !res.error);
}

/**
 * "Check your inbox", in place of the first run for an account whose address was never confirmed and that is in no
 * workspace yet (`emailConfirmation` `required`, ADR 0006, addendum 2026-11-22), as on the web: a new link, a new
 * address typed here (changed at once, its link sent there; an older sign-in is asked to sign in again), and Sair. It
 * moves on by itself once `/me` says the address is confirmed.
 */
export function ConfirmEmailScreen({ email }: { email: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  useQuery({ ...meQuery(api), refetchInterval: OPENED_POLL_MS, refetchOnWindowFocus: "always" });
  const [pending, setPending] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const [changing, setChanging] = useState(false);
  const [value, setValue] = useState("");
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SPAM_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setSaid(null);
    try {
      await work();
    } finally {
      setPending(false);
    }
  };
  const resend = () =>
    run(async () => {
      const sent = await sendConfirmationLink(email);
      setSaid(
        sent
          ? { text: t("auth.newLinkSent", { email }), failed: false }
          : { text: t("mobile.app.failed"), failed: true },
      );
    });
  const newEmail = value.trim();
  const change = () =>
    run(async () => {
      try {
        const r = await api.account.changeEmail({ newEmail });
        setChanging(false);
        setValue("");
        setSaid({ text: t("auth.newLinkSent", { email: r.email }), failed: false });
        await qc.invalidateQueries({ queryKey: keys.me });
      } catch (e) {
        setSaid({ text: errorText(t, e), failed: true });
      }
    });
  return (
    <AuthScaffold
      sky="low"
      title={t("auth.confirm.title")}
      subtitle={t("auth.confirm.lead", { email })}
      stepKey="confirm-email"
      agentMode={pending ? "run" : "idle"}
      footer={pending ? null : <AuthLink label={t("mobile.org.signOut")} onPress={() => void signOut()} />}
    >
      <Locked when={pending} keepKeyboard style={styles.stack}>
        {changing ? (
          <>
            <AuthField
              value={value}
              onChangeText={(v) => {
                setValue(v);
                setSaid(null);
              }}
              placeholder={email}
              accessibilityLabel={t("shell.email.new")}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="go"
              autoFocus
              onSubmitEditing={() => {
                if (isEmail(newEmail)) void change();
              }}
            />
            <Button
              variant="primary"
              wide
              label={t("shell.email.change")}
              loading={pending}
              disabled={!isEmail(newEmail)}
              onPress={() => void change()}
            />
            <Button variant="ghost" wide label={t("mobile.common.cancel")} onPress={() => setChanging(false)} />
          </>
        ) : (
          <>
            <Button
              variant="primary"
              wide
              label={t("auth.sendNewLink")}
              loading={pending}
              onPress={() => void resend()}
            />
            <Button variant="ghost" wide label={t("auth.confirm.wrongAddress")} onPress={() => setChanging(true)} />
          </>
        )}
      </Locked>
      {said ? (
        <Text
          variant="small"
          tone={said.failed ? "danger" : "muted"}
          accessibilityLiveRegion="polite"
          style={[CENTER, styles.said]}
        >
          {said.text}
        </Text>
      ) : late && !changing ? (
        <Text variant="small" tone="faint" style={[CENTER, styles.said]}>
          {t("auth.flow.sentLead")}
        </Text>
      ) : null}
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  said: { paddingTop: 12 },
});
