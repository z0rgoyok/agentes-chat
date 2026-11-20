import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, GroupedList } from "@/ui";
import { router } from "@/ui/navigation";
import { RowBones } from "../roles/parts";
import { SettingsPage } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { goBack, Loaded } from "../shared/parts";
import { ReviewStep, type SaveBar } from "./ToolReview";

/** Opens a connection's Ferramentas (from its sheet, or the gallery when its tools wait for a review). */
export const openTools = (id: string) => router.push({ pathname: "/connectors/tools", params: { id } });

/**
 * Ferramentas, a screen pushed over Conectores (the web's "Ferramentas", "Revisar" while some wait): what each
 * tool may do on its own, grouped by level, on the settings' page under the native bar with its back button. A
 * server's are changed here and saved with Salvar, docked at the bottom (over the keyboard while the search is
 * typed in), which goes back; our catalog services' are shown as they are.
 */
export function ToolsScreen({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === connectionId,
  );
  const name = item ? itemName(t, item) : "";
  // Until the connection is known, a catalog one can't tell its tools yet (it would read as none).
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  // A server's Salvar, docked at the bottom: the review hands it up (a state setter, the same every render).
  const [save, setSave] = useState<SaveBar | null>(null);
  return (
    <SettingsPage
      title={t("connectors.tools")}
      {...(name ? { subtitle: name } : {})}
      {...(save
        ? {
            bottom: (
              <Button
                variant="primary"
                wide
                label={save.label}
                disabled={save.busy}
                loading={save.saving}
                onPress={save.onPress}
              />
            ),
          }
        : {})}
    >
      {/* The tools fade in over their rows' shape; tools already here when the screen opens just show. */}
      <View style={styles.page}>
        {loading ? (
          // The rows' shape while the connection is read, never a bare spinner.
          <GroupedList>
            <RowBones />
            <RowBones name={56} />
          </GroupedList>
        ) : (
          <Loaded>
            <View style={styles.stack}>
              <ReviewStep
                connectionId={connectionId}
                def={item?.def ?? null}
                name={name}
                onNext={goBack}
                onScreen
                onSaveBar={setSave}
              />
            </View>
          </Loaded>
        )}
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // Under the page's own margin, as the connection screen it opens from.
  page: { paddingTop: 4, gap: 14 },
  // The page's own gap, for what fades in together.
  stack: { gap: 14 },
});
