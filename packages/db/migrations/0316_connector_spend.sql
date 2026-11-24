ALTER TABLE "connector_usage_days" ADD COLUMN "cost_nano_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "limit_connector_nano_usd" bigint;