import { personalOfParts } from "@agenteschat/client/lib/connected";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Chip, Field, Segmented, SettingNote } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/** Which side of the Vault's split a list shows, or a new item goes to (ADR 0144). */
export type OwnerTab = "team" | "personal";

/** "Equipe (n) | Pessoal (n)" over a list, full width, as the Vault has it. */
export function OwnerTabs({
  label,
  value,
  onValueChange,
  team,
  personal,
}: {
  label: string;
  value: OwnerTab;
  onValueChange: (tab: OwnerTab) => void;
  team: number;
  personal: number;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Segmented<OwnerTab>
      block
      label={label}
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: "team", label: t(modeKey(org, "vault.tab.team")), count: team },
        { value: "personal", label: t("vault.tab.personal"), count: personal },
      ]}
    />
  );
}

/**
 * "Para quem: Pessoal | Equipe" where something is added. `locked`: the person may not choose (they may not add the
 * team's, or the thing is always its person's), said by `note`.
 */
export function ForWhom({
  label,
  value,
  onValueChange,
  locked,
  note,
}: {
  label: string;
  value: OwnerTab;
  onValueChange: (tab: OwnerTab) => void;
  locked: boolean;
  note: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Field label={label} group>
      <Segmented<OwnerTab>
        block
        label={label}
        value={value}
        onValueChange={onValueChange}
        options={[
          { value: "personal", label: t("vault.tab.personal") },
          { value: "team", label: t(modeKey(org, "vault.tab.team")), disabled: locked },
        ]}
      />
      {locked && <SettingNote icon="lock">{note}</SettingNote>}
    </Field>
  );
}

/** The mark of a person's own connection beside its name: a lock and "Pessoal". */
export function PersonalChip() {
  const { t } = useTranslation();
  return <Chip icon="lock">{t("vault.tab.personal")}</Chip>;
}

/** "Pessoal de <name>", wrapping as words do; the name in its own direction, so a right-to-left name keeps its start. */
export function PersonalOf({ name }: { name: string }) {
  const { t } = useTranslation();
  const { before, after } = personalOfParts(t);
  return (
    <span className="owner-of">
      {before}
      <bdi dir="auto">{name}</bdi>
      {after}
    </span>
  );
}
