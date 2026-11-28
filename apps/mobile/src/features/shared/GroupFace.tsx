import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { AgentFace } from "./Face";
import { useColors } from "./hooks";

/** The most faces a group's face shows: four, or three and how many else. */
const FACES = 4;

/** Where each cell sits in the box (`side` the box, `cell` a face, `gap` between them), by how many it holds. */
function places(count: number, side: number, cell: number, gap: number): [number, number][] {
  const far = cell + gap;
  if (count === 1) return [[0, 0]];
  if (count === 2)
    return [
      [0, 0],
      [far, far],
    ];
  if (count === 3)
    return [
      [0, 0],
      [far, 0],
      [(side - cell) / 2, far],
    ];
  return [
    [0, 0],
    [far, 0],
    [0, far],
    [far, far],
  ];
}

/**
 * A personal workspace's group conversation as one face (ADR 0159, amendment of 2026-11-26), as the web's: its agents'
 * own tiles in the box of one face, two on a diagonal, three as two over one, four as two by two, more as three and
 * "+N". With no agent, an empty tile with the people mark. Still frames: it sits in lists and bars.
 */
export const GroupFace = memo(function GroupFace({
  agentIds,
  count,
  size,
}: {
  /** Its agents, in the order they joined (the channel list's `agentIds`). */
  agentIds: readonly string[];
  /** How many agents it has in all, when `agentIds` holds only the first ones. */
  count?: number;
  size: number;
}) {
  const c = useColors();
  const total = Math.max(count ?? agentIds.length, agentIds.length);
  const shown = agentIds.slice(0, total > FACES ? FACES - 1 : FACES);
  const more = total - shown.length;
  const box = { width: size, height: size };
  if (shown.length === 0)
    return (
      <View
        style={[styles.empty, box, { borderRadius: Math.round(size * 0.3), backgroundColor: c.sunken }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name="members" size={Math.round(size * 0.4)} color={c.faint} />
      </View>
    );
  const cells = shown.length + (more > 0 ? 1 : 0);
  const gap = Math.max(2, Math.round(size / 18));
  const cell = cells === 1 ? size : (size - gap) / 2;
  const at = places(cells, size, cell, gap);
  return (
    <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((id, i) => (
        <View key={id} style={[styles.cell, { left: at[i]?.[0] ?? 0, top: at[i]?.[1] ?? 0 }]}>
          <AgentFace agentId={id} size={cell} live={false} framed />
        </View>
      ))}
      {more > 0 ? (
        <View
          style={[
            styles.cell,
            styles.more,
            {
              left: at[cells - 1]?.[0] ?? 0,
              top: at[cells - 1]?.[1] ?? 0,
              width: cell,
              height: cell,
              borderRadius: Math.round(cell * 0.3),
              backgroundColor: c.sunken,
            },
          ]}
        >
          <Text
            variant="caption"
            tone="muted"
            style={[styles.count, { fontSize: Math.max(9, Math.round(size * 0.22)) }]}
          >
            {`+${more}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center" },
  cell: { position: "absolute" },
  more: { alignItems: "center", justifyContent: "center" },
  count: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
