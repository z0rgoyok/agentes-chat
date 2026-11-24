import { useApi } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useLiveActivity } from "./useLiveActivity";

/**
 * The agents' Live Activity's work in the signed-in app (ADR 0210): registration with the server and the faces it
 * reads. A leaf of its own: the directory's changes redraw nothing else.
 */
export function LiveActivityWork() {
  const api = useApi();
  const { i18n } = useTranslation();
  const dir = useDirectory();
  const agents = useMemo(() => dir.agents.map((agent) => ({ id: agent.id, look: agentLook(agent) })), [dir.agents]);
  useLiveActivity(api, i18n.language, agents);
  return null;
}
