import type { StepState } from "@agenteschat/client/lib/devices";
import { Icon, PixelSpinner } from "@agenteschat/ui";
import type { ReactNode } from "react";
import "./devices.css";

/**
 * One step of a live checklist: its mark (a tick, the live orbit, an alert, or its number), title, one line, extras.
 * `open` given: the step folds to its title when not open, and its title opens it (`onOpen`); a done step shows its
 * extras when open. Without it, a done step hides them. `live`: the current step's mark spins (the computer watches).
 */
export function Step({
  state,
  title,
  text,
  children,
  live = true,
  open,
  onOpen,
}: {
  state: StepState;
  title: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  live?: boolean;
  open?: boolean;
  onOpen?: () => void;
}) {
  const shut = open === false;
  return (
    <li
      className="dv-step"
      data-state={state}
      data-shut={shut ? "" : undefined}
      aria-current={state === "current" ? "step" : undefined}
    >
      <span className="dv-step__mark" aria-hidden="true">
        {state === "done" ? (
          <Icon name="check" size={14} />
        ) : state === "current" && live ? (
          <PixelSpinner size={14} />
        ) : state === "needs" ? (
          <Icon name="alert" size={14} />
        ) : null}
      </span>
      <div className="dv-step__head">
        {shut && onOpen ? (
          <button type="button" className="dv-step__title dv-step__open" aria-expanded="false" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <p className="dv-step__title">{title}</p>
        )}
        {text && !shut && (
          <p className="dv-step__text" role={state === "current" ? "status" : undefined}>
            {text}
          </p>
        )}
      </div>
      {children && !shut && (open || state !== "done") && <div className="dv-step__more">{children}</div>}
    </li>
  );
}
