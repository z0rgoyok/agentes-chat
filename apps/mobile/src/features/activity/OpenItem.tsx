import { StyleSheet, View } from "react-native";
import { SCREEN_X, Sky } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";

/** How far the sky runs up behind the bar, past the top of what scrolls. */
const ABOVE = 200;

/**
 * The top of an open item (a request, a question): the asking agent standing on its own sky, which runs up behind the
 * bar and fades into the page; a gray sky and no face when nobody is behind it.
 */
export function OpenItemHead({ agentId, grouped = false }: { agentId: string | null; grouped?: boolean }) {
  const dir = useDirectory();
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  return (
    <View style={styles.head}>
      <Sky
        color={agent ? agentLook(agent).color : "graphite"}
        depth={0.7}
        fade={0.3}
        surface={grouped ? "grouped" : "bg"}
        style={StyleSheet.absoluteFill}
      />
      {agentId ? <AgentFace agentId={agentId} size={72} framed={false} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    marginTop: -ABOVE,
    paddingTop: ABOVE + 12,
    paddingHorizontal: SCREEN_X,
    paddingBottom: 4,
    minHeight: ABOVE + 96,
    justifyContent: "flex-end",
    alignItems: "flex-start",
  },
});
