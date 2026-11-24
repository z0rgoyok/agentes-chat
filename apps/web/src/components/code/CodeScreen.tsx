import type { Agent, PhoneDevice } from "@agenteschat/client";
import { type ComputerSurface, surfaceOf } from "@agenteschat/client/lib/agent-computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, cx, Icon, Select } from "@agenteschat/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ComputerStage } from "@/components/computer/ComputerDialog";
import { useAgentComputer } from "@/components/computer/facts";
import type { KeptPicture } from "@/components/computer/head";
import { OpenedComputerContext } from "@/components/computer/open";
import { PhoneLive } from "@/components/devices/PhoneLive";
import { useDevices } from "@/components/devices/queries";
import { useOrg } from "@/components/org-context";
import { useSaid } from "@/lib/toast";
import { CodeScreenSky } from "./CodeSky";

/** A screen the panel can show: the agent's computer, or a phone this person may use (ADR 0042). */
type ScreenPick = { kind: "computer" } | { kind: "phone"; phoneId: string };

/**
 * The session panel's Screen tab (ADR 0215): the agent's computer as its computer dialog shows it (live, "Take
 * control", full screen; a Mac's browser page), or one of the phones the person may use, picked from a menu. The
 * worktree's server runs on that computer, on a port only the agent reaches, so its screen is the preview.
 */
export function CodeScreen({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [pick, setPick] = useState<ScreenPick>({ kind: "computer" });
  // The bar's places the computer's stage portals its sub-line and its actions into (its dialog head's slots).
  const [sub, setSub] = useState<HTMLElement | null>(null);
  const [acts, setActs] = useState<HTMLElement | null>(null);
  const devices = useDevices(org.id, 15_000);
  const phones = useMemo(() => {
    const list: { phone: PhoneDevice; host: string }[] = [];
    for (const computer of devices.data?.devices ?? [])
      for (const phone of computer.phones ?? []) if (phone.mayUse) list.push({ phone, host: computer.name });
    return list;
  }, [devices.data]);
  const phone = pick.kind === "phone" ? (phones.find((p) => p.phone.id === pick.phoneId) ?? null) : null;
  return (
    <div className="code-screen">
      <div className="code-ssky" aria-hidden="true">
        <CodeScreenSky />
      </div>
      <div className="code-sbar">
        {phones.length > 0 && (
          <Select
            size="sm"
            className="code-select"
            aria-label={t("codeSessions.screen.menu", agentGrammar(agent.name))}
            value={phone ? phone.phone.id : "computer"}
            onValueChange={(v) => setPick(v === "computer" ? { kind: "computer" } : { kind: "phone", phoneId: v })}
            options={[
              {
                value: "computer",
                label: t("codeSessions.screen.computer", agentGrammar(agent.name)),
                description: t("codeSessions.screen.computerHint"),
                leading: <Icon name="computer" size={16} />,
              },
              ...phones.map(({ phone: p, host }) => ({
                value: p.id,
                label: p.name,
                description: t("codeSessions.screen.onHost", { host }),
                leading: <Icon name="phone" size={16} />,
              })),
            ]}
          />
        )}
        {!phone && (
          <>
            <span className="code-sbar__sub" ref={setSub} />
            <span className="code-sbar__r" ref={setActs} />
          </>
        )}
      </div>
      {phone ? (
        <div className="code-sstage code-sstage--phone">
          <PhoneLive phone={phone.phone} host={phone.host} />
        </div>
      ) : (
        <AgentScreen agent={agent} sub={sub} acts={acts} />
      )}
    </div>
  );
}

/** The agent's computer, through the computer dialog's own stage, with the panel's bar as its head. */
function AgentScreen({ agent, sub, acts }: { agent: Agent; sub: HTMLElement | null; acts: HTMLElement | null }) {
  const { t } = useTranslation();
  const [poll, setPoll] = useState<number | false>(5_000);
  const view = useAgentComputer(agent, { poll, runs: true });
  const surface: ComputerSurface | null = view.facts ? surfaceOf(view.facts) : null;
  // A live screen streams by itself; anything else (a page, a cover) is asked again now and then.
  useEffect(() => setPoll(surface === "screen" ? false : 5_000), [surface]);
  const [full, setFull] = useState(false);
  const picture = useRef<KeptPicture | null>(null);
  const { say } = useSaid();
  return (
    <OpenedComputerContext.Provider value={agent.id}>
      <div className={cx("code-sstage", full && "is-full")}>
        {full && (
          <Button
            size="sm"
            variant="ghost"
            icon="shrink"
            iconOnly
            className="code-sstage__exit"
            aria-label={t("codeSessions.screen.exitFull")}
            onClick={() => setFull(false)}
          />
        )}
        <ComputerStage
          agent={agent}
          view={view}
          surface={surface}
          slots={{ sub, actions: acts, full, setFull, say: (text) => say(text, true), picture, notice: "hint" }}
          onLeave={() => setFull(false)}
        />
      </div>
    </OpenedComputerContext.Provider>
  );
}
