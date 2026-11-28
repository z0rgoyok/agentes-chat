-- A wake for what an agent thinks with now (`agent_run.execute:<run>:switched:<wait>`) that a usage line's retime moved
-- to the plan's reset sleeps there for hours or days, and every later change's wake of that wait is deduplicated into
-- it: due now. A claim reads the agent's brain again; a run still at a limit parks again in its place. One due over an
-- hour after it was queued is never one `wakeAgentUsageWaits` staggered (60 s apart, a few minutes for a busy agent).
UPDATE "outbox" SET "next_attempt_at" = now()
WHERE "kind" = 'agent_run.execute'
  AND "status" = 'pending'
  AND "dedupe_key" LIKE 'agent_run.execute:%:switched:%'
  AND "next_attempt_at" > "created_at" + interval '1 hour';
