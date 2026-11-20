import { WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { planMark, SCENE_PLANS } from "@agenteschat/client/lib/no-ai";
import { rightHandOf, sceneTeam } from "@agenteschat/client/lib/right-hand";
import { TEAM_NIGHT } from "@agenteschat/ui/sky/math";
import { StyleSheet, View } from "react-native";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { Dither } from "@/sky/Dither";
import { ProviderLogo, useTheme } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { FocusLive } from "../shared/parts";

const TRAIL = [0, 1, 2];

/**
 * The band over "Conectar uma IA" (the web's `ConnectScene`): two of the team asleep under the night, the workspace's
 * computer and the AIs' marks, a few pixels between them. Decoration: the screen's words say what it shows. Its night
 * and sleepers hold still while the next page is over it.
 */
export function ConnectScene() {
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
      <View style={styles.band} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Dither kind="sky" tones={TEAM_NIGHT} pixel={4} style={StyleSheet.absoluteFill} />
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
  band: { height: 132, borderRadius: 14, overflow: "hidden", marginBottom: 12 },
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
