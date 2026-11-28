import { RadioGroup as RRadioGroup } from "radix-ui";
import { type ButtonHTMLAttributes, Fragment, type ReactNode, useId } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Chip } from "./Chip";
import { useLocked } from "./Field";

export interface OptionListItem<V extends string> {
  value: V;
  title: ReactNode;
  /** Quiet words after the title ("Recomendado", "Em teste"). */
  tag?: ReactNode;
  /** One short line under the title. */
  description?: ReactNode;
  /** Before the text: an illustration (`AutonomyPixels`), an icon, an avatar. No radio dot: the chosen one's border says it. */
  leading?: ReactNode;
  /** Shown but not choosable now (say why in `description`). */
  disabled?: boolean;
  /** Cards only: at the bottom of the card (a chip with where it runs). */
  foot?: ReactNode;
  /** Rows only: quiet words at the row's end (where it runs). Hidden on narrow screens. */
  side?: ReactNode;
  /** Its settings, under the row while it is the one chosen, aligned with the row's text. */
  children?: ReactNode;
  /** List only: its level in a tree (0 at the top), one thin guide line per level before it, as a file tree. */
  depth?: number;
}

export interface OptionListProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: OptionListItem<V>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Shown but not changeable (the choice is kept, the others fade). */
  disabled?: boolean;
  /**
   * `rows` (default): full-width rows. `cards`: side by side, the illustration
   * on top; the chosen card's
   * settings go under all of them. One column on narrow screens. `tiles`: two
   * per row, the leading icon on the title's line. `list`: plain compact rows (a list of places to pick, a
   * folder tree), no borders, a quiet hover and chosen background.
   */
  layout?: "rows" | "cards" | "tiles" | "list";
  /**
   * Rows only: the chosen row and its settings are one card, the
   * settings full width under a hairline.
   */
  attached?: boolean;
  className?: string;
}

/**
 * A vertical list of choices as full-width rows of the same height, one left
 * edge, neutral selection (e.g. a mission's Autonomia and Quem faz o
 * trabalho). Radix RadioGroup: `role="radio"` rows, one tab stop, arrow
 * keys move and select. A row may lead with its illustration; no radio dot, the chosen row's border marks it.
 * The chosen row can carry its own settings (`children`) right under it.
 */
export function OptionList<V extends string>({
  value,
  onValueChange,
  options,
  disabled,
  layout = "rows",
  attached,
  className,
  ...rest
}: OptionListProps<V>) {
  const locked = useLocked();
  const cards = layout === "cards";
  const tiles = layout === "tiles";
  const list = layout === "list";
  const card = attached && !cards && !tiles && !list;
  const item = (o: OptionListItem<V>) => (
    <RRadioGroup.Item
      key={o.value}
      value={o.value}
      disabled={o.disabled}
      className={cx("ac-optrow", o.leading ? "ac-optrow--lead" : undefined)}
    >
      {list &&
        Array.from({ length: o.depth ?? 0 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one guide per level, never reordered
          <span key={i} className="ac-optrow__guide" aria-hidden="true" />
        ))}
      {o.leading && <span className="ac-optrow__lead">{o.leading}</span>}
      <span className="ac-optrow__text">
        <span className="ac-optrow__title">
          {o.title}
          {o.tag && <span className="ac-optrow__tag">{o.tag}</span>}
        </span>
        {o.description && <span className="ac-optrow__desc">{o.description}</span>}
      </span>
      {cards && o.foot && <span className="ac-optrow__foot">{o.foot}</span>}
      {!cards && !tiles && o.side && <span className="ac-optrow__side">{o.side}</span>}
    </RRadioGroup.Item>
  );
  const chosen = options.find((o) => o.value === value);
  return (
    <RRadioGroup.Root
      className={cx(
        "ac-optlist",
        cards && "ac-optlist--cards",
        tiles && "ac-optlist--tiles",
        list && "ac-optlist--list",
        (disabled || locked) && "ac-optlist--locked",
        card && "ac-optlist--attached",
        className,
      )}
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
      orientation={cards || tiles ? undefined : "vertical"}
      loop
      {...rest}
    >
      {cards ? (
        <>
          <div className="ac-optlist__cards">{options.map(item)}</div>
          {chosen?.children && <div className="ac-optrow__more ac-optrow__more--cards">{chosen.children}</div>}
        </>
      ) : (
        options.map((o) =>
          card && o.value === value && o.children ? (
            <div key={o.value} className="ac-optcard">
              {item(o)}
              <div className="ac-optrow__more ac-optrow__more--card">{o.children}</div>
            </div>
          ) : (
            <Fragment key={o.value}>
              {item(o)}
              {o.value === value && o.children && (
                <div className={cx("ac-optrow__more", o.leading ? "ac-optrow__more--lead" : undefined)}>
                  {o.children}
                </div>
              )}
            </Fragment>
          ),
        )
      )}
    </RRadioGroup.Root>
  );
}

export interface OptionLinkItem {
  /** Stable key, also the row's `data-option`. */
  value: string;
  title: ReactNode;
  /** The way most people should take ("Recomendado"): a chip after the title. */
  tag?: ReactNode;
  /** One short line under the title. May hold a link: it stays clickable above the row's own button. */
  description?: ReactNode;
  /** Before the text: a provider's logo, an icon tile, an avatar. */
  leading?: ReactNode;
  /** Quiet words before the chevron ("Um login por agente"). */
  side?: ReactNode;
  /** In place of the chevron: `chevronDown` for a row that shows more rows here instead of opening steps. */
  end?: IconName;
  disabled?: boolean;
  onSelect: () => void;
  /** The row's button, beyond its click: focus and pointer handlers, `autoFocus`, `aria-expanded`. */
  button?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "disabled" | "children">;
}

/**
 * A choice that opens its own steps (which app to bring a team from, which AI to connect, where to keep files): the
 * `OptionList` row's look, each a button with a chevron at its end, the recommended way marked with a chip. Nothing
 * stays chosen here: a pick moves on. The title is the button and stretches over the whole row, so a link in the
 * description stays a link (a link can't sit inside a button).
 */
export function OptionLinks({
  options,
  className,
  ...rest
}: {
  options: readonly OptionLinkItem[];
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const id = useId();
  return (
    <ul className={cx("ac-optlist ac-optlinks", className)} {...rest}>
      {options.map((o) => {
        const desc = o.description ? `${id}-${o.value}` : undefined;
        // The chip sits outside the button: read with its line, so "Recomendado" is heard on the button too.
        const tagId = o.tag ? `${id}-${o.value}-tag` : undefined;
        const describedBy = [tagId, desc].filter(Boolean).join(" ") || undefined;
        return (
          <li
            key={o.value}
            data-option={o.value}
            className={cx("ac-optrow ac-optrow--link", o.leading ? "ac-optrow--lead" : undefined)}
            data-disabled={o.disabled ? "" : undefined}
          >
            {o.leading && <span className="ac-optrow__lead">{o.leading}</span>}
            <span className="ac-optrow__text">
              <span className="ac-optrow__title">
                <button
                  type="button"
                  className="ac-optrow__hit"
                  aria-describedby={describedBy}
                  {...o.button}
                  disabled={o.disabled}
                  onClick={o.onSelect}
                >
                  {o.title}
                </button>
                {o.tag && (
                  <Chip tone="info" className="ac-optrow__chip" id={tagId}>
                    {o.tag}
                  </Chip>
                )}
              </span>
              {o.description && (
                <span className="ac-optrow__desc" id={desc}>
                  {o.description}
                </span>
              )}
            </span>
            {o.side && <span className="ac-optrow__side ac-optrow__side--link">{o.side}</span>}
            <Icon name={o.end ?? "chevronRight"} size={16} className="ac-optrow__go" />
          </li>
        );
      })}
    </ul>
  );
}
