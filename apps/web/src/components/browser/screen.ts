import type { ScreenKind } from "@agenteschat/client";
import type { IconName } from "@agenteschat/ui";

// The cards' words by screen, shared with the phone (`@agenteschat/client/lib/browser-card`).
export { screenT } from "@agenteschat/client/lib/browser-card";

export const screenIcon = (screen: ScreenKind): IconName => (screen === "desktop" ? "computer" : "globe");
