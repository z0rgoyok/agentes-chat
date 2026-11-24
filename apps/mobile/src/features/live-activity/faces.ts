import { ClipOp, ImageFormat, type SkImage, Skia } from "@shopify/react-native-skia";
import { Directory, File } from "expo-file-system";
import { agentFrame } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import { STILL_T, seedOf } from "@/agent/poses";
import { replay } from "@/agent/skia-ctx";

/** A face's side in pixels: the island's largest (34 points) at 3x. */
export const FACE_PX = 102;

/** What a face is drawn from: when it changes, its picture is drawn again. */
export const faceKey = (look: AgentLookInput) => `${look.color}|${look.eyes ?? ""}|${look.accessory ?? ""}`;

/**
 * One agent's still face on its night sky, `px` pixels square, as the app draws its tile on a dark page: in the
 * tile's corners, or square where the system cuts its own shape (a share sheet's circle). Null: nothing drew.
 */
export function stillFace(id: string, look: AgentLookInput, px = FACE_PX, corners = true): SkImage | null {
  const surface = Skia.Surface.Make(px, px);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  if (corners) {
    const corner = px * 0.3;
    canvas.clipRRect(Skia.RRectXY(Skia.XYWHRect(0, 0, px, px), corner, corner), ClipOp.Intersect, true);
  }
  // Still, its sky under it (the island is black, and so is a share sheet's dark plate).
  const frame = agentFrame(look, px, "idle", STILL_T, seedOf(id), true, { dark: true }, undefined, true);
  replay(canvas, frame);
  surface.flush();
  return surface.makeImageSnapshot();
}

/** One agent's still face for the island, as PNG bytes. */
function facePng(id: string, look: AgentLookInput): Uint8Array | null {
  return stillFace(id, look)?.encodeToBytes(ImageFormat.PNG, 100) ?? null;
}

/** What was drawn for each agent, kept beside the faces so a launch draws only what changed. */
const INDEX = "index.json";

/**
 * Writes the agents' faces where the Live Activity reads them (the app group's widgets directory, ADR 0210): one PNG
 * per agent, drawn again only when its look changed. Never throws: an island without a face shows a dot instead.
 */
export function writeFaces(dir: string, agents: readonly { id: string; look: AgentLookInput }[]): void {
  try {
    const folder = new Directory(dir.replace(/\/+$/, ""), "faces");
    if (!folder.exists) folder.create({ intermediates: true });
    const index = new File(folder, INDEX);
    let drawn: Record<string, string> = {};
    try {
      if (index.exists) drawn = JSON.parse(index.textSync()) as Record<string, string>;
    } catch {}
    let changed = false;
    for (const agent of agents) {
      const key = faceKey(agent.look);
      const file = new File(folder, `${agent.id}.png`);
      if (drawn[agent.id] === key && file.exists) continue;
      const png = facePng(agent.id, agent.look);
      if (!png) continue;
      file.write(png);
      drawn[agent.id] = key;
      changed = true;
    }
    if (changed) index.write(JSON.stringify(drawn));
  } catch {}
}
