import { type ReactNode, useId, useState } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";

/**
 * A list row that opens in place: its one line (the face, the name and its pills, what ends the line, a chevron) is a
 * button, and what it holds (the details, the row's actions) unfolds under it. Closed, the rest is out of reach of the
 * keyboard and of screen readers, so whatever needs the person must be said on the line itself (a pill, a short word).
 * `end` leaves the line for one of its own under the name when the list is narrow (`.ac-mediarow__end--wrap`).
 */
export function FoldRow({
  face,
  title,
  body,
  end,
  children,
  defaultOpen = false,
  className,
}: {
  face?: ReactNode;
  title: ReactNode;
  /** Under the name's line, at the row's full width (`.ac-mediarow__body`), above what ends that line once it wraps. */
  body?: ReactNode;
  end?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cx("ac-list__row ac-foldrow", open && "ac-foldrow--open", className)}>
      <button
        type="button"
        className="ac-foldrow__head ac-mediarow"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {face && <span className="ac-mediarow__face">{face}</span>}
        <span className="ac-mediarow__head">{title}</span>
        {body && <span className="ac-mediarow__body">{body}</span>}
        {end && <span className="ac-mediarow__end ac-mediarow__end--wrap">{end}</span>}
        <Icon name="chevronRight" size={16} className="ac-foldrow__chevron" />
      </button>
      <div id={id} className="ac-foldrow__fold" inert={!open} aria-hidden={!open}>
        <div className="ac-foldrow__more">{children}</div>
      </div>
    </div>
  );
}
