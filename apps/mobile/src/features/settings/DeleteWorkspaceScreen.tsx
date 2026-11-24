import {
  ApiError,
  useApi,
  useAuthConfig,
  useDeleteWorkspace,
  useMe,
  usePlanMove,
  useResetWorkspace,
} from "@agenteschat/client";
import { deletionProof, proofToSend } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { typedCode } from "@agenteschat/client/lib/join-requests";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  HoldButton,
  Locked,
  Text,
  useToast,
} from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { PasswordField } from "@/ui/auth/PasswordField";
import { router } from "@/ui/navigation";
import { openWebPath } from "../links/open-web";
import { errorHaptic } from "../shared/parts";
import { PlanMoveSection } from "./PlanMove";
import { Gap, ResendCode, SettingsPage } from "./parts";

/**
 * Apagar o workspace, the screen after the alert on the workspace's page (owners): what it does, in the grouped
 * list's words (`deleteOrg.goes.*`), then the proof that it's them (ADR 0088 §2: a code emailed to them, or on a
 * server that sends no email their password, which the website adds first to an account without one), and the hold.
 * Done, the app's root shows the workspace as being deleted, with Restore for its owners, so this screen only goes
 * back. The hold is the one deliberate motion here: a linear fill while held, a quick snap back on release. With
 * `reset`, Recomeçar o workspace instead: what goes and what stays, its own code, and back at the root the apps start
 * over once the server says it is done (`org.reset`).
 */
export function DeleteWorkspaceScreen({ reset = false }: { reset?: boolean }) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const me = useMe().data;
  const config = useAuthConfig().data;
  const deletion = useDeleteWorkspace(orgId);
  const restart = useResetWorkspace(orgId);
  const plan = usePlanMove(orgId);
  const remove = reset ? restart : deletion;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [sending, setSending] = useState(false);
  // Why the proof was refused, under its field.
  const [refused, setRefused] = useState<string | null>(null);
  const proof = deletionProof(config, me?.user.hasPassword);
  const toSend = proofToSend(proof, { sent: sent !== null, code, password });
  const name = org?.name ?? "";
  const busy = remove.isPending;

  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const sendCode = async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await (reset ? api.orgs.resetCode(orgId) : api.orgs.deletionCode(orgId));
      codeOut(r.email, r.resendIn);
      setCode("");
      setRefused(null);
    } catch (e) {
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "reauth.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(me?.user.email ?? "", retryIn);
      else setRefused(errorText(t, e));
    } finally {
      setSending(false);
    }
  };

  const confirm = () => {
    if (busy || !toSend.ready) return;
    remove.mutate(toSend.input, {
      onSuccess: () => {
        if (reset) toast({ title: t("resetOrg.resetting", { name }) });
        // The hold already answered the finger. Back at Conversas, the workspace reads as ever under its notice on top.
        router.dismissTo("/");
      },
      onError: (e) => {
        errorHaptic();
        const code = e instanceof ApiError ? e.code : "";
        if (code.startsWith("reauth.")) {
          setRefused(errorText(t, e));
          setCode("");
          setPassword("");
        } else
          toast({
            title: errorText(t, e) || t(reset ? "mobile.settings.resetFailed" : "mobile.settings.deleteFailed"),
            icon: "x",
          });
      },
    });
  };

  return (
    <SettingsPage title={t(reset ? "resetOrg.row.title" : "deleteOrg.card.title")} locked={busy}>
      <Gap />
      <Text variant="body" tone="ink2" style={styles.intro}>
        {reset ? t("resetOrg.row.text") : t("mobile.settings.deleteIntro", { name })}
      </Text>
      <GroupedHeader>{t(reset ? "resetOrg.row.title" : "deleteOrg.card.title")}</GroupedHeader>
      {reset ? (
        <GroupedList>
          <GroupedRow key="goes" icon="archive" label={t("resetOrg.goes")} labelLines={3} />
          <GroupedRow key="stays" icon="check" label={t("resetOrg.stays")} labelLines={3} />
          <GroupedRow key="fresh" icon="undo" label={t("resetOrg.fresh")} labelLines={3} />
        </GroupedList>
      ) : (
        <GroupedList>
          <GroupedRow key="content" icon="archive" label={t("deleteOrg.goes.content")} labelLines={3} />
          <GroupedRow key="people" icon="members" label={t("deleteOrg.goes.peopleQuiet")} labelLines={3} />
          <GroupedRow key="connectors" icon="join" label={t("deleteOrg.goes.connectors")} labelLines={3} />
        </GroupedList>
      )}
      <GroupedFooter>{t(reset ? "resetOrg.now" : "mobile.settings.deleteFoot")}</GroupedFooter>
      {reset ? null : <PlanMoveSection plan={plan} />}

      <View style={styles.proof}>
        {proof === "code" && !sent ? (
          <>
            <Text variant="body" tone="ink2" style={styles.words}>
              {t("proof.willSend", { email: me?.user.email ?? "" })}
            </Text>
            <Button variant="secondary" label={t("proof.send")} loading={sending} onPress={() => void sendCode()} />
          </>
        ) : null}
        {proof === "code" && sent ? (
          <>
            <Locked when={busy || sending}>
              <AuthField
                code
                value={code}
                onChangeText={(value) => {
                  setCode(typedCode(value));
                  setRefused(null);
                }}
                placeholder={t("proof.code")}
                accessibilityLabel={t("proof.code")}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                returnKeyType="done"
              />
            </Locked>
            <Text variant="small" tone="muted" style={styles.words}>
              {t("proof.sent", { email: sent.email })}
            </Text>
            <ResendCode resendAt={sent.resendAt} disabled={busy} sending={sending} onPress={() => void sendCode()} />
          </>
        ) : null}
        {proof === "password" ? (
          <Locked when={busy}>
            {/* Not focused as it appears: the keyboard would cover what deleting takes before it is read. */}
            <PasswordField
              label={t("proof.password")}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setRefused(null);
              }}
              autoFocus={false}
            />
          </Locked>
        ) : null}
        {proof === "addPassword" ? (
          me?.user.confirmsOnThisMac ? (
            <Text variant="body" tone="ink2" style={styles.words}>
              {t("mobile.delete.onThisComputer")}
            </Text>
          ) : (
            <>
              <Text variant="body" tone="ink2" style={styles.words}>
                {t("mobile.delete.addPasswordFirst")}
              </Text>
              <Button
                variant="secondary"
                label={t("mobile.delete.addPasswordWeb")}
                onPress={() => openWebPath(`/org/${orgId}?account=password`)}
              />
            </>
          )
        ) : null}
        {refused ? (
          <Text variant="small" tone="danger" style={styles.words} accessibilityLiveRegion="polite">
            {refused}
          </Text>
        ) : null}
        <HoldButton
          label={t(reset ? "mobile.settings.holdReset" : "mobile.settings.holdDelete")}
          disabled={!toSend.ready || busy}
          onConfirm={confirm}
        />
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // Words off the cards start where a group's header and footer do; fields and buttons keep the cards' edge.
  intro: { paddingHorizontal: 16 },
  words: { paddingHorizontal: 16 },
  proof: { gap: 12, paddingTop: 24 },
});
