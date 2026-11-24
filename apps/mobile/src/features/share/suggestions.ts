import { ImageFormat } from "@shopify/react-native-skia";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { AgentLookInput } from "@/agent/looks";
import { faceKey, stillFace } from "../live-activity/faces";
import { suggestionId } from "./picked";

/**
 * The agents in the system's share sheet (ADR 0213), through modules/share-suggestions: each message a person sends to
 * an agent is donated, and iOS offers the conversations used most at the top of its share sheet, beside the person's
 * contacts, with the agent's face. The one picked comes back on the share extension's link (`&to=<id>`), and
 * "Compartilhar com…" opens with that agent chosen. A build without the module (Android, an older build) donates
 * nothing and reads no pick.
 */
interface ShareSuggestionsNative {
  donate(id: string, name: string, face: string | null): Promise<boolean>;
  forget(id: string): Promise<void>;
  forgetAll(): Promise<void>;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<ShareSuggestionsNative>("ShareSuggestions") : null;

/** The face's side in pixels: iOS matches a suggestion's picture better from 360 on. */
export const SUGGESTION_FACE_PX = 360;

/** The faces drawn for suggestions, by agent and look: each send doesn't draw the same face again. */
const faces = new Map<string, string>();

function faceOf(agent: { id: string; look: AgentLookInput }): string | null {
  const key = `${agent.id}|${faceKey(agent.look)}`;
  const kept = faces.get(key);
  if (kept) return kept;
  const face = stillFace(agent.id, agent.look, SUGGESTION_FACE_PX, false)?.encodeToBase64(ImageFormat.PNG, 100);
  if (!face) return null;
  faces.set(key, face);
  return face;
}

/**
 * A message the person sent to an agent (its conversation, or "Compartilhar com…"): one more donation for the share
 * sheet's suggestions. Apple asks for donations only as people send or receive messages, never ahead of them.
 */
export function suggestAgent(orgId: string, agent: { id: string; name: string; look: AgentLookInput }): void {
  if (!native) return;
  let face: string | null = null;
  try {
    face = faceOf(agent);
  } catch {
    // Drawn or not, the suggestion goes: without a picture iOS shows the app's icon.
  }
  void native.donate(suggestionId(orgId, agent.id), agent.name, face).catch(() => false);
}

/** Signing out: the account's agents leave the share sheet. */
export async function forgetSuggestions(): Promise<void> {
  faces.clear();
  await native?.forgetAll().catch(() => undefined);
}
