-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and it is the only way
-- to build an index of a busy table while the table's writes go on. So a statement that fails leaves the ones before it
-- done and the migration unrecorded, and the next start runs them all again: hence IF NOT EXISTS, and a DROP before each
-- concurrent build, which leaves an invalid index under its name when it fails.
CREATE INDEX IF NOT EXISTS "agent_questions_org_id_created_at_index" ON "agent_questions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_requests_org_id_created_at_index" ON "secret_requests" USING btree ("org_id","created_at");--> statement-breakpoint
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "agent_run_steps_tool_calls_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "agent_run_steps_tool_calls_idx" ON "agent_run_steps" USING btree ("org_id","created_at") WHERE "agent_run_steps"."kind" = 'tool_call';--> statement-breakpoint
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "outbox_created_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "outbox_created_idx" ON "outbox" USING btree ("created_at","id");--> statement-breakpoint
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "outbox_run_jobs_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "outbox_run_jobs_idx" ON "outbox" USING btree ("dedupe_key" text_pattern_ops) WHERE "outbox"."kind" = 'agent_run.execute';