import { useAgentGroups } from "@agenteschat/client";
import { NO_GROUP } from "@agenteschat/client/lib/agent-groups";
import { RoleMark, Select } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";

/** A channel's sector (ADR 0240): "Sem setor" or one of the workspace's, each with its mark. */
export function SectorSelect({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (groupId: string | null) => void;
  id?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const groups = useAgentGroups(org.id).data ?? [];
  return (
    <Select
      id={id}
      value={value ?? NO_GROUP}
      onValueChange={(v) => onChange(v === NO_GROUP ? null : v)}
      options={[
        { value: NO_GROUP, label: t("agentGroups.none") },
        ...groups.map((g) => ({
          value: g.id,
          label: g.name,
          leading: <RoleMark color={g.color ?? "graphite"} icon={g.icon ?? "person"} size={16} />,
        })),
      ]}
    />
  );
}
