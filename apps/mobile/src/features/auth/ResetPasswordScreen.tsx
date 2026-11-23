import { passwordState } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/auth";
import { useSession } from "@/providers/session";
import { Button, Locked, Text } from "@/ui";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { PasswordField } from "@/ui/auth/PasswordField";
import { haptics } from "@/ui/haptics";
import { landOn } from "@/ui/navigation";
import { Quiet } from "./AuthFlow";
import { refusalOf, refusalText } from "./human-check";

/** Better Auth's refusals that mean the link itself no longer works: it expired or was used, or its account is gone. */
const LINK_GONE = new Set(["INVALID_TOKEN", "USER_NOT_FOUND"]);

/**
 * "Esqueci a senha"'s link opened in the app (`/reset-password?token=`, a universal link / App Link): a new
 * password, then back to signing in. No token, or one the server says is no longer good: the link expired, and a
 * new one is asked for. Anything else (no connection, a limit, the server failing) is said under the field, which
 * keeps the password typed, to try again. Opened over the app or the sign-in, the system's back returns there; the
 * form's "Not now" leaves for the sign-in (the app, signed in) either way, as a connect link's does.
 */
export function ResetPasswordScreen({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const session = useSession();
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"form" | "done" | "expired">(token ? "form" : "expired");
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = passwordState(password) === "ok";
  const save = async () => {
    if (!token || !ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const refused = refusalOf(await authClient().resetPassword({ newPassword: password, token }));
      if (refused) {
        haptics.warning();
        if (refused.code && LINK_GONE.has(refused.code)) setState("expired");
        else setError(refused.status ? refusalText(t, refused) : t("mobile.auth.errors.network"));
        return;
      }
      haptics.success();
      setState("done");
    } catch (e) {
      // Only a request that never got an answer is "no connection"; anything else reads as the generic failure.
      const network = e instanceof TypeError && /network|fetch/i.test(e.message);
      haptics.warning();
      setError(t(network ? "mobile.auth.errors.network" : "mobile.auth.errors.generic"));
    } finally {
      setPending(false);
    }
  };
  const toSignIn = () => landOn("/sign-in");
  // Signed in already (a link opened on a phone that is), leaving is for the app; otherwise the sign-in.
  const leave = () => landOn(session.signedIn ? "/" : "/sign-in");
  if (state === "expired")
    return (
      <AuthScaffold title={t("mobile.reset.expired")} subtitle={t("mobile.reset.expiredLead")} expression="closed">
        <Button variant="primary" wide label={t("mobile.reset.toSignIn")} onPress={toSignIn} />
      </AuthScaffold>
    );
  if (state === "done")
    return (
      <AuthScaffold title={t("mobile.reset.done")} expression="happy">
        <Button variant="primary" wide label={t("mobile.reset.toSignIn")} onPress={toSignIn} />
      </AuthScaffold>
    );
  return (
    <AuthScaffold
      title={t("mobile.reset.title")}
      agentMode={pending ? "run" : "idle"}
      {...(secret ? { expression: "closed" as const } : {})}
    >
      <Locked when={pending}>
        <PasswordField
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setError(null);
          }}
          fresh
          onSecretChange={setSecret}
          onSubmitEditing={() => void save()}
          label={t("invite.createPassword")}
        />
      </Locked>
      {error ? (
        <Text tone="danger" variant="small" accessibilityLiveRegion="polite" style={CENTER}>
          {error}
        </Text>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("mobile.reset.save")}
        loading={pending}
        disabled={!ready}
        onPress={() => void save()}
      />
      {pending ? null : <Quiet label={t("mobile.auth.connect.notNow")} onPress={leave} />}
    </AuthScaffold>
  );
}
