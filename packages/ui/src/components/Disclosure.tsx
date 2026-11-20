import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";

/**
 * What most people never need, behind one quiet line ("Detalhes" and a chevron) that opens it in place. A native
 * `<details>`: the keyboard, screen readers and find-in-page work as they do on any page, and closed it starts that way
 * every time. `onOpenChange` for a caller that shows more while it is open (an account's bars split by agent).
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  onOpenChange,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <details
      className={cx("ac-disclosure", className)}
      open={defaultOpen || undefined}
      onToggle={(e) => onOpenChange?.(e.currentTarget.open)}
    >
      <summary className="ac-disclosure__summary">
        <span>{summary}</span>
        <Icon name="chevronRight" size={16} className="ac-disclosure__chevron" />
      </summary>
      <div className="ac-disclosure__body">{children}</div>
    </details>
  );
}
