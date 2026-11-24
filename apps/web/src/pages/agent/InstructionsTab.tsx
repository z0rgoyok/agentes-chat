import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, Card, diffLines, Textarea } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InstructionTips } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { ProseDiff } from "@/components/ProseDiff";
import { useDirectory } from "@/hooks/useDirectory";
import { useTextLimit } from "@/hooks/useTextLimit";
import { Markdown } from "@/lib/markdown";
import { CardHead, useAgentEdit } from "./context";
import { ReadOnlyNote } from "./pieces";

/** Instruções: the text, edited in place (admins); what changed, as a diff; tips to add a line. */
export function InstructionsTab() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, draft, saved, set, can, changeOf } = useAgentEdit();
  const [showDiff, setShowDiff] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const limit = useTextLimit(FIELD_LIMITS.instructions);
  const editable = can("instructions");
  const changed = Boolean(changeOf("instructions"));
  const helper =
    (agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : me.user.name)?.split(/\s+/)[0] ?? me.user.name;
  return (
    <>
      <ReadOnlyNote field="instructions" />
      <div className="agp-cols">
        <div className="agp-col">
          <Card as="section" className="agp-card" data-changed={changed || undefined} aria-labelledby="in-title">
            <CardHead
              id="in-title"
              icon="document"
              title={t("agent.howWorks", g)}
              hint={{
                name: t("common.about", { label: t("agent.howWorks", g) }),
                text: t(modeKey(org, "agent.instructionsHelp"), { ...g, org: org.name }),
              }}
              changeKeys={["instructions"]}
              lock="instructions"
            />
            {editable ? (
              <>
                <Textarea
                  ref={area}
                  className="newag__textarea agp-instructions"
                  rows={14}
                  limit={limit}
                  aria-label={t("agent.instructions")}
                  placeholder={t("newAgent.instructionsPlaceholder")}
                  value={draft.instructions}
                  onChange={(e) => set("instructions", e.target.value)}
                />
                <div className="newag__ta-meta" style={{ justifyContent: "flex-end" }}>
                  <span className="newag__count ac-num">
                    <span aria-hidden="true">{draft.instructions.length}</span>
                    <span className="ac-visually-hidden">
                      {t("newAgent.characters", { count: draft.instructions.length })}
                    </span>
                  </span>
                </div>
                {changed && (
                  <div className="agp-stack">
                    <Button
                      size="sm"
                      className="agp-self-start"
                      aria-expanded={showDiff}
                      onClick={() => setShowDiff((v) => !v)}
                    >
                      {showDiff ? t("agentPage.instructions.hideDiff") : t("agentPage.instructions.showDiff")}
                    </Button>
                    {showDiff && (
                      <ProseDiff
                        label={t("agentPage.instructions.diff")}
                        lines={diffLines(saved.instructions.split("\n"), draft.instructions.split("\n"))}
                      />
                    )}
                  </div>
                )}
              </>
            ) : agent.instructions.trim() ? (
              <Markdown source={agent.instructions} variant="message" className="agp-prose" />
            ) : (
              <p className="muted">{t("agent.noInstructions", g)}</p>
            )}
          </Card>
        </div>
        <div className="agp-col">
          {editable && (
            <Card as="section" className="agp-card" aria-labelledby="in-add">
              <CardHead id="in-add" icon="plus" title={t("agentPage.instructions.add")} />
              <InstructionTips
                helper={helper}
                onAdd={(line) => {
                  const v = draft.instructions;
                  set("instructions", (v.trim() ? `${v.replace(/\s+$/, "")}\n` : "") + line);
                  setTimeout(() => {
                    const ta = area.current;
                    ta?.focus();
                    ta?.setSelectionRange?.(ta.value.length, ta.value.length);
                  });
                }}
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
