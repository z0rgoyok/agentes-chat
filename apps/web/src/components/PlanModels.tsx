import type { PlanUsage } from "@agenteschat/client";
import { planModelUsage } from "@agenteschat/client/lib/plan-usage";
import { useTranslation } from "react-i18next";
import "./plan-models.css";

/**
 * One line per model at a limit of its own ("GLM-5.3 — Sem cota · renova sáb 18:00"), under the account's windows,
 * which only say how much the whole account used: its name, then where its quota stands (no quota left and when it
 * resets, off, the region it needs, or no subscription). Nothing while no model is at a limit.
 */
export function PlanModels({ usage, provider }: { usage: Pick<PlanUsage, "models"> | null; provider: string | null }) {
  const { t, i18n } = useTranslation();
  const rows = planModelUsage(t, i18n.language, usage, provider);
  if (rows.length === 0) return null;
  return (
    <div className="plan-models">
      {rows.map((r) => (
        <div key={r.id} className="plan-model">
          <span className="plan-model__name">{r.label}</span>
          <small className="plan-model__text">{r.text}</small>
        </div>
      ))}
    </div>
  );
}
