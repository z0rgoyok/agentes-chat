import { PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { type Mark, pinAt, pinFlips } from "./marks";

/**
 * The comment being written (ADR 0208): its area's dashed outline as it is dragged, then the pin it will have, with
 * the person's own face and the number it takes, until it is sent or dropped.
 */
export function DraftMark({ mark, n }: { mark: Mark; n?: number }) {
  const { me } = useOrg();
  const at = pinAt(mark);
  return (
    <>
      {mark.w !== undefined && (
        <span
          className="mf-area mf-area--draft"
          style={{
            left: `${mark.x * 100}%`,
            top: `${mark.y * 100}%`,
            width: `${(mark.w ?? 0) * 100}%`,
            height: `${(mark.h ?? 0) * 100}%`,
          }}
          aria-hidden="true"
        />
      )}
      {n !== undefined && (
        <span
          className="mf-pin mf-pin--on mf-pin--draft"
          data-flip={pinFlips(at.x) || undefined}
          style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
        >
          <PersonAvatar id={me.user.id} name={me.user.name} size="xs" />
          <span className="mf-pin__n tabular">{n}</span>
        </span>
      )}
    </>
  );
}
