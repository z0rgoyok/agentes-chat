import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef, type MouseEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { Kbd } from "./Kbd";
import { Spinner } from "./Skeleton";

export type ButtonVariant = "default" | "primary" | "agent" | "danger" | "ghost" | "link";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` at most once per area; `agent` only to ask an agent for
   * something ("Pedir à Ada": cut corner + agent icon); `danger` to refuse or
   * delete; `ghost` in toolbars; `link` for a row's or a card's quiet action ("Editar", "Mudar", "Ver"): the words
   * alone, with no box, so it takes no room but its text's (`size`, `block` and `iconOnly` don't apply).
   */
  variant?: ButtonVariant;
  /** The control ruler: `md` 40 (default), `sm` 32 (toolbars, rows, composer), `lg` 48 (only a full screen's main action). */
  size?: "md" | "sm" | "lg";
  /**
   * Leading icon. With `iconOnly`, the only content (then `aria-label` is required); `iconOnly` with no `icon` shows
   * its child as the glyph (a stop square, an `Icon` of its own).
   */
  icon?: IconName;
  iconOnly?: boolean;
  block?: boolean;
  /** Keyboard hints after the label: `["⌘", "↵"]`. */
  kbd?: string[];
  /** An async action is running: inline spinner, same width, not clickable (`aria-busy`). */
  loading?: boolean;
  /** Render the child element (e.g. a router link) with the button styles; `disabled` switches it off too. */
  asChild?: boolean;
  children?: ReactNode;
}

/** Plain words, which a narrow place cuts with an ellipsis (`.ac-btn__label`); any element is left as it is written. */
const isWords = (children: ReactNode) =>
  (Array.isArray(children) ? children : [children]).every((c) => typeof c === "string" || typeof c === "number") &&
  children !== "";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    size = "md",
    icon,
    iconOnly,
    block,
    asChild,
    loading,
    kbd,
    className,
    children,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const leading = variant === "agent" && !icon ? "agent" : icon;
  // An icon and nothing else is an icon button, said or not: square, as `ac-btn--icon` draws it.
  const onlyIcon =
    iconOnly || (Boolean(leading) && !asChild && (children == null || children === false || children === "") && !kbd);
  const classes =
    variant === "link"
      ? cx("ac-link", "ac-link--action", loading && "ac-link--loading", className)
      : cx(
          "ac-btn",
          variant !== "default" && `ac-btn--${variant}`,
          size !== "md" && `ac-btn--${size}`,
          onlyIcon && "ac-btn--icon",
          block && "ac-btn--block",
          loading && "ac-btn--loading",
          className,
        );
  if (asChild) {
    // A link has no `disabled` of its own: off, it follows no click (Enter is one) and is no stop for Tab.
    const off = disabled && {
      "aria-disabled": true,
      tabIndex: -1,
      onClick: (event: MouseEvent) => event.preventDefault(),
    };
    return (
      <Slot.Root ref={ref} className={classes} {...rest} {...off}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* The label stays (invisible) while loading, so the width never changes. */}
      {leading && <Icon name={leading} />}
      {(!iconOnly || !leading) && (isWords(children) ? <span className="ac-btn__label">{children}</span> : children)}
      {!iconOnly && kbd && kbd.length > 0 && (
        <span className="ac-btn__kbd" aria-hidden="true">
          {kbd.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
      {loading && <Spinner className="ac-btn__spinner" size={size === "sm" ? 14 : 16} />}
    </button>
  );
});

/**
 * A button's words that take turns ("Copiar link", then "Copiado"), each with its icon (in place of the button's own
 * `icon`): both stay in place, the other one unseen, so the button keeps the wider one's width and doesn't move under
 * the pointer when they change. The one shown sits in the middle with its icon beside it, the same padding at both ends.
 */
export function SwapLabel({
  label,
  alt,
  showAlt,
  icon,
  altIcon = icon,
}: {
  label: ReactNode;
  alt: ReactNode;
  showAlt: boolean;
  icon?: IconName;
  altIcon?: IconName;
}) {
  return (
    <span className="ac-swap">
      <span aria-hidden={showAlt || undefined}>
        {icon && <Icon name={icon} />}
        {label}
      </span>
      <span aria-hidden={!showAlt || undefined}>
        {altIcon && <Icon name={altIcon} />}
        {alt}
      </span>
    </span>
  );
}
