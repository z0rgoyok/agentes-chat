-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and agent_runs is
-- written all the time. A statement that fails leaves the migration unrecorded, and the next start runs it again: hence
-- the DROP before each concurrent build, which leaves an invalid index under its name when it fails.
-- The task manager's tasks that ended since a time (`visibleRuns`), asked at every poll of every viewer.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_runs_finished_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_runs_finished_idx" ON "agent_runs" USING btree ("org_id","finished_at") WHERE "agent_runs"."finished_at" is not null;--> statement-breakpoint
-- A conversation's runs: what agents did there before a run, read by its context as it starts.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_runs_channel_created_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_runs_channel_created_idx" ON "agent_runs" USING btree ("channel_id","created_at");
