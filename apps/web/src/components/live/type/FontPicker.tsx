import type { LiveFileFont } from "@agenteschat/client";
import {
  assetFontFamily,
  catalogFont,
  FONT_CATALOG,
  FONT_FALLBACK,
  type FontCategory,
  type FontRef,
  fontAssetOf,
  fontAssetRef,
  isFontRole,
} from "@agenteschat/live";
import { cx, Icon, SearchSelect, type SelectOption } from "@agenteschat/ui";
import { useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FontAssetUrl, fontFamilyCss, loadFontRef } from "../fonts";
import "./type.css";

/**
 * The font list people pick from in slides, canvases and documents (ADR 0220 §8): a search over the file's own
 * fonts (its heading and text fonts, or the ones a canvas already uses), the company's fonts brought from the Drive,
 * then the catalog by kind, each name drawn in its own face. Under the list, the file's fonts and bringing one from
 * the Drive. In a toolbar it is a narrow button with the font's name; in a dialog, a field.
 */

export type TypeFileKind = "slides" | "canvas" | "document";

/** What a file's font list offers besides the catalog. */
export interface FontChoices {
  kind: TypeFileKind;
  /** The file's heading and text fonts (slides, documents): catalog ids or the file's own. */
  roles?: { heading: FontRef; body: FontRef };
  /** The file's fonts brought from the Drive, regular faces first. */
  own: readonly LiveFileFont[];
  /** Fonts the file's other pieces use (a canvas has no heading and text fonts). */
  used?: readonly FontRef[];
}

interface FontOption extends SelectOption<string> {
  /** What to load and draw the row with (a role's own font). */
  ref: FontRef;
  family: string;
  note?: string;
}

const CATEGORIES: readonly FontCategory[] = ["sans", "serif", "display", "mono", "handwriting"];

/** One face per family of the file's own fonts: the first, the regular one. */
function ownFamilies(own: readonly LiveFileFont[]): LiveFileFont[] {
  const seen = new Set<string>();
  return own.filter((f) => {
    const key = f.family.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A ref's family name as people read it: a catalog font's, a file font's own, else null. */
export function fontName(ref: FontRef | undefined, own: readonly LiveFileFont[]): string | null {
  if (!ref) return null;
  const asset = fontAssetOf(ref);
  if (asset) return own.find((f) => f.id === asset)?.family ?? null;
  return catalogFont(ref)?.family ?? null;
}

/** A ref's CSS family with its kind's fallback (a file font by its own name). */
function familyCss(ref: FontRef): string {
  return fontFamilyCss(ref) ?? FONT_FALLBACK.sans;
}

/** The weights a font draws, among the ones people pick from; a file's own font offers them all. */
export function fontWeights(ref: FontRef | undefined, offered: readonly number[]): readonly number[] {
  const font = ref ? catalogFont(ref) : undefined;
  if (!font) return offered;
  const has = offered.filter((w) => (font.weights as readonly number[]).includes(w));
  return has.length ? has : offered;
}

export function useFontOptions(choices: FontChoices): FontOption[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const out: FontOption[] = [];
    const fileGroup = t(`live.type.groups.${choices.kind}`);
    if (choices.roles) {
      for (const role of ["heading", "body"] as const) {
        const ref = choices.roles[role];
        out.push({
          value: role,
          ref,
          label: fontName(ref, choices.own) ?? t("live.type.ownFont"),
          family: familyCss(ref),
          group: fileGroup,
          note: role === "heading" ? t("live.type.headings") : t("live.type.body"),
        });
      }
    }
    const own = ownFamilies(choices.own);
    const ownIds = new Set(choices.own.map((f) => fontAssetRef(f.id)));
    for (const ref of choices.used ?? []) {
      if (isFontRole(ref) || ownIds.has(ref)) continue;
      const name = fontName(ref, choices.own);
      if (name) out.push({ value: ref, ref, label: name, family: familyCss(ref), group: fileGroup });
    }
    for (const f of own) {
      const ref = fontAssetRef(f.id);
      out.push({
        value: ref,
        ref,
        label: f.family,
        family: `"${assetFontFamily(f.id)}", ${FONT_FALLBACK.sans}`,
        group: t("live.type.groups.company"),
        note: t("live.type.fromDrive"),
      });
    }
    for (const category of CATEGORIES) {
      for (const font of FONT_CATALOG) {
        if (font.category !== category) continue;
        out.push({
          value: font.id,
          ref: font.id,
          label: font.family,
          family: familyCss(font.id),
          group: t(`live.type.groups.${category}`),
        });
      }
    }
    return out;
  }, [choices, t]);
}

/** A row of the list: the family's name in its own face, loaded once the row shows. */
function FontRow({ option }: { option: FontOption }) {
  const assetUrl = useContext(FontAssetUrl);
  useEffect(() => loadFontRef(option.ref, assetUrl), [option.ref, assetUrl]);
  return (
    <span className="lf-fontrow">
      <span className="lf-fontrow__name" style={{ fontFamily: option.family }}>
        {option.label}
      </span>
      {option.note && <span className="lf-fontrow__note">{option.note}</span>}
    </span>
  );
}

export function FontPicker({
  choices,
  value,
  onChange,
  look = "bar",
  label,
  onFileFonts,
  onBring,
  disabled,
}: {
  choices: FontChoices;
  /** A role (`heading`, `body`) or a ref. */
  value: FontRef;
  onChange: (ref: FontRef) => void;
  look?: "bar" | "field";
  /** Its accessible name; default "Font". */
  label?: string;
  /** "Fontes da apresentação…": the file's heading and text fonts. */
  onFileFonts?: () => void;
  /** "Trazer fonte do Drive…". */
  onBring?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const options = useFontOptions(choices);
  const assetUrl = useContext(FontAssetUrl);
  const chosen = options.find((o) => o.value === value);
  const shownRef = chosen?.ref ?? (isFontRole(value) ? choices.roles?.[value] : value);
  useEffect(() => loadFontRef(shownRef, assetUrl), [shownRef, assetUrl]);
  const name = label ?? t("live.type.font");
  const fileFonts = choices.kind === "canvas" ? null : t(`live.type.fileFonts.${choices.kind}`);
  return (
    <SearchSelect<string, FontOption>
      className={cx("lf-fontsel", look === "bar" && "lf-fontsel--bar")}
      aria-label={name}
      value={value}
      onValueChange={onChange}
      options={options}
      disabled={disabled}
      labels={{
        search: t("live.type.search"),
        searchPlaceholder: t("live.type.search"),
        noResults: t("live.type.noResults"),
        list: t("live.type.list"),
      }}
      renderOption={(o) => <FontRow option={o} />}
      renderValue={(o) => (
        <span
          className="lf-fontsel__name"
          style={{ fontFamily: o?.family ?? (shownRef ? familyCss(shownRef) : undefined) }}
          title={name}
        >
          {o?.label ?? fontName(shownRef, choices.own) ?? t("live.type.ownFont")}
        </span>
      )}
      footer={
        onFileFonts || onBring
          ? (close) => (
              <>
                {onFileFonts && fileFonts && (
                  <button
                    type="button"
                    className="ac-menu__item lf-fontsel__foot"
                    onClick={() => {
                      close();
                      onFileFonts();
                    }}
                  >
                    <Icon name="textTool" />
                    <span className="ac-menu__label">{`${fileFonts}…`}</span>
                  </button>
                )}
                {onBring && (
                  <button
                    type="button"
                    className="ac-menu__item lf-fontsel__foot"
                    onClick={() => {
                      close();
                      onBring();
                    }}
                  >
                    <Icon name="drive" />
                    <span className="ac-menu__label">{t("live.type.bring")}</span>
                  </button>
                )}
              </>
            )
          : undefined
      }
    />
  );
}
