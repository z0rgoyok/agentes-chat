import { Image } from "expo-image";
import { useState } from "react";
import { type ImageStyle, Platform, type TextStyle } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { ICONS, type IconName } from "./icons.data";
import { SF_POINT_SCALE, sfSymbolOf } from "./icons.sf";
import { useTheme } from "./theme";

export type { IconName };

/** The weight of the system's symbol (iOS); our line icons have one stroke. */
export type IconWeight = "regular" | "medium" | "semibold" | "bold";

export interface IconProps {
  name: IconName;
  /** Points (default 20): the icon's square box. */
  size?: number;
  /** Default: the theme's ink2. */
  color?: string;
  /** The system's filled symbol where it has one (iOS): a white glyph on a colored tile. */
  filled?: boolean;
  /** The system symbol's weight (iOS, default regular): semibold for the marks at a row's end, as the system's. */
  weight?: IconWeight;
}

const IOS = Platform.OS === "ios";

const WEIGHTS = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

/**
 * A symbol's style: its square box, and the point size and weight expo-image reads off `fontSize` and `fontWeight` for
 * an `sf:` source. One per size and weight, so a long list of icons doesn't make a style object per icon per render.
 */
type SymbolStyle = ImageStyle & { fontSize: number; fontWeight: TextStyle["fontWeight"] };
const boxes = new Map<string, SymbolStyle>();
const boxOf = (size: number, weight: IconWeight) => {
  const key = `${size}|${weight}`;
  let box = boxes.get(key);
  if (!box) {
    box = {
      width: size,
      height: size,
      fontSize: Math.round(size * SF_POINT_SCALE * 2) / 2,
      fontWeight: WEIGHTS[weight],
    };
    boxes.set(key, box);
  }
  return box;
};

/**
 * An icon. On iOS the system's own symbol (SF Symbols, drawn by the system through expo-image's `sf:` source, at the
 * weight asked and tinted), so the app's icons are the ones every iPhone app shows; our line icon where the system has
 * none (the agent, the waiting fuse) or if a symbol can't be drawn on an older iOS. Android draws our line icons.
 */
export function Icon({ name, size = 20, color, filled = false, weight = "regular" }: IconProps) {
  const { colors } = useTheme();
  const tint = color ?? colors.ink2;
  const symbol = IOS ? sfSymbolOf(name, filled) : null;
  const [failed, setFailed] = useState(false);
  if (symbol && !failed)
    return (
      <Image
        source={`sf:${symbol}`}
        tintColor={tint}
        contentFit="scale-down"
        style={boxOf(size, weight)}
        accessible={false}
        onError={() => setFailed(true)}
      />
    );
  return <LineIcon name={name} size={size} color={tint} />;
}

/** The design system's line icon: 24×24, stroke 1.7, round caps and joins. */
function LineIcon({ name, size, color }: { name: IconName; size: number; color: string }) {
  const shapes = ICONS[name] ?? ICONS.circle;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {shapes.map((s) => {
        if (s.t === "circle")
          return (
            <Circle
              key={`c${s.cx}-${s.cy}-${s.r}`}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill={s.fill ? color : "none"}
              stroke={s.fill ? "none" : color}
              strokeWidth={1.7}
            />
          );
        if (s.t === "rect")
          return (
            <Rect
              key={`r${s.x}-${s.y}-${s.w}-${s.h}`}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.rx}
              fill={s.fill ? color : "none"}
              stroke={s.fill ? "none" : color}
              strokeWidth={1.7}
              opacity={s.opacity}
            />
          );
        return (
          <Path
            key={s.d}
            d={s.d}
            fill="none"
            stroke={color}
            strokeWidth={s.sw ?? 1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
    </Svg>
  );
}
