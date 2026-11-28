import { useMachines, useRetryCliFetch } from "@agenteschat/client";
import { cliFetchLine, shownFetch } from "@agenteschat/client/lib/cli-fetch";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button } from "@/ui";
import { Meter } from "../settings/parts";
import { Note } from "./parts";

/**
 * A coding CLI its computer fetches by itself (ADR 0228 §6), in the agent's AI screen and Contas de IA, as the web
 * says it: "Preparando o Claude Code no MacBook… 45%" with the meter while it comes, and why it failed with "Tentar
 * de novo", which asks the computer to fetch it again now. Nothing once it is ready.
 */
export function CliFetchNote({ machineId, cli }: { machineId: string; cli: string | undefined }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const machine = useMachines(orgId).data?.find((m) => m.id === machineId);
  const retry = useRetryCliFetch(orgId);
  const shown = machine && cli ? shownFetch(machine, cli) : undefined;
  const line = machine && shown ? cliFetchLine(t, machine.cliFetch?.[shown], shown, machine.name) : null;
  if (!machine || !shown || !line) return null;
  if (!line.failed) {
    return (
      <View style={styles.block}>
        <Note icon="clock" inset live>
          {line.text}
        </Note>
        {line.percent !== null ? (
          <View style={styles.bar}>
            <Meter value={line.percent} max={100} label={line.text} />
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.block}>
      <Note icon="x" inset live>
        {line.text}
      </Note>
      <View style={styles.action}>
        <Button
          variant="secondary"
          size="sm"
          label={t("common.retry")}
          disabled={retry.isPending || !machine.online}
          loading={retry.isPending}
          onPress={() => retry.mutate({ machineId: machine.id, cli: shown })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  bar: { paddingHorizontal: 16 },
  action: { paddingHorizontal: 16, alignItems: "flex-start" },
});
