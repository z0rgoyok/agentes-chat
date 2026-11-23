import { useSetOrgAccent } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { type AccentTokens, accentPalette, Button, ColorPicker, DEFAULT_ACCENT, Popover } from "@agenteschat/ui";
import { AGENT_GRADIENTS } from "@agenteschat/ui/agent/engine";
import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { ACCENT_VARS, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";

/**
 * The suggestions: the agent presets' own tones, sky (the design system's blue, the default) first. Sky is named
 * outright: inside a workspace with an accent, the engine's sky is that accent.
 */
const PRESETS = Object.entries(AGENT_GRADIENTS).map(([name, [, bottom]]) => ({
  name,
  hex: name === "sky" ? DEFAULT_ACCENT : bottom,
}));

const paint = (tokens: AccentTokens) =>
  Object.fromEntries(
    Object.entries(ACCENT_VARS).map(([k, name]) => [name, tokens[k as keyof AccentTokens]]),
  ) as CSSProperties;

/**
 * Settings › Workspace › "Accent color" (ADR 0193): the color the agents' frames, mentions, links and selected states
 * take for everyone here. Admins pick it in the kit's picker or from the suggestions, see a mention and a link in it
 * before saving, and can go back to the default.
 */
export function AccentRow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { resolved } = useTheme();
  const toast = useToast();
  const save = useSetOrgAccent(org.id);
  const editable = can(org, "configure");
  const saved = org.accent ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved ?? DEFAULT_ACCENT);
  // A suggestion picked restarts the picker on it (it keeps its own hue and saturation otherwise).
  const [pickerKey, setPickerKey] = useState(0);
  const pending = save.isPending;
  const shown = accentPalette(saved ?? DEFAULT_ACCENT)[resolved];
  const preview = accentPalette(draft)[resolved];

  const commit = (accent: string | null) =>
    save.mutate(accent, {
      onSuccess: (r) => {
        setOpen(false);
        toast.show(t(r.accent ? "orgAccent.saved" : "orgAccent.reset"));
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });

  return (
    <div className="settings-row ac-actrow">
      <div className="settings-row__text ac-actrow__text">
        <span className="settings-row__label">{t("orgAccent.label")}</span>
      </div>
      <div className="settings-row__control settings-accent__control">
        <span className="settings-accent__swatch" style={{ background: shown.agent }} data-testid="accent-swatch" />
        {editable && saved && (
          <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={() => commit(null)}>
            {t("orgAccent.useDefault")}
          </Button>
        )}
        {editable && (
          <Popover
            label={t("orgAccent.label")}
            side="bottom"
            align="end"
            open={open}
            onOpenChange={(next) => {
              if (next) {
                setDraft(saved ?? DEFAULT_ACCENT);
                setPickerKey((k) => k + 1);
              }
              setOpen(next);
            }}
            trigger={
              <Button size="sm" type="button" disabled={pending}>
                {t("orgAccent.change")}
              </Button>
            }
          >
            <div className="settings-accent">
              {/* biome-ignore lint/a11y/useSemanticElements: pressable swatches, not a native fieldset */}
              <div className="newag__swatches" role="group" aria-label={t("orgAccent.suggested")}>
                {PRESETS.map(({ name, hex }) => {
                  const tokens = accentPalette(hex)[resolved];
                  return (
                    <button
                      key={name}
                      type="button"
                      className="newag__swatch"
                      aria-label={t(`look.colors.${name}` as "look.colors.sky")}
                      aria-pressed={draft === hex}
                      disabled={pending}
                      style={{ "--a": tokens.agent2, "--b": tokens.agent } as CSSProperties}
                      onClick={() => {
                        setDraft(hex);
                        setPickerKey((k) => k + 1);
                      }}
                    />
                  );
                })}
              </div>
              <ColorPicker
                key={pickerKey}
                value={draft}
                onChange={setDraft}
                labels={{ area: t("look.colorArea"), hue: t("look.hue"), hex: t("look.hex") }}
              />
              <p className="settings-accent__sample" style={paint(preview)} data-testid="accent-sample">
                <span className="settings-accent__mention">{t("orgAccent.sampleMention")}</span>{" "}
                <span className="settings-accent__link">{t("orgAccent.sampleLink")}</span>
              </p>
              <Button
                type="button"
                variant="primary"
                loading={pending}
                disabled={pending || draft === (saved ?? DEFAULT_ACCENT)}
                onClick={() => commit(draft === DEFAULT_ACCENT ? null : draft)}
              >
                {t("orgAccent.save")}
              </Button>
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}
