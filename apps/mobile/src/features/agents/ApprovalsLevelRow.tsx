import { type Agent, useAgents, useSettings, useSetWorkspaceApprovalsLevel, useUpdateAgent } from "@agenteschat/client";
import {
  APPROVALS_LEVELS,
  approvalsLevelLine,
  ownApprovalsCount,
  shownApprovalsLevel,
} from "@agenteschat/client/lib/approvals-level";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { useTranslation } from "react-i18next";
import { GroupedList, GroupedRow } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";

/** The three levels as the picker sheet lists them, each a title and its line. */
const useLevelOptions = () => {
  const { t } = useTranslation();
  return APPROVALS_LEVELS.map((value) => ({
    key: value,
    label: t(`approvalsLevel.${value}.title`),
    sub: t(`approvalsLevel.${value}.text`),
    subLines: 3,
  }));
};

/**
 * The web's Aprovações (ADR 0173) on the phone: how much the agent asks before acting, one row with the choice in
 * sight, "· do workspace" after it while it has no choice of its own. Whoever manages it opens the three choices in the
 * app's picker (the value's up-down mark: it changes in its row, no screen opens), and a pick saves at once. Anyone
 * else reads the row.
 */
export function ApprovalsLevelRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const failed = useFailed();
  const options = useLevelOptions();
  const update = useUpdateAgent(useOrgId(), agent.id);
  const level = shownApprovalsLevel(agent, update);
  const title = t("approvalsLevel.title");
  const choose = async () => {
    const picked = await pickOne({
      title,
      note: t("approvalsLevel.lead", { name: agent.name }),
      value: level,
      options,
    });
    const next = APPROVALS_LEVELS.find((value) => value === picked);
    if (next && next !== level) update.mutate({ approvalsLevel: next }, { onError: failed });
  };
  return (
    <GroupedList>
      <GroupedRow
        icon="shield"
        label={title}
        value={approvalsLevelLine(t, agent, update)}
        {...(managesAgent(agent) ? { menu: true, disabled: update.isPending, onPress: () => void choose() } : {})}
      />
    </GroupedList>
  );
}

/**
 * Settings → Aprovações (ADR 0173 addendum 2026-11-15), for who may set every agent's level: the workspace's level,
 * which every agent without its own choice follows. The sheet says how many agents keep their own.
 */
export function WorkspaceApprovalsRow() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useFailed();
  const options = useLevelOptions();
  const settings = useSettings(orgId);
  const agents = useAgents(orgId).data ?? [];
  const set = useSetWorkspaceApprovalsLevel(orgId);
  const level = (set.isPending ? set.variables?.level : undefined) ?? settings.data?.approvalsLevel ?? "risky";
  const title = t("approvalsLevel.title");
  const own = ownApprovalsCount(agents);
  const choose = async () => {
    const picked = await pickOne({
      title,
      note: own > 0 ? t("approvalsLevel.ownAgents", { count: own }) : t("approvalsLevel.workspaceLead"),
      value: level,
      options,
    });
    const next = APPROVALS_LEVELS.find((value) => value === picked);
    if (next && next !== level) set.mutate({ level: next }, { onError: failed });
  };
  return (
    <GroupedList>
      <GroupedRow
        label={title}
        hint={{ name: t("common.about", { label: title }), text: t("approvalsLevel.workspaceHelp") }}
        value={t(`approvalsLevel.${level}.title`)}
        menu
        disabled={set.isPending || !settings.data}
        onPress={() => void choose()}
      />
    </GroupedList>
  );
}
