import { bodyTones } from "@agenteschat/ui/agent/engine";
import { useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, ClipPath, Defs, G, Path } from "react-native-svg";
import { Icon } from "./Icon";
import { ditherPaths, roleMarkFit, roleMarkIcon } from "./role-mark";

/**
 * A workspace role's mark (ADR 0085), as the web's: the role's color in the agents' dither in a full circle (never a
 * person's tile or an agent's cut corner), its icon in white on top with the web's one-point shadow. Decorative: the
 * role's name is always beside it. Without `icon` (Todos' and the owners' marks pass theirs) the circle alone.
 */
export function RoleMark({ color, icon, size = 26 }: { color: string; icon?: string | null; size?: number }) {
  const clip = `role-${useId().replace(/[^\w-]/g, "")}`;
  const { cells, icon: px } = roleMarkFit(size);
  const name = icon ? roleMarkIcon(icon) : null;
  const tones = bodyTones(color);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`}>
        <Defs>
          <ClipPath id={clip}>
            <Circle cx={cells / 2} cy={cells / 2} r={cells / 2} />
          </ClipPath>
        </Defs>
        {/* The middle tone under the runs: no light seam where two rows meet on a fractional point. */}
        <Circle cx={cells / 2} cy={cells / 2} r={cells / 2} fill={tones[2]} />
        <G clipPath={`url(#${clip})`}>
          {ditherPaths(color, cells).map((p) => (
            <Path key={p.fill} d={p.d} fill={p.fill} />
          ))}
        </G>
      </Svg>
      {name ? (
        <>
          <View style={[StyleSheet.absoluteFill, styles.center, styles.shadow]}>
            <Icon name={name} size={px} color="rgba(0,0,0,0.22)" />
          </View>
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Icon name={name} size={px} color="#ffffff" />
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  shadow: { top: 1, bottom: -1 },
});
