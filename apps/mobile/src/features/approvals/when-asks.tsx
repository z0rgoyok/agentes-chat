import { type Approval, useChangeWhenAsks, useUndoWhenAsks } from "@agenteschat/client";
import { APPROVALS_LEVELS, approvalsLevelOf, changesWhenAsks } from "@agenteschat/client/lib/approvals-level";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useDirectory, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";

/**
 * "Mudar quando perguntar" on a waiting approval (ADR 0173), as the web's: for who decides it and may set its agent's
 * level (who manages that agent, the server's `canManage`), the agent's three choices in the picker sheet. Choosing
 * approves nothing. Who may set the workspace's level gets "Para todos os agentes do workspace" under them. A toast
 * says the new choice, with Desfazer.
 */
export function useWhenAsks(approval: Approval | undefined) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const change = useChangeWhenAsks(orgId);
  const undo = useUndoWhenAsks(orgId);
  const agent = approval ? dir.agentById.get(approval.agentId) : undefined;
  const shown = Boolean(approval && agent && changesWhenAsks(agent, approval));
  const open = async () => {
    if (!agent) return;
    const level = approvalsLevelOf(agent);
    let everyAgent = false;
    const picked = await pickOne({
      title: t("approvalsLevel.title"),
      note: t("approvalsLevel.lead", { name: agent.name }),
      value: level,
      options: APPROVALS_LEVELS.map((value) => ({
        key: value,
        label: t(`approvalsLevel.${value}.title`),
        sub: t(`approvalsLevel.${value}.text`),
        subLines: 3,
      })),
      // The workspace's level reaches private agents too: owners and administrators only (ADR 0085 addendum of
      // 2026-11-17, the server's `setWorkspaceApprovalsLevel`).
      ...(can(org, "administrator")
        ? { toggle: { label: t("approvalsLevel.everyAgent"), onChange: (on: boolean) => (everyAgent = on) } }
        : {}),
    });
    const next = APPROVALS_LEVELS.find((value) => value === picked);
    if (!next || (next === level && !everyAgent)) return;
    change.mutate(
      { agentId: agent.id, level: next, everyAgent },
      {
        onSuccess: (before) => {
          const words = t(`approvalsLevel.${next}.title`);
          toast({
            title: everyAgent
              ? t("approvalsLevel.nowEveryAgent", { level: words })
              : t("approvalsLevel.now", { name: agent.name, level: words }),
            agentId: agent.id,
            action: {
              label: t("approvalsLevel.undo"),
              onPress: () => undo.mutate({ before, everyAgent }, { onError: failed }),
            },
          });
        },
        onError: failed,
      },
    );
  };
  return { shown, open: () => void open(), pending: change.isPending || undo.isPending };
}

/** The quiet link under a card's decision (the notifications' cards). */
export function WhenAsksLink({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const when = useWhenAsks(approval);
  if (!when.shown) return null;
  return (
    <View style={styles.line}>
      <Button
        variant="text"
        size="card"
        label={t("approvalsLevel.change")}
        disabled={when.pending}
        onPress={when.open}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Its words at the start edge, as wide as they are.
  line: { flexDirection: "row" },
});
