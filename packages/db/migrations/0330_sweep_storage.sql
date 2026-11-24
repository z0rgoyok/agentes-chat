-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and the outbox is
-- written all the time. A statement that fails leaves the migration unrecorded, and the next start runs it again: every
-- statement stands being run twice, and the DROP before the concurrent build clears the invalid index a failed one leaves.
-- The busiest tables get vacuumed after 2% of their rows (or of their TOAST rows) changed, not 20%, with ten times the
-- I/O budget per round: they are rewritten all day (runs and their steps, jobs, notifications, routine runs), and at the
-- default the dead rows of a big one pile up for days before a vacuum, then take long to clear. Only SHARE UPDATE
-- EXCLUSIVE: reads and writes go on.
ALTER TABLE "agent_runs" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000, toast.autovacuum_vacuum_scale_factor = 0.02, toast.autovacuum_vacuum_cost_limit = 2000);--> statement-breakpoint
ALTER TABLE "agent_run_steps" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000, toast.autovacuum_vacuum_scale_factor = 0.02, toast.autovacuum_vacuum_cost_limit = 2000);--> statement-breakpoint
ALTER TABLE "outbox" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000, toast.autovacuum_vacuum_scale_factor = 0.02, toast.autovacuum_vacuum_cost_limit = 2000);--> statement-breakpoint
ALTER TABLE "notifications" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000, toast.autovacuum_vacuum_scale_factor = 0.02, toast.autovacuum_vacuum_cost_limit = 2000);--> statement-breakpoint
ALTER TABLE "routine_runs" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 2000, toast.autovacuum_vacuum_scale_factor = 0.02, toast.autovacuum_vacuum_cost_limit = 2000);--> statement-breakpoint
-- Emails by when they were queued: the daily sweeps of a reply's words (`forgetReplyWords`) and of codes' emails
-- (`pruneJoinRequests`), and the operator's list of one address's emails, read them without scanning the outbox.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "outbox_email_created_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_email_created_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."kind" = 'email.send';
