import { Icon, OptionCard, Tip } from "@agenteschat/ui";
import type { ReactNode } from "react";

/**
 * Whom an AI thinks for, as one of a pair of cards (`.arrival-for`): faces, then the title and its ⓘ. The card is the
 * tip's button: hovering it or its focus shows `tip` (one line each, a string, so a screen reader hears it as the
 * card's description), a long press on touch. The picked card is marked by its border alone.
 */
export function AudienceCard({
  pressed,
  onClick,
  faces,
  title,
  tip,
}: {
  pressed: boolean;
  onClick: () => void;
  faces: ReactNode;
  title: string;
  /** Nothing: no ⓘ, no tip. */
  tip?: string;
}) {
  const parts = title.split(" · ");
  const last = parts.pop();
  return (
    <Tip tip={tip} look="ac-hint__bubble ac-glass arrival-for__tip" button>
      {/* The name is the title as written: the parts' dots are CSS, which a screen reader would read run together. */}
      <OptionCard pressed={pressed} onClick={onClick} aria-label={title}>
        {faces}
        <span className="ac-option__title arrival-for__title">
          {parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
          <span className="ac-hintline">
            <span>{last}</span>
            {tip && (
              <span className="ac-hint" aria-hidden="true">
                <Icon name="info" size={14} />
              </span>
            )}
          </span>
        </span>
      </OptionCard>
    </Tip>
  );
}
