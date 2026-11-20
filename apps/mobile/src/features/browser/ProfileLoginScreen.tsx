import { useBrowserProfiles, useMachines } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, SkeletonList, Text } from "@/ui";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useOrgId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { BrowserCard } from "./BrowserCard";

/**
 * "Fazer login" from the phone (ADR 0110): a shared browser profile's live view, pushed with the opaque bar (its title),
 * the computer it runs on in a line over it, in the person's control; Devolver hands it back to its agents. The take
 * over itself happened on the computer's page.
 */
export function ProfileLoginScreen({ profileId }: { profileId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const profiles = useBrowserProfiles(orgId);
  const profile = profiles.data?.find((p) => p.id === profileId);
  const machine = useMachines(orgId, Boolean(profile)).data?.find((m) => m.id === profile?.machineId);
  return (
    <SheetHostProvider>
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader
          title={profile ? t("browser.profiles.loginTitle", { name: profile.name }) : t("browser.profiles.title")}
        />
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          {/* Where it runs and who waits, whole: the bar's one line would cut it. */}
          {profile ? (
            <Text variant="footnote" tone="muted" style={styles.line}>
              {machine
                ? t("browser.profiles.controlSubOn", { machine: machine.name })
                : t("browser.profiles.controlSub")}
            </Text>
          ) : null}
          {profile ? (
            <BrowserCard
              agentId={`profile:${profile.id}`}
              profile={{ id: profile.id, name: profile.name, machineId: profile.machineId }}
              surface
              style={styles.flush}
            />
          ) : profiles.isError ? (
            // A list that didn't load is not a profile that's gone: what happened, and the way to ask again.
            <LoadFailed onRetry={() => void profiles.refetch()} />
          ) : profiles.data ? (
            // Removed meanwhile (on the computer's page, or the web): said, never a blank screen.
            <EmptyState size="inline" title={t("common.gone")} />
          ) : (
            // The profiles still on their way: the shape of what comes, never a blank screen.
            <SkeletonList rows={2} />
          )}
        </ScrollView>
      </View>
    </SheetHostProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  body: { paddingHorizontal: 12, paddingTop: 8, gap: 12 },
  flush: { marginTop: 0 },
  // On the screen's 16-point margin, as a group's footer.
  line: { paddingHorizontal: 4 },
});
