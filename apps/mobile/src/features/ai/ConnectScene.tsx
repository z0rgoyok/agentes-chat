import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { planMark, SCENE_PLANS } from "@agenteschat/client/lib/no-ai";
import { rightHandOf, sceneTeam } from "@agenteschat/client/lib/right-hand";
import { TEAM_NIGHT } from "@agenteschat/ui/sky/math";
import { StyleSheet, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { Dither } from "@/sky/Dither";
import { ProviderLogo, useTheme } from "@/ui";
import { CoverParallax } from "@/ui/cover";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { FocusLive } from "../shared/parts";

const TRAIL = [0, 1, 2];

/**
 * The cover over "Conectar uma IA" (the web's `ConnectScene`): two of the team asleep under the night, the workspace's
 * computer and the AIs' marks, a few pixels between them. Edge to edge and up behind the clear bar, as the agent's
 * sky on its profile: the night lags behind the scroll and stretches on a pull (`CoverParallax`), the scene stays at
 * its foot. Decoration: the screen's words say what it shows. Its night and sleepers hold still while the next page
 * is over it.
 */
export function ConnectScene({ y, height }: { y: SharedValue<number>; height: number }) {
  const { colors: c } = useTheme();
  const agents = useDirectory().agents;
  const lead = rightHandOf(agents);
  const team = sceneTeam(agents, lead).slice(0, 2);
  const trail = (
    <View style={styles.trail}>
      {TRAIL.map((n) => (
        <View key={n} style={styles.pixel} />
      ))}
    </View>
  );
  return (
    <FocusLive>
      <View style={{ height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <CoverParallax y={y} style={StyleSheet.absoluteFill}>
          <Dither kind="sky" tones={TEAM_NIGHT} pixel={4} style={StyleSheet.absoluteFill} />
        </CoverParallax>
        <View style={styles.row}>
          <View style={styles.cast}>
            {team.map((a) => (
              <AgentFace key={a.id} agentId={a.id} size={a.id === lead?.id ? 56 : 42} mode="sleep" framed={false} />
            ))}
          </View>
          {team.length > 0 ? trail : null}
          <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="paused" />
          {trail}
          <View style={styles.marks}>
            {SCENE_PLANS.map((plan, i) => (
              <View key={plan} style={[styles.plate, { backgroundColor: c.raised }, i > 0 ? styles.over : null]}>
                <ProviderLogo id={planMark(plan)} size="sm" />
              </View>
            ))}
          </View>
        </View>
      </View>
    </FocusLive>
  );
}

const styles = StyleSheet.create({
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  cast: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  trail: { flexDirection: "row", gap: 5 },
  pixel: { width: 6, height: 6, backgroundColor: "#ffffff66" },
  marks: { flexDirection: "row" },
  plate: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  over: { marginLeft: -8 },
});
