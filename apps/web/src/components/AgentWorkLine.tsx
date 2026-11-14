import type { WorkLine } from "@agenteschat/client/lib/agent-work";
import { cx } from "@agenteschat/ui";
import { useRef } from "react";
import { useFitStep } from "@/hooks/useFitStep";

/**
 * An agent's work in a list's line (ADR 0084 addendum of 2026-11-13): its words in the state's tone ("esperando
 * você" in amber), then " · " and the time, plain text on one line. Short of room it drops the time, then says its
 * short form ("trabalhando", "esperando", "na fila"); only a short form that still doesn't fit ends in "…". The words
 * turn with a small rise.
 */
export function AgentWorkLine({ line, className }: { line: WorkLine; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const forms = line.time ? 3 : 2;
  const step = useFitStep(ref, forms, `${line.text}|${line.time ?? ""}|${line.short}`, ".work-line__words");
  const words = step === forms - 1 && step > 0 ? line.short : line.text;
  return (
    <span ref={ref} className={cx("work-line", className)} data-tone={line.tone}>
      <span key={words} className="work-line__words">
        {words}
      </span>
      {line.time && step === 0 && (
        <>
          <span className="work-line__dot" aria-hidden="true">
            {" · "}
          </span>
          <span className="work-line__time">{line.time}</span>
        </>
      )}
    </span>
  );
}
