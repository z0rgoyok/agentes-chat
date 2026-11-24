-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and notifications
-- are written all the time. A statement that fails leaves the migration unrecorded, and the next start runs it again:
-- hence the DROP before the concurrent build, which leaves an invalid index under its name when it fails.
-- The sweeps that settle open rows of one kind (an approval or a question that closed, a budget period that ended).
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "notifications_open_kind_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_open_kind_idx" ON "notifications" USING btree ("kind","group_key" text_pattern_ops) WHERE "notifications"."done_at" is null;
