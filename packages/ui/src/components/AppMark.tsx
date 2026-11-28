import type { CSSProperties } from "react";
import { cx } from "../cx";
import { ditherUrl } from "../sky/dither";
import type { AgentColor } from "./AgentLook";

/**
 * An integration app's mark (ADR 0251): its color in the agents' dither on a person's tile (a rounded square, never a
 * role's circle or an agent's cut corner), its initial in white. Decorative: the app's name is always beside it.
 */
export function AppMark({
  color,
  name,
  size = 36,
  className,
}: {
  color: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const cells = size <= 20 ? 8 : size <= 28 ? 10 : 14;
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.44),
    backgroundImage: `url("${ditherUrl(color as AgentColor, cells)}")`,
  };
  return (
    <span className={cx("ac-rolemark", "ac-appmark", className)} style={style as CSSProperties} aria-hidden="true">
      {initial}
    </span>
  );
}
