import type { Machine } from "@agenteschat/client";
import { commandInReason, machineReasonText, oneClickTerminal } from "@agenteschat/client/lib/machines";
import { Card, CardHeader, Chip, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { MachineToolButtons, useToolOneClick } from "../devices/ToolOneClick";
import { CommandBlock, TerminalFallback } from "../machine-bits";
import "../browser/browser.css";

/** Both switches desktop use needs, turned on at the computer. */
const TURN_ON = "agentes-runner tools enable desktop && agentes-runner tools enable commands";

/**
 * Each agent's own screen, on a Linux computer's page (ADR 0062): whether agents can use apps on their own
 * desktops there; when not, the computer's own words on what is missing (each agent its own user, packages) with the
 * command in them; or the two switches to turn on. What the card is for, and why Linux alone, is its title's ⓘ. Not
 * on a Mac or Windows computer, where it can't apply, nor on the workspace's own computer.
 */
export function MachineDesktopUseCard({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const oneClick = useToolOneClick(m);
  const use = m.desktopUse;
  if (!use || m.os !== "linux") return null;
  const off = use.available && !(m.access?.tools.desktop && m.access.tools.commands);
  const missing = (["desktop", "commands"] as const).filter((tool) => m.access?.tools[tool] !== true);
  const reason = use.available ? null : machineReasonText(t, use, "desktop_use_install");
  const command = use.available ? null : commandInReason(use.reason);
  return (
    <Card aria-labelledby="sec-machine-desktop-use">
      <CardHeader
        id="sec-machine-desktop-use"
        icon="computer"
        title={t("desktop.use.title")}
        hint={{ name: t("common.about", { label: t("desktop.use.title") }), text: t("desktop.use.description") }}
      />
      <div className="brw-status">
        {!use.available ? (
          <Chip icon="dash">{t("desktop.use.unavailable")}</Chip>
        ) : off ? (
          <Chip icon="dash">{t("desktop.use.off")}</Chip>
        ) : (
          <Chip icon="check" tone="done">
            {t("desktop.use.ready")}
          </Chip>
        )}
      </div>
      {off && oneClick && oneClick.kind !== "outdated" ? (
        // Each switch it still needs, one click each, for whoever connected it (anyone else asks them).
        <>
          <div className="brw-note brw-note--act">
            <span className="brw-note__text ac-iconline">
              <Icon name="computer" size={16} />
              <span>{t("desktop.use.offOne")}</span>
            </span>
            <span className="ac-acts">
              <MachineToolButtons machine={m} tools={missing} />
            </span>
          </div>
          <TerminalFallback command={oneClickTerminal(m, oneClick, missing)} />
        </>
      ) : (
        off && (
          <div className="brw-note ac-iconline">
            <Icon name="computer" size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {t("desktop.use.offHelp")}
              <CommandBlock command={TURN_ON} />
            </div>
          </div>
        )
      )}
      {reason && (
        <div className="brw-note ac-iconline">
          <Icon name="alert" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {reason}
            {command && <CommandBlock command={command} />}
          </div>
        </div>
      )}
    </Card>
  );
}
