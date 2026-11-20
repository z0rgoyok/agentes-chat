import { Icon } from "./Icon";
import { useTheme } from "./theme";

/** The marks at a row's end, in points: the system lists' chevron, a menu's up-down mark and the chosen check. */
export const ROW_MARK = { disclosure: 17, menu: 16, check: 20 } as const;

/** › at a row's end: it opens a screen. The system's chevron, semibold, in its tertiary gray. */
export function Disclosure({ color }: { color?: string }) {
  const { colors } = useTheme();
  return <Icon name="right" size={ROW_MARK.disclosure} weight="semibold" color={color ?? colors.label3} />;
}

/** ⇅ after a row's value: the value changes in the row, through a menu (the system's pop-up button mark). */
export function MenuMark() {
  const { colors } = useTheme();
  return <Icon name="updown" size={ROW_MARK.menu} weight="semibold" color={colors.label3} />;
}

/** ✓ at a row's end: the chosen option. */
export function CheckMark({ color }: { color?: string }) {
  const { colors } = useTheme();
  return <Icon name="check" size={ROW_MARK.check} weight="semibold" color={color ?? colors.ink} />;
}
