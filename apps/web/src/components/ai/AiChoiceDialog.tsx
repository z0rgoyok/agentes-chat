import { useAiChoice } from "@agenteschat/client";
import type { AiChoiceTarget } from "@agenteschat/client/lib/ai-choice";
import { Button, Dialog, DialogBody, DialogFooter, Icon, ProviderLogo } from "@agenteschat/ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TeamScene } from "@/components/arrival/TeamScene";
import { useOrg } from "@/components/org-context";
import { BrainLine } from "@/pages/agent/brain/pieces";
import { AiChoiceFields, rowOfChoice } from "./AiChoice";
import "@/pages/agent/brain/brain-dialog.css";

/** A line under the picker that leads elsewhere ("Mais opções", connecting another AI). */
export interface AiChoiceLink {
  label: string;
  value?: string;
  onOpen: () => void;
  opensDialog?: boolean;
}

/**
 * "Quem pensa" as one dialog for an agent's header and for Lodi: the agent under its sky with the AI's mark at the
 * trail's end, the title, the one picker (Conta, Modelo, Esforço; each change saved at once), a line or two that lead
 * elsewhere, and who the choice is for in the footer.
 */
export function AiChoiceDialog({
  open,
  onClose,
  agent,
  target,
  title,
  note,
  links = [],
  disabled = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string };
  target: AiChoiceTarget;
  title: string;
  /** Who the choice is for ("Vale só para a Ada."). */
  note: string;
  links?: readonly AiChoiceLink[];
  /** Nothing changes for now (a billing hold). */
  disabled?: boolean;
  /** Notes over the picker (a billing hold, what the AI can't do now). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="arrival arrival-chat bd"
    >
      {open && (
        <Body
          agent={agent}
          target={target}
          title={title}
          note={note}
          links={links}
          disabled={disabled}
          onClose={onClose}
        >
          {children}
        </Body>
      )}
    </Dialog>
  );
}

function Body({
  agent,
  target,
  title,
  note,
  links,
  disabled,
  onClose,
  children,
}: {
  agent: { id: string; name: string };
  target: AiChoiceTarget;
  title: string;
  note: string;
  links: readonly AiChoiceLink[];
  disabled: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const state = useAiChoice(org.id, target);
  const row = rowOfChoice(state.rows, state.current) ?? state.selected;
  const mark = row?.account?.provider ?? row?.account?.kind ?? row?.apiKey?.provider ?? null;
  return (
    <>
      <div className="arrival-hero">
        <TeamScene agents={[agent]} lead={agent.id} asleep={!row && !state.loading}>
          {row && (
            <>
              <span className="team-scene__trail" data-state={state.saving ? "walk" : "done"}>
                {[0, 1, 2, 3, 4].map((n) => (
                  <i key={n} style={{ "--n": n } as CSSProperties} />
                ))}
              </span>
              <span key={row.key} className="team-scene__mark">
                {mark ? <ProviderLogo id={mark} size="tile" /> : <Icon name="key" />}
              </span>
            </>
          )}
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="bd-glide">
        {/* biome-ignore lint/a11y/useSemanticElements: the dialog's one screen, not a group of form fields */}
        <div className="bd-screen" role="group" aria-label={title}>
          <div className="arrival-lede arrival-lede--row">
            <p className="arrival-lede__title" aria-hidden="true">
              {title}
            </p>
          </div>
          <DialogBody>
            {children}
            <AiChoiceFields state={state} disabled={disabled} />
            {links.length > 0 && (
              <div className="bd-lines">
                {links.map((l) => (
                  <BrainLine
                    key={l.label}
                    label={l.label}
                    {...(l.value ? { value: l.value } : {})}
                    opensDialog={l.opensDialog ?? false}
                    onOpen={l.onOpen}
                  />
                ))}
              </div>
            )}
          </DialogBody>
        </div>
        <DialogFooter
          className="bd-foot"
          note={
            <span className="ac-iconline">
              <Icon name="info" />
              <span>{note}</span>
            </span>
          }
        >
          <Button variant="primary" onClick={onClose}>
            {t("agentPage.work.brain.v2.finish")}
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}
