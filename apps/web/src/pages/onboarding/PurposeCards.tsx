import type { WorkspaceMode } from "@agenteschat/client";
import type { PurposeKind } from "@agenteschat/client/lib/purpose-scene";
import { OptionList } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PurposeScene, type PurposeYou } from "@/components/PurposeScene";
import { type PurposeLife, usePurposeLife } from "@/components/purpose-life";

const PURPOSES = ["personal", "team"] as const satisfies readonly WorkspaceMode[];

/**
 * "What will you use agentes.chat for?" (ADR 0159, 0162): two choices one over the other with no card around them, a
 * hairline between them and a round choice at each one's end. On the left the drawing, on the right the title and one
 * line saying what each view is (the simpler one keeps every feature). At rest the agents doze; pointing at one wakes
 * it and it says what it does; choosing a row wakes its agents in a wave, then one at a time says what it does.
 */
export function PurposeCards({
  value,
  onValueChange,
  you,
}: {
  value: WorkspaceMode | null;
  onValueChange: (value: WorkspaceMode | null) => void;
  you: PurposeYou;
}) {
  const { t } = useTranslation();
  const lives: Record<PurposeKind, PurposeLife> = {
    personal: usePurposeLife("personal", value === "personal"),
    team: usePurposeLife("team", value === "team"),
  };
  return (
    <OptionList<WorkspaceMode | "">
      aria-label={t("onboarding.purpose.title")}
      layout="cards"
      className="onb-purpose"
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v || null)}
      options={PURPOSES.map((mode) => ({
        value: mode,
        leading: <PurposeScene kind={mode} chosen={value === mode} you={you} life={lives[mode]} horizon={false} says />,
        title: t(`onboarding.purpose.${mode}`),
        description: t(`onboarding.purpose.${mode}Line`),
      }))}
    />
  );
}
