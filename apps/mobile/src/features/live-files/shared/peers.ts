import { peerColor } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/ui";
import { type Directory, useDirectory } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import type { PeerWhere } from "../logic";

/**
 * How someone in a live file looks on the phone (ADR 0196 §5): people in their own color from the palette of ten
 * (`peerColor`, never the agents' sky blue), agents in their face's deep tone, the color their face already uses. The
 * same tint rings their face in the bar, outlines their selection and colors the words saying where they are.
 */
export function peerTint(user: Peer["user"], dark: boolean, dir: Pick<Directory, "anyAgent">): string {
  if (user.kind === "agent") return gradientOf(agentLook(dir.anyAgent(user.id)).color)[1];
  return peerColor(user.id, dark);
}

/** A file's people as faces and words: their tint and name, read from the workspace's directory. */
export function usePeerLook() {
  const dir = useDirectory();
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  return useCallback(
    (user: Peer["user"]) => ({
      tint: peerTint(user, dark, dir),
      name: dir.nameOf({ type: user.kind === "agent" ? "agent" : "person", id: user.id }),
    }),
    [dir, dark],
  );
}

/** Where someone is, in words ("editando B4:C10", "no slide 3", "vendo", an agent's "escrevendo em B2:C40"). */
export function whereText(t: TFunction, where: PeerWhere): string {
  switch (where.kind) {
    case "range":
      return t(where.editing ? "mobile.live.here.editingAt" : "mobile.live.here.viewingAt", { where: where.label });
    case "slide":
      return t(where.editing ? "mobile.live.here.editingSlide" : "mobile.live.here.onSlide", { n: where.n });
    case "shapes":
      return t("mobile.live.here.editingShapes", { count: where.count });
    case "activity": {
      // An agent says what it does in words the apps translate; one this build doesn't know reads as editing.
      const key = `live.activity.${where.key}`;
      return t(key, { ...where.params, defaultValue: t("mobile.live.here.editing") });
    }
    case "editing":
      return t("mobile.live.here.editing");
    case "viewing":
      return t("mobile.live.here.viewing");
  }
}

/** `whereText` with the screen's translation. */
export function useWhereText() {
  const { t } = useTranslation();
  return useCallback((where: PeerWhere) => whereText(t, where), [t]);
}
