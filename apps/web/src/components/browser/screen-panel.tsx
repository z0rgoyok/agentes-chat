import { Icon, type IconName, ToolLink } from "@agenteschat/ui";
import { createContext } from "react";
import { useTranslation } from "react-i18next";

/**
 * A page that shows the agent's screen in a panel of its own (a code session's Screen, ADR 0215): there the
 * conversation's browser and desktop cards are one line that opens it, and the panel turns to the screen as the agent
 * starts using it.
 */
export const ScreenPanelContext = createContext<{ show: () => void } | null>(null);

/**
 * In such a page, a browser or desktop card's line: what the agent did there last ("Abriu" and, in mono, the address
 * when its words end with it) and the way to the screen, as one line of the tools block (`ToolLink`).
 */
export function ScreenLine({
  icon,
  text,
  detail,
  onShow,
}: {
  icon: IconName;
  text: string;
  /** What the step acted on, to set apart in mono. */
  detail?: string | null;
  onShow: () => void;
}) {
  const { t } = useTranslation();
  const d = detail?.trim();
  const split = d && text.length > d.length && text.endsWith(d);
  return (
    <ToolLink
      logo={
        <span className="tool-logo" aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
      }
      label={split ? text.slice(0, -d.length).trim() : text}
      target={split ? d : null}
      action={t("codeSessions.screenLine.show")}
      onClick={onShow}
    />
  );
}
