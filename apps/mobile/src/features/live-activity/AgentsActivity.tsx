import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";
import type { IslandProps } from "./props";

/**
 * The agents at work in the Dynamic Island and on the Lock Screen (ADR 0210): one Live Activity per person, its content
 * made and pushed by the server (`IslandProps`, a JSON string in the push's `content-state`). Drawn by iOS from iOS's
 * own components: a face, words and the system's timer, nothing of ours that moves.
 *
 * It runs in the widget extension's own runtime (the `widget` directive): no hooks, no state, and nothing from this
 * module's scope but the components it imports, so its colors and helpers live inside it.
 */
function AgentsActivityLayout(props: IslandProps, _environment: LiveActivityEnvironment) {
  "widget";
  const AMBER = "#ffb340";
  const GREEN = "#34c759";
  const DIM = "#ffffffa0";
  const agents = props?.agents ?? [];
  const first = agents[0];
  const tone = props?.tone ?? "working";
  const accent = tone === "waiting" ? AMBER : tone === "done" ? GREEN : "#ffffff";

  // A face: the agent's picture the app left in the widgets directory, or a plain dot in its place.
  const face = (agent: IslandProps["agents"][number] | undefined, size: number) =>
    agent?.face ? (
      <Image uiImage={agent.face} modifiers={[resizable(), frame({ width: size, height: size })]} />
    ) : (
      <Image systemName="circle.fill" size={size * 0.7} color="#5aa8ff" />
    );
  // How long an agent has been at it, counted by the system; a request or "done" says so instead.
  const clock = (agent: IslandProps["agents"][number] | undefined, size: number) =>
    agent && agent.state === "working" ? (
      <Text
        date={new Date(agent.since)}
        dateStyle="timer"
        modifiers={[font({ size, weight: "semibold" }), monospacedDigit(), foregroundStyle(DIM)]}
      />
    ) : (
      <Text modifiers={[font({ size, weight: "semibold" }), foregroundStyle(accent)]}>
        {agent?.state === "done" ? "✓" : ""}
      </Text>
    );
  const trailing = (size: number) =>
    props?.trailing ? (
      <Text modifiers={[font({ size, weight: "semibold" }), foregroundStyle(accent), lineLimit(1)]}>
        {props.trailing}
      </Text>
    ) : (
      clock(first, size)
    );
  // One agent's line: its face, its name and what it does, and its clock.
  const line = (agent: IslandProps["agents"][number], size: number) => (
    <HStack spacing={10} alignment="center">
      {face(agent, size)}
      <VStack alignment="leading" spacing={1}>
        <Text modifiers={[font({ size: 15, weight: "semibold" }), lineLimit(1)]}>{agent.name}</Text>
        <Text modifiers={[font({ size: 14 }), foregroundStyle(DIM), lineLimit(2)]}>{agent.step}</Text>
      </VStack>
      <Spacer />
      {agent.state === "waiting" ? (
        <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(AMBER)]}>{props.trailing ?? ""}</Text>
      ) : (
        clock(agent, 15)
      )}
    </HStack>
  );

  return {
    // The Lock Screen: every agent shown, a request first.
    banner: (
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[
          padding({ all: 16 }),
          activityBackgroundTint("#1c1c1ee6"),
          widgetURL(props?.url ?? "agenteschat://island"),
        ]}
      >
        {agents.map((agent) => line(agent, 34))}
        {props?.more ? <Text modifiers={[font({ size: 13 }), foregroundStyle(DIM)]}>{`+${props.more}`}</Text> : null}
      </VStack>
    ),
    compactLeading: face(first, 22),
    compactTrailing: trailing(14),
    minimal: face(first, 20),
    expandedLeading: face(first, 34),
    expandedCenter: (
      <VStack alignment="leading" spacing={1}>
        <Text modifiers={[font({ size: 16, weight: "semibold" }), lineLimit(1)]}>{props?.headline ?? ""}</Text>
        {first ? <Text modifiers={[font({ size: 14 }), foregroundStyle(DIM), lineLimit(1)]}>{first.where}</Text> : null}
      </VStack>
    ),
    expandedTrailing: trailing(15),
    expandedBottom:
      agents.length > 1 ? (
        <VStack alignment="leading" spacing={8} modifiers={[widgetURL(props?.url ?? "agenteschat://island")]}>
          {agents.map((agent) => line(agent, 24))}
        </VStack>
      ) : (
        <Text modifiers={[font({ size: 15 }), lineLimit(2), widgetURL(props?.url ?? "agenteschat://island")]}>
          {first?.step ?? ""}
        </Text>
      ),
  };
}

/** The Live Activity's name: the server's pushes say it (`content-state.name`, ADR 0210). */
export const AGENTS_ACTIVITY = "AgentsActivity";

export default createLiveActivity<IslandProps>(AGENTS_ACTIVITY, AgentsActivityLayout);
