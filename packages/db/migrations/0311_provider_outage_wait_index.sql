-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and agent_run_steps
-- holds every step of every run and is written all the time. A statement that fails leaves the migration unrecorded,
-- and the next start runs it again: hence the DROP before the concurrent build, which leaves an invalid index under its
-- name when it fails.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_run_steps_provider_outage_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "agent_run_steps_provider_outage_idx" ON "agent_run_steps" USING btree ("run_id") WHERE "agent_run_steps"."kind" = 'error' and "agent_run_steps"."data"->>'reason' = 'provider_outage';