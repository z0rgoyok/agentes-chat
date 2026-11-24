-- No transaction holds this migration (`migrateInSteps`): Postgres refuses CONCURRENTLY inside one, and both tables are
-- written all the time. A statement that fails leaves the migration unrecorded, and the next start runs it again: hence
-- the DROP before each concurrent build, which leaves an invalid index under its name when it fails.
-- Open jobs by the message they are for (a question's or a note's wake, a follow-up's return), read by payload.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "outbox_open_message_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_open_message_idx" ON "outbox" USING btree ("kind",("payload"->>'messageId')) WHERE "outbox"."status" in ('pending', 'processing');--> statement-breakpoint
-- The platform AI cap's month sum (`platformSpendNano`), read from the index alone.
-- deploy-safe: only this migration builds the index, so the drop removes what a cut-short run of it left and nothing a running version has
DROP INDEX CONCURRENTLY IF EXISTS "usage_records_platform_month_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_records_platform_month_idx" ON "usage_records" USING btree ("org_id","created_at","cost_nano_usd") WHERE "usage_records"."billed_to" = 'platform';
