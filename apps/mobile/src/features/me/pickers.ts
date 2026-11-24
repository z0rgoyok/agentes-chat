import { useTranslation } from "react-i18next";
import { type SoundChoice, setSoundChoice, useSoundChoice } from "@/lib/sounds";
import { type ThemePreference, useTheme } from "@/ui";
import { pickOne } from "../shared/PickerSheet";
import { useSoundLabel } from "./PreferencePages";

/**
 * Sons and Aparência, a few fixed choices each, change through the app's picker (the one in use checked), with no
 * screen of their own: from their rows in Você, and from a setting found by the search. Their values, as the rows
 * show them.
 */
export function useMePickers() {
  const { t } = useTranslation();
  const theme = useTheme();
  const sounds = useSoundChoice();
  const styleLabel = useSoundLabel();
  const pickSound = () => {
    const choices: SoundChoice[] = ["tactile", "sky", "pixel", "off"];
    void pickOne({
      title: t("mobile.me.sounds"),
      value: sounds,
      options: choices.map((choice) => ({
        key: choice,
        label: choice === "off" ? t("mobile.me.soundsOff") : styleLabel(choice),
      })),
    }).then((key) => {
      if (key) setSoundChoice(key as SoundChoice);
    });
  };
  const pickTheme = () => {
    const choices: ThemePreference[] = ["system", "light", "dark"];
    void pickOne({
      title: t("mobile.me.appearance"),
      value: theme.preference,
      options: choices.map((choice) => ({ key: choice, label: t(`mobile.theme.${choice}`) })),
    }).then((key) => {
      if (key) theme.setPreference(key as ThemePreference);
    });
  };
  return {
    pickSound,
    pickTheme,
    soundValue: sounds === "off" ? t("mobile.me.soundsOff") : styleLabel(sounds),
    themeValue: t(`mobile.theme.${theme.preference}`),
  };
}
