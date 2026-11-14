import { useAgents } from "@agenteschat/client";
import { APP_ICONS, appIconNameKey } from "@agenteschat/client/lib/app-icons";
import { type AgentAppearance, Dialog, DialogBody } from "@agenteschat/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { agentIconPicture } from "@/lib/agent-app-icon";
import {
  type AppIconPick,
  appIcon,
  appIconPicture,
  followPickedAgent,
  onAppIconChange,
  pickedAgent,
  setAppIcon,
} from "@/lib/app-icon";
import { desktopPlatform } from "@/lib/desktop";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/** The picked icon, kept in step with the store (lib/app-icon.ts). */
export const useAppIcon = () => useSyncExternalStore(onAppIconChange, appIcon, appIcon);

/** The picked agent follows its workspace: a new name or look redraws the icon (ADR 0179). In the workspace's shell. */
export function useFollowPickedAgent(orgId: string) {
  const agents = useAgents(orgId).data;
  useEffect(() => {
    if (agents) followPickedAgent(orgId, agents);
  }, [orgId, agents]);
}

/** An agent drawn as the app icon (lib/agent-app-icon.ts), the size of the others; blank while it is drawn. */
function AgentIconPicture({ look, className }: { look: AgentAppearance; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const key = `${look.color ?? ""}|${look.eyes ?? ""}|${look.accessory ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: redrawn when the look's parts change (`key`)
  useEffect(() => {
    let live = true;
    void agentIconPicture(look).then((url) => live && setSrc(url));
    return () => {
      live = false;
    };
  }, [key]);
  const cls = ["app-icon-pic", className].filter(Boolean).join(" ");
  return src ? <img src={src} alt="" className={cls} /> : <span className={cls} aria-hidden="true" />;
}

/** A pick's picture in iOS's shape (the corners round like a home screen's): an icon's, or the agent's. */
export function AppIconPicture({ pick, className }: { pick: AppIconPick; className?: string }) {
  if (typeof pick !== "string") return <AgentIconPicture look={pick.agent.look} className={className} />;
  return <img src={appIconPicture(pick)} alt="" className={["app-icon-pic", className].filter(Boolean).join(" ")} />;
}

/** A pick's name: the icon's, or the agent's. */
export function useAppIconName(pick: AppIconPick) {
  const { t } = useTranslation();
  return typeof pick === "string" ? t(appIconNameKey(pick)) : pick.agent.name;
}

/**
 * Settings › Account › This device › App icon (ADR 0179): the icons, one line each with its picture, then the open
 * workspace's agents side by side, each drawn as the icon it makes; a pick applies at once (the tab's icon, or the
 * desktop app's Dock), like the theme.
 */
export function AppIconDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { org } = useOrg();
  const agents = useDirectory(org.id).agents;
  const current = useAppIcon();
  const picked = pickedAgent(current);
  const platform = desktopPlatform();
  const hint = !platform ? t("appIcon.hintWeb") : platform === "mac" ? t("appIcon.hintMac") : t("appIcon.hintDesktop");
  const pick = (next: AppIconPick) => {
    if (typeof next === "string" ? next === current : picked?.orgId === org.id && picked.id === next.agent.id) return;
    void setAppIcon(next).catch(() => toast.show(t("appIcon.failed")));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("appIcon.title")}
      description={hint}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <div role="radiogroup" aria-label={t("appIcon.title")}>
          <div className="app-icons">
            {APP_ICONS.map((id) => (
              // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={current === id}
                className="app-icons__item"
                onClick={() => pick(id)}
              >
                <span className="ac-radio" data-state={current === id ? "checked" : "unchecked"} aria-hidden="true">
                  {current === id && <span className="ac-radio__dot" />}
                </span>
                <AppIconPicture pick={id} />
                <span className="app-icons__name">{t(appIconNameKey(id))}</span>
              </button>
            ))}
          </div>
          {agents.length > 0 && (
            <>
              <p className="ac-eyebrow app-icons__group">{t("appIcon.agentsOf", { org: org.name })}</p>
              <div className="app-icons__agents">
                {agents.map((agent) => {
                  const on = picked?.orgId === org.id && picked.id === agent.id;
                  const look = lookOf(agent) ?? {};
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
                    <button
                      key={agent.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className="app-icons__agent"
                      onClick={() => pick({ agent: { orgId: org.id, id: agent.id, name: agent.name, look } })}
                    >
                      <AgentIconPicture look={look} />
                      <span className="app-icons__agent-name">{agent.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}
