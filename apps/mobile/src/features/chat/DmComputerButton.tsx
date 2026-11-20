import { entryLine, entryState } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import type { HeaderAction } from "@/ui";
import { openComputer } from "../computer/AgentComputerRow";
import { useAgentComputer } from "../computer/useAgentComputer";
import { useDirectory } from "../shared/hooks";

/**
 * The agent's computer when this person may watch it and it has one, else null: a self-hosted agent with no computer
 * yet has nothing to open from a conversation (its profile offers to pick one).
 */
export function useWatchableComputer(agentId: string) {
  const view = useAgentComputer(agentId);
  const f = view.facts;
  if (!view.ready || view.forbidden || !f || entryState(f).kind === "noComputer") return null;
  return view;
}

/** The entry's states worth hearing on the button (the web's dot): someone is needed there, or it's in use. */
const SAYS: ReadonlySet<string> = new Set(["needsYou", "needsOther", "working", "you", "other"]);

/** What a screen reader hears with the DM header's computer entry (the web's dot), "" when nothing worth hearing. */
export function useComputerSays(agentId: string) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const view = useWatchableComputer(agentId);
  const f = view?.facts;
  if (!f) return "";
  const entry = entryState(f);
  return SAYS.has(entry.kind)
    ? entryLine(t, entry, {
        edition: f.edition,
        locale: i18n.language,
        computer: computerName(t, org?.name ?? "", view.machine, isPersonal(org)),
        lastSeenAt: null,
        person: (id) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson"),
        step: null,
        emailPromised: false,
      })
    : "";
}

/** The entry's words (with what a screen reader hears of its state), null while there is no computer to open. */
function useComputerWords(agentId: string) {
  const { t } = useTranslation();
  const view = useWatchableComputer(agentId);
  const says = useComputerSays(agentId);
  if (!view) return null;
  return says ? `${t("agentComputer.button")}, ${says}` : t("agentComputer.button");
}

function openDmComputer(agentId: string, onOpen?: () => void) {
  onOpen?.();
  openComputer(agentId);
}

/**
 * "Computador" in an agent's DM header, as the web's: for whoever may watch the agent's computer (the profile's entry
 * shows to the same people) once it has one, it opens it full screen; while the agent needs someone there or works on
 * it, a screen reader hears that too. The conversation builds its bar's actions, and the hooks that say whether there
 * is a computer to open need the agent, so this tells `onWords` its words, null when none.
 */
export function DmComputerWords({ agentId, onWords }: { agentId: string; onWords: (words: string | null) => void }) {
  const words = useComputerWords(agentId);
  useEffect(() => {
    onWords(words);
  }, [words, onWords]);
  useEffect(() => () => onWords(null), [onWords]);
  return null;
}

/** The entry as one of the bar's system buttons, with the words `DmComputerWords` told. */
export const dmComputerAction = (agentId: string, words: string, onOpen?: () => void): HeaderAction => ({
  icon: "laptop",
  sf: "laptopcomputer",
  label: words,
  onPress: () => openDmComputer(agentId, onOpen),
});
