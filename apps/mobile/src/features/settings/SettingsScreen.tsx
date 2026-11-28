import { useOrg } from "@/providers/org";
import { ConnectorsScreen } from "../connectors/ConnectorsScreen";
import { DevicesScreen } from "../devices/DevicesScreen";
import { AccountPage } from "../me/AccountPage";
import { InvitesScreen } from "../members/InvitesScreen";
import { MembersPage } from "../members/MembersPage";
import { RolesScreen } from "../roles/RolesScreen";
import { PageSplitScreen, type SplitPages } from "../shared/SplitPanes";
import { UsageScreen } from "../usage/UsageScreen";
import { VaultScreen } from "../vault/VaultScreen";
import { AccessScreen } from "./AccessScreen";
import { AdvancedScreen } from "./AdvancedScreen";
import { AppsScreen } from "./AppsScreen";
import { AuditScreen } from "./AuditScreen";
import { GeneralScreen } from "./GeneralScreen";
import { usePersonalView } from "./hooks";
import { ImportScreen } from "./ImportScreen";
import { IntegrationsScreen } from "./IntegrationsScreen";
import { MediaSettingsScreen } from "./MediaSettingsScreen";
import { SkillsScreen } from "./SkillsScreen";
import { StorageScreen } from "./StorageScreen";
import { settingsFallback, settingsSplit } from "./split";
import { WorkspaceScreen } from "./WorkspaceScreen";

/**
 * Each page a row of the settings opens, drawn as its route draws it (`app/(app)/(main)/settings/*`, `usage`,
 * `connectors`, `me/members`, `me/account`), so it can stand beside the list (`SETTINGS_PAGES` names them).
 */
const SETTINGS_PAGE_VIEWS = {
  "/settings/general": () => <GeneralScreen />,
  "/settings/media": () => <MediaSettingsScreen />,
  "/me/members": () => <MembersPage />,
  "/settings/invites": () => <InvitesScreen />,
  "/settings/roles": () => <RolesScreen />,
  "/usage": () => <UsageScreen initialView="summary" />,
  "/connectors": () => <ConnectorsScreen />,
  "/settings/skills": () => <SkillsScreen />,
  "/settings/vault": () => <VaultScreen />,
  "/settings/access": () => <AccessScreen />,
  "/settings/apps": () => <AppsScreen />,
  "/settings/integrations": () => <IntegrationsScreen />,
  "/settings/devices": () => <DevicesScreen />,
  "/settings/storage": () => <StorageScreen />,
  "/settings/import": () => <ImportScreen />,
  "/settings/audit": () => <AuditScreen agentId={null} />,
  "/me/account": () => <AccountPage />,
  "/settings/advanced": () => <AdvancedScreen />,
} satisfies SplitPages;

/**
 * The workspace's settings (pushed from Você): its list (`WorkspaceScreen`), and on a large screen (ADR 0212: the iPhone
 * Duo's inner display) the open section's screen beside it (`PageSplitScreen`), the list's first row there while none
 * is chosen. A section's own rows (a role, a computer) push their screens over both panes, as before. Deleting or
 * resetting the workspace stays pushed after its alert.
 */
export function SettingsScreen() {
  const { org } = useOrg();
  const { personal } = usePersonalView();
  return (
    <PageSplitScreen
      store={settingsSplit}
      pages={SETTINGS_PAGE_VIEWS}
      fallback={settingsFallback(personal, org)}
      list={<WorkspaceScreen />}
      testID="settings-split"
    />
  );
}
