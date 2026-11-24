import { type RunAccount, type RunAccountSwitch, useAccountOrder } from "@agenteschat/client";
import { accountCardFacts, accountInOrder, accountMark, accountTitle } from "@agenteschat/client/lib/ai-accounts";
import { Trans, useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { ProviderLogo, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";
import { PlanMeter } from "../usage/parts";

/**
 * An AI account a run thought with (the web's `AccountRef`): its name in bold, a press shows its card in a sheet
 * (which plan, whose, on which computer, how much of it is used).
 */
export function AccountRefText({ account }: { account: RunAccount }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheetIfAny();
  const open = () => sheet?.open(<AccountCardSheet account={account} />);
  return (
    <RNText
      accessibilityRole="button"
      accessibilityLabel={t("accountRef.label", { name: account.name })}
      accessibilityHint={t("accountRef.card", { name: account.name })}
      {...(sheet ? { onPress: open } : {})}
      style={[styles.ref, { color: c.ink }]}
    >
      {account.name}
    </RNText>
  );
}

function AccountCardSheet({ account }: { account: RunAccount }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const order = useAccountOrder(orgId);
  const found = accountInOrder(order.data?.groups, account.id);
  if (!found) {
    return (
      <SheetTitle title={account.name} subtitle={order.isPending ? t("channelRefs.loading") : t("accountRef.gone")} />
    );
  }
  const a = found.account;
  return (
    <>
      <SheetTitle
        leading={<ProviderLogo id={accountMark(a)} size="sm" />}
        title={accountTitle(t, a)}
        subtitle={accountCardFacts(t, a, found.computer).join(" · ")}
      />
      {a.usage ? <PlanMeter usage={a.usage} compact /> : null}
    </>
  );
}

/** "Seguiu na conta [B] porque a conta [A] chegou ao limite": a run's switch, its accounts pressable. */
export function AccountSwitchLine({ move }: { move: RunAccountSwitch }) {
  return (
    <Text variant="footnote" tone="muted">
      <Trans
        i18nKey={`accountSwitch.${move.cause}` as "accountSwitch.limit"}
        components={{ to: <AccountRefText account={move.to} />, from: <AccountRefText account={move.from} /> }}
      />
    </Text>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "700" },
});
