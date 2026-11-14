import { isRoleTab, type RoleTab } from "@agenteschat/client/lib/roles";
import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/** Settings › Cargos › one cargo (`everyone` for Todos, `owner` for Dono), on one of its tabs (`?tab=`). */
export const Route = createFileRoute("/org/$orgId/settings_/roles/$roleId")({
  validateSearch: (search: Record<string, unknown>): { tab?: RoleTab } => ({
    tab: isRoleTab(search.tab) ? search.tab : undefined,
  }),
  component: function RoleRoute() {
    const { roleId } = Route.useParams();
    const { tab } = Route.useSearch();
    return (
      <Main>
        <SettingsPage section="roles" role={roleId} tab={tab} />
      </Main>
    );
  },
});
