import type { ConnectorDef } from "@agenteschat/client";
import { CONNECTOR_MARK, OWN_MARK, SERVER_ICON } from "@agenteschat/client/lib/connected";
import { initialsOf } from "@agenteschat/ui";
import { type CSSProperties, useState } from "react";

// A module of its own: the cards that show a service's mark (the Home's first steps, a run's tools) don't bring the
// catalog of services and its connect flows with them.

/**
 * The service's one-color brand icon drawn as a mask in its brand color (the
 * ink for near-black brands); else a mark in its own colors, ours or the
 * icon a server connected by address gave (`image`); else a monogram.
 */
export function ConnectorIcon({
  def,
  label,
  size = "md",
  image,
}: {
  def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  label: string;
  size?: "md" | "lg";
  image?: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const cls = `connector-icon${size === "lg" ? " connector-icon--lg" : ""}`;
  // Only a file of ours goes into the CSS `url()`.
  if (def?.iconUrl && CONNECTOR_MARK.test(def.iconUrl)) {
    const style = {
      "--connector-icon": `url("${def.iconUrl}")`,
      ...(def.brandColor && /^#[0-9a-fA-F]{6}$/.test(def.brandColor) ? { "--connector-color": def.brandColor } : {}),
    } as CSSProperties;
    return (
      <span className={`${cls} connector-icon--brand`} aria-hidden="true">
        <span className="connector-icon__mark" style={style} />
      </span>
    );
  }
  const own =
    def?.iconUrl && OWN_MARK.test(def.iconUrl) ? def.iconUrl : image && SERVER_ICON.test(image) ? image : null;
  // A saved call keeps the icon its server had then, and a newer icon deletes that file: the monogram instead.
  if (own && own !== failed) {
    return (
      <span className={`${cls} connector-icon--brand`} aria-hidden="true">
        <img className="connector-icon__img" src={own} alt="" onError={() => setFailed(own)} />
      </span>
    );
  }
  return (
    <span className={`${cls} connector-icon--mono connector-icon--initial`} aria-hidden="true">
      {initialsOf(label)}
    </span>
  );
}
