import { useSetOrgAccent } from "@agenteschat/client";
import { DEFAULT_ACCENT } from "@agenteschat/tokens/accent";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedList, GroupedRow, useToast } from "@/ui";
import { ColorSheet } from "../agents/ColorSheet";
import { useColors } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { chooseAction } from "./parts";

/** The swatch: the agent color as the app paints it now. */
const SWATCH = 22;

/**
 * Settings › General › "Accent color" (ADR 0193), as on the web: the color shown now, and for who configures the
 * workspace the kit's color sheet to change it, or the default back.
 */
export function AccentRow({ editable }: { editable: boolean }) {
  const { t } = useTranslation();
  const { org, orgId } = useOrg();
  const c = useColors();
  const toast = useToast();
  const save = useSetOrgAccent(orgId);
  const saved = org?.accent ?? null;
  const [opens, setOpens] = useState(0);
  const [picking, setPicking] = useState(false);

  const commit = (accent: string | null) =>
    save.mutate(accent === DEFAULT_ACCENT ? null : accent, {
      onSuccess: (r) => {
        successHaptic();
        toast({ title: t(r.accent ? "orgAccent.saved" : "orgAccent.reset") });
      },
      onError: () => {
        errorHaptic();
        toast({ title: t("mobile.app.failed"), icon: "x" });
      },
    });
  const pick = () => {
    setOpens((n) => n + 1);
    setPicking(true);
  };
  const choose = () =>
    saved
      ? chooseAction(
          t("orgAccent.label"),
          [
            { icon: "pen", label: t("orgAccent.change"), onPress: pick },
            { icon: "undo", label: t("orgAccent.useDefault"), onPress: () => commit(null) },
          ],
          t("mobile.common.cancel"),
        )
      : pick();

  return (
    <>
      <GroupedList>
        <GroupedRow
          label={t("orgAccent.label")}
          valueLeading={<View style={[styles.swatch, { backgroundColor: c.agent, borderColor: c.line2 }]} />}
          {...(editable ? { more: Boolean(saved), chevron: !saved, onPress: choose, disabled: save.isPending } : {})}
        />
      </GroupedList>
      <ColorSheet
        key={opens}
        open={picking}
        value={saved ?? DEFAULT_ACCENT}
        title={t("orgAccent.label")}
        done={t("orgAccent.save")}
        onChange={() => {}}
        onDone={commit}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH * 0.3, borderWidth: StyleSheet.hairlineWidth },
});
