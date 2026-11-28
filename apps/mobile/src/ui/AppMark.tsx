import { bodyTones } from "@agenteschat/ui/agent/engine";
import { useId } from "react";
import { Text as RNText, StyleSheet, View } from "react-native";
import Svg, { ClipPath, Defs, G, Path, Rect } from "react-native-svg";
import { ditherPaths } from "./role-mark";

/**
 * An integration app's mark (ADR 0251), as the web's: its color in the agents' dither on a person's tile (corner 30%
 * of the side, never a role's circle), its initial in white. Decorative: the app's name is always beside it.
 */
export function AppMark({ color, name, size = 34 }: { color: string; name: string; size?: number }) {
  const clip = `app-${useId().replace(/[^\w-]/g, "")}`;
  const cells = size <= 20 ? 8 : size <= 28 ? 10 : 14;
  const tones = bodyTones(color);
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  const r = cells * 0.3;
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`}>
        <Defs>
          <ClipPath id={clip}>
            <Rect width={cells} height={cells} rx={r} ry={r} />
          </ClipPath>
        </Defs>
        <Rect width={cells} height={cells} rx={r} ry={r} fill={tones[2]} />
        <G clipPath={`url(#${clip})`}>
          {ditherPaths(color, cells).map((p) => (
            <Path key={p.fill} d={p.d} fill={p.fill} />
          ))}
        </G>
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <RNText allowFontScaling={false} style={[styles.initial, { fontSize: Math.round(size * 0.44) }]}>
          {initial}
        </RNText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  initial: {
    color: "#ffffff",
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.22)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 0,
  },
});
