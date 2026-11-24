import type { PlanMove } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, GroupedList, GroupedRow, useToast } from "@/ui";

/**
 * Its payer's way to keep a workspace's plan when deleting the workspace (ADR 0079): what happens to it, with the ⓘ
 * saying what moves with it, then a button per workspace it can go to; once asked, where it is going. Nothing for
 * anyone else, or with no workspace to move it to.
 */
export function PlanMoveSection({ plan }: { plan: PlanMove }) {
  const { t } = useTranslation();
  if (plan.targets.length === 0) return null;
  const warning = t("planMove.warning");
  return (
    <>
      <GroupedList>
        {plan.movedTo ? (
          <GroupedRow key="moving" icon="wallet" label={t("planMove.moving", { name: plan.movedTo })} labelLines={0} />
        ) : (
          <GroupedRow
            key="plan"
            icon="wallet"
            label={warning}
            labelLines={0}
            hint={{ name: t("common.about", { label: warning }), text: t("planMove.how") }}
          />
        )}
      </GroupedList>
      {plan.movedTo ? null : (
        <View style={styles.moves}>
          <PlanMoveButtons plan={plan} />
        </View>
      )}
    </>
  );
}

/** A button per workspace the plan can go to: the one asked busy, every one disabled meanwhile, a refusal as a toast. */
export function PlanMoveButtons({ plan, size }: { plan: PlanMove; size?: "sm" }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { move } = plan;
  return plan.targets.map((to) => (
    <Button
      key={to.id}
      variant="secondary"
      size={size}
      wide
      label={t("planMove.button", { name: to.name })}
      loading={move.isPending && move.variables === to.id}
      disabled={move.isPending}
      onPress={() => plan.start(to, (error) => toast({ title: errorText(t, error), icon: "x" }))}
    />
  ));
}

const styles = StyleSheet.create({
  moves: { gap: 8, paddingTop: 12 },
});
