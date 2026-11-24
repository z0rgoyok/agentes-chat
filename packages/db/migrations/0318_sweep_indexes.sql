-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and both tables are
-- written all the time. A statement that fails leaves the migration unrecorded, and the next start runs it again: hence
-- the DROP before each concurrent build, which leaves an invalid index under its name when it fails.
-- The inbox sweep (`sweepEndedInboxes`): ended runs still holding unread messages, read by a full scan every tick.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_runs_inbox_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_runs_inbox_idx" ON "agent_runs" USING btree ("status") WHERE cardinality("agent_runs"."pending_message_ids") + cardinality("agent_runs"."after_message_ids") > 0;--> statement-breakpoint
-- The routine run reaper and stall sweep (`reapRoutineRuns`, `releaseStalledRoutineRuns`): open runs, read by full scans every tick.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "routine_runs_open_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "routine_runs_open_idx" ON "routine_runs" USING btree ("status","created_at") WHERE "routine_runs"."finished_at" is null;
